"""Сводка «Обучения модели» (GET /api/learning) и блока «Модель учится» на главной
(этап 5, волна 3; макет learning.js и dashboard.js).

Свое: рассчитанные ставки приложения участника (сколько по архиву, событий в них), сколько
ждут результата, свои правила суммы ставки (активная версия и кандидат). Общее (Р25):
уроки, версии инструкций анализа, базовая модель, замороженный набор, пороги и цены из
настроек. Чужих ставок, сумм и прогнозов в ответе нет (Р14): свои уроки участника видит
только он, общие — все.
"""

from datetime import date, datetime, time, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import batches
from app.agent.config import load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.runs import price_for
from app.db.models import (
    AgentRun,
    Bet,
    BetLeg,
    Lesson,
    MlModel,
    StrategyVersion,
    User,
    WeeklyReport,
)
from app.ml.elo import MODEL_ID
from app.ml.model_versions import CALIBRATION_KIND, active_calibration
from app.schemas.learning import (
    LearningLessonsOut,
    LearningModelOut,
    LearningOut,
    LearningPricesOut,
    LearningThresholdsOut,
    LearningVersionsOut,
    LessonBriefOut,
    VersionBriefOut,
)
from app.services import eval_runs, eval_sets, lesson_quick
from app.services.bank import user_zone
from app.services.bets import bet_counts
from app.services.check_runs import eval_budget
from app.services.recalibration import events_with_outcome
from app.services.sessions import utcnow
from app.services.strategy_versions import (
    ACTIVE,
    CANDIDATE,
    active_version,
    checked_on_set,
    ensure_shared_ready,
    shared_active,
    system_prompt_of,
)

# Еженедельный отчет — понедельник, 07:00 по поясу участника (В8)
REPORT_HOUR = 7
# Живая цена разбора: средняя по последним разборам
LIVE_POSTMORTEMS = 200


def next_report_day(now: datetime, tz: str | None) -> date:
    """Понедельник следующего отчета по поясу участника: сегодня, если сегодня понедельник
    и 07:00 еще не наступило, иначе ближайший следующий понедельник."""
    zone = user_zone(tz)
    local = now.astimezone(zone)
    today = local.date()
    if today.weekday() == 0 and local.time() < time(REPORT_HOUR):
        return today
    return today + timedelta(days=(7 - today.weekday()) % 7 or 7)


async def _settled(db: AsyncSession, user: User) -> tuple[int, int, int]:
    """Рассчитанные ставки приложения участника, из них авторасчетом, ног в них."""
    settled = (Bet.user_id == user.id, Bet.source == "app", Bet.status != "open")
    row = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(Bet.settled_by == "auto"),
            ).where(*settled)
        )
    ).one()
    legs = await db.scalar(
        select(func.count()).select_from(BetLeg).join(Bet, Bet.id == BetLeg.bet_id).where(*settled)
    )
    return int(row[0] or 0), int(row[1] or 0), int(legs or 0)


async def _lessons(db: AsyncSession, user: User, max_active: int) -> LearningLessonsOut:
    visible = (Lesson.user_id.is_(None)) | (Lesson.user_id == user.id)
    rows = await db.execute(
        select(Lesson.status, func.count()).where(visible).group_by(Lesson.status)
    )
    counts = {str(status): int(count) for status, count in rows}
    in_prompt = await db.scalar(
        select(func.count())
        .select_from(Lesson)
        .where(Lesson.user_id.is_(None), Lesson.in_prompt.is_(True))
    )
    ready = list(
        await db.scalars(
            select(Lesson.code).where(visible, Lesson.status == "ready").order_by(Lesson.code)
        )
    )
    last = await db.scalar(
        select(Lesson)
        .where(visible, Lesson.status.not_in(("rejected", "retired")))
        .order_by(Lesson.created_at.desc(), Lesson.id.desc())
        .limit(1)
    )
    return LearningLessonsOut(
        in_prompt=int(in_prompt or 0),
        max_active=max_active,
        total=sum(int(value) for value in counts.values()),
        hypotheses=int(counts.get("hypothesis", 0)),
        ready=int(counts.get("ready", 0)),
        confirmed=int(counts.get("confirmed", 0)),
        rejected=int(counts.get("rejected", 0)),
        retired=int(counts.get("retired", 0)),
        ready_codes=ready,
        last=LessonBriefOut(
            id=last.id,
            code=last.code,
            text=last.text,
            status=last.status,
            created_at=last.created_at,
        )
        if last is not None
        else None,
    )


async def _brief(db: AsyncSession, version: StrategyVersion | None) -> VersionBriefOut | None:
    if version is None:
        return None
    shared = version.user_id is None
    checked = shared and version.status == CANDIDATE and await checked_on_set(db, version.id)
    passed = (version.metrics or {}).get("passed") if checked else None
    return VersionBriefOut(
        id=version.id,
        code=version.code,
        name=version.name or version.code,
        status=version.status,  # type: ignore[arg-type]
        activated_at=version.approved_at if version.status == ACTIVE else None,
        checked=checked,
        passed=passed if isinstance(passed, bool) else None,
        rule=eval_runs.rule_for(version) if shared and version.status == CANDIDATE else None,  # type: ignore[arg-type]
    )


