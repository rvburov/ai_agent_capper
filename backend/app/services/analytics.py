"""Аналитика ставок участника — одна функция расчета для главной, «Ставок» и «Аналитики»
(решения Т4, Т5; согласованный макет analytics.js). Видит только сам участник (Р14).

Выборка. Ставка попадает в период по времени ставки (как фильтры «Ставок»: последние N
дней с сегодняшним по поясу участника или даты from–to), под фильтры рынка и покрытия —
если у нее есть такая нога. Прошлый период той же длины сравнивается, только если история
участника покрывает его целиком (как в макете). Показатели (KPI) считает тот же запрос,
что итоги «Ставок» (app/services/bets.py, summary_query): главная = аналитика без
фильтров = итоги «Ставок» по тому же периоду. Возвраты не входят ни в оборот, ни в
прибыль (Т8); ставки старого бота входят в деньги, но не в CLV, Brier и калибровку (В5).

События — ноги рассчитанных ставок с исходом «выиграл» или «проиграл» (возвраты и ноги
без исхода не считаются). Ноги экспрессов старого бота не считаются по отдельности
совсем: бот записывал исходы только у выигранных экспрессов (Т10), остались бы почти одни
выигрыши. Фильтры рынка и покрытия у событий — по самой ноге; срез по покрытию не
сужается фильтром покрытия, срез по рынку — фильтром рынка.

- Срезы ROI по покрытию, исходу и кэфу события — по событиям как виртуальным ординарам на
  равную сумму (Р21): ROI = среднее (кэф − 1 при выигрыше, −1 при проигрыше). По
  итоговому кэфу — реальные ставки по диапазонам таблицы стратегии участника.
- Р21: реальные экспрессы против тех же событий ординарами, разница с парным интервалом.
- Калибровка и Brier (В3, Т9): события рассчитанных ставок, на пару исходов одно (у
  повтора — последняя ставка), прогноз — последний не замененный (supersedes) до начала
  матча, проверочные прогоны (is_eval) исключены. Модель — p_final (в таблице еще p_base
  и p_claude); у ставок бота — только p_claude, их калибровка — только под фильтром
  «старый бот». Brier против рынка — рынок в момент прогноза без маржи
  (q_market_at_pred, В2); закрытие — вторым рядом по событиям с двумя сторонами.
- CLV — кэф / закрытие − 1 по ставкам приложения с закрытием у всех ног (В1).
- Интервалы — 95%, бутстрэп с фиксированным seed, B = 10 000 (LLM_LEARNING.md, 3.4).
- Выводы — кодом, до трех; пороги малой выборки — здесь, в одном месте (THRESHOLDS).

Сбор данных — запросы к базе, расчет — чистая функция build_analytics без базы: ее
зовут в отдельном потоке, бутстрэп на тысячах ставок не держит цикл событий. Готовый
ответ кэшируется в Redis (app/services/analytics_cache.py).
"""

import asyncio
import csv
import io
import math
import zipfile
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal
from zoneinfo import ZoneInfo

from redis.asyncio import Redis
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.csv_safe import csv_cell
from app.core.errors import AppError
from app.core.i18n import t
from app.db.models import BankrollLedger, Bet, BetLeg, Match, Prediction, Tournament, User
from app.ml.metrics import (
    BOOTSTRAP_SAMPLES,
    Estimate,
    bootstrap_diff_ci,
    bootstrap_mean_ci,
    bootstrap_ratio_ci,
    clv,
    clv_fair,
    clv_parlay,
    paired_ratio_ci,
    rolling_means,
    wilson_interval,
)
from app.ml.strategy import StakeBand, StrategyParams
from app.schemas.analyses import TextKey
from app.schemas.analytics import (
    AnalyticsFiltersIn,
    AnalyticsOut,
    BankFlowOut,
    BrierOut,
    BrierPointOut,
    CalibrationBinOut,
    CalibrationFlagOut,
    CalibrationOut,
    ChangeOut,
    CiOut,
    ClvBinOut,
    ClvOut,
    ExportPart,
    InsightAction,
    InsightCode,
    InsightFilterOut,
    InsightOut,
    InsightTone,
    KpiOut,
    MarketSliceOut,
    MarketsTotalOut,
    OddsSliceOut,
    ParlaysOut,
    PrevOut,
    SampleOut,
    SeriesOut,
    SeriesPointOut,
    SeriesRowOut,
    SlicesOut,
    SurfaceSliceOut,
    ThresholdsOut,
    TotalSliceOut,
)
from app.schemas.bets import DATE_MIN, BetFiltersIn, Period
from app.services import analytics_cache
from app.services.app_settings import get_app_settings
from app.services.bank import (
    PERIOD_DAYS,
    DayCapital,
    DayFlow,
    daily_capital,
    daily_flows,
    local_today,
    period_start,
    user_zone,
)
from app.services.bets import bet_conditions, leg_surface_sql, summary_query
from app.services.sessions import utcnow
from app.services.strategy_versions import active_version, params_of

# --- пороги (одно место) ---

THRESHOLDS = ThresholdsOut(
    # Меньше — метка «мало данных» у среза ROI (макет: SMALL)
    small_sample=20,
    # Меньше событий — первым выводом «выборка мала для выводов»
    insight_min_events=30,
    # Диапазон калибровки с 8+ событиями и расхождением от 4 п.п. — плохой (макет)
    calibration_min_n=8,
    calibration_gap=0.04,
    # Меньше событий — точки калибровки «скачут»
    calibration_few=60,
    # Меньше событий плюс в срезе — «пока не закономерность»
    slice_pattern_n=30,
    # Меньше рассчитанных ставок за период — главная предупреждает о малой выборке
    dashboard_small=15,
    rolling_window=30,
    rolling_step=3,
)
# Вывод по итоговому кэфу — от стольких ставок в диапазоне; срез в выводе — от стольких
# событий; Brier против рынка в выводе — от стольких событий
TOTAL_MIN_N = 8
SLICE_MIN_N = 3
BRIER_MIN_N = 20
INSIGHTS_MAX = 3
# Точек скользящего Brier в ответе не больше (график шириной 360–1366 px); окна для «точнее
# рынка X из Y» и выгрузка CSV — все
BRIER_POINTS_MAX = 200
# Строк из базы за один шаг цикла событий (около 10 мс разбора)
ROWS_CHUNK = 250
# Потоков на бутстрэп одного ответа: блоки «срезы», KPI, Brier и Р21 — параллельно
CI_THREADS = 4
# Seed бутстрэпа: одинаковые данные — одинаковые интервалы
SEED = 20261013
# Корзины калибровки по 5 п.п. от 50 до 95%: номера корзин 10..18 (0,05 × номер)
CALIB_WIDTH = 0.05
CALIB_FIRST, CALIB_LAST = 10, 18
# Диапазоны кэфа события: нижние границы (последний — и выше)
ODDS_LOWS: tuple[Decimal, ...] = tuple(
    Decimal(value) for value in ("1.01", "1.30", "1.50", "1.65", "2.00")
)
_ODDS_TICK = Decimal("0.01")
# Распределение CLV: столбцы по 1 п.п., крайний левый не левее −3%, правый не правее +7%
CLV_LOW_MIN, CLV_TOP_MAX, CLV_MIN_BINS = -3, 7, 3
# Строки таблицы под рядом: по неделям, если в периоде не больше стольких дней
WEEK_ROWS_MAX_DAYS = 31
# Порядок срезов: покрытия, исходы (П1, П2, Ф1(−1.5), Ф2(−1.5), Ф1(+1.5), Ф2(+1.5))
SURFACE_ORDER = ("hard", "clay", "grass", "carpet", "unknown")
OUTCOME_ORDER: tuple[tuple[str, int], ...] = (
    ("ML", 1),
    ("ML", 2),
    ("HCP_-1.5", 1),
    ("HCP_-1.5", 2),
    ("HCP_+1.5", 1),
    ("HCP_+1.5", 2),
)
_ZERO = Decimal(0)


# --- период ---


@dataclass(frozen=True)
class Window:
    """Период по поясу участника: первый день first (None — все время или без начала),
    последний last, прошлый период той же длины prev."""

    period: Period | None
    first: date | None
    last: date
    prev: tuple[date, date] | None


