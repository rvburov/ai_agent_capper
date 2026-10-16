"""Еженедельный отчет участника (В8 Р25, Т24; этап 5, волна 4).

Неделя — с понедельника 00:00 по воскресенье 24:00 по поясу участника. Отчет за прошлую
неделю собирается в понедельник в REPORT_HOUR (07:00) по тому же поясу: задача воркера
раз в час выбирает тех, у кого этот момент уже наступил, а отчета за неделю еще нет
(не успел час — отчет придет на следующем запуске). Один отчет на неделю:
UNIQUE(user_id, week_start) и INSERT … ON CONFLICT DO NOTHING; уведомление — только тому,
чей отчет записан сейчас, поэтому две задачи одновременно не шлют двух уведомлений.

Отчет — снимок (weekly_reports.payload): ставки, рассчитанные за неделю (сами по архиву и
вручную), прибыль и ROI, CLV, Brier модели против рынка и калибровка на событиях этих
ставок, разборы ИИ их матчей, уроки недели, расход на проверки, состояние базовой
модели. Пустая неделя (ни одной рассчитанной ставки) — короткий отчет: «ставок не было»,
расход и модель — есть. Администратору — еще общее по программе (shared): только
счетчики и расход ИИ, без ставок и сумм участников (Р14). Пользователь, которого еще не
было к концу недели, отчета за нее не получает; заблокированные и удаленные — тоже.
"""

from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

import structlog
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.formatting import format_money, format_pct, format_week
from app.core.i18n import t
from app.db.models import (
    AgentRun,
    Analysis,
    Bet,
    Lesson,
    MlModel,
    Postmortem,
    User,
    WeeklyReport,
)
from app.ml.elo import MODEL_ID
from app.ml.model_versions import CALIBRATION_KIND
from app.schemas.reports import (
    ReportAccuracyOut,
    ReportBetsOut,
    ReportCalibrationOut,
    ReportClvOut,
    ReportEvalOut,
    ReportLessonsOut,
    ReportModelOut,
    ReportReviewsOut,
    ReportSharedOut,
    WeeklyReportBriefOut,
    WeeklyReportOut,
    WeeklyReportsOut,
)
from app.services.admin_users import CHECK_RUN_KINDS
from app.services.analytics import bet_clvs, calibration_events, settled_rows, totals
from app.services.app_settings import get_app_settings
from app.services.bank import user_zone
from app.services.check_runs import eval_budget
from app.services.learning import REPORT_HOUR, model_brief, next_report_day
from app.services.notifications import notify
from app.services.sessions import utcnow

# Версия формы payload: старые отчеты читаются по своей версии
PAYLOAD_VERSION = 1
# Куда ведет уведомление: вкладка «Отчеты» с открытым отчетом
REPORT_LINK = "/learning/reports?report={id}"
REPORTS_LIMIT = 104
ZERO = Decimal(0)
# Насколько начало недели может разойтись с концом прошлого отчета (смена пояса — до 26 ч):
# дальше — это пропуск недель, а не сдвиг пояса, и неделя считается по своим границам
CONTINUE_GAP = timedelta(hours=27)

log = structlog.get_logger(__name__)


# --- неделя ---


@dataclass(frozen=True)
class Week:
    """Неделя по поясу участника: дни start–end (пн–вс), границы [begin, finish) в UTC и
    момент отчета due (понедельник после недели, REPORT_HOUR по поясу)."""

    start: date
    tz: str
    begin: datetime
    finish: datetime
    due: datetime

    @property
    def end(self) -> date:
        return self.start + timedelta(days=6)


def week_of(start: date, tz: str | None) -> Week:
    zone = user_zone(tz)
    begin = datetime.combine(start, time.min, tzinfo=zone).astimezone(UTC)
    after = start + timedelta(days=7)
    finish = datetime.combine(after, time.min, tzinfo=zone).astimezone(UTC)
    due = datetime.combine(after, time(REPORT_HOUR), tzinfo=zone).astimezone(UTC)
    return Week(start=start, tz=zone.key, begin=begin, finish=finish, due=due)


