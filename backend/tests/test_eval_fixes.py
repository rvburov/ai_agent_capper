"""Исправления волны 3 (этап 5) по прогонам на наборе, на поддельном Claude:
- M1: проверка урока не берет матчи замороженных наборов; урок кандидата, проверенный до
  заморозки, — отказ плана eval.lesson_overlap;
- M2: отклоненный кандидат больше не тратит бюджет; остановка прогона администратором
  (ждущий — сразу, пакет у Anthropic — отмена) и командой терминала;
- m3: набор раньше среза знаний модели анализа — отказ eval.set_model_seen;
- m4: калибровка базовой модели закреплена за набором при заморозке;
- заметка: худший случай до запуска — вместе с пакетом повтора."""

import asyncio
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AgentRun, BatchJob, EvalRun, EvalSetItem, Lesson, MlModel, User
from app.ml import model_versions
from app.ml.lesson_scope import Condition, Scope
from app.ml.model_versions import CALIBRATION_KIND
from app.schemas.learning import EvalRunIn, EvalSetIn, InstructionsCandidateIn
from app.services import (
    check_runs,
    eval_runs,
    eval_sets,
    lesson_check,
    smoke_eval,
    strategy_versions,
)
from app.services.dossier import build_dossier
from app.workers.jobs import advance_eval_runs, collect_all
from tests.fake_claude import FakeClaude
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.support import ClientFactory, LoginFn, UserFactory
from tests.test_eval_runs import _lesson, _ready, fake, world  # noqa: F401

FAVORITE = Scope(
    direction="lower", conditions=(Condition(feature="role", op="eq", values=("favorite",)),)
)


async def _no_queue(run_id: int) -> None:
    return None


async def _candidate(db: AsyncSession, admin_id: int) -> int:
    await _lesson(db)
    user = await db.get_one(User, admin_id)
    cand = await strategy_versions.create_instructions_candidate(
        db, user, InstructionsCandidateIn(lessons=["L-001"]), ip=None
    )
    return cand.id


async def _start(db: AsyncSession, admin_id: int, version_id: int) -> int:
    user = await db.get_one(User, admin_id)
    run = await eval_runs.start(
        db, user, EvalRunIn(version_id=version_id), confirm=None, ip=None, enqueue=_no_queue,
        terminal=True,
    )  # fmt: skip
    return run.id


# --- M1 ---


async def test_lesson_history_excludes_frozen_sets(
    db: AsyncSession,
    world: dict[int, int],  # noqa: F811
    make_user: UserFactory,
) -> None:
    admin = await make_user(role="admin")
    frozen = await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    in_set = set(
        await db.scalars(select(EvalSetItem.match_id).where(EvalSetItem.eval_set_id == frozen.id))
    )
    cases = await lesson_check.history_cases(db, FAVORITE, today=date(2026, 1, 1))
    # Урок не подбирается и не отбирается на матчах, где потом сравнивают кандидата
    assert cases and not ({case.match_id for case in cases} & in_set)
    check = lesson_check.evaluate(cases, FAVORITE, shrink_k=20)
    assert check.n_history + check.n_holdout == len(cases)

    # Урок кандидата проверен на архиве до заморозки — прогон кандидата не запускается
    await strategy_versions.ensure_shared_active(db)
    await db.commit()
    cand_id = await _candidate(db, admin.id)
    lesson = await db.scalar(select(Lesson).where(Lesson.code == "L-001"))
    assert lesson is not None
    assert frozen.frozen_at is not None
    lesson.validated_at = frozen.frozen_at - timedelta(days=1)
    await db.commit()
    plan = await eval_runs.plan(db, cand_id)
    assert plan.reason == "eval.lesson_overlap" and plan.overlap_lesson == "L-001"
    # Перепроверили после заморозки — можно
    lesson.validated_at = frozen.frozen_at + timedelta(minutes=1)
    await db.commit()
    assert (await eval_runs.plan(db, cand_id)).reason != "eval.lesson_overlap"


