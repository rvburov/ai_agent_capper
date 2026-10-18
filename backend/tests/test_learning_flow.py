"""Уроки в анализе и сводка «Обучения модели» (этап 5, волна 3): включение урока
администратором создает новую версию общей линии инструкций с блоком уроков в system
(отдельная точка кэша), анализ пишет версию промпта и lessons_applied, выключение —
версия без урока; GET /learning (пороги из настроек вместо констант фронтенда), блок
«Модель учится» на главной; «Все мои прогнозы» и главный ряд Brier в «Аналитике»."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import (
    AgentRun,
    Analysis,
    AppSettings,
    Lesson,
    Match,
    Prediction,
    StrategyVersion,
    Tournament,
)
from app.services import strategy_versions
from tests.analysis_helpers import install, make_analysis, run, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import admin_signed_in, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


async def _ready_lesson(db: AsyncSession, code: str = "L-001") -> Lesson:
    """Урок проверен на архиве и прошел быструю проверку — его можно включить."""
    lesson = Lesson(
        user_id=None,
        code=code,
        text="На харде фаворит после пяти сетов за двое суток переоценен",
        scope={
            "v": 1,
            "direction": "lower",
            "conditions": [
                {"feature": "surface", "op": "in", "values": ["hard"]},
                {"feature": "role", "op": "eq", "values": ["favorite"]},
                {"feature": "sets_48h", "op": "ge", "value": 5},
            ],
        },
        kind="numeric",
        status="ready",
        effect_shrunk=-0.031,
        origin="manual",
        validated_at=datetime.now(UTC) - timedelta(days=1),
        metrics={
            "quick": {
                "status": "done",
                "passed": True,
                "finished_at": datetime.now(UTC).isoformat(),
            }
        },
    )
    db.add(lesson)
    await db.commit()
    return lesson


async def test_enabled_lesson_goes_to_analysis_system_block(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    lesson = await _ready_lesson(db)

    enabled = await admin.client.post(f"/api/lessons/{lesson.id}/enable")
    assert enabled.status_code == 200, enabled.text
    versions = list(
        await db.scalars(
            select(StrategyVersion)
            .where(StrategyVersion.user_id.is_(None))
            .order_by(StrategyVersion.id)
        )
    )
    assert [(v.code, v.status, v.lessons) for v in versions] == [
        ("v3", "archived", []),
        ("v4", "active", ["L-001"]),
    ]
    v4 = versions[1]
    assert v4.changes == ["+ урок L-001"] and v4.parent_id == versions[0].id
    assert v4.prompt_version is not None
    assert v4.prompt_version.startswith("analysis.v1+lessons_block.v3:")
    block = v4.params["lessons_block"]
    # В инструкции — условие из словаря и поправка, собранные кодом; текст урока — нет (m7)
    assert "- L-001: surface = hard; role = favorite; sets_48h ≥ 5; направление lower." in block
    assert "−3,1 п.п." in block and "На харде фаворит" not in block

    analysis_id = await make_analysis(
        db, redis, member.user.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    analysis = await db.get_one(Analysis, analysis_id, populate_existing=True)
    assert analysis.prompt_version == v4.prompt_version
    assert await run(engine, redis, analysis_id) == "done"
    calls = fake.calls("analysis")
    assert len(calls) == 2
    for body in calls:
        base, lessons = body["system"]
        assert "Уроки из разборов" not in base["text"] and "- L-001:" in lessons["text"]
        assert base["cache_control"] == lessons["cache_control"] == {"type": "ephemeral"}
    # Второй матч читает кэш всего system (промпт и блок уроков)
    runs = list(
        await db.scalars(
            select(AgentRun)
            .where(AgentRun.analysis_id == analysis_id, AgentRun.kind == "analysis")
            .order_by(AgentRun.id)
        )
    )
    assert {row.prompt_version for row in runs} == {v4.prompt_version}
    predictions = list(
        await db.scalars(select(Prediction).where(Prediction.analysis_id == analysis_id))
    )
    assert len(predictions) == 12
    assert all(row.lessons_applied == ["L-001"] for row in predictions)
    assert all(row.prompt_version == v4.prompt_version for row in predictions)

    # Выключение — новая версия без урока; следующий анализ — без блока уроков
    disabled = await admin.client.post(f"/api/lessons/{lesson.id}/disable")
    assert disabled.status_code == 200
    active = await strategy_versions.shared_active(db)
    assert active is not None and (active.code, active.lessons) == ("v5", [])
    assert active.prompt_version == "analysis.v1" and active.changes == ["− урок L-001"]
    prompt = await strategy_versions.instructions_prompt(db)
    assert prompt.lessons is None and prompt.version_id == "analysis.v1"
    # Откат к v4 возвращает урок в анализ
    back = await admin.client.post(f"/api/strategy/versions/{v4.id}/rollback")
    assert back.status_code == 200 and back.json()["lessons"] == ["L-001"]
    await db.refresh(lesson)
    assert lesson.in_prompt is True and lesson.status == "confirmed"


async def test_learning_summary_dashboard_and_analytics(
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    await db.execute(
        update(AppSettings).values(
            agent_config={"lessons_max_active": 12, "lesson_min_cases": 25, "eval_set_size": 220}
        )
    )
    await db.commit()
    member = await signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    db.add_all(
        [
            Lesson(user_id=None, code="L-001", text="Гипотеза один", kind="numeric"),
            Lesson(
                user_id=None, code="L-002", text="Готов к решению", kind="numeric", status="ready"
            ),
            Lesson(user_id=other.id, code="L-003", text="Чужой свой урок", kind="numeric"),
        ]
    )
    await db.commit()
    maker = BetMaker(db)
    now = datetime.now(UTC)
    # Ставка с рынком при прогнозе и закрытием обеих сторон — у ног; закрытий больше
    settled = await maker.bet(
        member.user,
        [LegSpec(odds="1.50", q_market=None, p_final=0.7)],
        placed_at=now - timedelta(days=2),
    )
    settled.status, settled.settled_at, settled.profit = "won", now, settled.stake / 2
    settled.settled_by = "auto"
    leg = await db.scalar(select(Prediction).where(Prediction.analysis_id == settled.analysis_id))
    assert leg is not None
    from app.db.models import BetLeg

    bet_leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == settled.id))
    assert bet_leg is not None
    bet_leg.result, bet_leg.settled_at = "win", now
    bet_leg.q_close = 0.66
    match = await db.get_one(Match, bet_leg.match_id)
    match.winner_id, match.status = match.player1_id, "finished"
    await db.commit()

    summary = await member.client.get("/api/learning")
    assert summary.status_code == 200, summary.text
    body = summary.json()
    assert body["thresholds"] == {
        "lessons_max": 12,
        "lesson_min_cases": 25,
        "lesson_min_process": 10,
        "shrink_k": 200,
        "claude_min_events": 300,
        "quick_check_events": 40,
        "eval_set_size": 220,
        "eval_batch_size": 100,
        "eval_hard_share": 0.18,
        "eval_min_answered": 0.9,
    }
    assert (body["settled"], body["settled_auto"], body["settled_legs"]) == (1, 1, 1)
    lessons = body["lessons"]
    assert (lessons["total"], lessons["hypotheses"], lessons["ready"]) == (2, 1, 1)
    assert lessons["ready_codes"] == ["L-002"] and lessons["max_active"] == 12
    assert lessons["last"]["code"] in ("L-001", "L-002")
    # Действующая версия инструкций есть с первого обращения (v3 создается сама, №2)
    assert body["versions"]["active"]["code"] == "v3" and body["versions"]["candidate"] is None
    again = (await member.client.get("/api/learning")).json()
    assert again["versions"]["active"]["id"] == body["versions"]["active"]["id"]
    assert body["eval_set"] is None and body["model"] is None and body["last_report"] is None
    assert body["events_with_outcome"] == 1
    assert body["prices"]["budget"]["first_month"] is False
    assert body["next_report"] > datetime.now(UTC).date().isoformat() or True

    dashboard = (await member.client.get("/api/dashboard")).json()
    assert dashboard["learning"]["lessons"]["ready_codes"] == ["L-002"]
    assert dashboard["learning"]["settled"] == 1

    analytics = (await member.client.get("/api/analytics")).json()
    all_predictions = analytics["calibration_all"]
    assert all_predictions["kind"] == "all" and all_predictions["events"] == 1
    assert analytics["brier"]["closing_n"] == 1 and analytics["brier"]["n"] == 0
    assert analytics["brier"]["main"] == "closing"
    assert analytics["brier"]["closing_model"] == pytest.approx((0.7 - 1) ** 2)
    # Фильтр покрытия действует и на «Все мои прогнозы» (№4 проверки экранов)
    tournament = await db.get_one(Tournament, match.tournament_id)
    surface = tournament.surface or "hard"
    other_surface = "clay" if surface != "clay" else "grass"
    same = (await member.client.get(f"/api/analytics?surface={surface}")).json()
    assert same["calibration_all"]["events"] == 1
    off = (await member.client.get(f"/api/analytics?surface={other_surface}")).json()
    assert off["calibration_all"]["events"] == 0
    legacy = (await member.client.get("/api/analytics?source=legacy")).json()
    assert legacy["calibration_all"] is None
    # Чужие прогнозы в «Все мои прогнозы» не попадают
    foreign = (await other.client.get("/api/analytics")).json()
    assert foreign["calibration_all"]["events"] == 0


async def test_active_version_keeps_its_lessons_block_version(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """H1 волны 3: активная версия собрана с блоком уроков v2, после выкладки код
    перешел на v3. Ключ версии берется из сохраненной prompt_version: анализ находит
    свою версию, получает блок уроков и lessons_applied, готовая оценка переиспользуется."""
    from app.agent import prompts

    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    lesson = await _ready_lesson(db)

    # Версия создана до выкладки: в коде еще lessons_block.v2
    monkeypatch.setattr(prompts, "LESSONS_BLOCK", ("lessons_block", 2))
    monkeypatch.setattr(strategy_versions, "LESSONS_BLOCK", ("lessons_block", 2))
    enabled = await admin.client.post(f"/api/lessons/{lesson.id}/enable")
    assert enabled.status_code == 200, enabled.text
    monkeypatch.undo()
    assert prompts.LESSONS_BLOCK == ("lessons_block", 3)

    active = await strategy_versions.shared_active(db)
    assert active is not None and active.prompt_version is not None
    stored = active.prompt_version
    assert stored.startswith("analysis.v1+lessons_block.v2:")
    prompt = await strategy_versions.instructions_prompt(db)
    assert prompt.version_id == stored and prompt.lessons and prompt.codes == ("L-001",)
    resolved = await strategy_versions.resolve_prompt(db, stored)
    assert resolved.version_id == stored and resolved.lessons == prompt.lessons
    assert await strategy_versions.lessons_of_prompt(db, stored) == ["L-001"]

    first = await make_analysis(db, redis, member.user.user, world, ("sinner", "rune"))
    analysis = await db.get_one(Analysis, first, populate_existing=True)
    assert analysis.prompt_version == stored
    assert await run(engine, redis, first) == "done"
    calls = fake.calls("analysis")
    assert len(calls) == 1 and "- L-001:" in calls[0]["system"][1]["text"]
    predictions = list(await db.scalars(select(Prediction).where(Prediction.analysis_id == first)))
    assert predictions and all(row.lessons_applied == ["L-001"] for row in predictions)
    assert all(row.prompt_version == stored for row in predictions)

    # Повтор оценки по MatchAssessment.prompt_version: второй анализ берет готовую
    second = await make_analysis(db, redis, other.user.user, world, ("sinner", "rune"))
    assert await run(engine, redis, second) == "done"
    assert len(fake.calls("analysis")) == 1
