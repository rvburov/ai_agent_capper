"""Настройки агента: значения по умолчанию, чтение поверх app_settings.agent_config,
сохранение с журналом и команды терминала agent-config и prices."""

import asyncio

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import cli
from app.agent.client import client_for, set_http_client_for_tests
from app.agent.config import (
    DEFAULT_CONFIG,
    DEFAULT_NEWS_DOMAINS,
    AgentConfig,
    config_from_overrides,
    load_agent_config,
    parse_setting,
    save_agent_config,
)
from app.core.errors import AppError
from app.db.models import AppSettings
from tests.claude_mock import KEY, seed_prices
from tests.helpers_admin import audit_entries


async def run(*argv: str) -> int:
    return await asyncio.to_thread(cli.main, list(argv))


def test_defaults_from_brief() -> None:
    c = DEFAULT_CONFIG
    assert (c.parse_model, c.parse_effort, c.parse_max_tokens, c.parse_timeout_s) == (
        "claude-haiku-5-5",
        "low",
        4096,
        60,
    )
    assert c.news_enabled is True
    assert (c.news_model, c.news_effort, c.news_max_tokens, c.news_timeout_s) == (
        "claude-sonnet-5-5",
        "low",
        8000,
        180,
    )
    assert (
        c.news_max_uses,
        c.news_max_searches_per_analysis,
        c.news_max_searches_per_day,
        c.news_ttl_hours,
        c.news_lookback_days,
        c.news_max_pause_continuations,
    ) == (3, 9, 30, 12, 14, 3)
    assert c.news_domains == DEFAULT_NEWS_DOMAINS and "atptour.com" in c.news_domains
    assert (c.analysis_model, c.analysis_effort, c.analysis_max_tokens) == (
        "claude-opus-5-5",
        "medium",
        16000,
    )
    assert (
        c.analysis_stream_timeout_s,
        c.analysis_step_timeout_s,
        c.analysis_max_iterations,
        c.analysis_parallel,
        c.assessment_reuse_hours,
    ) == (120, 300, 3, 3, 6)
    assert (
        c.estimate_analysis_input_tokens,
        c.estimate_analysis_output_tokens,
        c.estimate_news_input_tokens,
        c.estimate_news_output_tokens,
        c.estimate_news_searches,
    ) == (7000, 4000, 15000, 1500, 3)
    assert c.models() == ("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5")
    no_news = AgentConfig(news_enabled=False)
    assert no_news.models() == ("claude-haiku-5-5", "claude-opus-5-5")


def test_overrides_skip_unknown_and_invalid() -> None:
    config = config_from_overrides(
        {
            "news_max_uses": 2,
            "analysis_effort": "low",
            "removed_setting": True,
            "analysis_parallel": 99,
            "parse_model": "gpt-4",
        }
    )
    assert config.news_max_uses == 2 and config.analysis_effort == "low"
    assert config.analysis_parallel == 3 and config.parse_model == "claude-haiku-5-5"
    assert config_from_overrides({}) == DEFAULT_CONFIG


def test_domains_are_checked() -> None:
    config = AgentConfig(news_domains=(" ATPtour.com ", "bbc.com/sport/tennis"))
    assert config.news_domains == ("atptour.com", "bbc.com/sport/tennis")
    for bad in ("https://atptour.com", "атп.рф", "localhost"):
        with pytest.raises(ValueError):
            AgentConfig(news_domains=(bad,))


def test_parse_setting() -> None:
    assert parse_setting("news_domains", "a.com, b.org ,") == ["a.com", "b.org"]
    assert parse_setting("news_max_uses", "2") == "2"
    with pytest.raises(AppError) as caught:
        parse_setting("no_such", "1")
    assert caught.value.code == "agent_config.unknown"