def window_of(filters: AnalyticsFiltersIn, today: date) -> Window:
    """Период фильтров: даты from–to (последний день — не позже сегодня) или последние N
    дней с сегодняшним; прошлый период — столько же дней до первого."""
    if filters.date_from is not None or filters.date_to is not None:
        if filters.date_from and filters.date_to and filters.date_from > filters.date_to:
            raise AppError(422, "bet.bad_dates")
        first = filters.date_from
        last = min(filters.date_to or today, today)
        if first is not None and first > last:
            last = first
        if first is None:
            return Window(None, None, last, None)
        days = (last - first).days + 1
        prev_last = first - timedelta(days=1)
        prev_first = max(first - timedelta(days=days), DATE_MIN)
        prev = (prev_first, prev_last) if prev_last >= DATE_MIN else None
        return Window(None, first, last, prev)
    first = period_start(filters.period, today)
    if first is None:
        return Window(filters.period, None, today, None)
    days = PERIOD_DAYS[filters.period] or 0
    return Window(
        filters.period,
        first,
        today,
        (first - timedelta(days=days), first - timedelta(days=1)),
    )


def _base_filters(filters: AnalyticsFiltersIn, window: Window) -> BetFiltersIn:
    """Фильтры «Ставок» периода и источника (без рынка и покрытия): все рассчитанные
    ставки, из которых берутся события."""
    if window.period is not None:
        return BetFiltersIn(period=window.period, source=filters.source)
    return BetFiltersIn.model_validate(
        {"from": filters.date_from, "to": filters.date_to, "source": filters.source}
    )


def _bet_filters(filters: AnalyticsFiltersIn, base: BetFiltersIn) -> BetFiltersIn:
    return base.model_copy(update={"market": filters.market, "surface": list(filters.surface)})


def _selection_condition(filters: AnalyticsFiltersIn, user: User) -> list[ColumnElement[bool]]:
    """Сторона исхода (selection) — дополнительно к фильтру рынка «Ставок»: есть нога
    этого рынка с этой стороной."""
    if filters.selection is None or filters.market is None:
        return []
    own = (
        select(BetLeg.bet_id)
        .join(Bet, Bet.id == BetLeg.bet_id)
        .where(
            Bet.user_id == user.id,
            BetLeg.market == filters.market,
            BetLeg.selection == filters.selection,
        )
    )
    return [Bet.id.in_(own)]


def selected_conditions(
    filters: AnalyticsFiltersIn, user: User, window: Window, now: datetime
) -> list[ColumnElement[bool]]:
    """Условия на ставки выборки (все фильтры) — те же, что у «Ставок»."""
    bet_filters = _bet_filters(filters, _base_filters(filters, window))
    return bet_conditions(bet_filters, user, now) + _selection_condition(filters, user)


def prev_conditions(
    filters: AnalyticsFiltersIn, user: User, window: Window, now: datetime
) -> list[ColumnElement[bool]] | None:
    if window.prev is None:
        return None
    base = BetFiltersIn.model_validate(
        {"from": window.prev[0], "to": window.prev[1], "source": filters.source}
    )
    return bet_conditions(_bet_filters(filters, base), user, now) + _selection_condition(
        filters, user
    )


# --- строки из базы ---


@dataclass(frozen=True, slots=True)
class LegRow:
    """Нога рассчитанной ставки с покрытием (Т29) и прогнозом (уже с заменой, если она
    была до начала матча)."""

    id: int
    match_id: int
    market: str
    selection: int
    odds: Decimal
    result: str | None
    closing: Decimal | None
    q_close: float | None
    surface: str | None
    p_final: float | None
    p_base: float | None
    p_claude: float | None
    q_market: float | None
    forecast: bool


@dataclass(slots=True)
class BetRow:
    id: int
    placed_at: datetime
    settled_at: datetime | None
    status: str
    stake: Decimal
    profit: Decimal | None
    total_odds: Decimal
    source: str
    bookmaker: str
    legs: list[LegRow] = field(default_factory=list)

    @property
    def legacy_parlay(self) -> bool:
        """Экспресс старого бота: его ноги по отдельности не считаются (Т10)."""
        return self.source == "legacy" and len(self.legs) > 1

    @property
    def played(self) -> bool:
        return self.status in ("won", "lost")


@dataclass(frozen=True, slots=True)
class _Forecast:
    p_final: float | None
    p_base: float | None
    p_claude: float | None
    q_market: float | None


async def _replacement_rows(db: AsyncSession, user: User) -> dict[int, Any]:
    """Замены прогнозов участника (supersedes): id замененного прогноза → строка замены.
    Проверочные прогоны (is_eval) заменой не считаются. Замен у участника единицы: они
    читаются все сразу (по индексу участника), цепочки — в Python."""
    rows = await db.execute(
        select(
            Prediction.id,
            Prediction.supersedes,
            Prediction.as_of,
            Prediction.p_final,
            Prediction.p_base,
            Prediction.p_claude,
            Prediction.q_market_at_pred,
        ).where(
            Prediction.user_id == user.id,
            Prediction.supersedes.is_not(None),
            Prediction.is_eval.is_(False),
        )
    )
    # supersedes уникален: у прогноза не больше одной замены
    return {row.supersedes: row for row in rows}


def _latest_replacement(
    by_parent: dict[int, Any], root: int, start: datetime | None
) -> _Forecast | None:
    """Последняя замена прогноза root, сделанная до начала матча start (None — начало
    неизвестно), или None."""
    current, latest = root, None
    while current in by_parent:
        row = by_parent[current]
        if start is not None and row.as_of >= start:
            break
        latest, current = row, row.id
    if latest is None:
        return None
    return _Forecast(latest.p_final, latest.p_base, latest.p_claude, latest.q_market_at_pred)


async def settled_rows(
    db: AsyncSession, user: User, conds: Sequence[ColumnElement[bool]]
) -> list[BetRow]:
    """Рассчитанные ставки по условиям с ногами, покрытием и прогнозами, по времени ставки."""
    surface = leg_surface_sql(Bet, BetLeg, Tournament).label("surface")
    query = (
        select(
            Bet.id.label("bet_id"),
            Bet.placed_at,
            Bet.settled_at,
            Bet.status,
            Bet.stake,
            Bet.profit,
            Bet.total_odds,
            Bet.source,
            Bet.bookmaker,
            BetLeg.id.label("leg_id"),
            BetLeg.match_id,
            BetLeg.market,
            BetLeg.selection,
            BetLeg.odds_taken,
            BetLeg.result,
            BetLeg.closing_odds,
            BetLeg.q_close,
            BetLeg.prediction_id,
            surface,
            Match.scheduled_at,
            Prediction.p_final,
            Prediction.p_base,
            Prediction.p_claude,
            Prediction.q_market_at_pred,
            Prediction.is_eval,
        )
        .select_from(Bet)
        .join(BetLeg, BetLeg.bet_id == Bet.id)
        .join(Match, Match.id == BetLeg.match_id)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .outerjoin(Prediction, Prediction.id == BetLeg.prediction_id)
        .where(*conds, Bet.status != "open")
        .order_by(Bet.placed_at, Bet.id, BetLeg.id)
    )
    by_parent = await _replacement_rows(db, user)
    bets: dict[int, BetRow] = {}
    # Строки — пачками курсора: каждая пачка — отдельное ожидание, и цикл событий не
    # стоит, пока разбираются тысячи строк (на 10 тыс. ставок все строки разом занимали
    # его на четверть секунды). Строки не копятся: из пачки сразу собираются ставки
    stream = await db.stream(query.execution_options(yield_per=ROWS_CHUNK))
    async for chunk in stream.partitions(ROWS_CHUNK):
        for row in chunk:
            _add_row(bets, row, by_parent)
    return list(bets.values())


