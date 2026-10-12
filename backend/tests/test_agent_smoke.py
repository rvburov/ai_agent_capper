"""Команда agent-smoke на поддельном Claude: разбор, новости одного игрока, два вызова
анализа (второй читает кэш), учет без прогнозов, подтверждение цены."""

import asyncio
from collections.abc import Iterator
from decimal import Decimal

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import cli
from app.db.models import AgentRun, Dossier, Match, PlayerNews, Prediction, Tournament
from app.services.agent_smoke import SmokeCall, SmokeReport, run_smoke, smoke_match
from tests.analysis_helpers import install, seed_world, set_admin_key
from tests.claude_mock import seed_prices
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
