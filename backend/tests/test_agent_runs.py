"""Учет вызовов Claude: usage из ответа API, стоимость по ценам моделей, худший случай
до вызова и запись в agent_runs."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from anthropic.types import Message
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.errors import ClaudeStepError
from app.agent.runs import Usage, cost_usd, price_for, record_run, usage_from, worst_case_usd
from app.db.models import AgentRun, Analysis, User
from tests.claude_mock import PRICES_FROM, price_row, seed_prices, text_message
from tests.support import UserFactory

OPUS = price_row("claude-opus-5-5")
SONNET = price_row("claude-sonnet-5-5")
HAIKU = price_row("claude-haiku-5-5")


def test_usage_from_message() -> None:
    msg = Message.model_validate(
        text_message(
            "{}",
            input_tokens=1200,
            output_tokens=6500,
            cache_creation_input_tokens=16500,
            cache_read_input_tokens=25000,
            cache_creation={"ephemeral_5m_input_tokens": 16000, "ephemeral_1h_input_tokens": 500},
            server_tool_use={"web_search_requests": 3, "web_fetch_requests": 1},
            output_tokens_details={"thinking_tokens": 4000},
        )
    )
    assert usage_from(msg) == Usage(
        input_tokens=1200,
        output_tokens=6500,
        cache_write_tokens=16500,
        cache_write_5m_tokens=16000,
        cache_write_1h_tokens=500,
        cache_read_tokens=25000,
        thinking_tokens=4000,
        web_searches=3,
        batch=False,
    )


def test_usage_without_optional_fields() -> None:
    """Старый формат usage: без разбивки записи кэша, без поиска и размышлений."""
    msg = Message.model_validate(
        text_message(
            "{}",
            cache_creation_input_tokens=700,
            cache_read_input_tokens=None,
            cache_creation=None,
            server_tool_use=None,
            output_tokens_details=None,
            service_tier="batch",
        )
    )
    usage = usage_from(msg)
    assert usage.cache_write_tokens == usage.cache_write_5m_tokens == 700
    assert usage.cache_write_1h_tokens == usage.cache_read_tokens == usage.web_searches == 0
    assert usage.thinking_tokens is None and usage.batch is True


def test_usage_sum() -> None:
    first = Usage(input_tokens=10, output_tokens=5, web_searches=1, thinking_tokens=None)
    second = Usage(input_tokens=1, cache_read_tokens=7, thinking_tokens=3, batch=True)
    total = first + second
    assert total == Usage(
        input_tokens=11,
        output_tokens=5,
        cache_read_tokens=7,
        thinking_tokens=3,
        web_searches=1,
        batch=True,
    )
    assert (Usage() + Usage()).thinking_tokens is None
    assert total.prompt_tokens == 18 and total.total_tokens == 23


def test_cost_example_from_token_economy() -> None:
    """TOKEN_ECONOMY.md: анализ на Opus 5.5 — 16,5 тыс. записи кэша × $5 + 25 тыс.
    чтения × $0,20 + 6,5 тыс. выхода × $20 = $0,2175."""
    usage = Usage(
        cache_write_tokens=16500,
        cache_write_5m_tokens=16500,
        cache_read_tokens=25000,
        output_tokens=6500,
    )
    assert cost_usd(OPUS, usage) == Decimal("0.217500")


def test_cost_every_price_and_searches() -> None:
    usage = Usage(
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        cache_write_tokens=2_000_000,
        cache_write_5m_tokens=1_000_000,
        cache_write_1h_tokens=1_000_000,
        cache_read_tokens=1_000_000,
        web_searches=3,
    )
    # 2 + 10 + 2,50 + 4 + 0,10 токенами и 3 поиска по $0,01
    assert cost_usd(SONNET, usage) == Decimal("18.630000")


def test_batch_halves_tokens_not_searches() -> None:
    usage = Usage(input_tokens=6000, output_tokens=3000, web_searches=2)
    plain = cost_usd(OPUS, usage)
    batch = cost_usd(OPUS, Usage(input_tokens=6000, output_tokens=3000, web_searches=2, batch=True))
    assert plain == Decimal("0.104000")  # 0,024 + 0,060 + 0,02
    assert batch == Decimal("0.062000")  # (0,024 + 0,060) / 2 + 0,02


def test_haiku_long_prompt_costs_five_times() -> None:
    """Haiku 5.5: весь вход больше 100 тыс. токенов — все цены токенов × 5."""
    short = Usage(input_tokens=60_000, cache_read_tokens=40_000, output_tokens=2000)
    long = Usage(input_tokens=60_001, cache_read_tokens=40_000, output_tokens=2000)
    assert short.prompt_tokens == 100_000
    # 0,006 + 0,0004 + 0,001
    assert cost_usd(HAIKU, short) == Decimal("0.007400")
    # то же × 5 (плюс один токен входа)
    assert cost_usd(HAIKU, long) == Decimal("0.037001")
    with_search = Usage(input_tokens=120_000, web_searches=1)
    assert cost_usd(HAIKU, with_search) == Decimal("0.070000")  # 0,06 + поиск без множителя


def test_cost_rounding() -> None:
    assert cost_usd(HAIKU, Usage(input_tokens=1)) == Decimal("0.000000")
    assert cost_usd(HAIKU, Usage(input_tokens=5)) == Decimal("0.000001")


def test_worst_case() -> None:
    """Худший случай: вход по цене записи кэша, весь max_tokens, все поиски."""
    # 20 тыс. × $5 + 16 тыс. × $20
    assert worst_case_usd(OPUS, input_tokens=20_000, max_tokens=16_000) == Decimal("0.420000")
    # 15 тыс. × $2,50 + 8 тыс. × $10 + 3 поиска
    assert worst_case_usd(SONNET, input_tokens=15_000, max_tokens=8000, searches=3) == Decimal(
        "0.147500"
    )
    # Haiku: короткий вход — по цене записи кэша $0,125, длинный — × 5
    assert worst_case_usd(HAIKU, input_tokens=2000, max_tokens=4096) == Decimal("0.002298")
    assert worst_case_usd(HAIKU, input_tokens=200_000, max_tokens=0) == Decimal("0.125000")
    # Округление вверх: худший случай не занижается
    assert worst_case_usd(HAIKU, input_tokens=1, max_tokens=0) == Decimal("0.000001")


async def test_price_for_picks_current_row(db: AsyncSession) -> None:
    await seed_prices(db, "claude-opus-5-5")
    newer = price_row("claude-opus-5-5", valid_from=datetime(2099, 1, 1, tzinfo=UTC))
    newer.output = Decimal("99")
    db.add(newer)
    await db.commit()
    assert (await price_for(db, "claude-opus-5-5")).valid_from == PRICES_FROM
    future = await price_for(db, "claude-opus-5-5", at=datetime(2099, 6, 1, tzinfo=UTC))
    assert future.output == Decimal("99")
    with pytest.raises(ClaudeStepError) as caught:
        await price_for(db, "claude-opus-5-5", at=datetime(2026, 9, 1, tzinfo=UTC))
    assert caught.value.code == "ai.no_price"
    assert caught.value.params == {"model": "claude-opus-5-5"}


async def _analysis(db: AsyncSession, user: User) -> Analysis:
    analysis = Analysis(user_id=user.id, input_text="x", status="modelling", key_source="admin")
    db.add(analysis)
    await db.commit()
    return analysis


FULL = Usage(
    cache_write_tokens=16500,
    cache_write_5m_tokens=16500,
    cache_read_tokens=25000,
    output_tokens=6500,
    thinking_tokens=3000,
)


async def _record(
    db: AsyncSession,
    *,
    user_id: int,
    analysis_id: int | None,
    model: str = "claude-opus-5-5",
    step: int = 0,
    usage: Usage = FULL,
    stop_reason: str = "end_turn",
) -> AgentRun:
    return await record_run(
        db,
        user_id=user_id,
        key_source="admin",
        analysis_id=analysis_id,
        kind="analysis",
        step=step,
        model=model,
        effort="medium",
        prompt_version="analysis.v1",
        schema_version="a1",
        usage=usage,
        duration_ms=41000,
        stop_reason=stop_reason,
        error=None,
        request_id="req_" + "r" * 200,
    )


async def test_record_run_writes_cost_and_adds_to_analysis(
    db: AsyncSession, make_user: UserFactory
) -> None:
    await seed_prices(db)
    member = await make_user()
    analysis = await _analysis(db, member.user)
    run = await _record(db, user_id=member.id, analysis_id=analysis.id)
    second = await _record(
        db,
        user_id=member.id,
        analysis_id=analysis.id,
        step=1,
        usage=Usage(input_tokens=1000),
        stop_reason="refusal",
    )
    await db.commit()
    stored = await db.get_one(AgentRun, run.id, populate_existing=True)
    assert stored.cost_usd == Decimal("0.217500")
    assert stored.cache_write_5m_tokens == 16500 and stored.thinking_tokens == 3000
    assert stored.request_id is not None and len(stored.request_id) == 128
    assert stored.analysis_id == analysis.id and stored.key_source == "admin"
    assert second.cost_usd == Decimal("0.004000")
    fresh = await db.get_one(Analysis, analysis.id, populate_existing=True)
    assert fresh.cost_usd == Decimal("0.221500")


async def test_record_run_without_analysis_or_price(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """Анализ удалили во время вызова — строка пишется без analysis_id. Нет цены модели —
    ai.no_price, строка не пишется."""
    await seed_prices(db, "claude-opus-5-5")
    member = await make_user()
    analysis = await _analysis(db, member.user)
    gone = analysis.id
    await db.execute(delete(Analysis).where(Analysis.id == gone))
    await db.commit()
    run = await _record(db, user_id=member.id, analysis_id=gone)
    await db.commit()
    assert run.analysis_id is None and run.cost_usd == Decimal("0.217500")
    with pytest.raises(ClaudeStepError) as caught:
        await _record(db, user_id=member.id, analysis_id=None, model="claude-sonnet-5-5")
    assert caught.value.code == "ai.no_price"
    await db.rollback()
    assert len(list(await db.scalars(select(AgentRun)))) == 1