def _add_row(bets: dict[int, BetRow], row: Any, by_parent: dict[int, Any]) -> None:
    """Нога из строки запроса settled_rows — в свою ставку (прогноз — с последней заменой
    до начала матча)."""
    bet = bets.get(row.bet_id)
    if bet is None:
        bet = bets[row.bet_id] = BetRow(
            id=row.bet_id,
            placed_at=row.placed_at,
            settled_at=row.settled_at,
            status=row.status,
            stake=Decimal(row.stake),
            profit=Decimal(row.profit) if row.profit is not None else None,
            total_odds=Decimal(row.total_odds),
            source=row.source,
            bookmaker=row.bookmaker,
        )
    forecast = row.prediction_id is not None and not row.is_eval
    values = _Forecast(row.p_final, row.p_base, row.p_claude, row.q_market_at_pred)
    if forecast and by_parent:
        values = _latest_replacement(by_parent, row.prediction_id, row.scheduled_at) or values
    bet.legs.append(
        LegRow(
            id=row.leg_id,
            match_id=row.match_id,
            market=row.market,
            selection=row.selection,
            odds=Decimal(row.odds_taken),
            result=row.result,
            closing=Decimal(row.closing_odds) if row.closing_odds is not None else None,
            q_close=row.q_close,
            surface=row.surface,
            p_final=values.p_final if forecast else None,
            p_base=values.p_base if forecast else None,
            p_claude=values.p_claude if forecast else None,
            q_market=values.q_market if forecast else None,
            forecast=forecast,
        )
    )


@dataclass(frozen=True)
class Totals:
    """Строка итогов summary_query (как у «Ставок»)."""

    settled: int
    won: int
    lost: int
    void: int
    turnover: Decimal
    profit: Decimal
    open: int
    open_stake: Decimal
    legacy: int
    clv: float | None
    clv_n: int
    clv_positive: int

    @property
    def roi(self) -> float | None:
        return float(self.profit / self.turnover) if self.turnover > 0 else None

    @property
    def winrate(self) -> float | None:
        decided = self.won + self.lost
        return self.won / decided if decided else None


async def totals(db: AsyncSession, conds: Sequence[ColumnElement[bool]]) -> Totals:
    row = (await db.execute(summary_query(conds))).one()
    return Totals(
        settled=int(row.settled),
        won=int(row.won),
        lost=int(row.lost),
        void=int(row.void),
        turnover=Decimal(row.turnover),
        profit=Decimal(row.profit),
        open=int(row.open),
        open_stake=Decimal(row.open_stake),
        legacy=int(row.legacy),
        clv=float(row.mean) if row.mean is not None else None,
        clv_n=int(row.n),
        clv_positive=int(row.positive),
    )


async def history_start(db: AsyncSession, user: User, zone: ZoneInfo) -> date | None:
    """Первый день истории участника по его поясу: первая запись журнала банка или первая
    ставка (ставки старого бота бывают раньше журнала)."""
    first = await db.scalar(
        select(
            func.least(
                select(func.min(BankrollLedger.at))
                .where(BankrollLedger.user_id == user.id)
                .scalar_subquery(),
                select(func.min(Bet.placed_at)).where(Bet.user_id == user.id).scalar_subquery(),
            )
        )
    )
    return _local_day(first, zone) if first is not None else None


# --- входные данные расчета ---


@dataclass(frozen=True)
class Inputs:
    """Все, что нужно чистому расчету: строки, выборка, итоги, ряд капитала, таблица
    ставок стратегии."""

    filters: AnalyticsFiltersIn
    window: Window
    zone: ZoneInfo
    currency: str
    rows: list[BetRow]
    selected: frozenset[int]
    current: Totals
    previous: Totals | None
    equity: list[DayCapital] | None
    bands: tuple[StakeBand, ...]
    double_max: Decimal
    with_ci: bool = True
    bootstrap: int = BOOTSTRAP_SAMPLES
    # Пополнения, выводы и корректировки по дням и видам (ряд банка, В7)
    flows: tuple[DayFlow, ...] = ()


async def gather_inputs(
    db: AsyncSession,
    user: User,
    filters: AnalyticsFiltersIn,
    *,
    now: datetime | None = None,
    with_ci: bool = True,
) -> Inputs:
    """Данные из базы для расчета (одним сеансом)."""
    moment = now or utcnow()
    zone = user_zone(user.tz)
    window = window_of(filters, local_today(zone, moment))
    settings = await get_app_settings(db)
    base = bet_conditions(_base_filters(filters, window), user, moment)
    selected_conds = selected_conditions(filters, user, window, moment)
    current = await totals(db, selected_conds)
    previous_conds = prev_conditions(filters, user, window, moment)
    previous = None
    if previous_conds is not None and window.prev is not None:
        start = await history_start(db, user, zone)
        if start is not None and window.prev[0] >= start:
            previous = await totals(db, previous_conds)
    rows = await settled_rows(db, user, base)
    selected = frozenset(
        await db.scalars(select(Bet.id).where(*selected_conds, Bet.status != "open"))
    )
    equity: list[DayCapital] | None = None
    flows: tuple[DayFlow, ...] = ()
    if not filters.filtered:
        anchor = window.first - timedelta(days=1) if window.first is not None else None
        equity = await daily_capital(db, user, anchor, window.last)
        flows = tuple(await daily_flows(db, user))
    params: StrategyParams = params_of(await active_version(db, user.id))
    return Inputs(
        filters=filters,
        window=window,
        zone=zone,
        currency=settings.currency,
        rows=rows,
        selected=selected,
        current=current,
        previous=previous,
        equity=equity,
        bands=params.stake_bands,
        double_max=params.double_total[1],
        with_ci=with_ci,
        flows=flows,
    )


# --- события ---


def _market_ok(leg: LegRow, filters: AnalyticsFiltersIn) -> bool:
    if filters.market is None:
        return True
    return leg.market == filters.market and (
        filters.selection is None or leg.selection == filters.selection
    )


def _surface_ok(leg: LegRow, filters: AnalyticsFiltersIn) -> bool:
    return not filters.surface or (leg.surface or "unknown") in filters.surface


def _decided(rows: Iterable[BetRow]) -> list[tuple[BetRow, LegRow]]:
    """События: ноги с исходом «выиграл» или «проиграл», кроме экспрессов бота."""
    return [
        (bet, leg)
        for bet in rows
        if not bet.legacy_parlay
        for leg in bet.legs
        if leg.result in ("win", "loss")
    ]


def _won(leg: LegRow) -> int:
    return 1 if leg.result == "win" else 0


def _return(leg: LegRow) -> float:
    """Результат события как ординара на единицу суммы."""
    return float(leg.odds) - 1.0 if leg.result == "win" else -1.0


def _pair_key(leg: LegRow) -> tuple[int, str, int]:
    """Пара исходов матча: П1 и П2 — одна пара; Ф1(−1.5) и Ф2(+1.5) — другая."""
    if leg.market == "ML":
        return leg.match_id, "ML", 0
    favourite = leg.selection if leg.market == "HCP_-1.5" else 3 - leg.selection
    return leg.match_id, "HCP", favourite


@dataclass(frozen=True, slots=True)
class Event:
    """Событие калибровки и Brier: вероятность p (p_final или p_claude у бота) и исход y;
    рынок при прогнозе и закрытие — у ноги (leg.q_market, leg.q_close)."""

    bet: BetRow
    leg: LegRow
    p: float
    y: int


def calibration_events(
    legs: Sequence[tuple[BetRow, LegRow]], kind: Literal["final", "claude"]
) -> list[Event]:
    """События калибровки (Т9, Т10): по одному на пару исходов (у повтора — последняя
    ставка), по времени ставки. final — p_final ставок приложения, claude — p_claude
    ординаров бота."""
    picked: dict[tuple[int, str, int], Event] = {}
    for bet, leg in legs:
        if kind == "final":
            if bet.source != "app" or leg.p_final is None:
                continue
            p = leg.p_final
        else:
            if bet.source != "legacy" or leg.p_claude is None:
                continue
            p = leg.p_claude
        key = _pair_key(leg)
        picked.pop(key, None)
        picked[key] = Event(bet, leg, p, _won(leg))
    return sorted(picked.values(), key=lambda event: (event.bet.placed_at, event.leg.id))


# --- блоки ---


def _ci(estimate: Estimate | None) -> CiOut | None:
    return CiOut(low=estimate.low, high=estimate.high) if estimate is not None else None


def _noise(ci: CiOut | None) -> bool | None:
    return None if ci is None else ci.low <= 0 <= ci.high


def _local_day(moment: datetime, zone: ZoneInfo) -> date:
    return moment.astimezone(zone).date()


