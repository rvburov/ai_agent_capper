"""Уроки (этап 5, волна 2): путь гипотезы до решения на синтетическом архиве — свои
случаи, проверка на истории при пороге (урок с настоящим смещением подтверждается,
приманка — хорошая на своих 20 случаях, но без эффекта в архиве — нет), уведомления
ждущим и администраторам, ежемесячная перепроверка; маршруты /api/lessons (права, Т21,
предложение урока, «сообщить, когда наберется»), быстрая проверка на поддельном Claude
(готовые ответы smoke-eval без урока, бюджет проверок, итог) и включение и выключение
урока с журналом."""

import asyncio
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import cli
from app.db.models import (
    AdminAuditLog,
    AgentRun,
    AppSettings,
    BatchJob,
    EvalRun,
    Lesson,
    LessonWatch,
    Match,
    Notification,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ml.elo import rebuild_ratings
from app.ml.lesson_scope import cases_select, validate_scope
from app.services import check_runs, lesson_check, lesson_quick, lessons, smoke_eval
from app.workers.jobs import collect_all
from tests.analysis_helpers import install, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import Signed, admin_signed_in, error_code, signed_in
from tests.learning_helpers import own_leg
from tests.ml_world import make_world, store_world
from tests.support import ClientFactory, LoginFn, UserFactory

NOW = datetime(2026, 1, 15, 12, 0, tzinfo=UTC)
CLAY_UNDERDOG = {
    "direction": "lower",
    "conditions": [
        {"feature": "role", "op": "eq", "values": ["underdog"]},
        {"feature": "surface", "op": "eq", "values": ["clay"]},
    ],
}
LATE_FAVORITE = {
    "direction": "lower",
    "conditions": [
        {"feature": "round", "op": "in", "values": ["SF", "F"]},
        {"feature": "role", "op": "eq", "values": ["favorite"]},
    ],
}


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def archive(db: AsyncSession, engine: AsyncEngine) -> list[Match]:
    """Синтетический архив 2017–2025: исходы — по истинной вероятности, у модели в нем нет
    смещения по покрытию и роли. Полуфиналы и финалы с четным id потом переворачиваются
    (rigged_late_rounds): там фаворит модели выигрывает реже, чем она дает."""
    world = make_world(
        players=60,
        years=range(2017, 2026),
        tournaments_per_year=12,
        draw=16,
        seed=11,
        dated_from=2017,
    )
    ids = await store_world(db, world)
    await rebuild_ratings(db_factory=create_sessionmaker(engine))
    return list(await db.scalars(select(Match).where(Match.id.in_(list(ids.values())))))


async def rigged_late_rounds(db: AsyncSession) -> int:
    """Половина полуфиналов и финалов (четный id) — победа другого игрока. Рейтинги до
    матча от этого не меняются (они строго раньше дня матча)."""
    rows = list(
        await db.scalars(select(Match).where(Match.round.in_(("SF", "F")), Match.id % 2 == 0))
    )
    for match in rows:
        match.winner_id = (
            match.player2_id if match.winner_id == match.player1_id else match.player1_id
        )
    await db.commit()
    return len(rows)


async def _lesson(db: AsyncSession, scope: dict[str, Any], code: str = "L-001") -> Lesson:
    lesson = Lesson(
        user_id=None,
        code=code,
        text="Проверяемое правило урока",
        scope=validate_scope(scope).to_json(),
        kind="numeric",
        status="hypothesis",
        origin="manual",
        metrics={},
    )
    db.add(lesson)
    await db.commit()
    return lesson


async def _min_cases(db: AsyncSession, value: int) -> None:
    await db.execute(update(AppSettings).values(agent_config={"lesson_min_cases": value}))
    await db.commit()


async def _surface_matches(db: AsyncSession, surface: str, count: int) -> list[Match]:
    return list(
        await db.scalars(
            select(Match)
            .join(Tournament, Tournament.id == Match.tournament_id)
            .where(Tournament.surface == surface, Match.match_date >= date(2024, 1, 1))
            .order_by(Match.id)
            .limit(count)
        )
    )


# --- путь гипотезы ---


async def test_bait_lesson_good_on_own_cases_fails_on_history(
    db: AsyncSession, archive: list[Match], make_user: UserFactory
) -> None:
    """Приманка: на своих 20 случаях «аутсайдер на грунте» проиграл все 20 — урок выглядит
    отличным, но на архиве смещения нет (или оно в другую сторону): урок отклонен и в
    анализ не попадет."""
    admin = await make_user(role="admin")
    member = await make_user()
    lesson = await _lesson(db, CLAY_UNDERDOG)
    for match in await _surface_matches(db, "clay", 20):
        # Ставки на обе стороны проиграли: под условие попадает сторона аутсайдера
        await own_leg(db, member.id, match, selection=1, result="loss", p_final=0.45)
        await own_leg(db, member.id, match, selection=2, result="loss", p_final=0.45)
    db.add(LessonWatch(lesson_id=lesson.id, user_id=member.id))
    await db.commit()
    summary = await lessons.check_lessons(db, now=NOW)
    await db.refresh(lesson)
    assert summary == {"checked": 1, "ready": 0, "rejected": 1}
    assert lesson.status == "rejected" and lesson.n_cases == 20
    own = lesson.metrics["own"]
    assert own["n"] == 20 and own["residual"] == pytest.approx(-0.45)
    history = lesson.metrics["history"]
    assert history["status"] == "rejected" and history["reason"] in ("direction", "no_bias")
    assert history["n_history"] >= lesson_check.MIN_HISTORY
    assert history["seed"] == lesson_check.SEED and history["method"] == "elo_prematch"
    assert lesson.n_hist == history["n_hist"] and lesson.validated_at is not None
    assert lesson.effect is not None and lesson.effect_ci is not None
    # Уведомления: администратору и ждущему участнику, по одному
    notes = list(await db.scalars(select(Notification).order_by(Notification.user_id)))
    assert [(note.user_id, note.params["variant"]) for note in notes] == [
        (admin.id, "lesson_rejected"),
        (member.id, "lesson_rejected"),
    ]
    assert notes[0].link == "/learning" and "L-001" in notes[0].title
    watch = await db.get_one(LessonWatch, (lesson.id, member.id), populate_existing=True)
    assert watch.notified_at is not None
    assert await lessons.check_lessons(db, now=NOW) == {"checked": 0, "ready": 0, "rejected": 0}


async def test_real_bias_lesson_is_ready_then_retired(
    db: AsyncSession, archive: list[Match], make_user: UserFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Урок с настоящим смещением (фаворит в полуфинале и финале выигрывает реже) —
    ready после порога своих случаев; через месяц, если смещение пропало, — retired."""
    monkeypatch.setattr(lesson_check, "MIN_HISTORY", 100)
    monkeypatch.setattr(lesson_check, "MIN_HOLDOUT", 30)
    await make_user(role="admin")
    member = await make_user()
    flipped = await rigged_late_rounds(db)
    assert flipped > 50
    await _min_cases(db, 5)
    lesson = await _lesson(db, LATE_FAVORITE)
    late = list(
        await db.scalars(
            select(Match).where(Match.round.in_(("SF", "F"))).order_by(Match.id.desc()).limit(4)
        )
    )
    for match in late:
        await own_leg(db, member.id, match, selection=1, result="loss")
        await own_leg(db, member.id, match, selection=2, result="loss")
    # Своих случаев меньше порога — гипотеза копит, архив не проверяется
    assert (await lessons.check_lessons(db, now=NOW))["ready"] == 0
    await db.refresh(lesson)
    assert lesson.status == "hypothesis" and lesson.n_cases == 4 and lesson.n_hist == 0
    third = await db.scalar(
        select(Match).where(Match.round == "SF").order_by(Match.id.desc()).offset(5).limit(1)
    )
    assert third is not None
    await own_leg(db, member.id, third, selection=1, result="loss")
    await own_leg(db, member.id, third, selection=2, result="loss")
    checked = await lessons.check_lessons(db, now=NOW)
    await db.refresh(lesson)
    assert checked["ready"] == 1, (checked, lesson.n_cases, lesson.metrics)
    assert lesson.status == "ready" and lesson.n_cases == 5
    assert lesson.effect is not None and lesson.effect < -0.05
    assert lesson.effect_ci is not None and lesson.effect_ci[1] < 0
    assert lesson.effect_shrunk is not None and lesson.effect < lesson.effect_shrunk < 0
    n = lesson.metrics["history"]["n_history"] + 5
    assert lesson.effect_shrunk == pytest.approx(lesson.effect * n / (n + 200))
    assert lesson.holdout_effect is not None and lesson.holdout_effect > 0
    assert lesson.metrics["history"]["gain"]["low"] > 0

    # Включен в анализ, а на новых данных фаворит поздних кругов выигрывает всегда —
    # смещение пропало (оно даже в другую сторону): перепроверка списывает урок
    lesson.status, lesson.in_prompt = "confirmed", True
    await db.commit()
    model, _ = await lesson_check.elo_model(db)
    rows = await lesson_check.read_only(
        db,
        cases_select(
            validate_scope(LATE_FAVORITE), model=model, since=date(2000, 1, 1), until=NOW.date()
        ),
    )
    favorites = {int(row["match_id"]): int(row["pid"]) for row in rows}
    for match in list(await db.scalars(select(Match).where(Match.id.in_(list(favorites))))):
        match.winner_id = favorites[match.id]
    await db.commit()
    summary = await lessons.recheck_lessons(db, now=NOW + timedelta(days=17))
    await db.refresh(lesson)
    assert summary["retired"] == 1
    assert lesson.status == "retired" and not lesson.in_prompt and lesson.retired_at is not None
    assert lesson.rechecked_at is not None
    note = await db.scalar(
        select(Notification).where(Notification.params["variant"].astext == "lesson_retired")
    )
    assert note is not None


async def test_process_lesson_is_ready_without_history(
    db: AsyncSession, archive: list[Match], make_user: UserFactory
) -> None:
    member = await make_user()
    await _min_cases(db, 1)
    lesson = await _lesson(db, CLAY_UNDERDOG)
    lesson.kind = "process"
    await db.commit()
    await db.execute(update(AppSettings).values(agent_config={"lesson_min_cases_process": 2}))
    await db.commit()
    for match in await _surface_matches(db, "clay", 2):
        await own_leg(db, member.id, match, selection=1, result="loss")
        await own_leg(db, member.id, match, selection=2, result="loss")
    checked = await lessons.check_lessons(db, now=NOW)
    await db.refresh(lesson)
    assert checked["ready"] == 1, (checked, lesson.n_cases, lesson.metrics)
    assert lesson.status == "ready" and lesson.n_hist == 0 and "history" not in lesson.metrics


# --- маршруты ---


async def _members(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> tuple[Signed, Signed, Signed]:
    admin = await admin_signed_in(make_client, make_user, login)
    first = await signed_in(make_client, make_user, login, email="first@example.com")
    second = await signed_in(make_client, make_user, login, email="second@example.com")
    return admin, first, second


async def test_lesson_routes_rights_and_own_bets(
    db: AsyncSession,
    archive: list[Match],
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    admin, first, second = await _members(make_client, make_user, login)
    lesson = await _lesson(db, CLAY_UNDERDOG)
    [clay] = await _surface_matches(db, "clay", 1)
    mine, _, _ = await own_leg(db, first.id, clay, selection=2, result="loss")
    theirs, _, _ = await own_leg(db, second.id, clay, selection=1, result="loss")
    lesson.source_bet_ids = [mine.id, theirs.id]
    personal = Lesson(user_id=second.id, code="L-001", text="Свой урок", kind="numeric")
    db.add(personal)
    await db.commit()

    listing = (await first.client.get("/api/lessons")).json()
    assert [item["code"] for item in listing["items"]] == ["L-001"]
    [item] = listing["items"]
    # Т21: в основании видны только свои ставки
    assert item["own_bets"] == [mine.id] and item["shared"] and item["scope_ok"]
    assert item["scope"] == {
        "direction": "lower",
        "conditions": [
            {"feature": "surface", "op": "eq", "values": ["clay"], "value": None},
            {"feature": "role", "op": "eq", "values": ["underdog"], "value": None},
        ],
    }
    assert (listing["max_active"], listing["min_cases"], listing["shrink_k"]) == (15, 20, 200)
    assert (await admin.client.get(f"/api/lessons/{lesson.id}")).json()["own_bets"] == []
    assert (await second.client.get(f"/api/lessons/{lesson.id}")).json()["own_bets"] == [theirs.id]
    # Свой урок участника виден только ему
    assert (await first.client.get(f"/api/lessons/{personal.id}")).status_code == 404
    assert (await second.client.get(f"/api/lessons/{personal.id}")).status_code == 200
    assert len((await second.client.get("/api/lessons")).json()["items"]) == 2
    assert (await first.client.get("/api/lessons", params={"status": "ready"})).json()[
        "items"
    ] == []
    dictionary = (await first.client.get("/api/lessons/dictionary")).json()
    assert dictionary["max_conditions"] == 6 and dictionary["directions"] == ["lower", "raise"]

    # Решения — только администратору
    for method, path in (
        ("GET", "quick-check"),
        ("POST", "quick-check"),
        ("POST", "enable"),
        ("POST", "disable"),
    ):
        response = await first.client.request(method, f"/api/lessons/{lesson.id}/{path}")
        assert response.status_code == 403, (method, path)
        assert error_code(response) == "common.forbidden"
    refused = await admin.client.post(f"/api/lessons/{lesson.id}/enable")
    assert refused.status_code == 409 and error_code(refused) == "lesson.not_ready"
    preview = (await admin.client.get(f"/api/lessons/{lesson.id}/quick-check")).json()
    assert preview["can_run"] is False and preview["reason"] == "lesson.not_ready"
    assert (await admin.client.get("/api/lessons/999999/quick-check")).status_code == 404

    # «Сообщить, когда наберется»: у гипотезы — да, повтор ничего не меняет
    watched = await first.client.post(f"/api/lessons/{lesson.id}/notify-when-ready")
    assert watched.status_code == 200 and watched.json()["watching"] is True
    again = await first.client.post(f"/api/lessons/{lesson.id}/notify-when-ready")
    assert again.status_code == 200
    assert await db.scalar(select(func.count()).select_from(LessonWatch)) == 1
    assert (await second.client.get(f"/api/lessons/{lesson.id}")).json()["watching"] is False
    lesson.status = "ready"
    await db.commit()
    late = await second.client.post(f"/api/lessons/{lesson.id}/notify-when-ready")
    assert late.status_code == 409 and error_code(late) == "lesson.already_checked"


async def test_propose_lesson(
    db: AsyncSession,
    archive: list[Match],
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    admin, first, _ = await _members(make_client, make_user, login)
    [clay] = await _surface_matches(db, "clay", 1)
    await own_leg(db, first.id, clay, selection=1, result="loss")
    await own_leg(db, first.id, clay, selection=2, result="loss")
    body = {
        "text": "  На грунте   аутсайдер берет сет чаще, чем дает модель  ",
        "scope": {
            "direction": "raise",
            "conditions": [
                {"feature": "market", "op": "eq", "values": ["HCP_+1.5"]},
                {"feature": "surface", "op": "in", "values": ["clay"]},
                {"feature": "role", "op": "eq", "values": ["underdog"]},
            ],
        },
    }
    created = await first.client.post("/api/lessons", json=body)
    assert created.status_code == 201, created.text
    data = created.json()
    assert data["code"] == "L-001" and data["status"] == "hypothesis"
    assert data["origin"] == "manual" and data["kind"] == "numeric"
    assert data["text"] == "На грунте аутсайдер берет сет чаще, чем дает модель"
    # Свои случаи считаются сразу (фора +1.5 у ноги на П1/П2 не считается)
    assert data["n_cases"] == 0 and data["need_cases"] == 20
    lesson = await db.get_one(Lesson, data["id"])
    assert lesson.created_by == first.id and lesson.user_id is None
    duplicate = await admin.client.post("/api/lessons", json=body)
    assert duplicate.status_code == 409 and error_code(duplicate) == "lesson.exists"
    assert duplicate.json()["error"]["message"].endswith("L-001")
    bad = await first.client.post(
        "/api/lessons",
        json={
            **body,
            "scope": {
                "direction": "lower",
                "conditions": [{"feature": "surface", "op": "eq", "values": ["hard"]}],
            },
        },
    )
    assert bad.status_code == 422 and error_code(bad) == "lesson.scope_side"
    unknown = await first.client.post(
        "/api/lessons",
        json={**body, "scope": {"direction": "lower", "conditions": [{"feature": "speed"}]}},
    )
    assert unknown.status_code == 422
    short = await first.client.post("/api/lessons", json={**body, "text": "коротко"})
    assert short.status_code == 422
    # Участник — не больше 5 уроков в сутки, администратор — без предела
    for value in range(1, 5):
        varied = {
            **body,
            "scope": {
                "direction": "lower",
                "conditions": [
                    {"feature": "role", "op": "eq", "values": ["favorite"]},
                    {"feature": "rest_days", "op": "ge", "value": value},
                ],
            },
        }
        assert (await first.client.post("/api/lessons", json=varied)).status_code == 201
    limited = await first.client.post(
        "/api/lessons",
        json={
            **body,
            "scope": {
                "direction": "lower",
                "conditions": [
                    {"feature": "role", "op": "eq", "values": ["favorite"]},
                    {"feature": "rest_days", "op": "ge", "value": 30},
                ],
            },
        },
    )
    assert limited.status_code == 429 and error_code(limited) == "lesson.too_many"


# --- быстрая проверка и включение ---


async def test_quick_check_enable_disable(
    db: AsyncSession,
    engine: AsyncEngine,
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Быстрая проверка готового урока: 40 матчей после даты среза; ответы без урока —
    готовые из smoke-eval на тех же досье, в пакет идут только 40 запросов с уроком.
    Поддельный Claude отвечает одинаково с уроком и без: разница 0 — «не хуже», урок
    можно включить; журнал lesson_on и lesson_off, предел уроков в анализе."""
    from tests.analysis_helpers import seed_world

    await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    since = datetime.now(UTC).date() - timedelta(days=400)
    monkeypatch.setattr(smoke_eval, "POLL_SECONDS", 0.0)
    monkeypatch.setattr(smoke_eval, "SAFE_SINCE", {})
    monkeypatch.setattr(smoke_eval, "DEFAULT_SAFE_SINCE", since)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    lesson = await _lesson(db, LATE_FAVORITE)
    lesson.status, lesson.effect_shrunk = "ready", -0.042
    lesson.validated_at = datetime.now(UTC) - timedelta(days=1)
    await db.commit()

    # Готовые ответы без урока — smoke-eval на тех же 40 матчах
    code = await asyncio.to_thread(
        cli.main, ["smoke-eval", "--events", "40", "--since", since.isoformat(), "--yes"]
    )
    assert code in (0, 1, 3)
    smoke_runs = await db.scalar(select(func.count()).select_from(AgentRun))
    assert smoke_runs == 40

    preview = (await admin.client.get(f"/api/lessons/{lesson.id}/quick-check")).json()
    assert preview["can_run"] is True and preview["reason"] is None
    assert (preview["events"], preview["requests"], preview["baseline_reused"]) == (40, 40, 40)
    assert preview["model"] == "claude-opus-5-5"
    assert 0 < preview["estimate_usd"] < preview["worst_usd"] <= preview["left_usd"]
    assert (preview["active"], preview["max_active"]) == (0, 15)

    queued: list[int] = []

    async def enqueue(run_id: int) -> None:
        queued.append(run_id)

    monkeypatch.setattr(lesson_quick, "enqueue_quick", enqueue)
    started = await admin.client.post(f"/api/lessons/{lesson.id}/quick-check")
    assert started.status_code == 202, started.text
    assert started.json()["status"] == "pending" and started.json()["can_run"] is False
    assert started.json()["reason"] == "lesson.quick_check_running"
    [run_id] = queued
    again = await admin.client.post(f"/api/lessons/{lesson.id}/quick-check")
    assert again.status_code == 409 and error_code(again) == "lesson.quick_check_running"
    [audit] = list(
        await db.scalars(select(AdminAuditLog).where(AdminAuditLog.action == "eval_run"))
    )
    assert audit.details["kind"] == "quick" and audit.details["code"] == "L-001"

    status = await lesson_quick.prepare_and_submit(db, run_id)
    assert status == "running"
    job = await db.scalar(select(BatchJob).where(BatchJob.kind == "eval"))
    assert job is not None and job.requests == 40 and job.worst_usd > 0
    [batch] = [b for b in fake.batches.values() if b["requests"][0]["custom_id"].startswith("qc")]
    first = batch["requests"][0]["params"]
    assert first["max_tokens"] == 8000 and first["model"] == "claude-opus-5-5"
    system = first["system"][0]["text"]
    assert "Уроки из разборов" in system and "- L-001: Проверяемое правило урока" in system
    assert "−4,2 п.п." in system
    assert all(request["custom_id"].endswith("-l") for request in batch["requests"])
    # Резерв худшего случая — в бюджете проверок
    budget = await check_runs.eval_budget(db)
    assert budget.reserved_usd == job.worst_usd

    summary = await collect_all(db)
    assert summary["collected"] == 1
    run = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert run.status == "done" and run.batch_job_id == job.id
    result = run.metrics["summary"]
    assert result["passed"] is True and result["n"] == 40 and result["format_errors"] == 0
    assert result["diff"]["value"] == pytest.approx(0.0)
    runs = list(await db.scalars(select(AgentRun).where(AgentRun.eval_run_id == run_id)))
    assert len(runs) == 40 and all(r.kind == "eval" and r.batch for r in runs)
    assert all(r.prompt_version == "analysis.v1+lessons_block.v1:L-001" for r in runs)
    await db.refresh(lesson)
    quick = lesson.metrics["quick"]
    assert quick["status"] == "done" and quick["passed"] is True
    note = await db.scalar(
        select(Notification).where(Notification.params["variant"].astext == "quick_passed")
    )
    assert note is not None and note.user_id == admin.id

    # Участник видит итог, но включить не может
    seen = (await member.client.get(f"/api/lessons/{lesson.id}")).json()
    assert seen["quick"]["passed"] is True and seen["quick"]["events"] == 40
    assert (await member.client.post(f"/api/lessons/{lesson.id}/enable")).status_code == 403
    enabled = await admin.client.post(f"/api/lessons/{lesson.id}/enable")
    assert enabled.status_code == 200, enabled.text
    assert enabled.json()["in_prompt"] is True and enabled.json()["status"] == "confirmed"
    assert (await member.client.get("/api/lessons")).json()["active"] == 1
    disabled = await admin.client.post(f"/api/lessons/{lesson.id}/disable")
    assert disabled.json()["in_prompt"] is False
    # Включить снова — только после новой быстрой проверки
    again_on = await admin.client.post(f"/api/lessons/{lesson.id}/enable")
    assert again_on.status_code == 409 and error_code(again_on) == "lesson.quick_check_needed"
    actions = [
        row.action for row in await db.scalars(select(AdminAuditLog).order_by(AdminAuditLog.id))
    ]
    assert actions[-2:] == ["lesson_on", "lesson_off"]

    # Предел уроков в анализе
    await db.execute(update(AppSettings).values(agent_config={"lessons_max_active": 1}))
    other = await _lesson(db, CLAY_UNDERDOG, code="L-002")
    other.in_prompt, other.status = True, "confirmed"
    await db.refresh(lesson)
    lesson.metrics = {**lesson.metrics, "quick": {**quick, "passed": True}}
    await db.commit()
    full = await admin.client.post(f"/api/lessons/{lesson.id}/enable")
    assert full.status_code == 409 and error_code(full) == "lesson.max_active"


async def test_quick_check_refusals(
    db: AsyncSession,
    archive: list[Match],
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    await seed_prices(db)
    lesson = await _lesson(db, LATE_FAVORITE)
    lesson.status = "ready"
    await db.commit()
    preview = (await admin.client.get(f"/api/lessons/{lesson.id}/quick-check")).json()
    assert preview["reason"] == "ai.no_admin_key"
    await set_admin_key(db)
    # Архив кончается 2025 годом, а дата среза — июль 2026: матчей нет
    preview = (await admin.client.get(f"/api/lessons/{lesson.id}/quick-check")).json()
    assert preview["events"] == 0 and preview["reason"] == "lesson.quick_check_no_matches"
    monkeypatch.setattr(smoke_eval, "SAFE_SINCE", {})
    monkeypatch.setattr(smoke_eval, "DEFAULT_SAFE_SINCE", date(2025, 1, 1))
    await db.execute(update(AppSettings).values(eval_budget_usd=Decimal("0.5")))
    await db.commit()
    preview = (await admin.client.get(f"/api/lessons/{lesson.id}/quick-check")).json()
    assert preview["events"] == 40 and preview["reason"] == "lesson.quick_check_budget"
    refused = await admin.client.post(f"/api/lessons/{lesson.id}/quick-check")
    assert refused.status_code == 409 and error_code(refused) == "lesson.quick_check_budget"
    assert await db.scalar(select(func.count()).select_from(EvalRun)) == 0
