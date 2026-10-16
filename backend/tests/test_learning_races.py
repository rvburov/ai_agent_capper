"""Деньги на Claude и гонки этапа 5, волна 2 (замечания M1–M4, M6, m1 проверки backend):
бюджет пакетов разборов и быстрых проверок под одной блокировкой, одна проверка урока на
два одновременных запроса, сбой задачи проверки, предел предложений урока при
параллельных запросах, пакет, созданный у Anthropic до сбоя воркера."""

import asyncio
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.agent import batches
from app.agent.errors import ClaudeStepError
from app.core.errors import AppError
from app.db.models import AgentRun, AppSettings, BatchJob, EvalRun, Lesson, ModelPrice, Postmortem
from app.db.session import create_sessionmaker
from app.ml.lesson_scope import validate_scope
from app.services import ai_access, check_runs, lesson_quick, postmortems, smoke_eval
from app.workers.jobs import collect_all
from tests.analysis_helpers import install, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import admin_signed_in, signed_in
from tests.learning_helpers import MiniArchive, mini_archive, own_leg, reviews_from
from tests.support import ClientFactory, LoginFn, UserFactory

QUICK_SCOPES = [
    {
        "direction": "lower",
        "conditions": [
            {"feature": "round", "op": "in", "values": ["SF", "F"]},
            {"feature": "role", "op": "eq", "values": ["favorite"]},
        ],
    },
    {
        "direction": "lower",
        "conditions": [
            {"feature": "role", "op": "eq", "values": ["underdog"]},
            {"feature": "surface", "op": "eq", "values": ["clay"]},
        ],
    },
]


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> MiniArchive:
    found = await mini_archive(db, engine)
    await reviews_from(db)
    await set_admin_key(db)
    await seed_prices(db)
    return found


# --- M1: общий бюджет и пакеты разборов ---