def _sample(inputs: Inputs, chosen: Sequence[BetRow], events: int) -> SampleOut:
    days = [_local_day(bet.placed_at, inputs.zone) for bet in chosen]
    settled = [bet.settled_at for bet in chosen if bet.settled_at is not None]
    legacy_events = sum(len(bet.legs) for bet in inputs.rows if bet.legacy_parlay)
    return SampleOut(
        bets=len(chosen),
        singles=sum(1 for bet in chosen if len(bet.legs) == 1),
        parlays=sum(1 for bet in chosen if len(bet.legs) > 1),
        events=events,
        legacy_bets=sum(1 for bet in chosen if bet.source == "legacy"),
        legacy_parlay_events=legacy_events,
        open_bets=inputs.current.open,
        first_day=min(days, default=None),
        last_day=max(days, default=None),
        last_settled_at=max(settled, default=None),
    )


def bet_clvs(chosen: Iterable[BetRow]) -> list[float]:
    """CLV ставок приложения (кэф / закрытие − 1 по ногам без возвратов, если закрытие
    внесено у всех) — как итоги «Ставок»."""
    values: list[float] = []
    for bet in chosen:
        if bet.source != "app":
            continue
        live = [(leg.odds, leg.closing) for leg in bet.legs if leg.result != "void"]
        value = clv_parlay(live)
        if value is not None:
            values.append(value)
    return values


def kpi_block(inputs: Inputs, chosen: Sequence[BetRow], clvs: Sequence[float]) -> KpiOut:
    current = inputs.current
    roi_ci = clv_ci = None
    if inputs.with_ci:
        played = [bet for bet in chosen if bet.played and bet.profit is not None]
        if len(played) >= 2:
            roi_ci = _ci(
                bootstrap_ratio_ci(
                    [float(bet.profit or 0) for bet in played],
                    [float(bet.stake) for bet in played],
                    n=inputs.bootstrap,
                    seed=SEED,
                )
            )
        if len(clvs) >= 2:
            clv_ci = _ci(bootstrap_mean_ci(clvs, n=inputs.bootstrap, seed=SEED))
    return KpiOut(
        settled=current.settled,
        won=current.won,
        lost=current.lost,
        void=current.void,
        turnover=current.turnover,
        profit=current.profit,
        roi=current.roi,
        roi_ci=roi_ci,
        winrate=current.winrate,
        clv=current.clv,
        clv_ci=clv_ci,
        clv_positive=current.clv_positive,
        clv_n=current.clv_n,
        legacy_settled=current.legacy,
    )


def prev_block(inputs: Inputs) -> PrevOut | None:
    """Прошлый период для сравнения — только если он целиком покрыт историей участника
    (как в макете: начало прошлого периода не раньше первого дня истории, иначе сравнение
    с неполным периодом обманывает) и в нем есть рассчитанные ставки; это проверяет
    gather_inputs."""
    previous, window = inputs.previous, inputs.window
    if previous is None or window.prev is None or previous.settled == 0:
        return None
    return PrevOut(
        date_from=window.prev[0],
        date_to=window.prev[1],
        settled=previous.settled,
        turnover=previous.turnover,
        profit=previous.profit,
        roi=previous.roi,
        winrate=previous.winrate,
        clv=previous.clv,
        clv_n=previous.clv_n,
    )


def change_block(current: Totals, prev: PrevOut | None) -> ChangeOut | None:
    if prev is None:
        return None

    def diff(a: float | None, b: float | None) -> float | None:
        return a - b if a is not None and b is not None else None

    return ChangeOut(
        profit=current.profit - prev.profit,
        roi=diff(current.roi, prev.roi),
        winrate=diff(current.winrate, prev.winrate),
        clv=diff(current.clv, prev.clv),
    )


def brier_block(inputs: Inputs, events: Sequence[Event]) -> BrierOut:
    """Brier модели против рынка при прогнозе (В2) и закрытия; скользящее окно. Ряд
    закрытия — по всем событиям с двумя сторонами закрытия, в том числе без рынка при
    прогнозе (в анализе введен кэф только своей стороны)."""
    closing = [event for event in events if event.leg.q_close is not None]
    closing_model = closing_market = None
    if closing:
        closing_model = sum((event.p - event.y) ** 2 for event in closing) / len(closing)
        closing_market = sum(
            (float(event.leg.q_close or 0) - event.y) ** 2 for event in closing
        ) / len(closing)
    rows = [event for event in events if event.leg.q_market is not None]
    if not rows:
        return BrierOut(
            n=0, model=None, market=None, diff=None, diff_ci=None, noise=None,
            closing_n=len(closing), closing_model=closing_model, closing_market=closing_market,
            points=[], windows=0, better=0,
        )  # fmt: skip
    model = [(event.p - event.y) ** 2 for event in rows]
    market = [(float(event.leg.q_market or 0) - event.y) ** 2 for event in rows]
    model_mean, market_mean = sum(model) / len(model), sum(market) / len(market)
    diff_ci = None
    if inputs.with_ci and len(rows) >= 2:
        diff_ci = _ci(bootstrap_diff_ci(model, market, n=inputs.bootstrap, seed=SEED))
    windows = rolling_means(
        model, market, window=THRESHOLDS.rolling_window, step=THRESHOLDS.rolling_step
    )
    points = [
        BrierPointOut(day=_local_day(rows[end].bet.placed_at, inputs.zone), model=a, market=b)
        for end, a, b in thin(windows, BRIER_POINTS_MAX)
    ]
    return BrierOut(
        n=len(rows),
        model=model_mean,
        market=market_mean,
        diff=model_mean - market_mean,
        diff_ci=diff_ci,
        noise=_noise(diff_ci),
        closing_n=len(closing),
        closing_model=closing_model,
        closing_market=closing_market,
        points=points,
        windows=len(windows),
        better=sum(1 for _, a, b in windows if a < b),
    )


def brier_windows(inputs: Inputs, events: Sequence[Event]) -> list[tuple[date, float, float]]:
    """Все окна скользящего Brier (без прореживания) — для выгрузки CSV."""
    rows = [event for event in events if event.leg.q_market is not None]
    model = [(event.p - event.y) ** 2 for event in rows]
    market = [(float(event.leg.q_market or 0) - event.y) ** 2 for event in rows]
    if not rows:
        return []
    return [
        (_local_day(rows[end].bet.placed_at, inputs.zone), a, b)
        for end, a, b in rolling_means(
            model, market, window=THRESHOLDS.rolling_window, step=THRESHOLDS.rolling_step
        )
    ]


def thin[T](items: Sequence[T], limit: int) -> list[T]:
    """Не больше limit точек графика равномерно по ряду; последняя точка — всегда."""
    if len(items) <= limit:
        return list(items)
    step = math.ceil((len(items) - 1) / (limit - 1))
    picked = list(items[::step])
    if (len(items) - 1) % step:
        picked.append(items[-1])
    return picked


def _slice_values(legs: Sequence[tuple[BetRow, LegRow]], inputs: Inputs) -> dict[str, Any]:
    returns = [_return(leg) for _, leg in legs]
    wins = sum(_won(leg) for _, leg in legs)
    ci = None
    if inputs.with_ci and len(returns) >= 2:
        ci = _ci(bootstrap_mean_ci(returns, n=inputs.bootstrap, seed=SEED, grouped=True))
    return {
        "n": len(legs),
        "wins": wins,
        "winrate": wins / len(legs),
        "roi": sum(returns) / len(returns),
        "roi_ci": ci,
        "avg_odds": float(sum((leg.odds for _, leg in legs), _ZERO) / len(legs)),
        "small": len(legs) < THRESHOLDS.small_sample,
    }


def _groups(
    legs: Sequence[tuple[BetRow, LegRow]], key: Callable[[LegRow], Any]
) -> dict[Any, list[tuple[BetRow, LegRow]]]:
    out: dict[Any, list[tuple[BetRow, LegRow]]] = defaultdict(list)
    for bet, leg in legs:
        out[key(leg)].append((bet, leg))
    return out


def _odds_low(odds: Decimal) -> Decimal:
    return max((low for low in ODDS_LOWS if low <= odds), default=ODDS_LOWS[0])


