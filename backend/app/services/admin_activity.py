"""Активность участников для администратора: входы и число анализов за период (этап 4,
«Администрирование → Обзор» и «Расход ИИ»).

Р14: об участнике администратор видит только расход на ИИ и активность. Здесь —
успешные и неудачные входы из login_events (хранится 90 дней, поэтому период не длиннее)
и число запущенных анализов; ни адресов, ни устройств, ни содержимого анализов.
"""

from datetime import datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Analysis, LoginEvent, User
from app.schemas.admin import ActivityOut, ActivityPeriod, PersonActivityOut
from app.services.bank import user_zone
from app.services.sessions import utcnow

PERIOD_DAYS: dict[str, int] = {"1d": 1, "7d": 7, "30d": 30, "90d": 90}


async def activity(
    db: AsyncSession,
    admin: User,
    period: ActivityPeriod = "30d",
    *,
    now: datetime | None = None,
) -> ActivityOut:
    """Входы и анализы по людям за период; люди — все, кроме удаленных, и удаленные с
    активностью за период. Сначала самые активные."""
    now = now or utcnow()
    since = now - timedelta(days=PERIOD_DAYS[period])
    zone = user_zone(admin.tz)
    today = now.astimezone(zone).replace(hour=0, minute=0, second=0, microsecond=0)

    ok = LoginEvent.result == "ok"
    logins = {
        int(user_id or 0): (int(good), int(bad), int(today_good))
        for user_id, good, bad, today_good in await db.execute(
            select(
                LoginEvent.user_id,
                func.count().filter(ok),
                func.count().filter(~ok),
                func.count().filter(ok, LoginEvent.at >= today),
            )
            .where(LoginEvent.user_id.is_not(None), LoginEvent.at >= since, LoginEvent.at <= now)
            .group_by(LoginEvent.user_id)
        )
    }
    analyses = {
        int(user_id or 0): (int(count), last)
        for user_id, count, last in await db.execute(
            select(Analysis.user_id, func.count(), func.max(Analysis.started_at))
            .where(
                Analysis.user_id.is_not(None),
                Analysis.started_at >= since,
                Analysis.started_at <= now,
            )
            .group_by(Analysis.user_id)
        )
    }
    active_ids = set(logins) | set(analyses)
    users = list(
        await db.scalars(
            select(User)
            .where(or_(User.status != "deleted", User.id.in_(active_ids)))
            .order_by(User.id)
            .execution_options(populate_existing=True)
        )
    )
    people = [
        PersonActivityOut(
            user_id=user.id,
            display_name=user.display_name,
            role=user.role,  # type: ignore[arg-type]
            status=user.status,  # type: ignore[arg-type]
            logins=logins.get(user.id, (0, 0, 0))[0],
            failed_logins=logins.get(user.id, (0, 0, 0))[1],
            last_login_at=user.last_login_at,
            analyses=analyses.get(user.id, (0, None))[0],
            last_analysis_at=analyses.get(user.id, (0, None))[1],
        )
        for user in users
    ]
    people.sort(key=lambda item: (-item.analyses, -item.logins, item.user_id))
    return ActivityOut(
        period=period,
        since=since,
        logins=sum(item.logins for item in people),
        failed_logins=sum(item.failed_logins for item in people),
        analyses=sum(item.analyses for item in people),
        active_users=sum(1 for item in people if item.logins),
        today_users=sum(1 for counts in logins.values() if counts[2]),
        people=people,
    )