async def test_concurrent_postmortem_batches_fit_shared_budget(
    db: AsyncSession,
    engine: AsyncEngine,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Две задачи (cron и команда терминала) одновременно: остаток и строка пакета — под
    одной блокировкой, второй пакет в остаток не помещается и ждет."""
    member = await make_user()
    await own_leg(db, member.id, world.m2, result="loss")
    await own_leg(db, member.id, world.m3, result="loss")
    await reviews_from(db, postmortem_batch_max=1)
    maker = create_sessionmaker(engine)
    # Худший случай одного пакета — пробной отправкой, потом ее убираем
    async with maker() as probe:
        one = Decimal(str((await postmortems.submit(probe, force=True))["worst_usd"]))
    async with maker() as fix:
        job = await fix.scalar(select(BatchJob))
        assert job is not None
        await postmortems.requeue_job(fix, job.id)
        await fix.execute(update(BatchJob).values(status="failed"))
        await fix.commit()
    budget = (one * Decimal("1.5")).quantize(Decimal("0.01"))
    await db.execute(update(AppSettings).values(monthly_budget_usd=budget))
    await db.commit()
    assert await ai_access.shared_budget_left(db) == budget

    # Окно между чтением остатка и commit строки пакета — шире
    real_open = batches.open_job

    async def slow_open(*args: Any, **kwargs: Any) -> BatchJob:
        job = await real_open(*args, **kwargs)
        await asyncio.sleep(0.3)
        return job

    monkeypatch.setattr(batches, "open_job", slow_open)
    async with maker() as s1, maker() as s2:
        results = await asyncio.gather(
            postmortems.submit(s1, force=True), postmortems.submit(s2, force=True)
        )
    assert sorted(int(item.get("sent", 0)) for item in results) == [0, 1]
    assert sorted(int(item.get("waiting", 0)) for item in results) == [0, 1]
    async with maker() as check:
        reserved = await batches.reserved_usd(check, ("postmortem",))
        sent = await check.scalar(
            select(func.count()).select_from(BatchJob).where(BatchJob.status == "submitted")
        )
    assert sent == 1 and reserved <= budget


# --- M2, M3, M4: быстрая проверка урока ---


async def _quick_world(
    db: AsyncSession, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch, count: int = 1
) -> list[Lesson]:
    await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    since = datetime.now(UTC).date() - timedelta(days=400)
    monkeypatch.setattr(smoke_eval, "SAFE_SINCE", {})
    monkeypatch.setattr(smoke_eval, "DEFAULT_SAFE_SINCE", since)
    lessons = []
    for index, scope in enumerate(QUICK_SCOPES[:count], start=1):
        lesson = Lesson(
            user_id=None,
            code=f"L-00{index}",
            text="Проверяемое правило урока",
            scope=validate_scope(scope).to_json(),
            kind="numeric",
            status="ready",
            origin="manual",
            metrics={},
            effect_shrunk=-0.03,
        )
        db.add(lesson)
        lessons.append(lesson)
    await db.commit()
    return lessons


async def _no_queue(run_id: int) -> None:
    return None


async def test_quick_check_reserves_eval_budget_at_start_and_send(
    db: AsyncSession,
    engine: AsyncEngine,
    fake: FakeClaude,
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Запуск пишет резерв худшего случая (pending): вторая проверка, которой не хватает
    остатка, получает отказ сразу. Две задачи отправки одновременно: остаток и строка
    пакета под блокировкой бюджета — уходит одна, резерв не больше бюджета."""
    lesson_ids = [lesson.id for lesson in await _quick_world(db, engine, monkeypatch, count=2)]
    admin = (await make_user(role="admin")).user
    plan = await lesson_quick.preview(db, lesson_ids[0])
    budget = (plan.worst_usd * Decimal("1.5")).quantize(Decimal("0.01"))
    await db.execute(update(AppSettings).values(eval_budget_usd=budget))
    await db.commit()

    first = await lesson_quick.start(db, admin, lesson_ids[0], ip=None, enqueue=_no_queue)
    assert first.status == "pending" and first.reserved_usd == plan.worst_usd
    with pytest.raises(AppError) as refused:
        await lesson_quick.start(db, admin, lesson_ids[1], ip=None, enqueue=_no_queue)
    assert refused.value.code == "lesson.quick_check_budget"
    await db.rollback()
    await db.refresh(admin)

    # Бюджет большой — обе запущены; перед отправкой бюджет урезан: уйдет одна
    await db.execute(update(EvalRun).values(status="failed"))
    await db.execute(update(AppSettings).values(eval_budget_usd=Decimal("500")))
    await db.commit()
    run_ids: list[int] = []
    for lesson_id in lesson_ids:
        await lesson_quick.start(db, admin, lesson_id, ip=None, enqueue=_no_queue)
        found = await db.scalar(select(EvalRun.id).order_by(EvalRun.id.desc()))
        assert found is not None
        run_ids.append(found)
    await db.execute(update(AppSettings).values(eval_budget_usd=budget))
    await db.commit()
    maker = create_sessionmaker(engine)
    async with maker() as s1, maker() as s2:
        statuses = await asyncio.gather(
            lesson_quick.prepare_and_submit(s1, run_ids[0]),
            lesson_quick.prepare_and_submit(s2, run_ids[1]),
        )
    assert sorted(statuses) == ["failed", "running"]
    async with maker() as check:
        left = await check_runs.eval_budget(check)
    assert left.reserved_usd <= left.budget_usd


async def test_double_quick_check_post_starts_one_run(
    db: AsyncSession,
    engine: AsyncEngine,
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    [lesson] = await _quick_world(db, engine, monkeypatch)
    admin = await admin_signed_in(make_client, make_user, login)
    queued: list[int] = []

    async def enqueue(run_id: int) -> None:
        queued.append(run_id)

    monkeypatch.setattr(lesson_quick, "enqueue_quick", enqueue)
    answers = await asyncio.gather(
        *[admin.client.post(f"/api/lessons/{lesson.id}/quick-check") for _ in range(2)]
    )
    assert sorted(answer.status_code for answer in answers) == [202, 409]
    assert await db.scalar(select(func.count()).select_from(EvalRun)) == 1
    assert len(queued) == 1


async def test_quick_check_worker_failure_and_stuck_run(
    db: AsyncSession,
    engine: AsyncEngine,
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Исключение в задаче до отправки — прогон failed, запуск снова возможен; повтор
    задачи ничего не делает. Задача потерялась — прогон без пакета старше часа уборщик
    ставит failed (not_sent)."""
    [lesson] = await _quick_world(db, engine, monkeypatch)
    lesson_id = lesson.id
    admin = await admin_signed_in(make_client, make_user, login)
    monkeypatch.setattr(lesson_quick, "enqueue_quick", _no_queue)
    assert (await admin.client.post(f"/api/lessons/{lesson_id}/quick-check")).status_code == 202
    run_id = await db.scalar(select(EvalRun.id))
    assert run_id is not None

    async def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("dossier failed")

    real_prepare = smoke_eval.prepare_events
    monkeypatch.setattr(smoke_eval, "prepare_events", boom)
    with pytest.raises(RuntimeError):
        await lesson_quick.prepare_and_submit(db, run_id)
    run = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert run.status == "failed" and run.metrics["error"] == "error"
    assert await lesson_quick.prepare_and_submit(db, run_id) == "failed"
    preview = (await admin.client.get(f"/api/lessons/{lesson_id}/quick-check")).json()
    assert preview["can_run"] and preview["reason"] is None

    # Вторая проверка: задача потерялась (воркер перезапущен) — уборщик
    monkeypatch.setattr(smoke_eval, "prepare_events", real_prepare)
    assert (await admin.client.post(f"/api/lessons/{lesson_id}/quick-check")).status_code == 202
    stuck_id = await db.scalar(select(EvalRun.id).order_by(EvalRun.id.desc()))
    assert stuck_id is not None and stuck_id != run_id
    await db.execute(
        update(EvalRun)
        .where(EvalRun.id == stuck_id)
        .values(created_at=datetime.now(UTC) - timedelta(hours=2))
    )
    await db.commit()
    # Зависший прогон запуск не блокирует и в резерве не держится
    preview = (await admin.client.get(f"/api/lessons/{lesson_id}/quick-check")).json()
    assert preview["reason"] is None and Decimal(str(preview["reserved_usd"])) == 0
    summary = await collect_all(db)
    assert summary["quick_reaped"] == 1
    stuck = await db.get_one(EvalRun, stuck_id, populate_existing=True)
    assert stuck.status == "failed" and stuck.metrics["error"] == "not_sent"
    saved = await db.get_one(Lesson, lesson_id, populate_existing=True)
    assert saved.metrics["quick"]["status"] == "failed"


# --- M6: предел предложений урока ---


async def test_member_proposals_limit_under_parallel_requests(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """20 одновременных предложений участника: создано ровно 5, остальным 429; ни одного
    500 и ожидания пула (подсчет случаев — в той же сессии, после commit урока)."""
    member = await signed_in(make_client, make_user, login)

    def body(value: int) -> dict[str, object]:
        return {
            "text": "Параллельное предложение урока",
            "scope": {
                "direction": "lower",
                "conditions": [
                    {"feature": "role", "op": "eq", "values": ["favorite"]},
                    {"feature": "rest_days", "op": "ge", "value": value},
                ],
            },
        }

    started = time.monotonic()
    answers = await asyncio.gather(
        *[member.client.post("/api/lessons", json=body(value)) for value in range(1, 21)]
    )
    elapsed = time.monotonic() - started
    codes = sorted(answer.status_code for answer in answers)
    assert codes == [201] * 5 + [429] * 15, codes
    created = await db.scalar(
        select(func.count()).select_from(Lesson).where(Lesson.created_by == member.id)
    )
    assert created == 5
    assert elapsed < 20


# --- m1: пакет создан, а ответ не дошел ---


async def test_batch_created_before_worker_crash_is_found_not_resent(
    db: AsyncSession,
    engine: AsyncEngine,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Воркер остановлен сразу после создания пакета, до commit submitted: через час
    уборка находит пакет у Anthropic по списку и custom_id и собирает его; второй пакет не
    уходит, расход записан в agent_runs."""
    member = await make_user()
    await own_leg(db, member.id, world.m3, result="loss")
    real = batches.create_batch

    async def create_then_die(client: Any, requests: Any) -> Any:
        await real(client, requests)
        raise asyncio.CancelledError()

    monkeypatch.setattr(batches, "create_batch", create_then_die)
    maker = create_sessionmaker(engine)
    with pytest.raises(asyncio.CancelledError):
        async with maker() as session:
            await postmortems.submit(session, force=True)
    monkeypatch.setattr(batches, "create_batch", real)
    async with maker() as session:
        await session.execute(
            update(BatchJob).values(created_at=datetime.now(UTC) - timedelta(hours=2))
        )
        await session.commit()
        summary = await collect_all(session)
        assert summary["attached"] == 1 and summary["collected"] == 1
        assert (await postmortems.submit(session, force=True))["sent"] == 0
        runs = await session.scalar(select(func.count()).select_from(AgentRun))
        jobs = list(await session.scalars(select(BatchJob)))
        pm = await session.scalar(select(Postmortem))
    assert len(fake.batches) == 1 and runs == 1
    assert [(job.status, job.batch_id) for job in jobs] == [("collected", "msgbatch_fake1")]
    assert pm is not None and pm.status == "done"


async def test_batch_create_without_sdk_retries(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Сбой 5xx на создании: один запрос (повторов SDK нет), пакета нет в списке — строка
    pending с резервом, разбор ждет; через час уборка ставит failed, разбор снова в
    очереди и уходит одним пакетом. Ответ потерян, а пакет создан — находится сразу."""
    member = await make_user()
    await own_leg(db, member.id, world.m3, result="loss")
    fake.fail("batch_create", "server", times=2)
    summary = await postmortems.submit(db, force=True)
    assert summary["sent"] == 0 and summary["error"] == "ai.unavailable"
    assert [switch.times for switch in fake.switches] == [1]
    job = await db.scalar(select(BatchJob))
    assert job is not None and job.status == "pending"
    assert await batches.reserved_usd(db, ("postmortem",)) == job.worst_usd
    fake.switches.clear()
    await db.execute(update(BatchJob).values(created_at=datetime.now(UTC) - timedelta(hours=2)))
    await db.commit()
    assert (await collect_all(db))["failed_sends"] == 1
    pm = await db.scalar(select(Postmortem).execution_options(populate_existing=True))
    assert pm is not None and pm.status == "queued"

    # Тайм-аут после создания: пакет найден по списку сразу
    real = batches.create_batch

    async def created_then_timeout(client: Any, requests: Any) -> Any:
        await real(client, requests)
        raise ClaudeStepError("ai.timeout", detail="timeout")

    monkeypatch.setattr(batches, "create_batch", created_then_timeout)
    sent = await postmortems.submit(db, force=True)
    assert sent["sent"] == 1 and sent["batch_id"] == "msgbatch_fake1"
    assert len(fake.batches) == 1


def test_batch_worst_case_counts_long_input_tier() -> None:
    """m4: худший случай запроса пакета — с надбавкой второй ступени цены, как у обычного
    вызова (runs.worst_case_usd)."""
    price = ModelPrice(
        model="claude-haiku-5-5",
        input=Decimal("1"),
        output=Decimal("5"),
        cache_write_5m=Decimal("1.25"),
        cache_write_1h=Decimal("2"),
        cache_read=Decimal("0.1"),
        search_price=Decimal("0.01"),
        long_input_threshold=100_000,
        long_multiplier=Decimal("5"),
    )
    short = batches.request_worst_usd(price, input_tokens=100_000, max_tokens=1000)
    long = batches.request_worst_usd(price, input_tokens=100_001, max_tokens=1000)
    assert short == (Decimal(100_000) * Decimal("1.25") + 1000 * 5) / 1_000_000 / 2
    assert long > short * 4
    estimate = batches.request_estimate_usd(price, input_tokens=200_000, output_tokens=100)
    assert estimate == (Decimal(200_000) + 500) / 1_000_000 / 2 * 5
