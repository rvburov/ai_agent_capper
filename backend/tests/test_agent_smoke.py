"""Команда agent-smoke на поддельном Claude: разбор, новости одного игрока, два вызова
анализа (второй читает кэш), учет без прогнозов, подтверждение цены; agent-smoke --only
news — только шаг новостей одного игрока с вариантами (модель, фильтрация поиска кодом,
число поисков, точка кэша)."""

import asyncio
from collections.abc import Iterator
from decimal import Decimal

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import cli
from app.agent.config import load_agent_config
from app.db.models import (
    AgentRun,
    Dossier,
    Match,
    ModelPrice,
    Player,
    PlayerNews,
    Prediction,
    Tournament,
)
from app.services.agent_smoke import (
    NewsOptions,
    NewsSmokeReport,
    SmokeCall,
    SmokeReport,
    news_config,
    run_news_smoke,
    run_smoke,
    smoke_match,
)
from tests.analysis_helpers import install, seed_world, set_admin_key
from tests.claude_mock import PRICES_FROM, seed_prices
from tests.fake_claude import FakeClaude


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


async def test_smoke_report(db: AsyncSession, world: dict[str, int], fake: FakeClaude) -> None:
    report = await run_smoke(db)
    assert [call.step for call in report.calls] == ["parse", "news", "analysis", "analysis"]
    assert report.parsed_events == 1 and report.news_facts == 1
    assert report.second_cache_read > 0 and report.total_usd > 0
    assert report.p_base is not None and report.p_claude is not None
    runs = list(await db.scalars(select(AgentRun)))
    assert len(runs) == 4 and all(run.analysis_id is None for run in runs)
    assert {run.key_source for run in runs} == {"admin"}
    assert await db.scalar(select(func.count()).select_from(Prediction)) == 0
    assert await db.scalar(select(func.count()).select_from(PlayerNews)) == 0