# --- M2 ---


async def test_rejected_candidate_stops_spending(
    db: AsyncSession,
    world: dict[int, int],  # noqa: F811
    fake: FakeClaude,  # noqa: F811
    make_user: UserFactory,
) -> None:
    await _ready(db)
    admin = await make_user(role="admin")
    await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    await strategy_versions.ensure_shared_active(db)
    await db.commit()
    cand_id = await _candidate(db, admin.id)
    run_id = await _start(db, admin.id, cand_id)
    assert await eval_runs.advance(db, run_id) == "running"
    await collect_all(db)  # первый пакет собран, прогон ждет второго
    run = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert run.status == "pending"

    user = await db.get_one(User, admin.id)
    await strategy_versions.reject(db, user, cand_id)
    run = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert run.status == "abandoned" and run.metrics["status"] == "canceled"
    assert await advance_eval_runs(db) == []
    assert len(fake.batches) == 1
    jobs = await db.scalar(
        select(func.count()).select_from(BatchJob).where(BatchJob.kind == "eval")
    )
    assert jobs == 1
    # Резерва до отправки у остановленного прогона нет
    assert (await check_runs.eval_budget(db)).reserved_usd == 0
    # Версия ушла в архив — пакет не уходит, даже если прогон еще ждал (проверка в отправке)
    plan = await eval_runs.plan(db, cand_id)
    assert plan.reason == "eval.version_closed"


