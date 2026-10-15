"""Замороженный eval-набор и прогон версий инструкций (этап 5, волна 3) на поддельном
Claude: заморозка (доля трудных, sha256, повтор — отказ), прогон пакетами по 100 событий
с досье на день матча (строго до него), бюджет проверок под блокировкой, повтор активной
версии (порог шума), кандидат с уроком в отдельном блоке system, сравнение по правилу и
«кандидат после прогона остается кандидатом», включение только администратором и откат."""

import asyncio
from collections.abc import Iterator
from datetime import UTC, date, datetime, time
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    AppSettings,
    BatchJob,
    Dossier,
    EvalComparison,
    EvalRun,
    EvalSet,
    EvalSetItem,
    Lesson,
    Match,
    Notification,
    Prediction,
    StrategyVersion,
    Tournament,
    User,
)
from app.db.session import create_sessionmaker
from app.ml.elo import rebuild_ratings
from app.schemas.learning import EvalRunIn, EvalSetIn
from app.services import check_runs, eval_runs, eval_sets, smoke_eval, strategy_versions
from app.workers.jobs import advance_eval_runs, collect_all
from tests.analysis_helpers import install, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.ml_world import make_world, store_world
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory

SINCE = date(2025, 1, 1)


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(
    db: AsyncSession, engine: AsyncEngine, monkeypatch: pytest.MonkeyPatch
) -> dict[int, int]:
    """Архив 2024–2025 основного тура с кэфами; «срез знаний модели» — 1 января 2025."""
    monkeypatch.setattr(eval_sets, "EVAL_SINCE", SINCE)
    monkeypatch.setattr(smoke_eval, "SAFE_SINCE", {})
    monkeypatch.setattr(smoke_eval, "DEFAULT_SAFE_SINCE", SINCE)
    data = make_world(
        players=60,
        years=range(2024, 2026),
        tournaments_per_year=16,
        draw=32,
        seed=3,
        dated_from=2024,
    )
    ids = await store_world(db, data)
    await rebuild_ratings(db_factory=create_sessionmaker(engine))
    await db.execute(
        update(AppSettings).values(agent_config={"eval_set_size": 200, "eval_batch_size": 100})
    )
    await db.commit()
    return ids


async def _ready(db: AsyncSession) -> None:
    await set_admin_key(db)
    await seed_prices(db)


async def _lesson(db: AsyncSession, code: str = "L-001") -> Lesson:
    lesson = Lesson(
        user_id=None,
        code=code,
        text="Фаворит после пяти сетов за двое суток переоценен",
        kind="numeric",
        status="confirmed",
        effect_shrunk=-0.03,
        origin="manual",
        metrics={},
    )
    db.add(lesson)
    await db.commit()
    return lesson


async def _finish(db: AsyncSession, run_id: int) -> EvalRun:
    """Пакеты прогона до конца: отправка, сбор, следующий пакет."""
    for _ in range(6):
        run = await db.get_one(EvalRun, run_id, populate_existing=True)
        if run.status in ("done", "failed"):
            return run
        if run.status == "pending":
            await eval_runs.advance(db, run_id)
        await collect_all(db)
        await advance_eval_runs(db)
    return await db.get_one(EvalRun, run_id, populate_existing=True)


# --- набор ---