def _band_index(total: Decimal, bands: Sequence[StakeBand]) -> int | None:
    """Строка итогового кэфа — по тому же правилу, по которому стратегия выбирает сумму
    ставки (app/ml/strategy.py, _band): первая полоса, у которой high ≥ кэфа (кэф 1.703 на
    стыке 1.70/1.71 — во второй); ниже low первой и выше high последней — вне таблицы."""
    if not bands or total < bands[0].low:
        return None
    return next((index for index, band in enumerate(bands) if total <= band.high), None)


def _total_slice(
    bets: Sequence[BetRow], inputs: Inputs, band: StakeBand | None, triple: bool
) -> TotalSliceOut:
    played = [bet for bet in bets if bet.played]
    turnover = sum((bet.stake for bet in played), _ZERO)
    profit = sum((bet.profit or _ZERO for bet in played), _ZERO)
    ci = None
    if inputs.with_ci and len(played) >= 2:
        ci = _ci(
            bootstrap_ratio_ci(
                [float(bet.profit or 0) for bet in played],
                [float(bet.stake) for bet in played],
                n=inputs.bootstrap,
                seed=SEED,
            )
        )
    return TotalSliceOut(
        low=band.low if band else None,
        high=band.high if band else None,
        stake_pct=band.pct if band else None,
        triple=triple,
        bets=len(played),
        voids=sum(1 for bet in bets if bet.status == "void"),
        turnover=turnover,
        profit=profit,
        roi=float(profit / turnover) if turnover > 0 else None,
        roi_ci=ci,
        small=0 < len(played) < THRESHOLDS.small_sample,
    )


def totals_block(inputs: Inputs, chosen: Sequence[BetRow]) -> list[TotalSliceOut]:
    """ROI реальных ставок по диапазонам итогового кэфа таблицы стратегии; ставки вне
    таблицы — последней строкой, если они есть."""
    by_band: dict[int | None, list[BetRow]] = defaultdict(list)
    for bet in chosen:
        by_band[_band_index(bet.total_odds, inputs.bands)].append(bet)
    out = [
        _total_slice(by_band.get(index, []), inputs, band, band.low > inputs.double_max)
        for index, band in enumerate(inputs.bands)
    ]
    if by_band.get(None):
        out.append(_total_slice(by_band[None], inputs, None, False))
    return out


def slices_block(
    inputs: Inputs,
    by_market: Sequence[tuple[BetRow, LegRow]],
    by_surface: Sequence[tuple[BetRow, LegRow]],
    legs: Sequence[tuple[BetRow, LegRow]],
) -> SlicesOut:
    """Срезы ROI по событиям: покрытия (без фильтра покрытия), исходы (без фильтра рынка),
    кэф события. Итоговый кэф (реальные ставки) — totals_block, его вписывает сборка."""
    surface_groups = _groups(by_surface, lambda leg: leg.surface or "unknown")
    surfaces = [
        SurfaceSliceOut(surface=key, **_slice_values(surface_groups[key], inputs))
        for key in sorted(
            surface_groups,
            key=lambda key: SURFACE_ORDER.index(key) if key in SURFACE_ORDER else 99,
        )
    ]
    market_groups = _groups(by_market, lambda leg: (leg.market, leg.selection))
    markets = [
        MarketSliceOut(
            market=key[0],  # type: ignore[arg-type]
            selection=key[1],
            **_slice_values(market_groups[key], inputs),
        )
        for key in OUTCOME_ORDER
        if key in market_groups
    ]
    markets_total = None
    if by_market:
        wins = sum(_won(leg) for _, leg in by_market)
        markets_total = MarketsTotalOut(
            n=len(by_market),
            winrate=wins / len(by_market),
            roi=sum(_return(leg) for _, leg in by_market) / len(by_market),
            avg_odds=float(sum((leg.odds for _, leg in by_market), _ZERO) / len(by_market)),
        )
    odds_groups = _groups(legs, lambda leg: _odds_low(leg.odds))
    odds = []
    for index, low in enumerate(ODDS_LOWS):
        if low not in odds_groups:
            continue
        high = ODDS_LOWS[index + 1] - _ODDS_TICK if index + 1 < len(ODDS_LOWS) else None
        odds.append(OddsSliceOut(low=low, high=high, **_slice_values(odds_groups[low], inputs)))
    return SlicesOut(
        surfaces=surfaces,
        markets=markets,
        markets_total=markets_total,
        odds=odds,
        totals=[],
    )


def parlays_block(inputs: Inputs, chosen: Sequence[BetRow]) -> ParlaysOut | None:
    """Р21: реальные экспрессы против тех же событий ординарами (парный бутстрэп)."""
    parlays = [bet for bet in chosen if len(bet.legs) > 1 and bet.played]
    legacy = [bet for bet in parlays if bet.source == "legacy"]
    own = [bet for bet in parlays if bet.source != "legacy"]
    if not parlays:
        return None
    events = [[leg for leg in bet.legs if leg.result in ("win", "loss")] for bet in own]
    own_pairs = [(bet, legs) for bet, legs in zip(own, events, strict=True) if legs]
    if not own_pairs:
        return ParlaysOut(
            parlays=0, events=0, legacy_parlays=len(legacy), profit=_ZERO, parlays_roi=None,
            parlays_ci=None, singles_roi=None, singles_ci=None, diff=None, diff_ci=None,
            verdict=None,
        )  # fmt: skip
    profits = [float(bet.profit or 0) for bet, _ in own_pairs]
    stakes = [float(bet.stake) for bet, _ in own_pairs]
    leg_sums = [sum(_return(leg) for leg in legs) for _, legs in own_pairs]
    leg_counts = [float(len(legs)) for _, legs in own_pairs]
    parlays_roi = sum(profits) / sum(stakes)
    singles_roi = sum(leg_sums) / sum(leg_counts)
    parlays_ci = singles_ci = diff_ci = None
    if inputs.with_ci and len(own_pairs) >= 2:
        paired = paired_ratio_ci(
            (profits, stakes), (leg_sums, leg_counts), n=inputs.bootstrap, seed=SEED
        )
        parlays_ci, singles_ci, diff_ci = _ci(paired.first), _ci(paired.second), _ci(paired.diff)
    diff = parlays_roi - singles_roi
    verdict: Literal["noise", "parlays", "singles"] | None = None
    if diff_ci is not None:
        verdict = "noise" if _noise(diff_ci) else "parlays" if diff > 0 else "singles"
    return ParlaysOut(
        parlays=len(own_pairs),
        events=int(sum(leg_counts)),
        legacy_parlays=len(legacy),
        profit=sum((bet.profit or _ZERO for bet, _ in own_pairs), _ZERO),
        parlays_roi=parlays_roi,
        parlays_ci=parlays_ci,
        singles_roi=singles_roi,
        singles_ci=singles_ci,
        diff=diff,
        diff_ci=diff_ci,
        verdict=verdict,
    )


def _calibration_bin(index: int, events: Sequence[Event], kind: str) -> CalibrationBinOut:
    def mean(values: Sequence[float]) -> float | None:
        return sum(values) / len(values) if values else None

    n = len(events)
    wins = sum(event.y for event in events)
    ci_low, ci_high = wilson_interval(wins, n)
    final = kind == "final"
    return CalibrationBinOut(
        low=round(index * CALIB_WIDTH, 10),
        high=round((index + 1) * CALIB_WIDTH, 10),
        n=n,
        p=sum(event.p for event in events) / n,
        p_base=mean([e.leg.p_base for e in events if e.leg.p_base is not None]) if final else None,
        p_claude=(
            mean([e.leg.p_claude for e in events if e.leg.p_claude is not None]) if final else None
        ),
        actual=wins / n,
        ci_low=ci_low,
        ci_high=ci_high,
    )


def _flag(item: CalibrationBinOut) -> CalibrationFlagOut:
    return CalibrationFlagOut(
        low=item.low,
        high=item.high,
        n=item.n,
        p=item.p,
        actual=item.actual,
        gap=abs(item.p - item.actual),
        direction="over" if item.p > item.actual else "under",
    )


