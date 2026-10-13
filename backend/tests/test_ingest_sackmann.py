"""Загрузчик архива Сакманна: python -m app.ingest.sackmann.

Образцы — tests/fixtures/sackmann (формат tennis_atp, без сети). Их сюжет:
- atp_players.csv: 14 игроков; Надаля нет в матчах (не грузится), у Xavier Nohand пустые
  рука и дата рождения и неверная страна «XX»; Alex de Minaur в справочнике отсутствует
  (берется из строки матча);
- atp_matches_2023.csv — 15 строк, годных 12: Australian Open (RET, W/O, ABD — пропуск,
  Q1 — пропуск), итоговый турнир (круговой этап Синнер — Джокович и финал той же пары),
  Кубок Дэвиса с пустым покрытием и строкой с битым id;
- atp_matches_2024.csv — 10 строк, годных 5: Australian Open (в финале битое число
  подач навылет), Brisbane (A, дата турнира в 2023 году), Paris (M) с пустым счетом,
  повтором match_num, одним игроком с двух сторон и неизвестным игроком; челленджер
  (уровень C) не грузится.
Итого: 14 игроков, 6 турниров, 17 матчей, 14 строк статистики, 8 пропусков.
"""

import asyncio
import hashlib
import re
import shutil
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, get_args

