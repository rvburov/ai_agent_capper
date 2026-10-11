"""Выполнение анализа при одновременных событиях: параллельные вызовы Opus и потолок
анализа, лимиты поиска при просьбе record_news и параллельных анализах, отмена и
перезапуск при живой задаче старого запуска, снятие задачи посреди вызова, общий предел
анализа, перезапуск после сбоя новостей, уборщик зависшего разбора."""

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import AgentRun, Analysis
from app.db.session import create_sessionmaker
from app.services import analyses as analyses_service
from app.services.analysis_run import execute, reap_stuck
from app.services.progress import stream_key
from app.services.sessions import utcnow
from tests.analysis_helpers import (
    Gate,
    _no_queue,
    install,
    install_gated,
    make_analysis,
    run,
    seed_world,
    set_admin_key,
)
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.support import UserFactory


@contextmanager
def _claude(fake: FakeClaude, gate: Gate | None) -> Iterator[FakeClaude]:
    """Все вызовы Claude теста — в fake (через ворота gate, если они есть)."""
    yield from (install(fake) if gate is None else install_gated(fake, gate))


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


async def _runs(db: AsyncSession, analysis_id: int, kind: str | None = None) -> list[AgentRun]:
    stmt = select(AgentRun).where(AgentRun.analysis_id == analysis_id).order_by(AgentRun.id)
    if kind is not None:
        stmt = stmt.where(AgentRun.kind == kind)
    return list(await db.scalars(stmt.execution_options(populate_existing=True)))


async def _analysis(db: AsyncSession, analysis_id: int) -> Analysis:
    return await db.get_one(Analysis, analysis_id, populate_existing=True)


async def _searches(db: AsyncSession, analysis_id: int | None = None) -> int:
    stmt = select(func.coalesce(func.sum(AgentRun.web_searches), 0)).where(AgentRun.kind == "news")
    if analysis_id is not None:
        stmt = stmt.where(AgentRun.analysis_id == analysis_id)
    return int(await db.scalar(stmt) or 0)


class Gates:
    """Ворота вызовов анализа: номер вызова Opus → событие «вошел» и «отпустить»."""

    def __init__(self, *blocked: int) -> None:
        self.count = 0
        self.blocked = set(blocked)
        self.entered: dict[int, asyncio.Event] = {}
        self.released: dict[int, asyncio.Event] = {}

    def event(self, table: dict[int, asyncio.Event], number: int) -> asyncio.Event:
        return table.setdefault(number, asyncio.Event())

    async def __call__(self, step: str, body: dict[str, Any], number: int) -> None:
        if step != "analysis":
            return
        self.count += 1
        current = self.count
        self.event(self.entered, current).set()
        if current in self.blocked:
            await self.event(self.released, current).wait()


def _pause(step: str, seconds: float) -> Any:
    async def gate(current: str, body: dict[str, Any], number: int) -> None:
        if current == step:
            await asyncio.sleep(seconds)

    return gate


# --- потолок анализа при параллельных вызовах ---