def calibration_block(events: Sequence[Event], kind: Literal["final", "claude"]) -> CalibrationOut:
    """Корзины 5 п.п. от 50 до 95%, интервал Уилсона; худший диапазон и противоположный."""
    grouped: dict[int, list[Event]] = defaultdict(list)
    outside = 0
    for event in events:
        index = math.floor(event.p / CALIB_WIDTH + 1e-9)
        if CALIB_FIRST <= index <= CALIB_LAST:
            grouped[index].append(event)
        else:
            outside += 1
    bins = [_calibration_bin(index, grouped[index], kind) for index in sorted(grouped)]
    big = [item for item in bins if item.n >= THRESHOLDS.calibration_min_n]
    worst = max(big, key=lambda item: abs(item.p - item.actual), default=None)
    status: Literal["empty", "few", "off", "ok"]
    opposite = None
    if not bins:
        status = "empty"
    elif worst is None:
        status = "few"
    elif abs(worst.p - worst.actual) >= THRESHOLDS.calibration_gap:
        status = "off"
        over = worst.p > worst.actual
        others = [
            item
            for item in big
            if (item.p > item.actual) != over
            and abs(item.p - item.actual) >= THRESHOLDS.calibration_gap
        ]
        found = max(others, key=lambda item: abs(item.p - item.actual), default=None)
        opposite = _flag(found) if found is not None else None
    else:
        status = "ok"
    return CalibrationOut(
        kind=kind,
        events=len(events),
        outside=outside,
        bins=bins,
        status=status,
        worst=_flag(worst) if worst is not None else None,
        opposite=opposite,
    )


def clv_block(clvs: Sequence[float], legs: Sequence[tuple[BetRow, LegRow]]) -> ClvOut:
    """Распределение CLV ставок по 1 п.п. (как макет) и CLV без маржи по событиям."""
    fair = [
        clv_fair(leg.odds, leg.q_close)
        for bet, leg in legs
        if bet.source == "app" and leg.q_close is not None
    ]
    fair_mean = sum(fair) / len(fair) if fair else None
    if not clvs:
        return ClvOut(n=0, positive=0, negative=0, bins=[], fair_mean=fair_mean, fair_n=len(fair))
    pct = [round(value * 100, 9) for value in clvs]
    low = max(CLV_LOW_MIN, math.floor(min(pct)))
    top = min(CLV_TOP_MAX, max(low + CLV_MIN_BINS, math.floor(max(pct))))
    counts = dict.fromkeys(range(low, top + 1), 0)
    for value in pct:
        counts[min(top, max(low, math.floor(value)))] += 1
    bins = [
        ClvBinOut(
            low=k / 100,
            high=(k + 1) / 100,
            n=n,
            share=n / len(pct),
            open_low=k == low and min(pct) < low,
            open_high=k == top and max(pct) >= top + 1,
        )
        for k, n in counts.items()
    ]
    return ClvOut(
        n=len(clvs),
        positive=sum(1 for value in clvs if value > 0),
        negative=sum(1 for value in clvs if value < 0),
        bins=bins,
        fair_mean=fair_mean,
        fair_n=len(fair),
    )


def max_drawdown(points: Sequence[DayCapital]) -> float:
    """Наибольшая просадка капитала от пика по дням (доля, 0 или меньше, не меньше −1) по
    правилу Р22 (app/services/bank.py): пополнение, вывод и корректировка — не просадка,
    они сдвигают пик в той же пропорции, что капитал; капитал дошел до нуля — пик заново."""
    if not points:
        return 0.0
    worst = 0.0
    peak = points[0].equity
    capital = points[0].equity
    for point in points[1:]:
        before, after_flows = capital, capital + point.flows
        if point.flows != 0:
            if before > 0 and after_flows > 0:
                peak = peak * after_flows / before
            else:
                peak = max(after_flows, _ZERO)
        capital = point.equity
        peak = max(peak, capital)
        if peak > 0:
            worst = min(worst, max(-1.0, float((capital - peak) / peak)))
    return worst


@dataclass(frozen=True)
class _Start:
    """Старт периода ряда банка: день, сумма, изменение за период долей от нее; opening —
    день первого пополнения, когда старт считается от первого дня банка (иначе None);
    opening_flow — само это пополнение (оно — старт, а не отметка)."""

    day: date
    amount: Decimal
    change: float | None
    opening: date | None = None
    opening_flow: DayFlow | None = None


def _period_start(
    inputs: Inputs, points: Sequence[tuple[date, Decimal]], kind: str, base: Decimal
) -> _Start:
    """Старт периода (В7, Р25): день, сумма и изменение за период долей от нее (главная и
    «Аналитика» показывают их как есть).

    Обычно старт — капитал на конец дня перед периодом (base), изменение — прибыль
    периода к нему. Если банк появился внутри периода (капитал перед ним — 0) или выбрано
    «все время», старт — первый день банка, сумма — первое пополнение (пополнения его дня
    по поясу участника; если пополнений нет — капитал первого дня), изменение — капитал на
    конец периода к вложенному (пополнения минус выводы с корректировками). Вывод или
    корректировка в день первого пополнения и пополнения позже двигают пунктир «вложено» и
    в старт не входят. У ряда результата (kind = result) старт — ноль."""
    start = points[0][0]
    if kind != "bank" or inputs.equity is None:
        return _Start(start, base, None)
    first = next((index for index, (_, value) in enumerate(points) if value != 0), None)
    if first is not None and (inputs.window.first is None or base == 0):
        day = points[first][0]
        tail = inputs.equity[first:]
        invested = sum((point.flows for point in tail), _ZERO)
        opening = next(
            (flow for flow in inputs.flows if flow.kind == "deposit" and flow.day >= day), None
        )
        amount = opening.amount if opening is not None else points[first][1]
        change = float((points[-1][1] - invested) / invested) if invested > 0 else None
        return _Start(day, amount, change, opening.day if opening is not None else day, opening)
    return _Start(start, base, float(inputs.current.profit / base) if base > 0 else None)


def _bank_steps(inputs: Inputs, begin: _Start) -> tuple[dict[date, Decimal], list[BankFlowOut]]:
    """Пунктир «вложено» по дням и отметки движения банка (В7). От первого дня банка —
    пополнения нарастающим итогом (до первого пополнения — 0), отметки — все движения
    после первого пополнения, в том числе вывод в его день; иначе — капитал на начало
    периода плюс пополнения и минус выводы внутри периода."""
    equity = inputs.equity or []
    level = _ZERO if begin.opening is not None else begin.amount
    steps: dict[date, Decimal] = {}
    for point in equity:
        if begin.opening is not None:
            if point.day >= begin.day:
                level += point.flows
        elif point.day > begin.day:
            level += point.flows
        steps[point.day] = level
    after = begin.opening if begin.opening is not None else begin.day
    marks = [
        BankFlowOut(day=flow.day, kind=flow.kind, amount=flow.amount)  # type: ignore[arg-type]
        for flow in inputs.flows
        if flow.day <= inputs.window.last
        and (after < flow.day or (flow.day == after and begin.opening_flow is not None))
        and flow is not begin.opening_flow
    ]
    return steps, marks