async def _versions(db: AsyncSession, user: User) -> LearningVersionsOut:
    candidate = await db.scalar(
        select(StrategyVersion)
        .where(StrategyVersion.user_id.is_(None), StrategyVersion.status == CANDIDATE)
        .order_by(StrategyVersion.created_at.desc(), StrategyVersion.id.desc())
        .limit(1)
    )
    own_candidate = await db.scalar(
        select(StrategyVersion)
        .where(StrategyVersion.user_id == user.id, StrategyVersion.status == CANDIDATE)
        .order_by(StrategyVersion.id.desc())
        .limit(1)
    )
    active = await _brief(db, await ensure_shared_ready(db))
    assert active is not None
    return LearningVersionsOut(
        active=active,
        candidate=await _brief(db, candidate),
        rules_active=await _brief(db, await active_version(db, user.id)),
        rules_candidate=await _brief(db, own_candidate),
    )


async def model_brief(db: AsyncSession) -> LearningModelOut | None:
    """Базовая модель на плитке и в отчете недели."""
    model: MlModel | None = await active_calibration(db)
    if model is None:
        model = await db.get(MlModel, MODEL_ID)
    if model is None:
        return None
    metrics = model.metrics or {}
    # Последняя перекалибровка: версия калибровки, подобранная заново (перенос калибровки
    # elo-v1 в первую версию — не перекалибровка), включена она или отклонена
    recalibrated = await db.scalar(
        select(func.max(MlModel.created_at)).where(
            MlModel.kind == CALIBRATION_KIND,
            MlModel.metrics["source"].astext.is_distinct_from(MODEL_ID),
        )
    )
    return LearningModelOut(
        id=model.id,
        brier=metrics.get("brier"),
        log_loss=metrics.get("log_loss"),
        activated_at=model.activated_at or model.created_at,
        auto=model.kind == CALIBRATION_KIND
        and model.activated_by is None
        and metrics.get("started_by") is None
        and metrics.get("source") != MODEL_ID,
        recalibrated_at=recalibrated,
    )


async def _prices(db: AsyncSession) -> LearningPricesOut:
    config = await load_agent_config(db)
    budget = await eval_budget(db)
    postmortem = quick = event_worst = Decimal(0)
    try:
        post_price = await price_for(db, config.postmortem_model)
        recent = (
            select(AgentRun.cost_usd)
            .where(AgentRun.kind == "postmortem", AgentRun.batch.is_(True), AgentRun.cost_usd > 0)
            .order_by(AgentRun.id.desc())
            .limit(LIVE_POSTMORTEMS)
            .subquery()
        )
        live = await db.scalar(select(func.avg(recent.c.cost_usd)))
        postmortem = batches.round_usd(
            Decimal(live)
            if live is not None
            else batches.request_estimate_usd(
                post_price,
                input_tokens=config.estimate_postmortem_input_tokens,
                output_tokens=config.estimate_postmortem_output_tokens,
            )
        )
    except ClaudeStepError:
        pass
    try:
        price = await price_for(db, config.analysis_model)
        live_eval = await lesson_quick.live_request_usd(db, config.analysis_model)
        one = (
            live_eval
            if live_eval is not None
            else batches.request_estimate_usd(
                price,
                input_tokens=config.estimate_analysis_input_tokens,
                output_tokens=config.estimate_analysis_output_tokens,
            )
        )
        quick = batches.round_usd(one * config.quick_check_events)
        event_worst = batches.round_usd(
            eval_runs.per_event_worst(price, config, system_prompt_of(await shared_active(db)))
        )
    except ClaudeStepError:
        pass
    return LearningPricesOut(
        postmortem_usd=postmortem,
        quick_check_usd=quick,
        eval_event_worst_usd=event_worst,
        budget=eval_runs.budget_out(budget),
    )


async def learning_out(db: AsyncSession, user: User, *, now: datetime | None = None) -> LearningOut:
    """Сводка экрана «Обучение модели» и блока «Модель учится»."""
    moment = now or utcnow()
    config = await load_agent_config(db)
    settled, auto, legs = await _settled(db, user)
    eval_set = await eval_sets.latest_set(db)
    last = await db.scalar(
        select(WeeklyReport)
        .where(WeeklyReport.user_id == user.id)
        .order_by(WeeklyReport.week_start.desc())
        .limit(1)
    )
    return LearningOut(
        settled=settled,
        settled_auto=auto,
        settled_legs=legs,
        awaiting=(await bet_counts(db, user, moment)).awaiting_result,
        events_with_outcome=await events_with_outcome(db),
        lessons=await _lessons(db, user, config.lessons_max_active),
        versions=await _versions(db, user),
        model=await model_brief(db),
        eval_set=eval_sets.set_out(eval_set) if eval_set is not None else None,
        thresholds=LearningThresholdsOut(
            lessons_max=config.lessons_max_active,
            lesson_min_cases=config.lesson_min_cases,
            lesson_min_process=config.lesson_min_cases_process,
            shrink_k=config.lesson_shrink_k,
            claude_min_events=config.claude_min_events,
            quick_check_events=config.quick_check_events,
            eval_set_size=config.eval_set_size,
            eval_batch_size=config.eval_batch_size,
            eval_hard_share=config.eval_hard_share,
            eval_min_answered=config.eval_min_answered,
        ),
        prices=await _prices(db),
        next_report=next_report_day(moment, user.tz),
        last_report=last.week_start if last is not None else None,
        last_report_end=last.week_start + timedelta(days=6) if last is not None else None,
        last_report_id=last.id if last is not None else None,
    )