async def test_freeze_set_hard_share_sha_and_refusals(
    db: AsyncSession,
    world: dict[int, int],
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    listing = (await admin.client.get("/api/admin/eval/sets")).json()
    assert listing["items"] == [] and listing["since"] == SINCE.isoformat()
    assert listing["available"] >= 250 and listing["size"] == 200

    created = await admin.client.post("/api/admin/eval/sets", json={"code": "eval-test"})
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["n_events"] == 200 and body["since"] == SINCE.isoformat()
    assert 0.15 <= body["hard_share"] <= 0.2 and body["hard"] == 36
    assert body["with_news"] is False and body["market_n"] == 200
    assert 0.3 < body["market_log_loss"] < 0.7
    eval_set = await db.scalar(select(EvalSet).where(EvalSet.code == "eval-test"))
    assert eval_set is not None
    items = list(
        await db.scalars(select(EvalSetItem).where(EvalSetItem.eval_set_id == eval_set.id))
    )
    assert len(items) == 200 and sum(item.hard for item in items) == 36
    assert eval_set.sha256 == eval_sets.list_sha256([(item.match_id, item.hard) for item in items])
    assert all(item.dossier_id is None and item.with_news is False for item in items)
    # Все события — сыгранные матчи после «среза знаний»
    days = await db.scalars(
        select(func.coalesce(Match.match_date, Tournament.start_date))
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.id.in_([item.match_id for item in items]))
    )
    assert min(days) >= SINCE

    # Повторная заморозка того же кода — отказ, список не меняется
    again = await admin.client.post("/api/admin/eval/sets", json={"code": "eval-test"})
    assert again.status_code == 409 and error_code(again) == "eval.set_exists"
    seen = await admin.client.post(
        "/api/admin/eval/sets", json={"code": "eval-old", "since": "2024-06-01"}
    )
    assert seen.status_code == 422 and error_code(seen) == "eval.set_seen"
    small = await admin.client.post(
        "/api/admin/eval/sets", json={"code": "eval-late", "since": "2025-12-20"}
    )
    assert small.status_code == 422 and error_code(small) == "eval.set_too_small"

    # Тот же код на тех же данных выбирает те же события (детерминизм)
    pool = await eval_sets.candidates(db, since=SINCE, until=date(2026, 1, 1))
    picked = eval_sets.choose(pool, code="eval-test", size=200, hard_share=0.18)
    assert eval_sets.list_sha256([(item.match_id, item.hard) for item in picked]) == (
        eval_set.sha256
    )


# --- прогон ---