import httpx
import pytest
from sqlalchemy import func, insert, select, text
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.i18n import has_key, t
from app.db.base import Base
from app.db.models import (
    Analysis,
    Bet,
    BetLeg,
    IngestionRun,
    Match,
    MatchStat,
    OddsSnapshot,
    Player,
    Prediction,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ingest import sackmann
from app.ingest.fetch import DataSource
from app.ingest.runs import UPDATE_LOCK_KEY, IngestError, IngestReport
from app.ingest.sackmann import (
    SkipReason,
    current_year,
    load_sackmann,
    parse_matches,
    parse_years,
    summary_lines,
)
from app.services import players
from tests.support import UserFactory

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "sackmann"
YEARS = (2023, 2024)
FORBIDDEN_LETTERS = ("\u0451", "\u0401")

SINNER, DJOKOVIC, MEDVEDEV, DIMITROV = 206173, 104925, 106421, 105777
ZVEREV, FRITZ, RUNE, AUGER, ALCARAZ = 100644, 126203, 208029, 200000, 207989


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Фабрика сеансов для загрузчика (db — ради чистой базы перед тестом)."""
    return create_sessionmaker(engine)


async def load(
    factory: async_sessionmaker[AsyncSession],
    years: Sequence[int] = YEARS,
    *,
    directory: Path = FIXTURES,
    force: bool = False,
    progress: list[str] | None = None,
) -> IngestReport:
    async with DataSource.local(directory) as source:
        return await load_sackmann(
            years=years,
            source=source,
            force=force,
            db_factory=factory,
            progress=progress.append if progress is not None else None,
        )


async def count(db: AsyncSession, model: type[Base], *where: Any) -> int:
    stmt = select(func.count()).select_from(model)
    if where:
        stmt = stmt.where(*where)
    return int(await db.scalar(stmt) or 0)


async def table_counts(db: AsyncSession) -> dict[str, int]:
    return {
        model.__tablename__: await count(db, model)
        for model in (Player, Tournament, Match, MatchStat, OddsSnapshot)
    }


async def player(db: AsyncSession, sackmann_id: int) -> Player:
    found = await db.scalar(
        select(Player)
        .where(Player.sackmann_id == sackmann_id)
        .execution_options(populate_existing=True)
    )
    assert found is not None, sackmann_id
    return found


async def match(db: AsyncSession, source_ref: str) -> Match:
    found = await db.scalar(
        select(Match)
        .where(Match.source == "sackmann", Match.source_ref == source_ref)
        .execution_options(populate_existing=True)
    )
    assert found is not None, source_ref
    return found


async def tournament(db: AsyncSession, source_ref: str) -> Tournament:
    found = await db.scalar(
        select(Tournament)
        .where(Tournament.source == "sackmann", Tournament.source_ref == source_ref)
        .execution_options(populate_existing=True)
    )
    assert found is not None, source_ref
    return found


async def odds_of(db: AsyncSession, match_id: int) -> dict[tuple[str, str, int], Decimal]:
    rows = await db.execute(
        select(
            OddsSnapshot.kind, OddsSnapshot.bookmaker, OddsSnapshot.selection, OddsSnapshot.odds
        ).where(OddsSnapshot.match_id == match_id)
    )
    return {(kind, bookmaker, selection): odds for kind, bookmaker, selection, odds in rows}


def no_forbidden_letters(lines: Sequence[str]) -> bool:
    return not any(letter in line for line in lines for letter in FORBIDDEN_LETTERS)


# --- свой файл матчей для сюжетов с перенумерацией и соседними турнирами ---

HEADER = (FIXTURES / "atp_matches_2023.csv").read_text(encoding="utf-8").splitlines()[0]


def sk_row(
    tourney: str, day: str, num: int, winner: int, loser: int, round_code: str, score: str
) -> str:
    """Строка atp_matches в формате Сакманна (уровень A, сетка 32, со статистикой)."""
    cells = dict.fromkeys(HEADER.split(","), "")
    cells.update(
        tourney_id=tourney,
        tourney_name=f"Open {tourney}",
        surface="Hard",
        draw_size="32",
        tourney_level="A",
        tourney_date=day,
        match_num=str(num),
        winner_id=str(winner),
        loser_id=str(loser),
        score=score,
        best_of="3",
        round=round_code,
        w_ace="5",
        w_svpt="60",
        l_ace="2",
        l_svpt="58",
    )
    return ",".join(cells.values())


def write_year(directory: Path, year: int, rows: Sequence[str]) -> None:
    shutil.copy(FIXTURES / "atp_players.csv", directory)
    content = "\n".join([HEADER, *rows]) + "\n"
    (directory / f"atp_matches_{year}.csv").write_text(content, encoding="utf-8")


# --- данные tennis-data и старого бота, созданные «как будто» другими загрузчиками ---


async def td_player(db: AsyncSession, name: str, alias: str | None = None) -> Player:
    """Игрок, которого создал бы загрузчик tennis-data: «И. Фамилия», без sackmann_id."""
    row = Player(name=name, aliases=[alias] if alias else [])
    db.add(row)
    await db.flush()
    return row


async def td_tournament(db: AsyncSession, ref: str, **fields: Any) -> Tournament:
    row = Tournament(source="tennis_data", source_ref=ref, **fields)
    db.add(row)
    await db.flush()
    return row


async def td_match(
    db: AsyncSession,
    tour: Tournament | None,
    first: Player,
    second: Player,
    *,
    day: date,
    round_code: str,
    source: str = "tennis_data",
) -> Match:
    """Матч tennis-data: player1 — победитель (как пишет загрузчик tennis-data)."""
    key = f"{first.id}|{second.id}|{day}|{round_code}|{source}"
    row = Match(
        tournament_id=tour.id if tour else None,
        round=round_code,
        player1_id=first.id,
        player2_id=second.id,
        winner_id=first.id,
        match_date=day,
        status="finished",
        score="6-4 6-4",
        best_of=3,
        source=source,
        source_ref=hashlib.sha256(key.encode()).hexdigest()[:32],
    )
    db.add(row)
    await db.flush()
    return row


def archive_odds(match_id: int, selection: int, bookmaker: str, odds: str) -> OddsSnapshot:
    return OddsSnapshot(
        match_id=match_id,
        market="ML",
        selection=selection,
        bookmaker=bookmaker,
        odds=Decimal(odds),
        kind="archive",
        taken_at=datetime(2024, 1, 28, tzinfo=UTC),
    )


# --- разбор ---


def test_parse_years() -> None:
    assert parse_years("2024") == [2024]
    assert parse_years("2000-2003") == [2000, 2001, 2002, 2003]
    assert parse_years("2019, 2021-2022,2019") == [2019, 2021, 2022]
    for bad in ("", "24", "2026-2024", "1900", "2020-21", "abc"):
        with pytest.raises(ValueError, match="Неверные годы"):
            parse_years(bad)


@pytest.mark.parametrize(
    ("score", "status"),
    [
        ("6-4 6-3", "finished"),
        ("7-6(5) 6-7(3) 7-6(10)", "finished"),
        ("6-3 2-1 RET", "retired"),
        ("RET", "retired"),
        ("6-4 DEF", "retired"),
        ("Def.", "retired"),
        ("W/O", "walkover"),
        ("ABD", None),
        ("6-4 2-2 ABD", None),
        ("", None),
        ("In Progress", None),
    ],
)
def test_status_by_score(score: str, status: str | None) -> None:
    header = ",".join(sackmann.MATCH_COLUMNS) + ",winner_name,loser_name"
    line = f"2024-1,Doha,Hard,A,20240101,1,1,2,{score},3,F,Ann One,Bob Two"
    parsed = parse_matches("atp_matches_2024.csv", f"{header}\n{line}\n")
    assert [row.status for row in parsed.rows] == ([status] if status else [])
    assert parsed.read == 1


@pytest.mark.parametrize(
    ("level", "round_code", "loaded"),
    [
        ("G", "QF", True),
        ("M", "R16", True),
        ("F", "RR", True),
        ("O", "BR", True),
        ("D", "ER", True),
        ("A", "Q1", False),
        ("A", "Q4", False),
        ("A", "R256", False),
        ("C", "F", False),
        ("S", "F", False),
    ],
)
def test_rounds_and_levels(level: str, round_code: str, loaded: bool) -> None:
    header = ",".join(sackmann.MATCH_COLUMNS)
    line = f"2024-1,Doha,Hard,{level},20240101,1,1,2,6-4 6-4,3,{round_code}"
    parsed = parse_matches("atp_matches_2024.csv", f"{header}\n{line}\n")
    assert [row.round for row in parsed.rows] == ([round_code] if loaded else [])


def test_parse_reports_skips_with_file_and_line() -> None:
    report = IngestReport()
    content = (FIXTURES / "atp_matches_2023.csv").read_text(encoding="utf-8")
    parsed = parse_matches("atp_matches_2023.csv", content, report)
    assert (parsed.read, len(parsed.rows), report.skipped) == (15, 12, 3)
    assert report.counts["skipped.abandoned"] == 1
    assert report.counts["skipped.qualifying"] == 1
    assert report.counts["skipped.bad_row"] == 1
    assert any("atp_matches_2023.csv, строка 5:" in w and "ABD" in w for w in report.warnings)
    assert parsed.last_date == date(2023, 11, 26)


def test_bad_header_stops_loading() -> None:
    with pytest.raises(IngestError, match="winner_id"):
        parse_matches("atp_matches_2024.csv", "tourney_id,score\n2024-1,6-4 6-4\n")


def test_every_skip_reason_has_text() -> None:
    missing = [r for r in get_args(SkipReason) if not has_key(f"ingest_sackmann.skip.{r}")]
    assert missing == []


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("20240115", date(2024, 1, 15)),
        ("20240115.0", date(2024, 1, 15)),
        # Не 8 цифр — разбор как раньше, через strptime: «2024013» — 3 января
        ("2024013", date(2024, 1, 3)),
        ("", None),
        ("20240230", ValueError),
        ("2024-01-15", ValueError),
        ("2024011a", ValueError),
    ],
)
def test_date_values(value: str, expected: date | type[ValueError] | None) -> None:
    if expected is ValueError:
        with pytest.raises(ValueError):
            sackmann._date(value)
    else:
        assert sackmann._date(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("12", 12),
        ("012", 12),
        ("12.0", 12),
        ("-3", -3),
        ("", None),
        ("1.5", None),
        ("x", None),
        # Границы INTEGER базы: за ними — битое значение, а не ошибка записи в базу
        ("2147483647", 2147483647),
        ("0000000012", 12),
        ("-2147483648", -2147483648),
        ("2147483648", None),
        ("2147483648.0", None),
        ("99999999999", None),
        ("-2147483649", None),
    ],
)
def test_int_values(value: str, expected: int | None) -> None:
    if expected is None and value:
        with pytest.raises(ValueError):
            sackmann._int(value)
    else:
        assert sackmann._int(value) == expected


def test_numbers_out_of_integer_range_are_bad_values() -> None:
    """Число статистики больше INTEGER — битое значение (None и замечание), как
    отрицательное; такой id игрока — битая строка. До записи в базу оно не доходит."""
    stats = sk_row("2024-1", "20240101", 1, ZVEREV, FRITZ, "R32", "6-4 6-4")
    stats = stats.replace(",5,", ",99999999999,", 1)
    huge_id = sk_row("2024-1", "20240101", 2, 99999999999, RUNE, "R32", "6-4 6-4")
    report = IngestReport()
    parsed = parse_matches("atp_matches_2024.csv", f"{HEADER}\n{stats}\n{huge_id}\n", report)
    assert [row.match_num for row in parsed.rows] == ["1"]
    winner, loser = parsed.rows[0].stats or ({}, {})
    assert (winner["aces"], winner["serve_points"], loser["aces"]) == (None, 60, 2)
    assert any("w_ace" in w and "«99999999999»" in w for w in report.warnings)
    assert report.counts["skipped.bad_row"] == 1


def test_cells_like_dict_reader() -> None:
    """Строки CSV: пробелы по краям срезаны, пустые строки пропущены, короткая строка
    дополнена пустыми значениями, лишние значения отброшены, номер строки — как в файле
    (значение в кавычках с переводом строки занимает две строки)."""
    content = ' a , b ,c\n1, 2 ,3\n\n4,5\n6,7,8,9\n"x\ny",z,w\n'
    rows = list(sackmann._cells("f.csv", content, ("a", "b")))
    assert rows == [
        (2, {"a": "1", "b": "2", "c": "3"}),
        (4, {"a": "4", "b": "5", "c": ""}),
        (5, {"a": "6", "b": "7", "c": "8"}),
        (7, {"a": "x\ny", "b": "z", "c": "w"}),
    ]
    with pytest.raises(IngestError, match="d, e"):
        list(sackmann._cells("f.csv", content, ("a", "d", "e")))


# --- загрузка ---


async def test_first_load(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> None:
    report = await load(factory)

    assert await table_counts(db) == {
        "players": 14,
        "tournaments": 6,
        "matches": 17,
        "match_stats": 14,
        "odds_snapshots": 0,
    }
    assert (report.created, report.updated, report.rows_read, report.skipped) == (51, 0, 25, 8)
    assert report.counts["files.processed"] == 2
    assert report.counts["players.created"] == 14
    assert report.counts["matches.created"] == 17
    for reason in ("no_score", "duplicate", "same_player", "other_level", "unknown_player"):
        assert report.counts[f"skipped.{reason}"] == 1, reason
    assert report.unmatched == [
        {"kind": "player", "file": "atp_matches_2024.csv", "line": 11, "sackmann_id": 999777}
    ]

    # Только игроки матчей: Надаля нет, Тим есть (из 2024), Фриц — тоже
    assert await count(db, Player, Player.sackmann_id == 104745) == 0
    djokovic = await player(db, DJOKOVIC)
    assert (djokovic.name, djokovic.hand, djokovic.country, djokovic.birth_date) == (
        "Novak Djokovic",
        "R",
        "SRB",
        date(1987, 5, 22),
    )
    assert djokovic.aliases == []
    nohand = await player(db, 999901)
    assert (nohand.hand, nohand.country, nohand.birth_date) == (None, None, None)
    de_minaur = await player(db, 200282)
    assert (de_minaur.name, de_minaur.hand, de_minaur.country) == ("Alex de Minaur", "R", "AUS")
    assert any("Alex de Minaur" in w for w in report.warnings)

    ao = await tournament(db, "2023-580")
    assert (ao.name, ao.category, ao.surface, ao.best_of, ao.start_date) == (
        "Australian Open",
        "grand_slam",
        "hard",
        5,
        date(2023, 1, 16),
    )
    assert (await tournament(db, "2023-605")).category == "finals"
    davis = await tournament(db, "2023-M-DC-2023-FLS-M-ITA-AUS-01")
    assert (davis.category, davis.surface) == ("davis_cup", None)
    brisbane = await tournament(db, "2024-339")
    assert (brisbane.category, brisbane.start_date) == ("atp", date(2023, 12, 31))
    assert (await tournament(db, "2024-352")).category == "masters"

    final = await match(db, "2023-580-126")
    assert final.player1_id == final.winner_id == djokovic.id
    assert (final.round, final.status, final.score, final.best_of, final.match_date) == (
        "F",
        "finished",
        "6-3 7-6(4) 7-6(5)",
        5,
        None,
    )
    assert final.tournament_id == ao.id
    assert (await match(db, "2023-580-101")).status == "retired"
    walkover = await match(db, "2023-580-102")
    assert (walkover.status, walkover.score) == ("walkover", "W/O")
    assert await count(db, Match, Match.source_ref == "2023-580-103") == 0

    stats = await db.scalar(
        select(MatchStat).where(MatchStat.match_id == final.id, MatchStat.player_id == djokovic.id)
    )
    assert stats is not None
    assert (stats.aces, stats.serve_points, stats.first_in, stats.bp_faced, stats.source) == (
        10,
        90,
        60,
        2,
        "sackmann",
    )
    assert await count(db, MatchStat, MatchStat.match_id == walkover.id) == 0
    sinner = await player(db, SINNER)
    ao24_final = await match(db, "2024-580-701")
    broken = await db.scalar(
        select(MatchStat).where(
            MatchStat.match_id == ao24_final.id, MatchStat.player_id == sinner.id
        )
    )
    assert broken is not None and broken.aces is None and broken.serve_points == 90
    assert any("w_ace" in w and "«x»" in w for w in report.warnings)

    run = await db.scalar(select(IngestionRun))
    assert run is not None
    assert (run.source, run.status, run.rows, run.error) == ("sackmann", "ok", 51, None)
    assert set(run.details["files"]) == {
        "atp_players.csv",
        "atp_matches_2023.csv",
        "atp_matches_2024.csv",
    }
    assert run.details["freshness"]["years"] == {
        "2023": {"last_tourney_date": "2023-11-26", "matches": 12},
        "2024": {"last_tourney_date": "2024-10-28", "matches": 7},
    }
    assert run.details["freshness"]["last_tourney_date"] == "2024-10-28"

    lines = summary_lines(report)
    assert t("ingest_sackmann.report.license") in lines
    assert no_forbidden_letters(lines)


async def test_rerun_skips_unchanged_files_and_force_changes_nothing(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    await load(factory)
    before = await table_counts(db)
    sinner_id = (await player(db, SINNER)).id

    again = await load(factory)
    assert again.counts["files.unchanged"] == 2
    assert again.counts["files.processed"] == 0
    assert (again.created, again.updated, again.rows_read, again.skipped) == (0, 0, 0, 0)
    assert set(again.files) == {"atp_players.csv", "atp_matches_2023.csv", "atp_matches_2024.csv"}
    # Свежесть есть и у пропущенного файла
    assert again.freshness["years"]["2024"]["last_tourney_date"] == date(2024, 10, 28)

    forced = await load(factory, force=True)
    assert forced.counts["files.processed"] == 2
    assert (forced.created, forced.updated, forced.rows_read, forced.skipped) == (0, 0, 25, 8)
    assert await table_counts(db) == before
    assert (await player(db, SINNER)).id == sinner_id
    assert await count(db, IngestionRun, IngestionRun.status == "ok") == 3


async def test_progress_by_file(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    """Ход работы — строка на каждый файл сразу по ходу загрузки: получен, разобран (строк,
    пропущено, создано, обновлено, секунды), не изменился, нет файла. Числа строк файла
    в сумме дают итог отчета."""
    said: list[str] = []
    report = await load(factory, [2019, 2023, 2024], progress=said)

    assert said[0].startswith("atp_players.csv: получен, ")
    assert said[1] == t("ingest_sackmann.progress.missing", file="atp_matches_2019.csv")
    assert said[2].startswith("atp_matches_2023.csv: получен, ")
    loaded = [line for line in said if ": строк " in line]
    assert [line.split(":")[0] for line in loaded] == [
        "atp_matches_2023.csv",
        "atp_matches_2024.csv",
    ]
    numbers = [[int(n) for n in re.findall(r"\d+", line.split(":", 1)[1])[:4]] for line in loaded]
    assert [row[0] for row in numbers] == [15, 10]
    assert sum(row[1] for row in numbers) == report.skipped == 8
    # Игроки справочника сверяются в конце: они в «создано» файлов матчей
    assert sum(row[2] for row in numbers) == report.created
    assert said[-1].startswith("atp_players.csv: игроки базы сверены со справочником")
    assert no_forbidden_letters(said)

    said.clear()
    await load(factory, progress=said)
    assert said == [
        t("ingest_sackmann.progress.unchanged", file=name)
        for name in ("atp_players.csv", "atp_matches_2023.csv", "atp_matches_2024.csv")
    ]


async def test_changed_stats_are_updated_and_equal_ones_are_not_written(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    """Статистика: новая строка — «создано», изменившаяся в архиве — «обновлено»,
    совпавшая не переписывается (повторная загрузка — 0)."""
    await load(factory)
    match_id = (await match(db, "2023-580-100")).id
    djokovic_id = (await player(db, DJOKOVIC)).id
    stat = await db.get(MatchStat, (match_id, djokovic_id))
    assert stat is not None and stat.aces == 10
    stat.aces = 99
    await db.execute(
        text("DELETE FROM match_stats WHERE match_id = :id AND player_id <> :p"),
        {"id": match_id, "p": djokovic_id},
    )
    await db.commit()

    report = await load(factory, force=True)
    assert (report.counts["stats.created"], report.counts["stats.updated"]) == (1, 1)
    assert (report.created, report.updated) == (1, 1)
    db.expire_all()
    stat = await db.get(MatchStat, (match_id, djokovic_id))
    assert stat is not None and stat.aces == 10
    assert await count(db, MatchStat, MatchStat.match_id == match_id) == 2

    again = await load(factory, force=True)
    assert (again.counts["stats.created"], again.counts["stats.updated"]) == (0, 0)


async def test_copy_rows_conflict_is_integrity_error(db: AsyncSession) -> None:
    """COPY не обходит конфликт: нарушение ключа — IntegrityError SQLAlchemy с именем
    ограничения, и загрузчик откатывает файл, как при INSERT."""
    table = sackmann._table(Tournament)
    columns = ("name", "source", "source_ref")
    await sackmann.copy_rows(db, table, columns, [("x", "sackmann", "2024-1")])
    assert await count(db, Tournament) == 1
    with pytest.raises(IntegrityError) as caught:
        await sackmann.copy_rows(db, table, columns, [("y", "sackmann", "2024-1")])
    assert getattr(caught.value.orig, "constraint_name", None) == "uq_tournaments_source_source_ref"
    await db.rollback()
    assert await count(db, Tournament) == 0


async def test_copy_rows_errors_are_sqlalchemy_errors(db: AsyncSession) -> None:
    """Прочие ошибки COPY — тоже классы SQLAlchemy, как у INSERT: значение вне типа колонки
    (кодирует драйвер или проверяет база) — DataError, остальное — DBAPIError. Команда
    терминала ловит DBAPIError и не печатает трассировку."""
    table = sackmann._table(Tournament)
    cases: list[tuple[tuple[str, ...], tuple[Any, ...], type[DBAPIError]]] = [
        (("name", "best_of"), ("x", 10**6), DataError),
        (("name", "source"), ("x", "s" * 40), DataError),
        (("name", "no_such_column"), ("x", 1), DBAPIError),
    ]
    for columns, record, error in cases:
        with pytest.raises(error):
            await sackmann.copy_rows(db, table, columns, [record])
        await db.rollback()
    assert await count(db, Tournament) == 0


async def test_renamed_player_keeps_human_fields(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    shutil.copytree(FIXTURES, tmp_path, dirs_exist_ok=True)
    await load(factory, directory=tmp_path)
    auger = await player(db, AUGER)
    auger.name_ru = "Оже-Альяссим"
    auger.aliases = ["FAA"]
    await db.commit()
    touched = (await player(db, AUGER)).updated_at
    untouched = (await player(db, SINNER)).updated_at

    players_csv = tmp_path / "atp_players.csv"
    content = players_csv.read_text(encoding="utf-8")
    players_csv.write_text(
        content.replace("Felix,Auger Aliassime", "Felix,Auger-Aliassime"), encoding="utf-8"
    )
    report = await load(factory, directory=tmp_path)

    assert report.counts["files.unchanged"] == 2
    assert (report.created, report.updated) == (0, 1)
    assert report.counts["players.updated"] == 1
    auger = await player(db, AUGER)
    assert auger.name == "Felix Auger-Aliassime"
    assert auger.aliases == ["FAA", "Felix Auger Aliassime"]
    assert auger.name_ru == "Оже-Альяссим"
    assert auger.updated_at > touched
    assert (await player(db, SINNER)).updated_at == untouched


async def test_players_file_missing_then_found(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    shutil.copy(FIXTURES / "atp_matches_2023.csv", tmp_path)
    report = await load(factory, [2023], directory=tmp_path)
    assert any("atp_players.csv" in w for w in report.warnings)
    djokovic = await player(db, DJOKOVIC)
    assert (djokovic.name, djokovic.country, djokovic.birth_date) == (
        "Novak Djokovic",
        "SRB",
        None,
    )

    # Справочник появился: матчи не изменились, но игроки базы обновляются по нему
    shutil.copy(FIXTURES / "atp_players.csv", tmp_path)
    report = await load(factory, [2023], directory=tmp_path)
    assert report.counts["files.unchanged"] == 1
    # Дата рождения появилась у всех, кроме de Minaur (нет в справочнике) и Nohand (в
    # справочнике о нем ничего нового)
    assert report.counts["players.updated"] == 9
    assert (await player(db, DJOKOVIC)).birth_date == date(1987, 5, 22)


async def test_adoption_and_promotion_with_flipped_sides(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], make_user: UserFactory
) -> None:
    """Архив отставал: tennis-data создал своих игроков и финал AO 2024 (с обратным
    порядком игроков), на матч есть кэфы, прогнозы и ставка. Сакманн догнал."""
    user = (await make_user()).user
    melbourne = await td_tournament(
        db,
        "2024-6",
        name="Australian Open",
        city="Melbourne",
        indoor=False,
        category="grand_slam",
        surface="hard",
        start_date=date(2024, 1, 14),
        best_of=5,
    )
    sinner_td = await td_player(db, "J. Sinner", "Sinner J.")
    medvedev_td = await td_player(db, "D. Medvedev", "Medvedev D.")
    final_td = await td_match(
        db, melbourne, medvedev_td, sinner_td, day=date(2024, 1, 28), round_code="F"
    )
    db.add_all(
        [
            archive_odds(final_td.id, 1, "pinnacle", "2.10"),
            archive_odds(final_td.id, 2, "pinnacle", "1.75"),
            archive_odds(final_td.id, 1, "avg", "2.00"),
            archive_odds(final_td.id, 2, "avg", "1.70"),
            OddsSnapshot(
                match_id=final_td.id,
                market="ML",
                selection=2,
                bookmaker="fonbet",
                odds=Decimal("1.80"),
                kind="user",
            ),
        ]
    )
    analysis = Analysis(user_id=user.id, input_text="финал")
    db.add(analysis)
    await db.flush()
    as_of = datetime(2024, 1, 28, 6, tzinfo=UTC)
    db.add_all(
        [
            Prediction(
                user_id=user.id,
                analysis_id=analysis.id,
                match_id=final_td.id,
                market="ML",
                selection=selection,
                as_of=as_of,
                p_final=p,
            )
            for selection, p in ((1, 0.4), (2, 0.6))
        ]
    )
    bet = Bet(
        user_id=user.id,
        placed_at=as_of,
        bookmaker="fonbet",
        stake=Decimal("100.00"),
        currency="RUB",
        total_odds=Decimal("1.80"),
    )
    db.add(bet)
    await db.flush()
    db.add(
        BetLeg(
            bet_id=bet.id,
            match_id=final_td.id,
            market="ML",
            selection=2,
            odds_taken=Decimal("1.80"),
        )
    )
    # Тезка: «Dimitrov Ge.» — не Григор Димитров (полные инициалы не совпали)
    other = await td_tournament(db, "2024-20", name="Indian Wells", start_date=date(2024, 3, 7))
    dimitrov_td = await td_player(db, "Ge. Dimitrov", "Dimitrov Ge.")
    nobody = await td_player(db, "Q. Nobody", "Nobody Q.")
    await td_match(db, other, dimitrov_td, nobody, day=date(2024, 3, 10), round_code="R64")
    # Игрок старого бота (только legacy-матчи) не усыновляется
    rune_legacy = await td_player(db, "H. Rune", "Rune H.")
    await td_match(
        db, None, rune_legacy, nobody, day=date(2024, 1, 2), round_code="", source="legacy"
    )
    await db.commit()

    report = await load(factory, [2024])

    assert report.counts["players.adopted"] == 2
    assert report.counts["matches.promoted"] == 1
    assert report.counts["tournaments.deleted"] == 1
    # Тезку не усыновили, но в отчет он попал: решает человек
    assert report.unmatched == [
        {"kind": "player", "file": "atp_matches_2024.csv", "line": 11, "sackmann_id": 999777},
        {
            "kind": "possible_duplicate",
            "file": "atp_matches_2024.csv",
            "sackmann_id": DIMITROV,
            "name": "Grigor Dimitrov",
            "candidates": [{"id": dimitrov_td.id, "name": "Ge. Dimitrov", "initials_differ": True}],
        },
    ]
    assert any(
        "Grigor Dimitrov" in w and "инициалы не совпали" in w and "players-merge" in w
        for w in report.warnings
    )
    sinner = await player(db, SINNER)
    assert sinner.id == sinner_td.id
    assert (sinner.name, sinner.country, sinner.birth_date) == (
        "Jannik Sinner",
        "ITA",
        date(2001, 8, 16),
    )
    assert sorted(sinner.aliases) == ["J. Sinner", "Sinner J."]
    assert (await player(db, MEDVEDEV)).id == medvedev_td.id
    assert (await player(db, DIMITROV)).id != dimitrov_td.id
    assert (await player(db, RUNE)).id != rune_legacy.id
    assert await count(db, Player, Player.sackmann_id.is_(None)) == 3

    final = await match(db, "2024-580-701")
    ao = await tournament(db, "2024-580")
    assert final.id == final_td.id
    assert (final.tournament_id, final.player1_id, final.player2_id, final.winner_id) == (
        ao.id,
        sinner.id,
        medvedev_td.id,
        sinner.id,
    )
    assert (final.match_date, final.round, final.score, final.status, final.best_of) == (
        date(2024, 1, 28),
        "F",
        "3-6 3-6 6-4 6-4 6-3",
        "finished",
        5,
    )
    assert await odds_of(db, final.id) == {
        ("archive", "pinnacle", 1): Decimal("1.750"),
        ("archive", "pinnacle", 2): Decimal("2.100"),
        ("archive", "avg", 1): Decimal("1.700"),
        ("archive", "avg", 2): Decimal("2.000"),
        ("user", "fonbet", 1): Decimal("1.800"),
    }
    legs = list(await db.scalars(select(BetLeg.selection).where(BetLeg.match_id == final.id)))
    assert legs == [1]
    predictions = await db.execute(
        select(Prediction.selection, Prediction.p_final, Prediction.market).where(
            Prediction.match_id == final.id
        )
    )
    assert sorted(tuple(row) for row in predictions) == [(1, 0.6, "ML"), (2, 0.4, "ML")]
    assert await count(db, Tournament, Tournament.id == melbourne.id) == 0
    assert (ao.city, ao.indoor, ao.category) == ("Melbourne", False, "grand_slam")
    # Турнир tennis-data с непереведенным матчем остается
    assert await count(db, Tournament, Tournament.id == other.id) == 1

    # Повторный запуск: все уже на месте
    forced = await load(factory, [2024], force=True)
    assert (forced.created, forced.updated, forced.counts["matches.promoted"]) == (0, 0, 0)


async def test_round_robin_and_final_of_same_pair(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    turin = await td_tournament(
        db,
        "2023-66",
        name="Masters Cup",
        city="Turin",
        indoor=True,
        category="finals",
        start_date=date(2023, 11, 12),
    )
    sinner_td = await td_player(db, "J. Sinner", "Sinner J.")
    djokovic_td = await td_player(db, "N. Djokovic", "Djokovic N.")
    group = await td_match(
        db, turin, sinner_td, djokovic_td, day=date(2023, 11, 14), round_code="RR"
    )
    final = await td_match(
        db, turin, djokovic_td, sinner_td, day=date(2023, 11, 19), round_code="F"
    )
    db.add_all(
        [
            archive_odds(final.id, 1, "pinnacle", "1.50"),
            archive_odds(final.id, 2, "pinnacle", "2.60"),
        ]
    )
    await db.commit()

    report = await load(factory, [2023])

    assert report.counts["matches.promoted"] == 2
    assert (await match(db, "2023-605-1")).id == group.id
    promoted_final = await match(db, "2023-605-6")
    assert promoted_final.id == final.id
    assert (promoted_final.player1_id, promoted_final.match_date) == (
        djokovic_td.id,
        date(2023, 11, 19),
    )
    assert await odds_of(db, final.id) == {
        ("archive", "pinnacle", 1): Decimal("1.500"),
        ("archive", "pinnacle", 2): Decimal("2.600"),
    }
    finals = await tournament(db, "2023-605")
    assert (finals.city, finals.indoor, finals.category) == ("Turin", True, "finals")
    assert await count(db, Tournament, Tournament.source == "tennis_data") == 0
    assert await count(db, Match) == 12


async def test_ambiguous_adoption_creates_player_and_reports(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    other = await td_tournament(db, "2024-20", name="Indian Wells", start_date=date(2024, 3, 7))
    zverev_a = await td_player(db, "A. Zverev", "Zverev A.")
    zverev_b = await td_player(db, "Zverev A.")
    fritz_td = await td_player(db, "T. Fritz", "Fritz T.")
    await td_match(db, other, zverev_a, fritz_td, day=date(2024, 3, 10), round_code="R64")
    await td_match(db, other, fritz_td, zverev_b, day=date(2024, 3, 12), round_code="R32")
    await db.commit()

    report = await load(factory, [2024])

    zverev = await player(db, ZVEREV)
    assert zverev.id not in (zverev_a.id, zverev_b.id)
    assert (await player(db, FRITZ)).id == fritz_td.id
    assert report.counts["players.adopted"] == 1
    duplicates = [row for row in report.unmatched if row["kind"] == "possible_duplicate"]
    assert duplicates == [
        {
            "kind": "possible_duplicate",
            "file": "atp_matches_2024.csv",
            "sackmann_id": ZVEREV,
            "name": "Alexander Zverev",
            "candidates": [
                {"id": zverev_a.id, "name": "A. Zverev"},
                {"id": zverev_b.id, "name": "Zverev A."},
            ],
        }
    ]
    assert any("players-merge" in w and "Alexander Zverev" in w for w in report.warnings)


async def week_pair(
    db: AsyncSession, *, early: bool, late: bool, extra_late: int = 0
) -> dict[str, Any]:
    """Синнер — Медведев в R32 двух турниров подряд (1 и 8 января), матчи tennis-data —
    3 и 10 января с кэфами. extra_late — сколько еще матчей других пар во втором."""
    sinner = await td_player(db, "J. Sinner", "Sinner J.")
    medvedev = await td_player(db, "D. Medvedev", "Medvedev D.")
    out: dict[str, Any] = {}
    for name, wanted, ref, start, odds in (
        ("early", early, "2025-1", date(2025, 1, 1), "1.50"),
        ("late", late, "2025-2", date(2025, 1, 8), "1.40"),
    ):
        if not wanted:
            continue
        tour = await td_tournament(db, ref, name=f"TD {ref}", start_date=start)
        day = start + timedelta(days=2)
        found = await td_match(db, tour, sinner, medvedev, day=day, round_code="R32")
        db.add(archive_odds(found.id, 1, "pinnacle", odds))
        out[name], out[f"{name}_tour"] = found, tour
    for number in range(extra_late):
        first = await td_player(db, f"A. Other{number}", f"Other{number} A.")
        second = await td_player(db, f"B. Else{number}", f"Else{number} B.")
        day = date(2025, 1, 11 + number)
        await td_match(db, out["late_tour"], first, second, day=day, round_code="R32")
    await db.commit()
    return out


WEEK_A = ("2025-A", "20250101", "7-5 6-1")
WEEK_B = ("2025-B", "20250108", "6-2 6-2")


def week_rows(*weeks: tuple[str, str, str]) -> list[str]:
    return [sk_row(tid, day, 1, SINNER, MEDVEDEV, "R32", score) for tid, day, score in weeks]


@pytest.mark.parametrize("reverse", [False, True])
async def test_same_pair_in_consecutive_weeks_keeps_each_match_in_its_tournament(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path, reverse: bool
) -> None:
    """Окно дат турнира A захватывает и матч турнира B. Каждый матч tennis-data все равно
    становится матчем своего турнира, при любом порядке строк."""
    td = await week_pair(db, early=True, late=True)
    rows = week_rows(WEEK_A, WEEK_B)
    write_year(tmp_path, 2025, rows[::-1] if reverse else rows)

    report = await load(factory, [2025], directory=tmp_path)

    assert report.counts["matches.promoted"] == 2
    assert report.unmatched == []
    assert (await match(db, "2025-A-1")).id == td["early"].id
    assert (await match(db, "2025-B-1")).id == td["late"].id
    assert await count(db, Match) == 2
    assert await count(db, Tournament, Tournament.source == "tennis_data") == 0


@pytest.mark.parametrize("reverse", [False, True])
async def test_match_of_next_week_is_not_taken_by_previous_tournament(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path, reverse: bool
) -> None:
    """У tennis-data есть только матч турнира B. Турнир A его не забирает: матч A
    создается новым, а матч B со своей датой и кэфом становится матчем турнира B."""
    td = await week_pair(db, early=False, late=True)
    rows = week_rows(WEEK_A, WEEK_B)
    write_year(tmp_path, 2025, rows[::-1] if reverse else rows)

    report = await load(factory, [2025], directory=tmp_path)

    assert (report.counts["matches.promoted"], report.counts["matches.created"]) == (1, 1)
    assert report.unmatched == []
    late = await match(db, "2025-B-1")
    assert late.id == td["late"].id
    assert (late.score, late.match_date) == ("6-2 6-2", date(2025, 1, 10))
    assert late.tournament_id == (await tournament(db, "2025-B")).id
    assert await odds_of(db, late.id) == {("archive", "pinnacle", 1): Decimal("1.400")}
    early = await match(db, "2025-A-1")
    assert (early.score, early.match_date) == ("7-5 6-1", None)


async def test_tournament_of_next_week_waits_for_its_own_sackmann_tournament(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """Архив догнал только турнир A. Турнир B tennis-data (пара та же, круг тот же)
    турниру A не отдается: из его матчей с A совпала меньшая часть."""
    td = await week_pair(db, early=True, late=True, extra_late=2)
    write_year(tmp_path, 2025, week_rows(WEEK_A))

    report = await load(factory, [2025], directory=tmp_path)

    assert report.counts["matches.promoted"] == 1
    assert report.unmatched == []
    assert (await match(db, "2025-A-1")).id == td["early"].id
    late = await db.get(Match, td["late"].id, populate_existing=True)
    assert late is not None
    assert (late.source, late.tournament_id) == ("tennis_data", td["late_tour"].id)


async def _namesake_world(db: AsyncSession, *, promotable: int) -> dict[str, Any]:
    """Турнир tennis-data (2 января) с игроком «X. Unknown», которого Сакманн знает как
    Alexander Zverev: общего ключа «фамилия + инициал» нет, усыновления нет.
    promotable — сколько матчей пар, известных обоим архивам (Синнер — Руне, Алькарас —
    Медведев), кроме двух матчей с Unknown или одного (если promotable = 2)."""
    names = {
        "sinner": ("J. Sinner", "Sinner J."),
        "rune": ("H. Rune", "Rune H."),
        "alcaraz": ("C. Alcaraz", "Alcaraz C."),
        "medvedev": ("D. Medvedev", "Medvedev D."),
        "fritz": ("T. Fritz", "Fritz T."),
        "unknown": ("X. Unknown", "Unknown X."),
    }
    p = {key: await td_player(db, name, alias) for key, (name, alias) in names.items()}
    tour = await td_tournament(db, "2025-9", name="TD Open", start_date=date(2025, 1, 2))
    day = date(2025, 1, 2)
    out: dict[str, Any] = {"tour": tour}
    out["sinner_rune"] = await td_match(db, tour, p["sinner"], p["rune"], day=day, round_code="R32")
    if promotable == 2:
        out["alcaraz_medvedev"] = await td_match(
            db, tour, p["alcaraz"], p["medvedev"], day=day, round_code="R32"
        )
        out["unknown"] = [
            await td_match(db, tour, p["unknown"], p["fritz"], day=day, round_code="R32")
        ]
    else:
        out["unknown"] = [
            await td_match(db, tour, p["unknown"], p["medvedev"], day=day, round_code="R32"),
            await td_match(db, tour, p["alcaraz"], p["unknown"], day=day, round_code="R16"),
        ]
    out["players"] = p
    await db.commit()
    return out


async def test_tournament_with_unadopted_namesake_is_reported(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """Общих пар с турниром Сакманна меньше половины: матчи tennis-data не повышаются, и
    это не молча — в отчете турнир и пары «копия → матч Сакманна». По подсказке человек
    сливает игрока (копии его матчей сливаются сами) и оставшуюся копию матча."""
    w = await _namesake_world(db, promotable=1)
    write_year(
        tmp_path,
        2025,
        [
            sk_row("2025-A", "20250101", 1, SINNER, RUNE, "R32", "6-4 6-4"),
            sk_row("2025-A", "20250101", 2, ZVEREV, MEDVEDEV, "R32", "6-3 6-3"),
            sk_row("2025-A", "20250101", 3, ALCARAZ, ZVEREV, "R16", "6-2 6-2"),
        ],
    )

    report = await load(factory, [2025], directory=tmp_path)

    assert report.counts["matches.promoted"] == 0
    sinner_rune = await match(db, "2025-A-1")
    [row] = report.unmatched
    assert row["kind"] == "tournament" and row["tennis_data_tournament"] == w["tour"].id
    assert (row["common"], row["size"]) == (1, 3)
    assert row["copies"] == {str(w["sinner_rune"].id): sinner_rune.id}
    [warning] = [text for text in report.warnings if "players-find" in text]
    assert f"{w['sinner_rune'].id} → {sinner_rune.id}" in warning
    # Повторный разбор: копии на месте — отчет повторяется, а не пропадает
    again = await load(factory, [2025], directory=tmp_path, force=True)
    assert [item["kind"] for item in again.unmatched] == ["tournament"]

    zverev = await player(db, ZVEREV)
    merged = await players.merge_players(
        db, source_id=w["players"]["unknown"].id, target_id=zverev.id, actor_id=None
    )
    assert len(merged.copies_merged) == 2
    await players.merge_matches(
        db, source_match_id=w["sinner_rune"].id, target_match_id=sinner_rune.id
    )
    assert await count(db, Match) == 3
    assert await count(db, Tournament, Tournament.source == "tennis_data") == 0


async def test_leftover_matches_of_owned_tournament_are_reported(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """Турнир tennis-data отдан турниру Сакманна, но матч с неусыновленным игроком
    остался копией: он в отчете с id."""
    w = await _namesake_world(db, promotable=2)
    write_year(
        tmp_path,
        2025,
        [
            sk_row("2025-A", "20250101", 1, SINNER, RUNE, "R32", "6-4 6-4"),
            sk_row("2025-A", "20250101", 2, ALCARAZ, MEDVEDEV, "R32", "6-3 6-3"),
            sk_row("2025-A", "20250101", 3, ZVEREV, FRITZ, "R32", "6-2 6-2"),
        ],
    )

    report = await load(factory, [2025], directory=tmp_path)

    assert report.counts["matches.promoted"] == 2
    [leftover] = w["unknown"]
    assert report.unmatched == [
        {
            "kind": "match",
            "file": "atp_matches_2025.csv",
            "tourney_id": "2025-A",
            "tennis_data_ids": [leftover.id],
        }
    ]
    assert any(f"матчи {leftover.id} не нашли пары" in text for text in report.warnings)


async def test_renumbered_matches_keep_their_pairs(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """Сакманн поменял номера двух матчей местами, потом вставил пропущенный матч в
    начало турнира. Матч остается у своей пары вместе с датой и кэфами tennis-data."""
    day = "20250101"
    write_year(
        tmp_path,
        2025,
        [
            sk_row("2025-A", day, 1, SINNER, MEDVEDEV, "R32", "6-4 6-4"),
            sk_row("2025-A", day, 2, ALCARAZ, RUNE, "R32", "6-3 6-3"),
        ],
    )
    await load(factory, [2025], directory=tmp_path)
    sinner_medvedev = await match(db, "2025-A-1")
    sinner_medvedev.match_date = date(2025, 1, 3)
    db.add(archive_odds(sinner_medvedev.id, 1, "pinnacle", "1.30"))
    await db.commit()
    alcaraz_rune = await match(db, "2025-A-2")
    stats_before = await count(db, MatchStat)

    write_year(
        tmp_path,
        2025,
        [
            sk_row("2025-A", day, 2, SINNER, MEDVEDEV, "R32", "6-4 6-4"),
            sk_row("2025-A", day, 1, ALCARAZ, RUNE, "R32", "6-3 6-3"),
        ],
    )
    swapped = await load(factory, [2025], directory=tmp_path)
    assert (swapped.created, swapped.updated, swapped.counts["matches.updated"]) == (0, 2, 2)
    assert (await match(db, "2025-A-2")).id == sinner_medvedev.id
    assert (await match(db, "2025-A-1")).id == alcaraz_rune.id

    write_year(
        tmp_path,
        2025,
        [
            sk_row("2025-A", day, 1, FRITZ, RUNE, "R16", "7-6(3) 6-4"),
            sk_row("2025-A", day, 2, SINNER, MEDVEDEV, "R32", "6-4 6-4"),
            sk_row("2025-A", day, 3, ALCARAZ, RUNE, "R32", "6-3 6-3"),
        ],
    )
    shifted = await load(factory, [2025], directory=tmp_path, force=True)

    assert shifted.counts["matches.created"] == 1
    assert shifted.counts["matches.players_changed"] == 0
    kept = await match(db, "2025-A-2")
    assert kept.id == sinner_medvedev.id
    assert (kept.player1_id, kept.match_date) == ((await player(db, SINNER)).id, date(2025, 1, 3))
    assert await odds_of(db, kept.id) == {("archive", "pinnacle", 1): Decimal("1.300")}
    assert (await match(db, "2025-A-3")).id == alcaraz_rune.id
    added = await match(db, "2025-A-1")
    assert (added.player1_id, added.round) == ((await player(db, FRITZ)).id, "R16")
    assert await count(db, MatchStat) == stats_before + 2
    run = await db.scalar(select(IngestionRun).order_by(IngestionRun.id.desc()).limit(1))
    assert run is not None and run.status == "ok"


async def test_corrected_player_keeps_match_and_warns(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    """Сакманн исправил проигравшего в матче: прежней пары в турнире больше нет. Матч
    остается тем же, статистика прежнего игрока удаляется, в отчете — предупреждение."""
    day = "20250101"
    write_year(tmp_path, 2025, [sk_row("2025-A", day, 1, SINNER, MEDVEDEV, "R32", "6-4 6-4")])
    await load(factory, [2025], directory=tmp_path)
    before = await match(db, "2025-A-1")

    write_year(tmp_path, 2025, [sk_row("2025-A", day, 1, SINNER, FRITZ, "R32", "6-4 6-4")])
    report = await load(factory, [2025], directory=tmp_path)

    after = await match(db, "2025-A-1")
    fritz, medvedev = await player(db, FRITZ), await player(db, MEDVEDEV)
    assert (after.id, after.player2_id) == (before.id, fritz.id)
    assert report.counts["matches.players_changed"] == 1
    assert any(f"id {before.id}" in w and "прежней паре" in w for w in report.warnings)
    stats = set(await db.scalars(select(MatchStat.player_id).where(MatchStat.match_id == after.id)))
    assert medvedev.id not in stats and fritz.id in stats


async def test_missing_files_mark_freshness(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    this_year = current_year()
    report = await load(factory, [2019, 2024, this_year])

    fresh = report.freshness
    assert fresh["years"][str(this_year)] == {"missing": True}
    assert fresh["years"]["2019"] == {"missing": True}
    assert fresh["missing_files"] == ["atp_matches_2019.csv", f"atp_matches_{this_year}.csv"]
    assert fresh["last_tourney_date"] == date(2024, 10, 28)
    # Файла текущего года может не быть — это не предупреждение; прошлого года — да
    missing = [w for w in report.warnings if "atp_matches_" in w and "нет в источнике" in w]
    assert missing == [t("ingest_sackmann.warnings.file_missing", file="atp_matches_2019.csv")]
    run = await db.scalar(select(IngestionRun))
    assert run is not None and run.status == "ok"
    lines = summary_lines(report)
    assert t("ingest_sackmann.report.freshness_missing", year=this_year) in lines


async def test_http_source_and_404_of_current_year(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        name = request.url.path.rsplit("/", 1)[-1]
        path = FIXTURES / name
        if request.url.path.startswith("/tennis_atp/") and path.is_file():
            return httpx.Response(200, content=path.read_bytes())
        return httpx.Response(404)

    this_year = current_year()
    async with DataSource.http(
        "https://data.example/tennis_atp", transport=httpx.MockTransport(handler)
    ) as source:
        report = await load_sackmann(years=[2023, this_year], source=source, db_factory=factory)
    assert requested == [
        "/tennis_atp/atp_players.csv",
        "/tennis_atp/atp_matches_2023.csv",
        f"/tennis_atp/atp_matches_{this_year}.csv",
    ]
    assert report.freshness["source"] == "https://data.example/tennis_atp"
    assert report.freshness["years"][str(this_year)] == {"missing": True}
    assert await count(db, Match) == 12


def serving(names: set[str]) -> httpx.MockTransport:
    """Архив по HTTP, в котором есть только эти файлы образцов."""

    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        if name in names:
            return httpx.Response(200, content=(FIXTURES / name).read_bytes())
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def test_http_source_without_players_or_past_year_fails(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    """Справочник и прошлые годы в архиве есть всегда: их 404 — неверный адрес архива.
    Запуск неудачный, иначе ночная загрузка «успешно» грузила бы ноль строк."""
    base = "https://data.example/tennis_atp"
    async with DataSource.http(base, transport=serving(set())) as source:
        with pytest.raises(IngestError, match="нет справочника игроков"):
            await load_sackmann(years=[current_year()], source=source, db_factory=factory)
    run = await db.scalar(select(IngestionRun))
    assert run is not None and run.status == "failed"
    assert "CAPPER_SACKMANN_BASE_URL" in (run.error or "")

    files = {"atp_players.csv", "atp_matches_2023.csv"}
    async with DataSource.http(base, transport=serving(files)) as source:
        with pytest.raises(IngestError, match=re.escape("atp_matches_2019.csv")):
            await load_sackmann(years=[2019, 2023], source=source, db_factory=factory)
    # Остальные годы загружены, файла 2019 года нет
    assert await count(db, Match) == 12
    last = await db.scalar(select(IngestionRun).order_by(IngestionRun.id.desc()).limit(1))
    assert last is not None and last.status == "failed"
    assert last.details["freshness"]["missing_files"] == ["atp_matches_2019.csv"]


async def test_empty_dir_fails(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession], tmp_path: Path
) -> None:
    with pytest.raises(IngestError, match="нет ни одного файла архива"):
        await load(factory, [2024, current_year()], directory=tmp_path)
    run = await db.scalar(select(IngestionRun))
    assert run is not None and run.status == "failed"


async def test_database_conflict_rolls_back_only_that_file(
    db: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Конфликт в базе при записи одного года: этот год откатывается, остальные пишутся,
    запуск помечается неудачным, а следующий запуск разбирает файл заново."""
    original = sackmann._Loader._absorb_tennis_data_tournaments
    calls = 0

    async def broken(self: Any, session: AsyncSession) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            await session.execute(
                insert(Tournament).values(name="x", source="sackmann", source_ref="2023-580")
            )
        await original(self, session)

    monkeypatch.setattr(sackmann._Loader, "_absorb_tennis_data_tournaments", broken)
    with pytest.raises(IngestError, match=re.escape("atp_matches_2023.csv")):
        await load(factory)

    assert await count(db, Tournament, Tournament.source_ref.like("2023-%")) == 0
    assert await count(db, Tournament, Tournament.source_ref.like("2024-%")) == 3
    run = await db.scalar(select(IngestionRun))
    assert run is not None and run.status == "failed"
    assert "atp_matches_2023.csv" in (run.error or "")
    assert "atp_matches_2023.csv" not in run.details["files"]
    assert any("uq_tournaments_source_source_ref" in w for w in run.details["warnings"])
    assert run.details["counts"]["matches.created"] == 5

    monkeypatch.setattr(sackmann._Loader, "_absorb_tennis_data_tournaments", original)
    report = await load(factory)
    assert report.counts["files.processed"] == 2
    assert report.counts["matches.created"] == 12
    assert await count(db, Match) == 17


# --- команда терминала ---


async def run_main(*argv: str) -> int:
    return await asyncio.to_thread(sackmann.main, list(argv))


async def test_main_with_dir(db: AsyncSession, capsys: pytest.CaptureFixture[str]) -> None:
    code = await run_main("--years", "2023-2024", "--dir", str(FIXTURES))
    assert code == 0
    out = capsys.readouterr().out
    assert t("ingest_sackmann.report.license") in out
    assert t("ingest_sackmann.report.title", location=str(FIXTURES)) in out
    assert no_forbidden_letters(out.splitlines())
    assert await count(db, Match) == 17
    assert await count(db, IngestionRun, IngestionRun.status == "ok") == 1


async def test_main_waits_for_update_lock(
    db: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пока идет обновление данных, отдельная загрузка архива не начинается: иначе она
    шла бы вперемешку с шагами ночной задачи (дубли матчей)."""
    await db.execute(text("SELECT pg_advisory_lock(:key)"), {"key": UPDATE_LOCK_KEY})
    try:
        assert await run_main("--years", "2023-2024", "--dir", str(FIXTURES)) == 1
    finally:
        await db.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": UPDATE_LOCK_KEY})
        await db.commit()
    assert t("ingest_update.errors.busy") in capsys.readouterr().err
    assert await count(db, Match) == 0
    assert await count(db, IngestionRun) == 0


async def test_main_errors(
    db: AsyncSession, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    assert await run_main("--dir", str(tmp_path / "nope")) == 1
    assert t("ingest_sackmann.errors.dir_not_found", path=tmp_path / "nope") in (
        capsys.readouterr().err
    )
    with pytest.raises(SystemExit) as exit_info:
        await run_main("--years", "2026-2020")
    assert exit_info.value.code == 2
    (tmp_path / "atp_matches_2024.csv").write_text("tourney_id,score\n", encoding="utf-8")
    assert await run_main("--years", "2024", "--dir", str(tmp_path)) == 1
    assert "winner_id" in capsys.readouterr().err
    run = await db.scalar(select(IngestionRun))
    assert run is not None and run.status == "failed"


@pytest.mark.parametrize("flipped", [False, True], ids=["same_order", "flipped"])
async def test_user_match_on_row_key_becomes_archive_match(
    flipped: bool,
    db: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    make_user: UserFactory,
) -> None:
    """Т14: матч из ввода участника с турниром, кругом и игроками строки Сакманна не
    вытесняет ее — строка записывается в этот матч (тот же id, нога ставки и прогноз
    остаются, сторона переворачивается при обратном порядке игроков), отчет это показывает."""
    await load(factory, [2024])
    final = await match(db, "2024-580-701")
    ao = await tournament(db, "2024-580")
    sinner, medvedev = await player(db, SINNER), await player(db, MEDVEDEV)
    await db.delete(final)
    await db.flush()
    first, second = (medvedev, sinner) if flipped else (sinner, medvedev)
    user_match = Match(
        tournament_id=ao.id,
        round="F",
        player1_id=first.id,
        player2_id=second.id,
        status="scheduled",
        source="user",
        source_ref="user:2024-01-28:t14",
    )
    user = (await make_user()).user
    analysis = Analysis(user_id=user.id, input_text="финал")
    db.add_all([user_match, analysis])
    await db.flush()
    db.add(
        Prediction(
            user_id=user.id,
            analysis_id=analysis.id,
            match_id=user_match.id,
            market="ML",
            selection=1,
            as_of=datetime(2024, 1, 28, tzinfo=UTC),
            p_final=0.55,
        )
    )
    bet = Bet(
        user_id=user.id,
        placed_at=datetime(2024, 1, 28, tzinfo=UTC),
        bookmaker="fonbet",
        stake=Decimal("100.00"),
        currency="RUB",
        total_odds=Decimal("1.80"),
    )
    db.add(bet)
    await db.flush()
    db.add(
        BetLeg(
            bet_id=bet.id,
            match_id=user_match.id,
            market="ML",
            selection=1,
            odds_taken=Decimal("1.80"),
        )
    )
    await db.commit()

    report = await load(factory, [2024], force=True)
    db.expunge_all()
    assert report.counts["matches.user_merged"] == 1
    assert not [row for row in report.unmatched if row["kind"] == "match"]
    assert any(
        f"матч {user_match.id} из ввода участника стал матчем архива" in warning
        for warning in report.warnings
    )
    archive = await match(db, "2024-580-701")
    assert archive.id == user_match.id and archive.source == "sackmann"
    assert (archive.player1_id, archive.winner_id, archive.status) == (
        sinner.id,
        sinner.id,
        "finished",
    )
    # Ставили на игрока 1 матча из ввода: при обратном порядке это теперь игрок 2
    expected = 2 if flipped else 1
    legs = list(await db.scalars(select(BetLeg.selection).where(BetLeg.match_id == archive.id)))
    assert legs == [expected]
    selections = list(
        await db.scalars(select(Prediction.selection).where(Prediction.match_id == archive.id))
    )
    assert selections == [expected]
