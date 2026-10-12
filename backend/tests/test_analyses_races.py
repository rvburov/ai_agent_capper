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

from app.core.errors import AppError
from app.db.models import AgentRun, Analysis, User
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
    # need — до скольких мог стоить вызов, которому не хватило места (текст на экране)
    params = analysis.error_params or {}
    assert params["cap"] == "0,80"
    assert total + Decimal(params["need"].replace(",", ".")) > cap
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


async def test_continue_waits_for_call_of_cancelled_attempt(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    """«Отменить» во время вызова Opus и сразу «Продолжить»: пока вызов старого запуска
    идет, продолжение отвечает 409 analysis.step_running. Раньше новый запуск покупал
    оценку того же матча второй раз (3 вызова на 2 матча), а расход старого вызова не
    попадал в шаги: экран показывал меньше, чем списано."""
    fake = FakeClaude()
    gates = Gates(1)
    with _claude(fake, gates):
        member = await make_user()
        member_id = member.id
        analysis_id = await make_analysis(
            db, redis, member.user, world, ("sinner", "rune"), ("djokovic", "rublev")
        )
        maker = create_sessionmaker(engine)
        old = asyncio.create_task(execute(analysis_id, maker, redis, attempt=1))
        await gates.event(gates.entered, 1).wait()  # старая задача ждет ответа по матчу 1
        await analyses_service.cancel(db, redis, member.user, analysis_id)
        # Экран узнает об этом из поля restart и ждет не дольше retry_at
        state = await analyses_service.restart_state(
            db, member.user, await _analysis(db, analysis_id)
        )
        assert state is not None and state.reason_code == "analysis.step_running"
        assert not state.allowed and state.retry_at is not None and state.retry_at > utcnow()
        with pytest.raises(AppError) as running:
            await analyses_service.start_run(
                db, redis, member.user, analysis_id, None, enqueue=_no_queue
            )
        assert (running.value.status_code, running.value.code) == (409, "analysis.step_running")
        await db.rollback()
        gates.event(gates.released, 1).set()  # старый вызов доработал и записан в шаг
        assert await asyncio.wait_for(old, 10) == "cancelled"
        state = await analyses_service.restart_state(
            db, await db.get_one(User, member_id), await _analysis(db, analysis_id)
        )
        assert state is not None and state.allowed and state.retry_at is None
        again = await analyses_service.start_run(
            db, redis, await db.get_one(User, member_id), analysis_id, None, enqueue=_no_queue
        )
        assert again.attempt == 2
        assert await execute(analysis_id, maker, redis, attempt=2) == "done"
    # Одна оценка на матч, и сумма шагов (итог на экране) равна списанному
    assert len(fake.calls("analysis")) == 2
    assert len(await _runs(db, analysis_id, "analysis")) == 2
    analysis = await _analysis(db, analysis_id)
    assert analysis.status == "done" and analysis.attempt == 2
    steps_total = sum(Decimal(str(step["cost_usd"])) for step in analysis.checkpoint["steps"])
    assert steps_total == analysis.cost_usd
    assert analysis.result is not None
    assert Decimal(str(analysis.result["costs"]["cost_usd"])) == analysis.cost_usd


async def test_waiting_call_after_cancel_does_not_block_continue(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    """Вызов, который ждал места в потолке (свои вызовы в полете), после отмены так и не
    начался: его шаг снова ждет, и «Продолжить» доступно сразу, как только доработал
    идущий вызов. Иначе шаг «в работе» держал бы 409 analysis.step_running до 5 минут."""
    fake = FakeClaude()
    gates = Gates(2)
    with _claude(fake, gates):
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
        # Второй и третий вызовы Opus по худшему случаю ($0,355) вместе не помещаются
        await db.execute(
            update(Analysis).where(Analysis.id == analysis_id).values(cost_cap_usd=Decimal("0.75"))
        )
        await db.commit()
        maker = create_sessionmaker(engine)
        old = asyncio.create_task(execute(analysis_id, maker, redis, attempt=1))
        await gates.event(gates.entered, 2).wait()  # матч 2 в вызове, матч 3 ждет места
        await asyncio.sleep(0.2)
        analysis = await _analysis(db, analysis_id)
        claude = [step for step in analysis.checkpoint["steps"] if step["kind"] == "claude"]
        assert sorted(step["state"] for step in claude) == ["done", "running", "running"]
        assert gates.count == 2
        await analyses_service.cancel(db, redis, member.user, analysis_id)
        gates.event(gates.released, 2).set()
        assert await asyncio.wait_for(old, 10) == "cancelled"
        analysis = await _analysis(db, analysis_id)
        claude = [step for step in analysis.checkpoint["steps"] if step["kind"] == "claude"]
        assert sorted(step["state"] for step in claude) == ["done", "done", "pending"]
        await analyses_service.start_run(
            db, redis, member.user, analysis_id, None, enqueue=_no_queue
        )
        assert await execute(analysis_id, maker, redis, attempt=2) == "done"
    assert len(fake.calls("analysis")) == 3


async def test_stale_running_step_does_not_block_continue(
    db: AsyncSession, redis: Redis, make_user: UserFactory, world: dict[str, int]
) -> None:
    """Воркер умер посреди шага отмененного анализа: шаг «в работе» не держит анализ
    дольше предела шага."""
    member = await make_user()
    member_id = member.id
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    analysis = await _analysis(db, analysis_id)
    steps = [
        {**step, "state": "running"} if step["kind"] == "claude" else step
        for step in analysis.checkpoint["steps"]
    ]
    await db.execute(
        update(Analysis)
        .where(Analysis.id == analysis_id)
        .values(status="cancelled", checkpoint={**analysis.checkpoint, "steps": steps})
    )
    await db.commit()
    with pytest.raises(AppError) as running:
        await analyses_service.start_run(
            db, redis, member.user, analysis_id, None, enqueue=_no_queue
        )
    assert running.value.code == "analysis.step_running"
    await db.rollback()
    await db.execute(
        update(Analysis)
        .where(Analysis.id == analysis_id)
        .values(updated_at=utcnow() - timedelta(minutes=6))
    )
    await db.commit()
    again = await analyses_service.start_run(
        db, redis, await db.get_one(User, member_id), analysis_id, None, enqueue=_no_queue
    )
    assert again.status == "queued"


async def test_old_job_failure_after_cancel_does_not_block_continue(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    """Вызов отмененного анализа упал (529): анализ остается отмененным, шаг снова ждет,
    и «Продолжить» сразу запускает новую попытку, которая доходит до конца."""
    fake = FakeClaude()
    gates = Gates(1)
    with _claude(fake, gates):
        member = await make_user()
        analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        maker = create_sessionmaker(engine)
        fake.fail("analysis", "overloaded")
        old = asyncio.create_task(execute(analysis_id, maker, redis, attempt=1))
        await gates.event(gates.entered, 1).wait()
        await analyses_service.cancel(db, redis, member.user, analysis_id)
        gates.event(gates.released, 1).set()  # старой задаче — 529
        assert await asyncio.wait_for(old, 10) == "cancelled"
        analysis = await _analysis(db, analysis_id)
        assert analysis.status == "cancelled" and analysis.error_code is None
        assert {step["state"] for step in analysis.checkpoint["steps"]} <= {
            "done",
            "skipped",
            "pending",
        }
        await analyses_service.start_run(
            db, redis, member.user, analysis_id, None, enqueue=_no_queue
        )
        assert await asyncio.wait_for(execute(analysis_id, maker, redis, attempt=2), 10) == "done"
    analysis = await _analysis(db, analysis_id)
    assert analysis.status == "done" and analysis.error_code is None


async def test_call_finished_after_cancel_is_kept_for_continue(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    fake = FakeClaude()
    gates = Gates(1)
    with _claude(fake, gates):
        member = await make_user()
        analysis_id = await make_analysis(
            db, redis, member.user, world, ("sinner", "rune"), ("djokovic", "rublev")
        )
        maker = create_sessionmaker(engine)
        old = asyncio.create_task(execute(analysis_id, maker, redis, attempt=1))
        await gates.event(gates.entered, 1).wait()  # идет оценка матча 1
        await analyses_service.cancel(db, redis, member.user, analysis_id)
        gates.event(gates.released, 1).set()  # вызов доработал уже после отмены
        assert await asyncio.wait_for(old, 10) == "cancelled"
        analysis = await _analysis(db, analysis_id)
        claude = [step for step in analysis.checkpoint["steps"] if step["kind"] == "claude"]
        # Оплаченная оценка осталась в отмененном анализе: шаг готов, расход шагов равен
        # учету agent_runs, второй матч не начинался
        assert analysis.status == "cancelled"
        assert [step["state"] for step in claude] == ["done", "pending"]
        assert sum(Decimal(str(s["cost_usd"])) for s in analysis.checkpoint["steps"]) == (
            analysis.cost_usd
        )
        assert "assessment_id" in analysis.checkpoint["matches"][str(claude[0]["match_id"])]
        # «Продолжить» покупает только второй матч
        await analyses_service.start_run(
            db, redis, member.user, analysis_id, None, enqueue=_no_queue
        )
        assert await execute(analysis_id, maker, redis, attempt=2) == "done"
    assert len(fake.calls("analysis")) == 2
    assert len(await _runs(db, analysis_id, "analysis")) == 2


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
