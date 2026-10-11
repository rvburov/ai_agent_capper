"""Команда agent-smoke на поддельном Claude: разбор, новости одного игрока, два вызова
анализа (второй читает кэш), учет без прогнозов, подтверждение цены."""

import asyncio
from collections.abc import Iterator

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import cli
from app.db.models import AgentRun, PlayerNews, Prediction
from app.services.agent_smoke import run_smoke
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