class LongAnswers(FakeClaude):
    """Оценка с длинным выходом (много размышлений): каждый вызов Opus дорогой."""

    def _analysis(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        msg = super()._analysis(body, model, error)
        msg["usage"]["output_tokens"] = 15000
        return msg


async def test_parallel_calls_stay_under_analysis_cap(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    with _claude(LongAnswers(), _pause("analysis", 0.3)):
        member = await make_user()
        analysis_id = await make_analysis(
            db,
            redis,
            member.user,
            world,
            ("sinner", "rune"),
            ("djokovic", "rublev"),
            ("alcaraz", "medvedev"),
        )
        cap = Decimal("0.80")
        await db.execute(
            update(Analysis).where(Analysis.id == analysis_id).values(cost_cap_usd=cap)
        )
        await db.commit()
        assert await run(engine, redis, analysis_id) == "failed"
    analysis = await _analysis(db, analysis_id)
    runs = await _runs(db, analysis_id)
    total = sum((row.cost_usd for row in runs), Decimal(0))
    # Два параллельных вызова видят худший случай друг друга: второй не допущен, а
    # расход не выходит за потолок (раньше оба проходили и сумма была $1,03 при $0,80)
    assert analysis.error_code == "ai.analysis_cap"
    assert total <= cap and analysis.cost_usd <= cap
    assert len([row for row in runs if row.kind == "analysis"]) == 2
    assert analysis.budget_reserved_usd == 0


# --- лимиты поиска ---


class FullSearch(FakeClaude):
    """Модель тратит все max_uses запроса."""

    def _news(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        msg = super()._news(body, model, error)
        uses = int(body["tools"][0]["max_uses"])
        msg["usage"]["server_tool_use"] = {"web_search_requests": uses, "web_fetch_requests": 0}
        return msg


class GreedySearch(FullSearch):
    """Модель тратит все max_uses запроса, а record_news вызывает только после просьбы."""

    def _news(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        asked = len(body["messages"]) > 1
        return super()._news(body, model, error if asked else "no_record")


async def test_search_limit_holds_with_ask_for_record(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    fake = GreedySearch()
    with _claude(fake, None):
        member = await make_user()
        analysis_id = await make_analysis(
            db,
            redis,
            member.user,
            world,
            ("sinner", "rune"),
            ("djokovic", "rublev"),
            ("alcaraz", "medvedev"),
        )
        assert await run(engine, redis, analysis_id) == "done"
    # Просьба вызвать record_news — новый запрос со своими max_uses: он допускается, только
    # если весь его max_uses укладывается в лимит анализа (9)
    assert await _searches(db, analysis_id) == 9
    assert [body["tools"][0]["max_uses"] for body in fake.calls("news")] == [3, 3, 3]
    analysis = await _analysis(db, analysis_id)
    assert analysis.result is not None
    keys = [warning["key"] for warning in analysis.result["warnings"]]
    assert keys.count("analysis.warnings.news_limit") == 2


async def test_daily_search_limit_with_parallel_analyses(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    with _claude(FullSearch(), _pause("news", 0.3)):
        member = await make_user()
        # Сегодня уже 28 поисков: на два параллельных анализа остается 2
        db.add(
            AgentRun(
                user_id=member.user.id,
                key_source="admin",
                kind="news",
                step=1,
                model="claude-sonnet-5-5",
                web_searches=28,
                cost_usd=Decimal("0.28"),
                created_at=datetime.now(UTC),
            )
        )
        await db.commit()
        first = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        second = await make_analysis(db, redis, member.user, world, ("djokovic", "rublev"))
        results = await asyncio.gather(run(engine, redis, first), run(engine, redis, second))
    assert list(results) == ["done", "done"]
    # Оба анализа прочли остаток дня (2) одновременно, но резерв поисков в Redis пустил
    # только один запрос с max_uses = 2 (раньше оба: 32 поиска при лимите 30)
    assert await _searches(db) == 30
    steps = []
    for analysis_id in (first, second):
        analysis = await _analysis(db, analysis_id)
        steps.append(next(s for s in analysis.checkpoint["steps"] if s["kind"] == "news"))
    assert sorted(step["detail_key"] for step in steps) == [
        "analysis.steps.news_found",
        "analysis.steps.news_limit",
    ]


# --- перезапуск при живой задаче старого запуска ---


async def test_old_job_stops_after_cancel_and_restart(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    fake = FakeClaude()
    gates = Gates(1, 3)
    with _claude(fake, gates):
        member = await make_user()
        analysis_id = await make_analysis(
            db, redis, member.user, world, ("sinner", "rune"), ("djokovic", "rublev")
        )
        maker = create_sessionmaker(engine)
        old = asyncio.create_task(execute(analysis_id, maker, redis, attempt=1))
        await gates.event(gates.entered, 1).wait()  # старая задача ждет ответа по матчу 1
        await analyses_service.cancel(db, redis, member.user, analysis_id)
        again = await analyses_service.start_run(
            db, redis, member.user, analysis_id, None, enqueue=_no_queue
        )
        assert again.attempt == 2
        new = asyncio.create_task(execute(analysis_id, maker, redis, attempt=2))
        await gates.event(gates.entered, 3).wait()  # новая: матч 1 готов, ждет матч 2
        gates.event(gates.released, 1).set()  # старая получила ответ
        old_status = await asyncio.wait_for(old, 10)
        gates.event(gates.released, 3).set()
        new_status = await asyncio.wait_for(new, 10)
    # Старая задача учла свой вызов и остановилась: ни новых вызовов, ни записи статуса
    assert old_status == "llm_review" and new_status == "done"
    assert len(fake.calls("analysis")) == 3
    assert len(await _runs(db, analysis_id, "analysis")) == 3
    analysis = await _analysis(db, analysis_id)
    assert analysis.status == "done" and analysis.attempt == 2


async def test_old_job_failure_does_not_fail_new_attempt(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    fake = FakeClaude()
    gates = Gates(1, 2)
    with _claude(fake, gates):
        member = await make_user()
        analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        maker = create_sessionmaker(engine)
        fake.fail("analysis", "overloaded")
        old = asyncio.create_task(execute(analysis_id, maker, redis, attempt=1))
        await gates.event(gates.entered, 1).wait()
        await analyses_service.cancel(db, redis, member.user, analysis_id)
        await analyses_service.start_run(
            db, redis, member.user, analysis_id, None, enqueue=_no_queue
        )
        new = asyncio.create_task(execute(analysis_id, maker, redis, attempt=2))
        await gates.event(gates.entered, 2).wait()
        gates.event(gates.released, 1).set()  # старой задаче — 529
        await asyncio.wait_for(old, 10)
        gates.event(gates.released, 2).set()
        assert await asyncio.wait_for(new, 10) == "done"
    analysis = await _analysis(db, analysis_id)
    assert analysis.status == "done" and analysis.error_code is None


# --- снятие задачи и общий предел ---


async def test_cancelled_job_fails_at_once_and_records_call(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    gates = Gates(1)
    with _claude(FakeClaude(), gates):
        member = await make_user()
        analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        # Как предел задачи arq: wait_for снимает задачу посреди вызова Opus
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(
                execute(analysis_id, create_sessionmaker(engine), redis), timeout=1.0
            )
    analysis = await _analysis(db, analysis_id)
    assert analysis.status == "failed" and analysis.error_code == "analysis.worker_lost"
    assert analysis.failed_step == "claude"
    assert analysis.budget_reserved_usd == 0
    # Прерванный вызов в учете: без строки его стоимость пропала бы из расхода
    assert [row.error for row in await _runs(db, analysis_id, "analysis")] == ["cancelled"]
    last = await redis.xrevrange(stream_key(analysis_id), count=1)
    assert '"failed"' in last[0][1]["data"]


async def test_run_deadline_fails_with_timeout(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    with _claude(FakeClaude(), _pause("analysis", 5.0)):
        member = await make_user()
        analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        status = await execute(analysis_id, create_sessionmaker(engine), redis, deadline_s=1.0)
    assert status == "failed"
    analysis = await _analysis(db, analysis_id)
    assert analysis.error_code == "ai.timeout" and analysis.budget_reserved_usd == 0
    assert [row.error for row in await _runs(db, analysis_id, "analysis")] == ["cancelled"]


# --- перезапуск после сбоя новостей ---


async def test_restart_does_not_buy_failed_news_again(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    fake = FakeClaude()
    with _claude(fake, None):
        member = await make_user()
        analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        fake.fail("news", "server").fail("analysis", "overloaded")
        assert await run(engine, redis, analysis_id) == "failed"
        await analyses_service.start_run(
            db, redis, member.user, analysis_id, None, enqueue=_no_queue
        )
        assert await run(engine, redis, analysis_id) == "done"
    # Досье собрано без новостей и не пересобирается: повторный поиск был бы оплачен,
    # но в анализ не попал бы
    assert len(fake.calls("news")) == 1
    assert len(await _runs(db, analysis_id, "news")) == 1
    analysis = await _analysis(db, analysis_id)
    news = next(step for step in analysis.checkpoint["steps"] if step["kind"] == "news")
    assert news["detail_key"] == "analysis.steps.news_failed"


# --- уборщик ---


async def test_reaper_fails_stuck_parse(
    db: AsyncSession, engine: AsyncEngine, redis: Redis, make_user: UserFactory
) -> None:
    member = await make_user()
    stuck = Analysis(user_id=member.user.id, input_text="x", input_kind="text", status="parsing")
    db.add(stuck)
    await db.commit()
    await db.execute(
        update(Analysis)
        .where(Analysis.id == stuck.id)
        .values(updated_at=utcnow() - timedelta(minutes=20))
    )
    await db.commit()
    assert await reap_stuck(create_sessionmaker(engine), redis) == [stuck.id]
    analysis = await _analysis(db, stuck.id)
    assert analysis.status == "failed" and analysis.failed_step == "parse"
    assert analysis.error_code == "analysis.worker_lost"