async def continue_week(db: AsyncSession, user: User, week: Week) -> Week:
    """Неделя продолжает прошлый отчет: начало — конец прошлого отчета (payload.finish).
    Участник сменил пояс — границы по новому поясу сдвинулись до 26 часов, и без этого
    ставка на стыке попала бы в 0 или в 2 отчета."""
    previous = await db.scalar(
        select(WeeklyReport.payload)
        .where(WeeklyReport.user_id == user.id, WeeklyReport.week_start < week.start)
        .order_by(WeeklyReport.week_start.desc())
        .limit(1)
    )
    raw = (previous or {}).get("finish")
    if not raw:
        return week
    finish = datetime.fromisoformat(str(raw))
    if finish == week.begin or abs(finish - week.begin) > CONTINUE_GAP:
        return week
    return replace(week, begin=min(finish, week.finish))


def due_week(now: datetime, tz: str | None) -> Week:
    """Последняя неделя, отчет за которую уже должен прийти: момент отчета (понедельник,
    REPORT_HOUR по поясу) не позже now."""
    zone = user_zone(tz)
    local = now.astimezone(zone)
    monday = local.date() - timedelta(days=local.weekday())
    if local < datetime.combine(monday, time(REPORT_HOUR), tzinfo=zone):
        monday -= timedelta(days=7)
    return week_of(monday - timedelta(days=7), tz)


# --- части отчета ---


def _in(column: Any, week: Week) -> Any:
    return (column >= week.begin) & (column < week.finish)


async def _bets(
    db: AsyncSession, user: User, week: Week, moment: datetime
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], set[int]]:
    """Ставки, CLV, точность и калибровка недели; матчи рассчитанных ставок."""
    conds = [Bet.user_id == user.id, Bet.source == "app", _in(Bet.settled_at, week)]
    sums = await totals(db, [*conds, Bet.status != "open"])
    auto = await db.scalar(
        select(func.count()).where(*conds, Bet.status != "open", Bet.settled_by == "auto")
    )
    placed = await db.scalar(
        select(func.count()).where(
            Bet.user_id == user.id, Bet.source == "app", _in(Bet.placed_at, week)
        )
    )
    still_open = await db.scalar(
        select(func.count()).where(
            Bet.user_id == user.id, Bet.status == "open", Bet.placed_at < moment
        )
    )
    rows = await settled_rows(db, user, conds)
    bets = {
        "settled": sums.settled,
        "auto": int(auto or 0),
        "manual": sums.settled - int(auto or 0),
        "won": sums.won,
        "lost": sums.lost,
        "void": sums.void,
        "turnover": str(sums.turnover),
        "profit": str(sums.profit),
        "roi": sums.roi,
        "placed": int(placed or 0),
        "open": int(still_open or 0),
    }
    clvs = bet_clvs(rows)
    clv = {
        "mean": sum(clvs) / len(clvs) if clvs else None,
        "n": len(clvs),
        "positive": sum(1 for value in clvs if value > 0),
    }
    decided = [(bet, leg) for bet in rows for leg in bet.legs if leg.result in ("win", "loss")]
    events = calibration_events(decided, "final")
    pred = [event for event in events if event.leg.q_market is not None]
    closing = [event for event in events if event.leg.q_close is not None]
    source = "closing" if len(closing) > len(pred) else "pred"
    chosen = closing if source == "closing" else pred
    model = market = None
    if chosen:
        model = sum((event.p - event.y) ** 2 for event in chosen) / len(chosen)

        def q(event: Any) -> float:
            value = event.leg.q_close if source == "closing" else event.leg.q_market
            return float(value or 0)

        market = sum((q(event) - event.y) ** 2 for event in chosen) / len(chosen)
    accuracy = {
        "n": len(chosen),
        "model": model,
        "market": market,
        "diff": model - market if model is not None and market is not None else None,
        "source": source,
    }
    calibration = {
        "n": len(events),
        "mean_p": sum(event.p for event in events) / len(events) if events else None,
        "hit_rate": sum(event.y for event in events) / len(events) if events else None,
    }
    matches = {leg.match_id for bet in rows for leg in bet.legs if leg.result in ("win", "loss")}
    return bets, clv, accuracy, calibration, matches