def series_block(inputs: Inputs, chosen: Sequence[BetRow]) -> SeriesOut:
    """Банк по дням (без фильтров) или результат отобранных ставок нарастающим итогом;
    таблица по неделям или месяцам."""
    zone, window = inputs.zone, inputs.window

    def settled_day(bet: BetRow) -> date:
        moment = bet.settled_at or bet.placed_at
        return min(_local_day(moment, zone), window.last)

    profits: dict[date, Decimal] = defaultdict(lambda: _ZERO)
    for bet in chosen:
        profits[settled_day(bet)] += bet.profit or _ZERO
    kind: Literal["bank", "result"]
    if inputs.equity is not None:
        kind = "bank"
        points = [(point.day, point.equity) for point in inputs.equity]
        drawdown = max_drawdown(inputs.equity)
    else:
        kind = "result"
        if window.first is not None:
            anchor = window.first - timedelta(days=1)
        elif chosen:
            anchor = min(_local_day(bet.placed_at, zone) for bet in chosen) - timedelta(days=1)
        else:
            anchor = window.last
        points, value, day = [], _ZERO, anchor
        while day <= window.last:
            value += profits.get(day, _ZERO) if day > anchor else _ZERO
            points.append((day, value))
            day += timedelta(days=1)
        drawdown = 0.0
    if not points:
        points = [(window.last, _ZERO)]
    start, base = points[0]
    begin = _period_start(inputs, points, kind, base)
    start_day, start_amount, change_share = begin.day, begin.amount, begin.change
    marks: list[BankFlowOut] = []
    invested: list[Decimal | None] = [None] * len(points)
    if kind == "bank":
        # Дни до первой записи журнала (банка еще не было) не рисуются
        points = [point for point in points if point[0] >= start_day] or points[-1:]
        steps, marks = _bank_steps(inputs, begin)
        invested = [steps.get(day, start_amount) for day, _ in points]
    values = [value for _, value in points]
    rows_from = window.first if window.first is not None else start
    by_day = dict(points)
    week_rows = (window.last - start).days <= WEEK_ROWS_MAX_DAYS
    groups: dict[date, list[BetRow]] = defaultdict(list)
    for bet in chosen:
        day = settled_day(bet)
        if day < rows_from:
            continue
        key = day - timedelta(days=day.weekday()) if week_rows else day.replace(day=1)
        groups[key].append(bet)
    rows: list[SeriesRowOut] = []
    for key in sorted(groups):
        bets = groups[key]
        if week_rows:
            end = key + timedelta(days=6)
        else:
            following = (key.replace(day=28) + timedelta(days=4)).replace(day=1)
            end = following - timedelta(days=1)
        first_day, last_day = max(key, rows_from), min(end, window.last)
        played = [bet for bet in bets if bet.played]
        turnover = sum((bet.stake for bet in played), _ZERO)
        profit = sum((bet.profit or _ZERO for bet in bets), _ZERO)
        rows.append(
            SeriesRowOut(
                date_from=first_day,
                date_to=last_day,
                bets=len(bets),
                profit=profit,
                roi=float(profit / turnover) if turnover > 0 else None,
                end=by_day.get(last_day, values[-1]),
            )
        )
    return SeriesOut(
        kind=kind,
        group="week" if week_rows else "month",
        start=start,
        base=base,
        start_day=start_day,
        start_amount=start_amount,
        change_share=change_share,
        last=values[-1],
        peak=max(values),
        max_drawdown=drawdown,
        best=max(values),
        worst=min(values),
        points=[
            SeriesPointOut(day=day, value=value, invested=level)
            for (day, value), level in zip(points, invested, strict=True)
        ],
        rows=rows,
        flows=marks,
        flows_total=sum((mark.amount for mark in marks), _ZERO),
    )


# --- выводы ---


def _insight(
    code: InsightCode,
    tone: InsightTone,
    params: dict[str, Any],
    basis: int,
    unit: Literal["events", "bets"],
    action: InsightAction | None,
    insight_filter: InsightFilterOut | None = None,
) -> InsightOut:
    return InsightOut(
        code=code,
        tone=tone,
        title=TextKey(key=f"analytics.insights.{code}.title", params=params),
        text=TextKey(key=f"analytics.insights.{code}.text", params=params),
        basis=basis,
        basis_unit=unit,
        action=action,
        filter=insight_filter,
    )


def _calibration_insight(calibration: CalibrationOut) -> InsightOut | None:
    worst = calibration.worst
    if calibration.status == "off" and worst is not None:
        code: InsightCode = "calibration_over" if worst.direction == "over" else "calibration_under"
        params = {
            "low": worst.low, "high": worst.high, "p": worst.p, "actual": worst.actual,
            "gap": worst.gap,
        }  # fmt: skip
        return _insight(code, "warn", params, worst.n, "events", "calibration")
    if calibration.status == "ok":
        big = [item for item in calibration.bins if item.n >= THRESHOLDS.calibration_min_n]
        n = sum(item.n for item in big)
        params = {"min_n": THRESHOLDS.calibration_min_n, "gap": THRESHOLDS.calibration_gap}
        return _insight("calibration_ok", "good", params, n, "events", None)
    return None


def _total_insight(slices: SlicesOut) -> InsightOut | None:
    candidates = [
        item
        for item in slices.totals
        if item.low is not None and item.bets >= TOTAL_MIN_N and item.roi is not None
    ]
    worst = min(candidates, key=lambda item: item.roi or 0.0, default=None)
    if worst is None or worst.roi is None or worst.roi >= 0:
        return None
    first = slices.totals[0] if slices.totals else None
    params = {
        "low": str(worst.low), "high": str(worst.high), "roi": worst.roi, "bets": worst.bets,
        "profit": str(worst.profit), "stake_pct": str(worst.stake_pct),
        "largest": first is not None and first.low == worst.low,
    }  # fmt: skip
    return _insight("total_negative", "bad", params, worst.bets, "bets", "bets")


def _slice_insight(slices: SlicesOut, filters: AnalyticsFiltersIn) -> InsightOut | None:
    options: list[tuple[float, int, InsightFilterOut, dict[str, Any]]] = []
    for surface in slices.surfaces:
        if surface.n < SLICE_MIN_N or surface.surface in filters.surface:
            continue
        options.append(
            (surface.roi, surface.n, InsightFilterOut(surface=surface.surface),
             {"dimension": "surface", "surface": surface.surface})
        )  # fmt: skip
    for market in slices.markets:
        chosen = filters.market == market.market and filters.selection in (None, market.selection)
        if market.n < SLICE_MIN_N or chosen:
            continue
        options.append(
            (market.roi, market.n,
             InsightFilterOut(market=market.market, selection=market.selection),
             {"dimension": "market", "market": market.market, "selection": market.selection})
        )  # fmt: skip
    if not options:
        return None
    roi, n, insight_filter, params = max(options, key=lambda option: option[0])
    if n >= THRESHOLDS.slice_pattern_n or roi <= 0:
        return None
    params = {
        **params, "roi": roi, "n": n, "roi_after_loss": (roi * n - 1) / (n + 1),
        "pattern_n": THRESHOLDS.slice_pattern_n,
    }  # fmt: skip
    return _insight("small_slice", "info", params, n, "events", "filter", insight_filter)


def _brier_insight(brier: BrierOut, kpi: KpiOut) -> InsightOut | None:
    if brier.n < BRIER_MIN_N or brier.model is None or brier.market is None:
        return None
    diff = brier.model - brier.market
    code: InsightCode
    if brier.noise or brier.noise is None:
        code = "brier_noise"
    elif diff < 0:
        code = "brier_model_better"
    else:
        code = "brier_market_better"
    params = {
        "model": brier.model, "market": brier.market,
        "ci_low": brier.diff_ci.low if brier.diff_ci else None,
        "ci_high": brier.diff_ci.high if brier.diff_ci else None,
        "clv": kpi.clv, "clv_positive": kpi.clv_positive, "clv_n": kpi.clv_n,
    }  # fmt: skip
    return _insight(code, "accent", params, brier.n, "events", "explain")


def insights_block(
    inputs: Inputs,
    sample: SampleOut,
    calibration: CalibrationOut,
    slices: SlicesOut,
    brier: BrierOut,
    kpi: KpiOut,
) -> list[InsightOut]:
    """До трех выводов (порядок макета): калибровка, убыточный итоговый кэф, срез на малой
    выборке, модель против рынка; при малой выборке первым — оговорка."""
    found = [
        _calibration_insight(calibration),
        _total_insight(slices),
        _slice_insight(slices, inputs.filters),
        _brier_insight(brier, kpi),
    ]
    out = [item for item in found if item is not None]
    if sample.events < THRESHOLDS.insight_min_events:
        whole = inputs.window.period == "all"
        action: InsightAction | None = (
            "widen" if not whole else "clear" if inputs.filters.filtered else None
        )
        params = {"bets": sample.bets, "events": sample.events,
                  "min_events": THRESHOLDS.insight_min_events}  # fmt: skip
        out.insert(0, _insight("sample", "info", params, sample.events, "events", action))
    return out[:INSIGHTS_MAX]


# --- сборка ---


@dataclass(frozen=True)
class Parts:
    """Выборка и события, общие для блоков."""

    chosen: list[BetRow]
    legs: list[tuple[BetRow, LegRow]]
    by_market: list[tuple[BetRow, LegRow]]
    by_surface: list[tuple[BetRow, LegRow]]
    events: list[Event]
    kind: Literal["final", "claude"]
    clvs: list[float]


