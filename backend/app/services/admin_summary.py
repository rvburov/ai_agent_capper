"""«Администрирование → Сводка» (GET /api/admin/summary, Р27): итоги и строка на каждого
участника вместе с администратором.

Формулы не повторяются: показатели периода у каждого — те же, что на его «Главной»
(dashboard.cached_core_json, тот же кэш), банк — bank_state, анализы и расход ИИ за месяц —
month_usage, как в списке участников. Итоги — суммы по людям; средние CLV и Brier —
средние по всем ставкам и событиям вместе (среднее каждого, взвешенное его числом).
"""

from decimal import Decimal

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.schemas.admin_summary import AdminSummaryOut, SummaryMemberOut, SummaryTotalsOut
from app.schemas.bets import Period
from app.schemas.dashboard import DashboardCoreOut
from app.services.admin_users import month_start, month_usage
from app.services.app_settings import get_app_settings
from app.services.bank import bank_state
from app.services.dashboard import cached_core_json
from app.services.sessions import utcnow

_ZERO = Decimal(0)


def _weighted(pairs: list[tuple[float | None, int]]) -> float | None:
    """Среднее всех значений вместе по средним групп и их размерам."""
    total = sum(n for value, n in pairs if value is not None)
    if not total:
        return None
    return sum(value * n for value, n in pairs if value is not None) / total


async def summary(
    db: AsyncSession, redis: Redis | None, admin: User, period: Period
) -> AdminSummaryOut:
    """Сводка за период: строки по всем, кроме удаленных, и итоги."""
    now = utcnow()
    users = list(await db.scalars(select(User).where(User.status != "deleted")))
    usage = await month_usage(db, [user.id for user in users], now)
    settings = await get_app_settings(db)
    members: list[SummaryMemberOut] = []
    brier: list[tuple[float | None, float | None, int]] = []
    for user in users:
        core = DashboardCoreOut.model_validate_json(await cached_core_json(db, redis, user, period))
        bank = await bank_state(db, user.id, now=now)
        spent, analyses = usage.get(user.id, (_ZERO, 0))
        kpi = core.kpi
        brier.append((core.brier.model, core.brier.market, core.brier.n))
        members.append(
            SummaryMemberOut(
                user_id=user.id,
                name=user.display_name,
                role=user.role,  # type: ignore[arg-type]
                status=user.status,  # type: ignore[arg-type]
                me=user.id == admin.id,
                empty=bank.empty,
                bank=bank.balance,
                bets=kpi.settled,
                turnover=kpi.turnover,
                roi=kpi.roi,
                profit=kpi.profit,
                clv_avg=kpi.clv,
                clv_n=kpi.clv_n,
                analyses=analyses,
                ai_spend_usd=spent,
                last_login_at=user.last_login_at,
            )
        )
    members.sort(key=lambda row: (not row.me, row.empty, -row.profit, row.name, row.user_id))
    turnover = sum((row.turnover for row in members), _ZERO)
    profit = sum((row.profit for row in members), _ZERO)
    totals = SummaryTotalsOut(
        bets=sum(row.bets for row in members),
        turnover=turnover,
        profit=profit,
        roi=float(profit / turnover) if turnover > 0 else None,
        clv_avg=_weighted([(row.clv_avg, row.clv_n) for row in members]),
        clv_n=sum(row.clv_n for row in members if row.clv_avg is not None),
        brier_model=_weighted([(model, n) for model, _, n in brier]),
        brier_market=_weighted([(market, n) for _, market, n in brier]),
        brier_n=sum(n for model, _, n in brier if model is not None),
        members_with_bets=sum(1 for row in members if row.bets > 0),
        bank=sum((row.bank for row in members), _ZERO),
    )
    return AdminSummaryOut(
        period=period,
        currency=settings.currency,
        month_start=month_start(now),
        totals=totals,
        members=members,
    )
