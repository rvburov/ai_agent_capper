"""Обновление данных одной командой (app/ingest/update.py): годы, порядок шагов, итог в
терминале, ошибка одного источника, повторный запуск, блокировка, команда терминала.

Без сети: архив Сакманна — образцы tests/fixtures/sackmann (2023 и 2024 годы), файл
tennis-data за 2024 год собирается в тесте через openpyxl. В нем Australian Open 2024 (три
матча есть у Сакманна: они получают день и кэфы) и Монпелье, которого у Сакманна нет
(свои матчи tennis-data).
"""

import asyncio
import shutil
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, get_args

import httpx
import pytest
from sqlalchemy import func, make_url, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import get_settings
from app.core.i18n import has_key
from app.db.base import Base
from app.db.models import (
    IngestionRun,
    Match,
    MlModel,
    OddsSnapshot,
    Player,
    PlayerRating,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ingest import sackmann, tennis_data, update
from app.ingest.update import (
    STEPS,
    StepResult,
    UpdateResult,
    plan_years,
    run_update,
    summary_lines,
)
from app.ml import backtest, elo
from tests.support import SettingsOverride
from tests.test_ingest_tennis_data import make_row, write_year

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "sackmann"
YEARS = [2023, 2024]

Factory = Callable[[], AsyncSession]


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> Factory:
    return create_sessionmaker(engine)


def rows_2024() -> list[dict[str, Any]]:
    ao: dict[str, Any] = {"series": "Grand Slam", "location": "Melbourne", "best_of": 5}
    sets = ((6, 4), (6, 4), (6, 4))
    return [
        make_row(
            6, "Australian Open", datetime(2024, 1, 15), "Sinner J.", "Thiem D.", sets=sets, **ao
        ),
        make_row(
            6,
            "Australian Open",
            datetime(2024, 1, 26),
            "Sinner J.",
            "Djokovic N.",
            round_label="Semifinals",
            sets=sets,
            **ao,
        ),
        make_row(
            6,
            "Australian Open",
            datetime(2024, 1, 28),
            "Sinner J.",
            "Medvedev D.",
            round_label="The Final",
            sets=sets,
            **ao,
        ),
        make_row(
            10,
            "Open Sud de France",
            datetime(2024, 2, 5),
            "Sinner J.",
            "Rune H.",
            location="Montpellier",
        ),
        make_row(
            10,
            "Open Sud de France",
            datetime(2024, 2, 5),
            "Fritz T.",
            "Rublev A.",
            location="Montpellier",
        ),
    ]


@pytest.fixture
def folders(tmp_path: Path) -> tuple[Path, Path]:
    """Папка архива Сакманна (копия образцов) и папка tennis-data с файлом 2024 года."""
    sackmann_dir = tmp_path / "sackmann"
    shutil.copytree(FIXTURES, sackmann_dir)
    tennis_dir = tmp_path / "tennis-data"
    write_year(tennis_dir, 2024, rows_2024())
    return sackmann_dir, tennis_dir


async def table_counts(db: AsyncSession) -> dict[str, int]:
    out: dict[str, int] = {}
    for model in (Player, Tournament, Match, OddsSnapshot, PlayerRating):
        table: type[Base] = model
        out[table.__tablename__] = int(
            await db.scalar(select(func.count()).select_from(table)) or 0
        )
    return out


def step(result: UpdateResult, name: str) -> update.StepResult:
    return next(item for item in result.steps if item.step == name)


# --- годы ---


def test_plan_years(override_settings: SettingsOverride) -> None:
    override_settings(data_first_year=2000, tennis_data_first_year=2013)
    october = date(2026, 10, 9)
    plan = plan_years(full=False, years=None, today=october)
    assert (plan.sackmann_years, plan.tennis_data_years, plan.force) == ((2026,), (2026,), False)
    # В январе — и прошлый год: архив прошлого года еще дописывается
    plan = plan_years(full=False, years=None, today=date(2027, 1, 3))
    assert (plan.sackmann_years, plan.tennis_data_years) == ((2026, 2027), (2026, 2027))
    plan = plan_years(full=True, years=None, today=october)
    assert plan.sackmann_years == tuple(range(2000, 2027))
    assert plan.tennis_data_years == tuple(range(2013, 2027))
    assert plan.force
    # Свои годы: у tennis-data нет файлов раньше 2013 года, будущих годов нет ни у кого
    plan = plan_years(full=False, years=[2010, 2011, 2012, 2013, 2014, 2027], today=october)
    assert plan.sackmann_years == (2010, 2011, 2012, 2013, 2014)
    assert plan.tennis_data_years == (2013, 2014)
    assert not plan.force
    assert plan_years(full=True, years=[2005], today=october).tennis_data_years == ()


def test_texts_for_every_step() -> None:
    for name in STEPS:
        assert has_key(f"ingest_update.step.{name}"), name
        assert has_key(f"ingest_update.freshness.{name}"), name
    for status in get_args(update.StepStatus):
        assert status in ("ok", "failed", "skipped")


# --- шаги по очереди ---


async def test_update_from_folders_and_repeat(
    db: AsyncSession, factory: Factory, folders: tuple[Path, Path]
) -> None:
    sackmann_dir, tennis_dir = folders
    said: list[str] = []
    result = await run_update(
        years=YEARS,
        sackmann_dir=sackmann_dir,
        tennis_data_dir=tennis_dir,
        db_factory=factory,
        echo=said.append,
    )

    assert result.ok, summary_lines(result)
    assert [item.step for item in result.steps] == list(STEPS)
    assert all(item.status == "ok" for item in result.steps)
    # Журнал: по строке на шаг, в порядке шагов
    runs = (await db.execute(select(IngestionRun.source, IngestionRun.status))).all()
    assert [tuple(run) for run in runs] == [(name, "ok") for name in STEPS]
    sack = step(result, "sackmann")
    assert sack.created > 0 and sack.skipped > 0
    assert sack.freshness == "Последний турнир архива начался 2024-10-28"
    tennis = step(result, "tennis_data")
    assert tennis.freshness == "Последний день матча с датой: 2024-02-05"
    assert step(result, "players_link").freshness == "Матчей старого бота без привязки: 0"
    assert step(result, "elo").created > 0

    # Матчи Australian Open получили день и кэфы, Монпелье — свой турнир tennis-data
    final = (
        await db.execute(
            select(Match)
            .join(Tournament, Tournament.id == Match.tournament_id)
            .where(Tournament.source_ref == "2024-580", Match.round == "F")
        )
    ).scalar_one()
    assert final.match_date == date(2024, 1, 28)
    odds = await db.scalar(
        select(func.count()).select_from(OddsSnapshot).where(OddsSnapshot.match_id == final.id)
    )
    assert odds == 6
    own = (
        await db.execute(select(Tournament).where(Tournament.source == "tennis_data"))
    ).scalar_one()
    assert own.source_ref == "2024-10" and own.city == "Montpellier"
    # Эло посчитано и записано
    assert (
        await db.scalar(select(func.count()).select_from(PlayerRating))
        == step(result, "elo").created
    )
    assert await db.get(MlModel, "elo-v1") is not None

    # Ход работы и итог — по-русски, с каждым шагом
    text_out = "\n".join(said)
    assert "== Шаг 1 из 4. Архив Сакманна: годы 2023, 2024, из папки" in text_out
    assert "== Шаг 4 из 4. Пересчет Эло" in text_out
    assert "Данные: Jeff Sackmann / Tennis Abstract, CC BY-NC-SA 4.0" in text_out
    # Ход работы шагов — с отступом, по файлу и по этапу, сразу, а не только в итоге
    assert any(line.startswith("  atp_players.csv: получен, ") for line in said)
    loaded = [line for line in said if line.startswith("  atp_matches_2023.csv: строк ")]
    assert len(loaded) == 1 and " за " in loaded[0]
    assert any(line.startswith("  история загружена: матчей ") for line in said)
    assert any(line.startswith("  рейтинги посчитаны: игроков ") for line in said)
    elo_rows = step(result, "elo").created
    written = [line for line in said if line.startswith("  строки записаны: ")]
    assert written and f"новых и изменившихся {elo_rows}, удалено 0" in written[0]
    assert said.index(loaded[0]) < said.index(written[0])
    lines = summary_lines(result)
    assert lines[0] == "Итог обновления данных:"
    assert lines[1].startswith("  Архив Сакманна — готово за ")
    assert ", не сопоставлено 1. Последний турнир архива начался 2024-10-28" in lines[1]
    assert lines[4].startswith("  Пересчет Эло — готово за ")
    assert f"строк рейтинга {elo_rows}, из них записано {elo_rows} (остальные" in lines[4]
    assert lines[-1] == "Все шаги прошли"

    before = await table_counts(db)
    ratings = (
        await db.execute(
            text("SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) FROM player_ratings t")
        )
    ).scalar_one()

    # Повтор без изменений: файлы пропущены по sha256, в базе то же самое
    again = await run_update(
        years=YEARS, sackmann_dir=sackmann_dir, tennis_data_dir=tennis_dir, db_factory=factory
    )
    assert again.ok
    for name in ("sackmann", "tennis_data", "players_link"):
        assert (step(again, name).created, step(again, name).updated) == (0, 0), name
    # Эло пересчитано, но ни одна строка рейтинга не изменилась — и не переписана
    assert (step(again, "elo").created, step(again, "elo").written) == (elo_rows, 0)
    assert f"строк рейтинга {elo_rows}, из них записано 0 (" in summary_lines(again)[4]
    db.expunge_all()
    assert await table_counts(db) == before
    assert (
        await db.execute(
            text("SELECT md5(string_agg(t::text, ',' ORDER BY t::text)) FROM player_ratings t")
        )
    ).scalar_one() == ratings

    # С --full (разбор заново) тоже ничего не меняется
    forced = await run_update(
        full=True,
        years=YEARS,
        sackmann_dir=sackmann_dir,
        tennis_data_dir=tennis_dir,
        db_factory=factory,
    )
    assert forced.ok
    for name in ("sackmann", "tennis_data"):
        assert (step(forced, name).created, step(forced, name).updated) == (0, 0), name
    assert await table_counts(db) == before


async def test_tennis_data_blocked_does_not_stop_other_steps(
    db: AsyncSession, factory: Factory, override_settings: SettingsOverride
) -> None:
    """403 от tennis-data: шаг с ошибкой и инструкцией, остальные шаги выполнены."""
    override_settings(
        sackmann_base_url="https://sackmann.test/atp", tennis_data_base_url="http://td.test"
    )
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(str(request.url))
        if request.url.host == "td.test":
            return httpx.Response(403, text="You are unable to access tennis-data.co.uk")
        path = FIXTURES / request.url.path.rsplit("/", 1)[-1]
        if path.is_file():
            return httpx.Response(200, content=path.read_bytes())
        return httpx.Response(404)

    result = await run_update(
        years=YEARS, db_factory=factory, transport=httpx.MockTransport(handler)
    )

    assert not result.ok
    assert [(item.step, item.status) for item in result.steps] == [
        ("sackmann", "ok"),
        ("tennis_data", "failed"),
        ("players_link", "ok"),
        ("elo", "ok"),
    ]
    error = step(result, "tennis_data").error or ""
    assert "ответ 403" in error
    assert "http://www.tennis-data.co.uk/alldata.php" in error
    # Подсказка ведет к загрузке всех лет: без --full грузится только текущий год
    assert "bash deploy/local.sh data --full --tennis-data-dir ПАПКА" in error
    assert "https://sackmann.test/atp/atp_matches_2024.csv" in asked
    lines = summary_lines(result)
    assert any(line.startswith("  tennis-data.co.uk — ошибка за ") for line in lines)
    assert lines[-1].startswith(
        "Есть ошибки: tennis-data.co.uk. Выполнены шаги: Архив Сакманна, Привязка старого "
        "бота, Пересчет Эло."
    )
    runs = dict((await db.execute(select(IngestionRun.source, IngestionRun.status))).all())
    assert runs == {"sackmann": "ok", "tennis_data": "failed", "players_link": "ok", "elo": "ok"}
    assert (await db.scalar(select(func.count()).select_from(PlayerRating)) or 0) > 0


def test_summary_when_no_step_was_done() -> None:
    """Связи с базой нет: первый шаг упал, остальные не выполнялись. Итог не говорит, что
    «остальные шаги выполнены»."""
    result = UpdateResult(
        steps=[
            StepResult(step="sackmann", status="failed", error="Нет подключения к базе данных"),
            StepResult(step="tennis_data", status="skipped", reason="нет связи"),
            StepResult(step="players_link", status="skipped", reason="нет связи"),
            StepResult(step="elo", status="skipped", reason="нет связи"),
        ]
    )
    last = summary_lines(result)[-1]
    assert last.startswith("Есть ошибки: Архив Сакманна. Ни один шаг не выполнен.")
    assert "Остальные" not in last and "Выполнены" not in last


async def test_sackmann_failure_keeps_counts_from_journal(
    db: AsyncSession, factory: Factory, folders: tuple[Path, Path]
) -> None:
    """Сакманн упал на середине (нет справочника по HTTP — неверный адрес): шаг с ошибкой,
    tennis-data и Эло работают дальше."""
    _, tennis_dir = folders

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    result = await run_update(
        years=[2024],
        tennis_data_dir=tennis_dir,
        db_factory=factory,
        transport=httpx.MockTransport(handler),
    )

    sack = step(result, "sackmann")
    assert sack.status == "failed"
    assert "нет справочника игроков atp_players.csv" in (sack.error or "")
    assert sack.freshness == "В базе пока нет данных"
    tennis = step(result, "tennis_data")
    # Сакманна нет: все матчи tennis-data — свои, игроки созданы по именам
    assert tennis.status == "ok" and tennis.created > 0
    assert step(result, "elo").status == "ok"
    assert not result.ok


async def test_skip_elo_and_busy(
    db: AsyncSession, engine: AsyncEngine, factory: Factory, folders: tuple[Path, Path]
) -> None:
    sackmann_dir, tennis_dir = folders
    result = await run_update(
        years=[2024],
        sackmann_dir=sackmann_dir,
        tennis_data_dir=tennis_dir,
        skip_elo=True,
        db_factory=factory,
    )
    assert result.ok
    assert step(result, "elo").status == "skipped"
    assert "--skip-elo" in summary_lines(result)[-2]
    assert await db.scalar(select(func.count()).select_from(PlayerRating)) == 0

    # Другое обновление держит блокировку: второе не начинается
    async with engine.connect() as other:
        await other.execute(text("SELECT pg_advisory_lock(:key)"), {"key": update.LOCK_KEY})
        busy = await run_update(
            years=[2024], sackmann_dir=sackmann_dir, tennis_data_dir=tennis_dir, db_factory=factory
        )
        await other.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": update.LOCK_KEY})
    assert busy.busy and not busy.ok and busy.steps == []
    assert summary_lines(busy) == [
        "Обновление данных уже идет (другая команда или ночная задача воркера). "
        "Дождитесь его конца и повторите"
    ]


# --- команда терминала ---


async def run_main(*argv: str) -> int:
    return await asyncio.to_thread(update.main, list(argv))


async def test_main_with_folders(
    db: AsyncSession, folders: tuple[Path, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    sackmann_dir, tennis_dir = folders
    code = await run_main(
        "--years",
        "2023-2024",
        "--sackmann-dir",
        str(sackmann_dir),
        "--tennis-data-dir",
        str(tennis_dir),
        "--skip-elo",
    )
    out = capsys.readouterr().out
    assert code == 0, out
    assert "Итог обновления данных:" in out and out.rstrip().endswith("Все шаги прошли")
    # Ход работы печатается по файлу, с отступом под строкой шага
    assert "\n  atp_matches_2024.csv: строк " in out
    assert (await db.scalar(select(func.count()).select_from(Match)) or 0) > 0

    # Вместо таблицы tennis-data — веб-страница (проверка Cloudflare): код 1, но Сакманн
    # и привязка выполнены
    (tennis_dir / "2024" / "2024.xlsx").write_bytes(b"<html><body>Just a moment</body></html>")
    code = await run_main(
        "--full",
        "--years",
        "2024",
        "--sackmann-dir",
        str(sackmann_dir),
        "--tennis-data-dir",
        str(tennis_dir),
        "--skip-elo",
    )
    out = capsys.readouterr().out
    assert code == 1
    assert "tennis-data.co.uk — ошибка за" in out and "веб-страница" in out
    assert "Архив Сакманна — готово за" in out


def test_main_bad_arguments(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # До подключения к базе: в этом же потоке
    assert update.main(["--sackmann-dir", str(tmp_path / "nope")]) == 1
    assert "Папка не найдена" in capsys.readouterr().err
    next_year = str(datetime.now(UTC).year + 1)
    for bad in ("20x4", next_year, "2025-2024"):
        with pytest.raises(SystemExit) as caught:
            update.main(["--years", bad])
        assert caught.value.code == 2
        assert "Неверные годы" in capsys.readouterr().err


def test_main_without_database(
    tmp_path: Path, override_settings: SettingsOverride, capsys: pytest.CaptureFixture[str]
) -> None:
    """Базы нет: код 1 и понятный текст без адреса и пароля базы."""
    override_settings(database_url="postgresql+asyncpg://capper:s3cret@127.0.0.1:1/capper")
    assert update.main(["--sackmann-dir", str(tmp_path), "--tennis-data-dir", str(tmp_path)]) == 1
    captured = capsys.readouterr()
    assert "Нет подключения к базе данных" in captured.err
    assert "s3cret" not in captured.err + captured.out


@pytest.mark.parametrize("broken", ["password", "database"])
@pytest.mark.parametrize("command", ["update", "sackmann", "tennis_data", "elo", "backtest"])
async def test_commands_report_rejected_connection(
    broken: str,
    command: str,
    db: AsyncSession,
    tmp_path: Path,
    override_settings: SettingsOverride,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Неверный пароль базы и несуществующая база: драйвер отдает общий DBAPIError.
    Команды печатают понятный текст без трассировки и пароля, код 1."""
    url = make_url(get_settings().database_url)
    if broken == "password":
        url = url.set(password="wr0ng-s3cr3t-pw")
    else:
        url = url.set(database="capper_no_such_db_for_ingest_test")
    override_settings(database_url=url.render_as_string(hide_password=False))
    folder = str(tmp_path)
    mains: dict[str, tuple[Callable[[list[str]], int], list[str]]] = {
        "update": (update.main, ["--sackmann-dir", folder, "--tennis-data-dir", folder]),
        "sackmann": (sackmann.main, ["--years", "2024", "--dir", folder]),
        "tennis_data": (tennis_data.main, ["--years", "2024", "--dir", folder]),
        "elo": (elo.main, []),
        "backtest": (backtest.main, ["--no-save", "--report", "-"]),
    }
    main, argv = mains[command]
    assert await asyncio.to_thread(main, argv) == 1
    captured = capsys.readouterr()
    assert "Нет подключения к базе данных" in captured.err
    assert "Traceback" not in captured.err and "wr0ng-s3cr3t-pw" not in captured.err
