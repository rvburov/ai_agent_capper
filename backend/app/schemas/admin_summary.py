"""Схема «Администрирование → Сводка» (GET /api/admin/summary, Р27): итоги по всем
участникам вместе с администратором и строка на каждого.

Числа — те же, что видит сам участник на «Главной» за тот же период (показатели периода
считает app/services/analytics.py по поясу участника). Суммы — в валюте программы (строкой,
как везде), расход на ИИ — в долларах числом, как в списке участников.
"""

from datetime import datetime

from pydantic import BaseModel

from app.schemas.admin import UsdOut
from app.schemas.analyses import DecimalOut
from app.schemas.bets import Period
from app.schemas.me import Role, UserStatus


class SummaryTotalsOut(BaseModel):
    """Итоги за период по всем вместе. bets — рассчитанные ставки (с возвратами), turnover и
    profit — без возвратов, roi = profit / turnover (пусто — оборота нет). clv_avg — средний
    CLV по clv_n ставкам приложения с закрытием. brier_model и brier_market — Brier модели и
    рынка при прогнозе на одних и тех же brier_n событиях (пусто — событий нет).
    members_with_bets — у скольких людей есть рассчитанные ставки за период. bank — сумма
    текущих банков."""

    bets: int
    turnover: DecimalOut
    profit: DecimalOut
    roi: float | None
    clv_avg: float | None
    clv_n: int
    brier_model: float | None
    brier_market: float | None
    brier_n: int
    members_with_bets: int
    bank: DecimalOut


class SummaryMemberOut(BaseModel):
    """Строка участника. bank — текущий баланс банка (как GET /me/bank: balance); empty —
    журнал банка пуст (ставок и банка нет). bets, roi, profit, clv_avg (и clv_n) — за период,
    как на его «Главной». analyses и ai_spend_usd — за текущий месяц (UTC, с month_start) на
    ключе администратора, как в списке участников. me — это строка самого администратора."""

    user_id: int
    name: str
    role: Role
    status: UserStatus
    me: bool
    empty: bool
    bank: DecimalOut
    bets: int
    turnover: DecimalOut
    roi: float | None
    profit: DecimalOut
    clv_avg: float | None
    clv_n: int
    analyses: int
    ai_spend_usd: UsdOut
    last_login_at: datetime | None


class AdminSummaryOut(BaseModel):
    """Сводка за период (7d, 30d, 90d или all — по поясу каждого участника). members —
    сначала сам администратор, потом участники с данными по убыванию прибыли, потом без
    данных; удаленных нет. month_start — начало месяца анализов и расхода ИИ."""

    period: Period
    currency: str
    month_start: datetime
    totals: SummaryTotalsOut
    members: list[SummaryMemberOut]