async def test_eval_runs_compare_candidate_and_activation(
    db: AsyncSession,
    world: dict[int, int],
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _ready(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    frozen = await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    v3 = await strategy_versions.ensure_shared_active(db)
    await db.commit()
    v3_id = v3.id

    plan = (await admin.client.get(f"/api/admin/eval/runs/preview?version_id={v3_id}")).json()
    assert (plan["events"], plan["chunks"], plan["batch_size"], plan["repeat_no"]) == (
        200,
        2,
        100,
        1,
    )
    assert plan["can_run"] is True and plan["max_tokens"] == 8000
    assert 0 < plan["worst_chunk_usd"] < plan["worst_usd"]
    assert plan["worst_chunk_usd"] <= plan["budget"]["left_usd"]
    # Месяц первого набора — бюджет проверок $30 (Р25), со следующего — настройка $25
    assert plan["budget"]["first_month"] is True
    assert (plan["budget"]["budget_usd"], plan["budget"]["next_usd"]) == (30.0, 25.0)

    queued: list[int] = []

    async def enqueue(run_id: int) -> None:
        queued.append(run_id)

    monkeypatch.setattr(eval_runs, "enqueue_run", enqueue)
    no_code = await admin.client.post("/api/admin/eval/runs", json={"version_id": v3_id})
    assert no_code.status_code == 403 and error_code(no_code) == "admin.totp_required"
    started = await admin.client.post(
        "/api/admin/eval/runs",
        json={"version_id": v3_id, "totp_code": await totp_code(admin.user)},
    )
    assert started.status_code == 202, started.text
    run_id = started.json()["id"]
    assert queued == [run_id] and started.json()["status"] == "pending"
    busy = (await admin.client.get(f"/api/admin/eval/runs/preview?version_id={v3_id}")).json()
    assert busy["reason"] == "eval.run_in_progress" and busy["running_run_id"] == run_id

    assert await eval_runs.advance(db, run_id) == "running"
    [batch] = fake.batches.values()
    assert len(batch["requests"]) == 100
    first = batch["requests"][0]
    assert first["custom_id"].startswith(f"er{run_id}-c0-m")
    params = first["params"]
    assert params["max_tokens"] == 8000 and len(params["system"]) == 1
    assert params["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"}
    # Резерв худшего случая пакета — в бюджете проверок
    job = await db.scalar(select(BatchJob).where(BatchJob.kind == "eval"))
    assert job is not None and job.params["eval_kind"] == "eval"
    budget = await check_runs.eval_budget(db)
    assert budget.reserved_usd == job.worst_usd
    # Досье — на начало дня матча: данных этого дня в нем нет
    dossiers = list(
        await db.execute(
            select(
                Dossier.as_of,
                Dossier.content,
                func.coalesce(Match.match_date, Tournament.start_date),
            )
            .join(EvalSetItem, EvalSetItem.dossier_id == Dossier.id)
            .join(Match, Match.id == EvalSetItem.match_id)
            .join(Tournament, Tournament.id == Match.tournament_id)
        )
    )
    assert len(dossiers) == 100
    for as_of, content, day in dossiers:
        assert as_of == datetime.combine(day, time(0), UTC)
        assert content["as_of"] == day.isoformat()
        for side in ("p1", "p2"):
            assert all(row["d"] < day.isoformat() for row in content[side]["form"]["m"])

    run = await _finish(db, run_id)
    assert run.status == "done" and run.repeat_no == 1
    summary = run.metrics["summary"]
    assert (summary["n"], summary["total"], summary["format_errors"]) == (200, 200, 0)
    assert summary["market_n"] == 200 and summary["vs_market"]["n"] == 200
    assert summary["seed"] == eval_runs.SEED and summary["log_loss"] is not None
    runs = list(await db.scalars(select(AgentRun).where(AgentRun.eval_run_id == run_id)))
    assert len(runs) == 200 and all(r.kind == "eval" and r.batch for r in runs)
    assert {r.prompt_version for r in runs} == {"analysis.v1"}
    assert (
        await db.scalar(
            select(func.count()).select_from(Prediction).where(Prediction.eval_run_id == run_id)
        )
        == 1200
    )
    detail = (await admin.client.get(f"/api/admin/eval/runs/{run_id}")).json()
    assert detail["kind"] == "eval" and detail["chunks_done"] == detail["chunks_total"] == 2
    assert detail["metrics"]["n"] == 200 and detail["version_code"] == "v3"

    # Повтор активной версии — порог шума; досье те же (новых не строится)
    dossiers_before = await db.scalar(select(func.count()).select_from(Dossier))
    admin_user = await db.get_one(User, admin.id)
    repeat = await eval_runs.start(
        db, admin_user, EvalRunIn(version_id=v3_id), confirm=None, ip=None, enqueue=enqueue,
        terminal=True,
    )  # fmt: skip
    assert repeat.repeat_no == 2
    repeat = await _finish(db, repeat.id)
    assert repeat.status == "done"
    assert await db.scalar(select(func.count()).select_from(Dossier)) == dossiers_before

    # Кандидат с уроком: блок уроков — отдельный блок system
    lesson = await _lesson(db)
    made = await admin.client.post(
        "/api/admin/strategy/versions", json={"lessons": ["L-001"], "goal": "quality"}
    )
    assert made.status_code == 201, made.text
    v4 = made.json()
    assert (v4["code"], v4["status"], v4["lessons"]) == ("v4", "candidate", ["L-001"])
    assert v4["prompt_version"].startswith("analysis.v1+lessons_block.v2:")
    assert v4["can_activate"] is False and v4["activate_reason"] == "strategy.eval_needed"
    early = await admin.client.post(f"/api/strategy/versions/{v4['id']}/activate")
    assert early.status_code == 409 and error_code(early) == "strategy.eval_needed"
    twin = await admin.client.post("/api/admin/strategy/versions", json={"lessons": ["L-001"]})
    assert twin.status_code == 409 and error_code(twin) == "strategy.candidate_exists"

    fake.shift = 0.04
    candidate_run = await eval_runs.start(
        db, admin_user, EvalRunIn(version_id=v4["id"]), confirm=None, ip=None, enqueue=enqueue,
        terminal=True,
    )  # fmt: skip
    candidate_id = candidate_run.id
    candidate_run = await _finish(db, candidate_id)
    assert candidate_run.status == "done"
    last_batch = list(fake.batches.values())[-1]
    system = last_batch["requests"][0]["params"]["system"]
    assert len(system) == 2 and "- L-001:" in system[1]["text"]
    assert "Уроки из разборов" not in system[0]["text"]

    # Сравнение посчитано, кандидат остается кандидатом
    comparison = await db.scalar(
        select(EvalComparison).where(EvalComparison.candidate_run_id == candidate_id)
    )
    assert comparison is not None and comparison.rule == "improve"
    assert comparison.noise_run_id is not None and comparison.metrics["n"] == 200
    await db.refresh(lesson)
    assert lesson.in_prompt is False
    v4_row = await db.get_one(StrategyVersion, v4["id"], populate_existing=True)
    assert v4_row.status == "candidate"
    assert (await strategy_versions.shared_active(db)).id == v3_id  # type: ignore[union-attr]
    notes = list(
        await db.scalars(
            select(Notification.params["variant"].astext).where(Notification.user_id == admin.id)
        )
    )
    assert notes.count("eval_done") == 2
    assert {"candidate_passed", "candidate_failed"} & set(notes)

    versions = (await member.client.get("/api/strategy/versions")).json()
    codes = [item["code"] for item in versions["instructions"]]
    assert codes == ["v4", "v3"] and versions["eval_set"]["code"] == frozen.code
    seen_v4 = versions["instructions"][0]
    assert seen_v4["comparison"]["candidate_code"] == "v4"
    assert seen_v4["comparison"]["baseline_code"] == "v3"
    assert seen_v4["can_activate"] is False and seen_v4["activate_reason"] == "common.forbidden"
    assert versions["instructions"][1]["eval"]["runs"] == 2
    assert versions["instructions"][1]["eval"]["noise"] == pytest.approx(0.0)
    compare = (
        await member.client.get(f"/api/strategy/versions/compare?a={v3_id}&b={v4['id']}")
    ).json()
    assert compare["diff"] == [{"key": "lessons", "a": "", "b": "L-001"}]
    assert compare["comparison"]["rule"] == "improve"
    assert (
        await member.client.post(f"/api/strategy/versions/{v4['id']}/activate")
    ).status_code == 403

    # Включает только администратор; откат — в один клик
    on = await admin.client.post(f"/api/strategy/versions/{v4['id']}/activate")
    assert on.status_code == 200, on.text
    assert on.json()["status"] == "active"
    await db.refresh(lesson)
    assert lesson.in_prompt is True
    prompt = await strategy_versions.instructions_prompt(db)
    assert prompt.version_id == v4["prompt_version"] and prompt.codes == ("L-001",)
    back = await admin.client.post(f"/api/strategy/versions/{v3_id}/rollback")
    assert back.status_code == 200 and back.json()["status"] == "active"
    v4_row = await db.get_one(StrategyVersion, v4["id"], populate_existing=True)
    assert v4_row.status == "candidate"
    await db.refresh(lesson)
    assert lesson.in_prompt is False
    listing = (await admin.client.get("/api/admin/eval/runs")).json()
    assert [item["kind"] for item in listing["items"]] == ["eval", "eval", "eval"]
    assert listing["budget"]["spent_usd"] > 0


async def test_eval_run_budget_lock_single_run_and_resend(
    db: AsyncSession,
    engine: AsyncEngine,
    world: dict[int, int],
    fake: FakeClaude,
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Один прогон за раз (два запуска одновременно — один прогон); первый пакет не
    помещается в бюджет — прогон failed, ничего не отправлено; пакет, который не ушел
    (529), отправляется снова; две задачи одного прогона — один пакет."""
    await _ready(db)
    admin = await make_user(role="admin")
    await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    v3 = await strategy_versions.ensure_shared_active(db)
    await db.commit()
    v3_id = v3.id

    async def enqueue(run_id: int) -> None:
        return None

    maker = create_sessionmaker(engine)

    async def start_once() -> Any:
        async with maker() as session:
            user = await session.get_one(User, admin.id)
            try:
                run = await eval_runs.start(
                    session, user, EvalRunIn(version_id=v3_id), confirm=None, ip=None,
                    enqueue=enqueue, terminal=True,
                )  # fmt: skip
                return run.id
            except AppError as exc:
                return exc.code

    results = await asyncio.gather(start_once(), start_once())
    ids = [value for value in results if isinstance(value, int)]
    assert len(ids) == 1 and "eval.run_in_progress" in results
    [run_id] = ids

    # Бюджет урезан после запуска: первый пакет не помещается — failed, пакета нет
    await db.execute(update(AppSettings).values(eval_budget_usd=Decimal("0.5")))
    await db.execute(
        update(AppSettings).values(
            agent_config={"eval_set_size": 200, "eval_batch_size": 100, "eval_first_month_usd": 0}
        )
    )
    await db.commit()
    assert await eval_runs.advance(db, run_id) == "failed"
    failed = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert failed.metrics["error"] == "budget" and fake.batches == {}
    plan = await eval_runs.plan(db, v3_id)
    assert plan.reason == "eval.budget" and not plan.can_run

    # Бюджет вернули; создание пакета отклонено (529) — прогон снова ждет отправки
    await db.execute(update(AppSettings).values(eval_budget_usd=Decimal("25")))
    await db.commit()
    user = await db.get_one(User, admin.id)
    run = await eval_runs.start(
        db, user, EvalRunIn(version_id=v3_id), confirm=None, ip=None, enqueue=enqueue,
        terminal=True,
    )  # fmt: skip
    run_id = run.id
    fake.fail("batch_create", "overloaded")
    assert await eval_runs.advance(db, run_id) == "pending"
    again = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert again.status == "pending" and again.metrics["attempts"] == 1
    assert again.metrics["waiting"] == "not_sent" and fake.batches == {}

    # Две задачи одного прогона одновременно — пакет один
    async def advance_once() -> str:
        async with maker() as session:
            return await eval_runs.advance(session, run_id)

    statuses = await asyncio.gather(advance_once(), advance_once())
    assert "running" in statuses and set(statuses) <= {"running", "busy"}
    assert len(fake.batches) == 1
    jobs = await db.scalar(
        select(func.count()).select_from(BatchJob).where(BatchJob.status == "submitted")
    )
    assert jobs == 1


async def test_cli_freeze_and_recalibrate(
    db: AsyncSession, world: dict[int, int], capsys: pytest.CaptureFixture[str]
) -> None:
    """Команды терминала eval-freeze (повтор кода — отказ) и ml-recalibrate."""
    from app.admin import cli

    code = await asyncio.to_thread(cli.main, ["eval-freeze", "--code", "eval-cli", "--size", "200"])
    assert code == 0
    out = capsys.readouterr().out
    assert "Набор eval-cli заморожен: 200 матчей" in out
    again = await asyncio.to_thread(cli.main, ["eval-freeze", "--code", "eval-cli"])
    assert again == 1
    assert "уже заморожен" in capsys.readouterr().err
    assert await asyncio.to_thread(cli.main, ["ml-recalibrate"]) == 0
    assert "elo-v1@" in capsys.readouterr().out


async def test_eval_chunk_and_quick_check_share_budget_under_lock(
    db: AsyncSession,
    engine: AsyncEngine,
    world: dict[int, int],
    fake: FakeClaude,
    make_user: UserFactory,
) -> None:
    """Пакет прогона версии и быстрая проверка урока одновременно, остатка хватает на
    одно: остаток и строка пакета — под блокировкой бюджета проверок, уходит один пакет,
    резерв не больше бюджета (как М1/М2 волны 2)."""
    from app.services import lesson_quick

    await _ready(db)
    admin = await make_user(role="admin")
    await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    v3 = await strategy_versions.ensure_shared_active(db)
    lesson = await _lesson(db)
    lesson.status = "ready"
    await db.execute(
        update(AppSettings).values(
            agent_config={"eval_set_size": 200, "eval_batch_size": 100, "eval_first_month_usd": 0},
            eval_budget_usd=Decimal("500"),
        )
    )
    await db.commit()
    user = await db.get_one(User, admin.id)

    async def no_queue(run_id: int) -> None:
        return None

    run = await eval_runs.start(
        db, user, EvalRunIn(version_id=v3.id), confirm=None, ip=None, enqueue=no_queue,
        terminal=True,
    )  # fmt: skip
    run_id = run.id
    await lesson_quick.start(db, user, lesson.id, ip=None, enqueue=no_queue)
    quick_id = await db.scalar(select(EvalRun.id).where(EvalRun.metrics["kind"].astext == "quick"))
    assert quick_id is not None
    plan = await eval_runs.plan(db, v3.id)
    quick = await lesson_quick.preview(db, lesson.id)
    biggest = max(plan.worst_chunk_usd, quick.worst_usd)
    budget = (biggest * Decimal("1.2")).quantize(Decimal("0.01"))
    assert plan.worst_chunk_usd + quick.worst_usd > budget
    await db.execute(update(AppSettings).values(eval_budget_usd=budget))
    await db.commit()
    maker = create_sessionmaker(engine)
    async with maker() as s1, maker() as s2:
        statuses = await asyncio.gather(
            eval_runs.advance(s1, run_id), lesson_quick.prepare_and_submit(s2, quick_id)
        )
    assert sorted(statuses) == ["failed", "running"]
    assert len(fake.batches) == 1
    async with maker() as check:
        left = await check_runs.eval_budget(check)
    assert left.reserved_usd <= left.budget_usd == budget