async def _reviews(db: AsyncSession, matches: set[int]) -> dict[str, Any]:
    """Разборы матчей недели: один на матч (общий), готов или ждет."""
    if not matches:
        return {"done": 0, "pending": 0, "cost_usd": "0"}
    rows = await db.execute(
        select(Postmortem.match_id, Postmortem.status, AgentRun.cost_usd)
        .outerjoin(AgentRun, AgentRun.id == Postmortem.agent_run_id)
        .where(Postmortem.match_id.in_(matches))
    )
    done: dict[int, Decimal] = {}
    pending: set[int] = set()
    for match_id, status, cost in rows:
        if status == "done":
            done[match_id] = max(done.get(match_id, ZERO), Decimal(cost or 0))
        elif status in ("queued", "submitted"):
            pending.add(match_id)
    return {
        "done": len(done),
        "pending": len(pending - set(done)),
        "cost_usd": str(sum(done.values(), ZERO)),
    }


async def _lessons(db: AsyncSession, user: User, week: Week) -> dict[str, Any]:
    visible = Lesson.user_id.is_(None) | (Lesson.user_id == user.id)

    async def codes(*conds: Any) -> list[str]:
        found = await db.scalars(select(Lesson.code).where(visible, *conds).order_by(Lesson.code))
        return list(found)

    in_prompt = await db.scalar(
        select(func.count()).select_from(Lesson).where(visible, Lesson.in_prompt.is_(True))
    )
    return {
        "new": await codes(_in(Lesson.created_at, week)),
        "confirmed": await codes(
            _in(Lesson.validated_at, week), Lesson.status.in_(("ready", "confirmed"))
        ),
        "enabled": await codes(_in(Lesson.decided_at, week), Lesson.in_prompt.is_(True)),
        "retired": await codes(_in(Lesson.retired_at, week)),
        "in_prompt": int(in_prompt or 0),
    }


async def _eval(db: AsyncSession, week: Week, moment: datetime) -> dict[str, Any]:
    checks = AgentRun.kind.in_(CHECK_RUN_KINDS)
    spent, runs = (
        await db.execute(
            select(
                func.coalesce(func.sum(AgentRun.cost_usd), 0),
                func.count(AgentRun.eval_run_id.distinct()),
            ).where(checks, _in(AgentRun.created_at, week))
        )
    ).one()
    budget = await eval_budget(db, moment)
    return {
        "spent_usd": str(Decimal(spent)),
        "runs": int(runs or 0),
        "budget_usd": str(budget.budget_usd),
        "month_spent_usd": str(budget.spent_usd),
    }


async def _model(db: AsyncSession, week: Week) -> dict[str, Any]:
    brief = await model_brief(db)
    recalibration = await db.scalar(
        select(MlModel)
        .where(
            MlModel.kind == CALIBRATION_KIND,
            MlModel.metrics["source"].astext.is_distinct_from(MODEL_ID),
            _in(MlModel.created_at, week),
        )
        .order_by(MlModel.created_at.desc())
        .limit(1)
    )
    return {
        "id": brief.id if brief is not None else None,
        "brier": brief.brier if brief is not None else None,
        "log_loss": brief.log_loss if brief is not None else None,
        "recalibrated_at": recalibration.created_at.isoformat()
        if recalibration is not None
        else None,
        "recalibration_activated": recalibration.activated_at is not None
        if recalibration is not None
        else None,
    }


async def _shared(db: AsyncSession, week: Week) -> dict[str, Any]:
    """Общее по программе для администратора: счетчики и расход ИИ, без ставок и сумм
    участников (Р14)."""
    settled = (
        Bet.source == "app",
        Bet.status != "open",
        _in(Bet.settled_at, week),
    )
    members, count, auto = (
        await db.execute(
            select(
                func.count(Bet.user_id.distinct()),
                func.count(),
                func.count().filter(Bet.settled_by == "auto"),
            ).where(*settled)
        )
    ).one()
    reviews, reviews_usd = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(AgentRun.cost_usd), 0)).where(
                AgentRun.kind == "postmortem", _in(AgentRun.created_at, week)
            )
        )
    ).one()
    analyses = await db.scalar(
        select(func.count()).select_from(Analysis).where(_in(Analysis.started_at, week))
    )
    ai_usd = await db.scalar(
        select(func.coalesce(func.sum(AgentRun.cost_usd), 0)).where(
            AgentRun.key_source == "admin",
            AgentRun.kind.not_in(CHECK_RUN_KINDS),
            _in(AgentRun.created_at, week),
        )
    )
    return {
        "members": int(members or 0),
        "settled": int(count or 0),
        "auto": int(auto or 0),
        "reviews": int(reviews or 0),
        "reviews_usd": str(Decimal(reviews_usd)),
        "analyses": int(analyses or 0),
        "ai_usd": str(Decimal(ai_usd or 0)),
    }