async def test_save_and_load(db: AsyncSession) -> None:
    assert await load_agent_config(db) == DEFAULT_CONFIG
    saved = await save_agent_config(
        db,
        changes={"news_max_uses": "2", "news_enabled": "false", "news_domains": ["atptour.com"]},
        actor_id=None,
    )
    assert saved.news_max_uses == 2 and saved.news_enabled is False
    row = await db.get_one(AppSettings, 1, populate_existing=True)
    assert row.agent_config == {
        "news_max_uses": 2,
        "news_enabled": False,
        "news_domains": ["atptour.com"],
    }
    assert await load_agent_config(db) == saved
    [entry] = await audit_entries(db, "agent_config_change")
    assert entry.details == {
        "changes": {
            "news_max_uses": {"from": 3, "to": 2},
            "news_enabled": {"from": True, "to": False},
            "news_domains": {"from": list(DEFAULT_NEWS_DOMAINS), "to": ["atptour.com"]},
        },
        "source": "terminal",
    }

    # Неизвестное имя и неверное значение — ошибка, ничего не меняется
    for changes, code in (
        ({"no_such": 1}, "agent_config.unknown"),
        ({"analysis_max_iterations": 0}, "agent_config.invalid"),
        ({"analysis_effort": "ultra"}, "agent_config.invalid"),
    ):
        with pytest.raises(AppError) as caught:
            await save_agent_config(db, changes=changes, actor_id=None)
        assert caught.value.code == code
        await db.rollback()
    with pytest.raises(AppError):
        await save_agent_config(db, changes={}, reset=["no_such"], actor_id=None)
    await db.rollback()

    # Возврат к значению по умолчанию и сохранение без изменений (журнал не пишется)
    back = await save_agent_config(db, changes={}, reset=["news_enabled"], actor_id=None)
    assert back.news_enabled is True and back.news_max_uses == 2
    await save_agent_config(db, changes={"news_max_uses": 2}, actor_id=None)
    assert len(await audit_entries(db, "agent_config_change")) == 2


async def test_unknown_stored_key_does_not_break_reading(db: AsyncSession) -> None:
    await db.execute(
        update(AppSettings).values(agent_config={"old_name": 1, "analysis_parallel": 2})
    )
    await db.commit()
    assert (await load_agent_config(db)).analysis_parallel == 2


async def test_cli_agent_config(db: AsyncSession, capsys: pytest.CaptureFixture[str]) -> None:
    assert await run("agent-config") == 0
    out = capsys.readouterr().out
    assert "  analysis_model = claude-opus-5-5" in out
    assert "news_domains = atptour.com, ausopen.com" in out

    assert (
        await run(
            "agent-config",
            "--set",
            "news_max_uses=2",
            "--set",
            "news_domains=atptour.com,bbc.com",
        )
        == 0
    )
    out = capsys.readouterr().out
    assert "* news_max_uses = 2 (по умолчанию 3)" in out
    assert "* news_domains = atptour.com, bbc.com" in out
    [entry] = await audit_entries(db, "agent_config_change")
    assert entry.actor_id is None and entry.details["source"] == "terminal"

    assert await run("agent-config", "--reset", "news_max_uses") == 0
    assert "  news_max_uses = 3" in capsys.readouterr().out

    for argv in (
        ("--set", "news_max_uses"),
        ("--set", "nope=1"),
        ("--set", "news_max_uses=many"),
        ("--reset", "nope"),
    ):
        assert await run("agent-config", *argv) == 1
    err = capsys.readouterr().err
    assert "ИМЯ=ЗНАЧЕНИЕ" in err and "nope" in err and "news_max_uses" in err


async def test_cli_prices(db: AsyncSession, capsys: pytest.CaptureFixture[str]) -> None:
    assert await run("prices") == 0
    assert "Цен моделей в базе нет" in capsys.readouterr().out
    await seed_prices(db)
    assert await run("prices") == 0
    out = capsys.readouterr().out
    lines = {line.split()[0]: line for line in out.splitlines() if line.startswith("claude-")}
    assert set(lines) == {
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-haiku-4-5",
    }
    assert lines["claude-opus-5-5"].split()[3:10] == ["4", "20", "0.2", "5", "8", "0.01", "—"]
    assert "> 100000 × 5" in lines["claude-haiku-5-5"]
    assert "0.125" in lines["claude-haiku-5-5"]


async def test_cli_closes_claude_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    """Команда терминала закрывает пул соединений Claude в своем цикле событий, и при
    ошибке команды тоже: после asyncio.run закрыть его уже нельзя."""
    pools: list[object] = []

    async def handler(args: object) -> None:
        pools.append(client_for(KEY, timeout=5.0)._client)
        if len(pools) == 2:
            raise AppError(409, "ai.paused")

    monkeypatch.setattr(cli, "_prices", handler)
    set_http_client_for_tests(None)
    try:
        assert await run("prices") == 0
        assert await run("prices") == 1
    finally:
        set_http_client_for_tests(None)
    assert len(pools) == 2 and all(getattr(pool, "is_closed", False) for pool in pools)