async def test_cancel_running_and_pending_runs(
    db: AsyncSession,
    world: dict[int, int],  # noqa: F811
    fake: FakeClaude,  # noqa: F811
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    capsys: pytest.CaptureFixture[str],
) -> None:
    await _ready(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    v3 = await strategy_versions.ensure_shared_active(db)
    await db.commit()
    v3_id = v3.id

    # Пакет у Anthropic: отмена там, не начатые запросы — canceled (бесплатно)
    run_id = await _start(db, admin.id, v3_id)
    assert await eval_runs.advance(db, run_id) == "running"
    denied = await member.client.post(f"/api/admin/eval/runs/{run_id}/cancel")
    assert denied.status_code == 403
    stop = await admin.client.post(f"/api/admin/eval/runs/{run_id}/cancel")
    assert stop.status_code == 200, stop.text
    assert stop.json()["status"] == "running" and stop.json()["waiting"] == "eval.canceling"
    [batch_id] = fake.batches
    assert fake.canceled == [batch_id]
    await collect_all(db)
    run = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert run.status == "abandoned" and run.metrics["error"] == "canceled"
    assert await advance_eval_runs(db) == [] and len(fake.batches) == 1
    cost = await db.scalar(
        select(func.coalesce(func.sum(AgentRun.cost_usd), 0)).where(AgentRun.eval_run_id == run_id)
    )
    assert Decimal(cost or 0) == 0
    again = await admin.client.post(f"/api/admin/eval/runs/{run_id}/cancel")
    assert again.status_code == 409 and error_code(again) == "eval.run_closed"
    missing = await admin.client.post("/api/admin/eval/runs/999999/cancel")
    assert missing.status_code == 404 and error_code(missing) == "eval.run_not_found"

    # Ждущий прогон (пакет не ушел) — команда терминала, сразу; резерв снимается
    pending_id = await _start(db, admin.id, v3_id)
    assert (await check_runs.eval_budget(db)).reserved_usd > 0
    from app.admin import cli

    assert await asyncio.to_thread(cli.main, ["eval-cancel", str(pending_id)]) == 0
    assert "остановлен" in capsys.readouterr().out
    run = await db.get_one(EvalRun, pending_id, populate_existing=True)
    assert run.status == "abandoned"
    assert (await check_runs.eval_budget(db)).reserved_usd == 0
    assert (await eval_runs.plan(db, v3_id)).reason is None


# --- m3, план ---


async def test_plan_refuses_seen_set_and_counts_retry(
    db: AsyncSession,
    world: dict[int, int],  # noqa: F811
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await _ready(db)
    admin = await make_user(role="admin")
    await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    v3 = await strategy_versions.ensure_shared_active(db)
    await db.commit()
    plan = await eval_runs.plan(db, v3.id)
    assert plan.can_run and plan.retry_events == 100 and plan.set_model is not None
    # Худший случай — 200 событий набора и пакет повтора (до 100 запросов)
    assert abs(plan.worst_usd - plan.per_event_worst_usd * 300) < Decimal("0.01")
    # Модель анализа сменили на ту, что могла видеть матчи набора
    monkeypatch.setattr(smoke_eval, "DEFAULT_SAFE_SINCE", date(2025, 6, 1))
    seen = await eval_runs.plan(db, v3.id)
    assert seen.reason == "eval.set_model_seen" and seen.set_seen_since == date(2025, 6, 1)
    user = await db.get_one(User, admin.id)
    with pytest.raises(Exception) as refused:
        await eval_runs.start(
            db, user, EvalRunIn(version_id=v3.id), confirm=None, ip=None, enqueue=_no_queue,
            terminal=True,
        )  # fmt: skip
    assert getattr(refused.value, "code", None) == "eval.set_model_seen"


# --- m4 ---


async def test_set_calibration_pinned_at_freeze(
    db: AsyncSession,
    world: dict[int, int],  # noqa: F811
    make_user: UserFactory,
) -> None:
    admin = await make_user(role="admin")
    old = MlModel(
        id="elo-v1@2024-12-30",
        kind=CALIBRATION_KIND,
        params={"base": "elo-v1", "platt": {"a": 0.05, "b": 1.1}},
        metrics={},
        status="active",
        train_from=date(2023, 1, 1),
        train_to=date(2024, 12, 1),
        activated_at=datetime.now(UTC),
    )
    db.add(old)
    await db.commit()
    frozen = await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    assert frozen.rules["calibration"]["model_id"] == "elo-v1@2024-12-30"
    # Позже включилась калибровка, подобранная на матчах набора
    old.status = "archived"
    await db.flush()
    db.add(
        MlModel(
            id="elo-v1@2025-12-29",
            kind=CALIBRATION_KIND,
            params={"base": "elo-v1", "platt": {"a": 0.9, "b": 2.0}},
            metrics={},
            status="active",
            train_from=date(2024, 1, 1),
            train_to=date(2025, 9, 1),
            activated_at=datetime.now(UTC),
        )
    )
    await db.commit()
    items = list(
        await db.scalars(
            select(EvalSetItem)
            .where(EvalSetItem.eval_set_id == frozen.id)
            .order_by(EvalSetItem.match_id)
            .limit(3)
        )
    )
    events = await eval_sets.prepare_events(db, frozen, items)
    await db.commit()
    assert {event.features["ml_model_id"] for event in events} == {"elo-v1@2024-12-30"}
    # p_base набора — по закрепленной калибровке, а не по новой активной
    matches = await eval_sets.set_matches(db, [events[0].match_id])
    item = matches[events[0].match_id]
    pinned = await model_versions.snapshot(db, "elo-v1@2024-12-30")
    newer = await model_versions.snapshot(db)
    assert newer.model_id == "elo-v1@2025-12-29"
    as_of = eval_sets.match_day_start(item.day)
    from app.ml.backtest import side_flip

    kwargs = {
        "as_of": as_of,
        "best_of": item.best_of,
        "surface": item.surface,
        "with_news": False,
        "swap": side_flip(item.match.id),
    }
    with_pinned = await build_dossier(db, item.match, model=pinned, **kwargs)  # type: ignore[arg-type]
    with_newer = await build_dossier(db, item.match, model=newer, **kwargs)  # type: ignore[arg-type]
    assert events[0].dossier_id == with_pinned.dossier_id != with_newer.dossier_id