async def build_payload(
    db: AsyncSession, user: User, week: Week, *, now: datetime | None = None
) -> dict[str, Any]:
    """Снимок отчета недели (JSON для weekly_reports.payload)."""
    moment = now or utcnow()
    settings = await get_app_settings(db)
    bets, clv, accuracy, calibration, matches = await _bets(db, user, week, moment)
    return {
        "version": PAYLOAD_VERSION,
        "tz": week.tz,
        # Границы недели в UTC: следующий отчет начинается с finish (continue_week)
        "begin": week.begin.isoformat(),
        "finish": week.finish.isoformat(),
        "currency": settings.currency,
        "empty": bets["settled"] == 0,
        "bets": bets,
        "clv": clv,
        "accuracy": accuracy,
        "calibration": calibration,
        "reviews": await _reviews(db, matches),
        "lessons": await _lessons(db, user, week),
        "eval": await _eval(db, week, moment),
        "model": await _model(db, week),
        "shared": await _shared(db, week) if user.role == "admin" else None,
    }


# --- уведомление ---


def _notify_params(payload: dict[str, Any], week: Week) -> dict[str, Any]:
    bets, clv = payload["bets"], payload["clv"]
    currency = str(payload["currency"])
    roi = bets.get("roi")
    mean = clv.get("mean")
    return {
        "week": format_week(week.start, week.end),
        "settled": bets["settled"],
        "placed": bets.get("placed", 0),
        "open": bets.get("open", 0),
        "auto": bets["auto"],
        "profit": format_money(Decimal(bets["profit"]), currency, signed=True),
        "roi": format_pct(roi) if roi is not None else t("notifications.weekly_report.no_roi"),
        "clv": format_pct(mean) if mean is not None else t("notifications.weekly_report.no_clv"),
    }


def _variant(payload: dict[str, Any]) -> str | None:
    """Текст уведомления: обычный; ставки есть, но еще не рассчитаны (файл tennis-data
    загружают раз в неделю) — «ждут результата»; «ставок не было» — только когда за неделю
    не поставлено и не ждет результата ни одной."""
    if not payload["empty"]:
        return None
    bets = payload["bets"]
    return "waiting" if bets.get("placed") or bets.get("open") else "empty"


# --- задача воркера ---


async def _candidates(db: AsyncSession, now: datetime) -> list[tuple[User, Week]]:
    users = list(await db.scalars(select(User).where(User.status == "active").order_by(User.id)))
    due = [(user, due_week(now, user.tz)) for user in users]
    # Пользователя еще не было к концу недели — отчета за нее нет
    due = [(user, week) for user, week in due if user.created_at < week.finish]
    if not due:
        return []
    done = set(
        (
            await db.execute(
                select(WeeklyReport.user_id, WeeklyReport.week_start).where(
                    WeeklyReport.user_id.in_([user.id for user, _ in due])
                )
            )
        ).all()
    )
    return [(user, week) for user, week in due if (user.id, week.start) not in done]


async def make_report(
    db: AsyncSession, user: User, week: Week, *, now: datetime | None = None
) -> WeeklyReport | None:
    """Отчет недели и уведомление weekly_report. Отчет за эту неделю уже есть (его
    записала другая задача) — None, уведомления нет. Делает commit."""
    moment = now or utcnow()
    week = await continue_week(db, user, week)
    payload = await build_payload(db, user, week, now=moment)
    stmt = (
        insert(WeeklyReport)
        .values(user_id=user.id, week_start=week.start, payload=payload, created_at=moment)
        .on_conflict_do_nothing(index_elements=[WeeklyReport.user_id, WeeklyReport.week_start])
        .returning(WeeklyReport.id)
    )
    report_id = await db.scalar(stmt)
    if report_id is None:
        # Отчет за эту неделю уже записала другая задача: ничего не меняли
        await db.commit()
        return None
    await notify(
        db,
        user_id=user.id,
        kind="weekly_report",
        variant=_variant(payload),
        link=REPORT_LINK.format(id=report_id),
        **_notify_params(payload, week),
    )
    await db.commit()
    return await db.get(WeeklyReport, report_id)


