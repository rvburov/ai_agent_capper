"""Схема главной (GET /api/dashboard): банк, показатели за период с изменением к
прошлому, ряд банка и последние ставки, открытые ставки, «Мои матчи сегодня» (В6),
«Требует внимания» (адаптации Р22 — из bank; у администратора — архив, просьбы о ключе и
участники у лимита). Расходы ИИ экран берет из GET /api/ai/budget.

Показатели — те же числа, что «Аналитика» и итоги «Ставок» за тот же период (одна
функция расчета, app/services/analytics.py), без доверительных интервалов.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.admin import UsdOut
from app.schemas.analyses import BetKind, DecimalOut, Market
from app.schemas.analytics import (
    BrierOut,
    ChangeOut,
    KpiOut,
    PrevOut,
    SeriesOut,
    ThresholdsOut,
)
from app.schemas.bets import BankOut, BetItemOut, BetSource, BetStatus, Period, PlayerRefOut
from app.schemas.learning import LearningOut

# Приветствие по времени суток в поясе участника: 5–12 утро, 12–17 день, 17–23 вечер
Greeting = Literal["morning", "day", "evening", "night"]


class RecentBetOut(BaseModel):
    """Рассчитанная ставка периода для таблицы «Динамика банка»: equity_after — капитал
    сразу после ее расчета («Банк после»)."""

    id: int
    placed_at: datetime
    settled_at: datetime | None
    legs: int
    total_odds: DecimalOut
    status: BetStatus
    stake: DecimalOut
    profit: DecimalOut | None
    source: BetSource
    kind: BetKind
    equity_after: DecimalOut | None


class DashboardCoreOut(BaseModel):
    """Часть главной, которая считается по ставкам периода (кэшируется вместе с
    аналитикой): показатели, прошлый период, Brier против рынка, ряд банка, последние
    рассчитанные ставки периода (новые сверху, до RECENT_LIMIT; всего — kpi.settled).
    small_sample — рассчитанных ставок меньше thresholds.dashboard_small."""

    period: Period
    date_from: date | None
    date_to: date
    kpi: KpiOut
    prev: PrevOut | None
    change: ChangeOut | None
    brier: BrierOut
    series: SeriesOut
    recent: list[RecentBetOut]
    small_sample: bool


class OpenBetOut(BetItemOut):
    """Открытая ставка: implied — 1 / кэф каждой ноги (вероятность по кэфу букмекера, с его
    маржой) в порядке legs; вероятность модели — legs[].p_final."""

    implied: list[float]


class MyMatchBetOut(BaseModel):
    """Нога открытой ставки на этом матче."""

    bet_id: int
    leg_id: int
    market: Market
    selection: int
    odds_taken: DecimalOut


class MyMatchOut(BaseModel):
    """Мой матч сегодня (В6): из ног открытых ставок и сегодняшних анализов участника.
    rank1 и rank2 — место по Эло (null — нет в таблице текущего Эло); tournament — из
    архива или своего ввода; scheduled_at — время, если известно."""

    match_id: int
    player1: PlayerRefOut
    player2: PlayerRefOut
    rank1: int | None
    rank2: int | None
    tournament: str | None
    round: str | None
    scheduled_at: datetime | None
    bets: list[MyMatchBetOut]
    analyses: list[int]


class ArchiveSourceOut(BaseModel):
    source: Literal["sackmann", "tennis_data"]
    last_load: datetime | None


class ArchiveStaleOut(BaseModel):
    """Архив матчей устарел (то же правило, что уведомление data_stale): days — дней с
    самой старой из последних успешных загрузок (null — какой-то архив не загружался ни
    разу), stale_after_days — порог; update_hour_utc и update_minute — когда идет ночное
    обновление (UTC)."""

    days: int | None
    last_load: datetime | None
    stale_after_days: int
    update_hour_utc: int
    update_minute: int
    sources: list[ArchiveSourceOut]


class ArchiveStatusOut(ArchiveStaleOut):
    """Свежесть архива матчей всегда, и когда он свежий: stale — устарел ли (то же
    правило, что archive в делах и уведомление data_stale). Нужен кабинету
    «Уведомления» (порог и последняя загрузка в подсказке) и главной."""

    stale: bool


class KeyReturnRequestOut(BaseModel):
    """Участник просит вернуть ключ администратора (Р12)."""

    user_id: int
    name: str
    at: datetime


class LimitAlertOut(BaseModel):
    """Участник у месячного лимита на ключе администратора: level 80 — дошел до порога
    предупреждения (alert_pct), 100 — остатка не хватает на анализ (то же правило, что у
    уведомлений limit_80 и limit_100). runs_out_on — день (UTC), когда при нынешнем темпе
    месяца лимит кончится (пусто — не в этом месяце или уже кончился). Р14: только
    расход на ИИ."""

    user_id: int
    name: str
    spent_usd: UsdOut
    limit_usd: UsdOut
    share: float
    level: Literal["80", "100"]
    runs_out_on: date | None


class AdminAttentionOut(BaseModel):
    """Дела администратора на главной. archive — дело «Архив матчей не обновлялся»
    (null — архив свежий); archive_status — свежесть архива всегда, с признаком stale."""

    archive: ArchiveStaleOut | None
    archive_status: ArchiveStatusOut
    return_requests: list[KeyReturnRequestOut]
    limits: list[LimitAlertOut]
    alert_pct: int


class DashboardOut(DashboardCoreOut):
    """Главная одним ответом. bank — как GET /me/bank (капитал «с учетом ставок в игре»,
    пик, просадка, адаптации Р22 со статусом); open_bets — открытые ставки (новые сверху,
    до OPEN_LIMIT; всего — open_count на open_stake), из них awaiting_count ждут результата
    (все матчи прошли, этап 5); admin — только у администратора. learning — «Модель
    учится» и строки «Требует внимания» об обучении (кандидат ждет решения, урок готов к
    проверке — learning.versions.candidate, learning.lessons.ready_codes; этап 5, волна 3)."""

    currency: str
    tz: str
    today: date
    greeting: Greeting
    thresholds: ThresholdsOut
    bank: BankOut
    open_bets: list[OpenBetOut]
    open_count: int
    open_stake: DecimalOut
    awaiting_count: int
    my_matches: list[MyMatchOut]
    admin: AdminAttentionOut | None
    learning: LearningOut