async def test_smoke_command(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answers = iter(["нет"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    assert await asyncio.to_thread(cli.main, ["agent-smoke"]) == 1
    assert fake.requests == []
    assert await asyncio.to_thread(cli.main, ["agent-smoke", "--yes"]) == 0
    out = capsys.readouterr().out
    assert "Чтение кэша во втором вызове анализа" in out
    assert "sk-ant-" not in out
    assert len(fake.calls("analysis")) == 2


async def test_smoke_fails_when_model_did_not_search(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Главная цель проверки — web_search и record_news в одном запросе. Модель вызвала
    record_news, но ни один поиск не прошел: раньше команда выходила с кодом 0 и строкой
    «Поиски 0», теперь — код 1 и что именно не подтвердилось."""
    fake.fail("news", "search_error")
    assert await asyncio.to_thread(cli.main, ["agent-smoke", "--yes"]) == 1
    printed = capsys.readouterr()
    assert "в худшем случае до $" in printed.out
    assert "Проверка не пройдена" in printed.err
    assert "шаг новостей не выполнил ни одного поиска" in printed.err


def test_smoke_problems() -> None:
    report = SmokeReport(
        calls=[SmokeCall("news", "m", 1, 0, 0, 1, 0, Decimal(0), None)],
        parsed_events=0,
        news_searched=True,
    )
    assert [key for key, _ in report.problems()] == ["events", "search", "cache"]
    good = SmokeReport(
        calls=[
            SmokeCall("news", "m", 1, 0, 0, 1, 2, Decimal(0), None),
            SmokeCall("analysis", "m", 1, 10, 0, 1, 0, Decimal(0), None),
            SmokeCall("analysis", "m", 1, 0, 10, 1, 0, Decimal(0), None),
        ],
        parsed_events=1,
        news_searched=True,
    )
    assert good.problems() == []


async def test_smoke_on_archive_without_match_dates(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude
) -> None:
    """У матчей архива Сакманна нет даты (только у tennis-data): раньше проверка без
    --match отвечала «Не найдено» еще до вызова Claude. Теперь берется последний матч по
    началу турнира, а досье — на день матча: его результат в досье не попадает."""
    await db.execute(update(Match).values(match_date=None))
    await db.commit()
    latest = await smoke_match(db, None)
    start = await db.scalar(
        select(Tournament.start_date).where(Tournament.id == latest.tournament_id)
    )
    newest = await db.scalar(select(func.max(Tournament.start_date)))
    assert start is not None and start == newest
    report = await run_smoke(db, match_id=latest.id)
    dossier = await db.scalar(
        select(Dossier).where(Dossier.match_id == latest.id).order_by(Dossier.id.desc()).limit(1)
    )
    assert dossier is not None and dossier.content["as_of"] == start.isoformat()
    rows = dossier.content["p1"]["form"]["m"] + dossier.content["h2h"].get("last", [])
    assert all(row["d"] < start.isoformat() for row in rows)
    assert report.problems() == []


async def test_smoke_without_matches_says_what_to_do(
    db: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    await seed_prices(db)
    await set_admin_key(db)
    assert await asyncio.to_thread(cli.main, ["agent-smoke", "--yes"]) == 1
    err = capsys.readouterr().err
    assert "В базе нет сыгранных матчей" in err and "--match" in err
    assert await asyncio.to_thread(cli.main, ["agent-smoke", "--match", "999999", "--yes"]) == 1
    assert "Матча 999999 нет в базе" in capsys.readouterr().err


async def test_smoke_goes_on_after_news_rejected(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Живой API отклонил запрос новостей (400): проверка не обрывается на нем — анализ
    матча тоже проверяется, а в итоге видна причина отказа Anthropic (без нее ошибку
    нашего запроса не найти)."""
    fake.fail("news", "bad_request")
    report = await run_smoke(db)
    assert [call.step for call in report.calls] == ["parse", "news", "analysis", "analysis"]
    assert report.news_failure is not None and "(fake)" in report.news_failure
    assert ("news_failed", {"message": report.news_failure}) in report.problems()
    news_run = await db.scalar(select(AgentRun).where(AgentRun.kind == "news"))
    assert news_run is not None and news_run.error == "400:invalid_request_error | fake"

    fake.fail("news", "bad_request")
    assert await asyncio.to_thread(cli.main, ["agent-smoke", "--yes"]) == 1
    printed = capsys.readouterr()
    assert "Чтение кэша во втором вызове анализа" in printed.out
    assert "шаг новостей не выполнен" in printed.err and "(fake)" in printed.err


# --- только новости одного игрока (--only news) ---


async def _cli(*argv: str) -> int:
    return await asyncio.to_thread(cli.main, ["agent-smoke", *argv])


async def test_news_only_default(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Только шаг новостей: один запрос Sonnet с прямым поиском, без разбора и анализа;
    печать — проверка модели, оценка, токены, стоимость, факты и их источники. Новости в
    базу не пишутся, вызов — строка agent_runs."""
    assert await _cli("--only", "news", "--yes") == 0
    out = capsys.readouterr().out
    assert [len(fake.calls(step)) for step in ("parse", "news", "analysis")] == [0, 1, 0]
    [body] = fake.calls("news")
    assert body["model"] == "claude-sonnet-5-5"
    assert body["tools"][0]["allowed_callers"] == ["direct"]
    assert body["tools"][0]["max_uses"] == 2
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    match = await smoke_match(db, None)
    player = await db.get_one(Player, match.player1_id)
    assert f"1. {player.name}" in body["messages"][0]["content"]
    assert "Модель новостей claude-sonnet-5-5: веб-поиск — да" in out
    assert f"Новости игрока {player.name} (id {player.id})" in out
    assert "фильтрация кодом — нет, точка кэша на system — да" in out
    assert "Факты и источники:" in out and "https://www.atptour.com/en/news/" in out
    assert "(ATP Tour)" in out and "Поиски: 1, ошибки поиска: —" in out
    runs = list(await db.scalars(select(AgentRun)))
    assert [(run.kind, run.key_source, run.analysis_id) for run in runs] == [
        ("news", "admin", None)
    ]
    assert await db.scalar(select(func.count()).select_from(PlayerNews)) == 0
    # Итерации серверного цикла (usage.iterations) и цена того же разговора без точки
    # кэша: весь вход каждой итерации по $2 за млн (Sonnet 5.5), выход и поиск как были
    [run] = runs
    write = run.cache_write_tokens
    assert "Итерации вызовов (usage.iterations" in out
    rows = [line.split() for line in out.splitlines() if line.startswith("1 ")]
    assert [row[:7] for row in rows] == [
        ["1", "1", "message", "300", str(write), "0", "150"],
        ["1", "2", "message", "7700", "0", "0", "350"],
    ]
    no_cache = (Decimal(8000 + write) * 2 + 500 * 10) / 1_000_000 + Decimal("0.01")
    expected = f"Без точки кэша тот же разговор стоил бы ${no_cache.quantize(Decimal('0.0001'))}"
    assert expected in out
    assert f"(с точкой — ${run.cost_usd.quantize(Decimal('0.0001'))}, разница −$" in out


async def test_news_only_variants(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Haiku 5.5, фильтрация кодом, один поиск, без точки кэша, выбранный игрок: в
    запросе — та же версия поиска без allowed_callers, max_uses 1 и ни одного
    cache_control; ответ с блоками кода и caller разбирается, факт проверен по адресу из
    вложенного результата поиска."""
    rune = world["rune"]
    argv = [
        "--only",
        "news",
        "--news-model",
        "claude-haiku-5-5",
        "--news-dynamic",
        "--news-max-uses",
        "1",
        "--news-no-cache",
        "--player",
        str(rune),
        "--yes",
    ]
    assert await _cli(*argv) == 0
    out = capsys.readouterr().out
    [body] = fake.calls("news")
    assert body["model"] == "claude-haiku-5-5"
    search = body["tools"][0]
    assert search["type"] == "web_search_20260209" and "allowed_callers" not in search
    assert search["max_uses"] == 1 and "cache_control" not in str(body)
    assert "1. Holger Rune" in body["messages"][0]["content"]
    assert "фильтрация поиска кодом (programmatic tool calling) — да" in out
    assert "фильтрация кодом — да, точка кэша на system — нет" in out
    assert "https://www.atptour.com/en/news/holger-rune-1" in out
    # Без точки кэша итерации печатаются, а пересчета «без точки» нет: он равен итогу
    assert "Итерации вызовов (usage.iterations" in out and "Без точки кэша" not in out
    run = await db.scalar(select(AgentRun))
    assert run is not None and run.model == "claude-haiku-5-5"
    assert run.cache_write_tokens == 0 and run.cache_read_tokens == 0
    # Настройки агента не меняются: варианты — только для этого запуска
    assert (await load_agent_config(db)).news_model == "claude-sonnet-5-5"


async def test_news_only_declined_and_wrong_options(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Отказ от подтверждения, флаги новостей без --only news, неверная модель, нет
    игрока, модель без programmatic tool calling с --news-dynamic, модель, недоступная
    ключу (404): код 1, понятная причина и ни одного платного вызова."""
    answers = iter(["нет"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    assert await _cli("--only", "news") == 1
    assert "Около $" in capsys.readouterr().out

    assert await _cli("--news-dynamic", "--yes") == 1
    assert "только вместе с --only news" in capsys.readouterr().err

    # --match с --only news не действует: не берем молча другого игрока
    assert await _cli("--only", "news", "--match", "999999", "--yes") == 1
    assert "С --only news флаг --match не действует" in capsys.readouterr().err

    assert await _cli("--only", "news", "--news-model", "gpt-4", "--yes") == 1
    assert "Неверное значение настройки агента news_model" in capsys.readouterr().err

    assert await _cli("--only", "news", "--news-max-uses", "0", "--yes") == 1
    assert "news_max_uses" in capsys.readouterr().err

    assert await _cli("--only", "news", "--player", "999999", "--yes") == 1
    assert "Игрока 999999 нет в базе" in capsys.readouterr().err

    argv = ["--only", "news", "--news-model", "claude-haiku-4-5", "--news-dynamic", "--yes"]
    assert await _cli(*argv) == 1
    assert "не поддерживает фильтрацию поиска кодом" in capsys.readouterr().err

    assert await _cli("--only", "news", "--news-model", "claude-haiku-9-9", "--yes") == 1
    assert "claude-haiku-9-9" in capsys.readouterr().err

    db.add(
        ModelPrice(
            model="claude-opus-9-9",
            valid_from=PRICES_FROM,
            input=Decimal(1),
            output=Decimal(1),
            cache_read=Decimal(1),
            cache_write_5m=Decimal(1),
            cache_write_1h=Decimal(1),
            search_price=Decimal("0.01"),
        )
    )
    await db.commit()
    assert await _cli("--only", "news", "--news-model", "claude-opus-9-9", "--yes") == 1
    assert "недоступна ключу администратора (404)" in capsys.readouterr().err

    assert fake.requests == []
    assert await db.scalar(select(func.count()).select_from(AgentRun)) == 0


async def test_news_only_without_search_fails(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Ни один поиск не прошел — код 1, как у полной проверки; таблица вызовов и итог
    в долларах все равно печатаются."""
    fake.fail("news", "search_error")
    assert await _cli("--only", "news", "--yes") == 1
    printed = capsys.readouterr()
    assert "Итого: $" in printed.out and "ошибки поиска: unavailable" in printed.out
    assert "шаг новостей не выполнил ни одного поиска" in printed.err

    # Запрос отклонен (400): причина с ответом Anthropic, учет вызова записан
    fake.fail("news", "bad_request")
    assert await _cli("--only", "news", "--yes") == 1
    printed = capsys.readouterr()
    assert "Шаг не выполнен:" in printed.err and "(fake)" in printed.err
    assert "400:invalid_request_error" in printed.out


async def test_run_news_smoke_report(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude
) -> None:
    config = news_config(await load_agent_config(db), NewsOptions(dynamic_filtering=True))
    player = await db.get_one(Player, world["sinner"])
    report = await run_news_smoke(db, config=config, player=player)
    assert report.problems() == [] and report.searched and report.searches == 1
    assert [fact.source_url for fact in report.facts] == [
        "https://www.atptour.com/en/news/jannik-sinner-1"
    ]
    assert report.total_usd > 0 and report.max_uses == 2
    assert [len(call.iterations) for call in report.calls] == [2]
    assert report.no_cache_usd is not None and report.no_cache_usd > 0


def test_news_report_without_iterations() -> None:
    """У какого-то вызова итераций нет (старый ответ API): цену без точки кэша не
    считаем вовсе, частичная сумма ввела бы в заблуждение."""

    def call(no_cache: Decimal | None) -> SmokeCall:
        return SmokeCall(
            step="news",
            model="claude-sonnet-5-5",
            input_tokens=1,
            cache_write_tokens=0,
            cache_read_tokens=0,
            output_tokens=1,
            web_searches=1,
            cost_usd=Decimal("0.02"),
            error=None,
            no_cache_usd=no_cache,
        )

    report = NewsSmokeReport(player_id=1, player_name="A", max_uses=2)
    assert report.no_cache_usd is None
    report.calls = [call(Decimal("0.03")), call(Decimal("0.04"))]
    assert report.no_cache_usd == Decimal("0.07")
    report.calls.append(call(None))
    assert report.no_cache_usd is None