async def send_due_reports(db: AsyncSession, *, now: datetime | None = None) -> list[int]:
    """Отчеты всем, у кого наступил понедельник REPORT_HOUR, а отчета за прошлую неделю
    нет. Возвращает id записанных отчетов."""
    moment = now or utcnow()
    made: list[int] = []
    due = [(user.id, week) for user, week in await _candidates(db, moment)]
    for user_id, week in due:
        try:
            # После отката сбойного участника объекты сессии устарели — берем заново
            user = await db.get(User, user_id)
            if user is None:
                continue
            report = await make_report(db, user, week, now=moment)
        except Exception:
            # Сбой на одном участнике не должен оставлять без отчетов всех после него:
            # его отчет повторится на следующем запуске
            await db.rollback()
            log.exception("weekly_report.failed", user_id=user_id, week=str(week.start))
            continue
        if report is not None:
            made.append(report.id)
    return made


# --- экраны ---


def _week_end(start: date) -> date:
    return start + timedelta(days=6)


def report_out(report: WeeklyReport) -> WeeklyReportOut:
    payload = report.payload or {}
    return WeeklyReportOut(
        id=report.id,
        week_start=report.week_start,
        week_end=_week_end(report.week_start),
        created_at=report.created_at,
        tz=str(payload.get("tz") or ""),
        currency=str(payload.get("currency") or ""),
        empty=bool(payload.get("empty")),
        bets=ReportBetsOut(**payload["bets"]),
        clv=ReportClvOut(**payload["clv"]),
        accuracy=ReportAccuracyOut(**payload["accuracy"]),
        calibration=ReportCalibrationOut(**payload["calibration"]),
        reviews=ReportReviewsOut(**payload["reviews"]),
        lessons=ReportLessonsOut(**payload["lessons"]),
        eval=ReportEvalOut(**payload["eval"]),
        model=ReportModelOut(**payload["model"]),
        shared=ReportSharedOut(**payload["shared"]) if payload.get("shared") else None,
    )


def _brief(report: WeeklyReport) -> WeeklyReportBriefOut:
    payload = report.payload or {}
    bets = payload.get("bets") or {}
    return WeeklyReportBriefOut(
        id=report.id,
        week_start=report.week_start,
        week_end=_week_end(report.week_start),
        created_at=report.created_at,
        empty=bool(payload.get("empty")),
        currency=str(payload.get("currency") or ""),
        settled=int(bets.get("settled") or 0),
        profit=Decimal(str(bets.get("profit") or "0")),
        roi=bets.get("roi"),
        clv=(payload.get("clv") or {}).get("mean"),
    )


async def list_reports(
    db: AsyncSession, user: User, *, now: datetime | None = None
) -> WeeklyReportsOut:
    """Свои отчеты, новые сверху (до REPORTS_LIMIT — два года)."""
    rows = await db.scalars(
        select(WeeklyReport)
        .where(WeeklyReport.user_id == user.id)
        .order_by(WeeklyReport.week_start.desc())
        .limit(REPORTS_LIMIT)
    )
    return WeeklyReportsOut(
        items=[_brief(row) for row in rows],
        next_report=next_report_day(now or utcnow(), user.tz),
        report_hour=REPORT_HOUR,
    )


async def report_detail(db: AsyncSession, user: User, report_id: int) -> WeeklyReportOut:
    """Свой отчет; чужой и несуществующий — 404 report.not_found."""
    report = await db.scalar(
        select(WeeklyReport).where(WeeklyReport.id == report_id, WeeklyReport.user_id == user.id)
    )
    if report is None:
        raise AppError(404, "report.not_found")
    return report_out(report)