def parts_of(inputs: Inputs) -> Parts:
    filters = inputs.filters
    chosen = [bet for bet in inputs.rows if bet.id in inputs.selected]
    decided = _decided(inputs.rows)
    legs = [
        pair for pair in decided if _market_ok(pair[1], filters) and _surface_ok(pair[1], filters)
    ]
    by_market = [pair for pair in decided if _surface_ok(pair[1], filters)]
    by_surface = [pair for pair in decided if _market_ok(pair[1], filters)]
    kind: Literal["final", "claude"] = "claude" if filters.source == "legacy" else "final"
    return Parts(
        chosen=chosen,
        legs=legs,
        by_market=by_market,
        by_surface=by_surface,
        events=calibration_events(legs, kind),
        kind=kind,
        clvs=bet_clvs(chosen),
    )


def build_analytics(inputs: Inputs) -> AnalyticsOut:
    """Все блоки «Аналитики» (чистая функция, без базы). Блоки с бутстрэпом считаются
    параллельно: numpy отпускает GIL, на тысячах ставок это в 2–3 раза быстрее."""
    parts = parts_of(inputs)
    window = inputs.window
    sample = _sample(inputs, parts.chosen, len(parts.legs))
    brier_events = parts.events if parts.kind == "final" else []
    with ThreadPoolExecutor(max_workers=CI_THREADS) as pool:
        totals_job = pool.submit(totals_block, inputs, parts.chosen)
        kpi_job = pool.submit(kpi_block, inputs, parts.chosen, parts.clvs)
        brier_job = pool.submit(brier_block, inputs, brier_events)
        parlays_job = pool.submit(parlays_block, inputs, parts.chosen)
        calibration = calibration_block(parts.events, parts.kind)
        series = series_block(inputs, parts.chosen)
        clv_out = clv_block(parts.clvs, parts.legs)
        # Срезы по событиям — в этом потоке, пока остальные блоки считаются в пуле
        slices = slices_block(inputs, parts.by_market, parts.by_surface, parts.legs)
        slices.totals = totals_job.result()
        kpi, brier, parlays = kpi_job.result(), brier_job.result(), parlays_job.result()
    prev = prev_block(inputs)
    return AnalyticsOut(
        currency=inputs.currency,
        tz=inputs.zone.key,
        period=window.period,
        date_from=window.first,
        date_to=window.last,
        filtered=inputs.filters.filtered,
        thresholds=THRESHOLDS,
        sample=sample,
        kpi=kpi,
        prev=prev,
        change=change_block(inputs.current, prev),
        brier=brier,
        insights=insights_block(inputs, sample, calibration, slices, brier, kpi),
        series=series,
        slices=slices,
        parlays=parlays,
        calibration=calibration,
        clv=clv_out,
    )


async def compute_analytics(
    db: AsyncSession, user: User, filters: AnalyticsFiltersIn, *, now: datetime | None = None
) -> AnalyticsOut:
    """Все блоки «Аналитики» без кэша: данные из базы, расчет — в отдельном потоке."""
    inputs = await gather_inputs(db, user, filters, now=now)
    return await asyncio.to_thread(build_analytics, inputs)


async def analytics_json(
    db: AsyncSession, redis: Redis | None, user: User, filters: AnalyticsFiltersIn
) -> str:
    """«Аналитика» из кэша (или посчитанная и сохраненная), JSON AnalyticsOut."""
    if filters.date_from and filters.date_to and filters.date_from > filters.date_to:
        raise AppError(422, "bet.bad_dates")
    version = await analytics_cache.data_version(db, user)
    key = analytics_cache.cache_key(user.id, "analytics", filters, version)

    async def compute() -> AnalyticsOut:
        return await compute_analytics(db, user, filters)

    return await analytics_cache.cached_json(redis, user.id, key, AnalyticsOut, compute)


# --- выгрузка CSV (В13) ---

CSV_COLUMNS: dict[str, tuple[str, ...]] = {
    "bets": (
        "bet_id", "placed_at", "settled_at", "source", "bookmaker", "status", "legs", "stake",
        "currency", "total_odds", "profit", "clv",
    ),
    "events": (
        "bet_id", "leg_id", "placed_at", "source", "market", "selection", "odds", "surface",
        "result", "p_final", "p_base", "p_claude", "q_market", "closing_odds", "q_close",
        "clv", "clv_fair", "in_calibration", "in_brier",
    ),
    "calibration": (
        "low", "high", "n", "p", "p_base", "p_claude", "actual", "ci_low", "ci_high",
    ),
    "brier": ("day", "model", "market", "diff"),
}  # fmt: skip


def _csv_time(moment: datetime | None, zone: ZoneInfo) -> str | None:
    return moment.astimezone(zone).strftime("%Y-%m-%d %H:%M") if moment is not None else None


def _part_rows(part: ExportPart, inputs: Inputs, parts: Parts) -> list[list[Any]]:
    zone = inputs.zone
    if part == "bets":
        clv_by_bet = {bet.id: value for bet in parts.chosen for value in bet_clvs([bet])}
        return [
            [
                bet.id, _csv_time(bet.placed_at, zone), _csv_time(bet.settled_at, zone),
                bet.source, bet.bookmaker, bet.status, len(bet.legs), bet.stake,
                inputs.currency, bet.total_odds, bet.profit, clv_by_bet.get(bet.id),
            ]
            for bet in parts.chosen
        ]  # fmt: skip
    if part == "events":
        calibrated = {event.leg.id for event in parts.events}
        in_brier = {
            event.leg.id
            for event in parts.events
            if parts.kind == "final" and event.leg.q_market is not None
        }
        rows: list[list[Any]] = []
        for bet, leg in parts.legs:
            leg_clv = clv(leg.odds, leg.closing) if leg.closing is not None else None
            fair = clv_fair(leg.odds, leg.q_close) if leg.q_close is not None else None
            rows.append(
                [
                    bet.id, leg.id, _csv_time(bet.placed_at, zone), bet.source, leg.market,
                    leg.selection, leg.odds, leg.surface, leg.result, leg.p_final, leg.p_base,
                    leg.p_claude, leg.q_market, leg.closing, leg.q_close, leg_clv, fair,
                    int(leg.id in calibrated), int(leg.id in in_brier),
                ]
            )  # fmt: skip
        return rows
    if part == "calibration":
        calibration = calibration_block(parts.events, parts.kind)
        return [
            [item.low, item.high, item.n, item.p, item.p_base, item.p_claude, item.actual,
             item.ci_low, item.ci_high]
            for item in calibration.bins
        ]  # fmt: skip
    windows = brier_windows(inputs, parts.events if parts.kind == "final" else [])
    return [[day.isoformat(), model, market, model - market] for day, model, market in windows]


def _csv_text(part: ExportPart, rows: list[list[Any]]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow([t(f"analytics.csv.{part}.{column}") for column in CSV_COLUMNS[part]])
    writer.writerows([csv_cell(value) for value in row] for row in rows)
    return "﻿" + out.getvalue()


def build_export(inputs: Inputs, export_parts: Sequence[ExportPart]) -> dict[ExportPart, str]:
    """CSV каждой части под фильтрами (чистая функция): BOM, заголовки из локали, время —
    по поясу участника, защита от формул (как выгрузка «Ставок»)."""
    parts = parts_of(inputs)
    return {part: _csv_text(part, _part_rows(part, inputs, parts)) for part in export_parts}


async def export_csv(
    db: AsyncSession, user: User, filters: AnalyticsFiltersIn, export_parts: Sequence[ExportPart]
) -> dict[ExportPart, str]:
    """Выгрузка аналитики под фильтрами: CSV по частям (без доверительных интервалов)."""
    async with analytics_cache.compute_slot():
        inputs = await gather_inputs(db, user, filters, with_ci=False)
        return await asyncio.to_thread(build_export, inputs, list(export_parts))


def export_zip(files: dict[ExportPart, str], stamp: date) -> bytes:
    """Части выгрузки одним архивом: analytics-<часть>-<дата>.csv."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for part, text in files.items():
            archive.writestr(f"analytics-{part}-{stamp.isoformat()}.csv", text.encode("utf-8"))
    return buffer.getvalue()
