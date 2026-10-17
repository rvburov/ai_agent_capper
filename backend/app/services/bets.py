"""Ставки участника: ставка по итогу анализа («Сохранить ставку»), список «Ставок» с
фильтрами и курсором, итоги по тем же фильтрам, карточка ставки, выгрузка CSV, банк.
Видит сам участник и администратор (только просмотр, Р27). «Мои букмекеры» —
app/services/bookmakers.py.

Ставка — рекомендованный экспресс анализа: состав ног менять нельзя, кэфы — можно
(фактические кэфы при ставке). Итоговый кэф — произведение кэфов ног. Сумма — больше
нуля и не больше банка (по учету; пустой журнал — банк из ввода анализа). Все
считается под блокировкой денег участника (bank.lock_member_money): две ставки не
списываются с одного банка параллельно. Пустой журнал и банк из ввода — сначала запись
deposit «начальный банк», затем ставка и запись stake. Повтор с тем же client_ref
возвращает ту же ставку. Валюта — валюта программы; форма, открытая до смены валюты
(BetIn.currency не та), — 409 common.currency_changed. Перед ставкой — пауза и лимиты дня
ответственной игры (app/services/play_limits.py) под той же блокировкой.

Итоги (решения Т8 и В5): возвраты не входят ни в оборот, ни в прибыль, их число —
отдельно; ставки старого бота входят в деньги, но не в CLV. Покрытие ноги — из турнира,
иначе из подтвержденного ввода анализа, иначе «не указано» (Т29). Турнир и матч из ввода
участника (source = 'user') общие у всех: их строку мог создать другой участник. Поэтому
название турнира, покрытие и формат у них — только из своего подтвержденного ввода.

Фильтры по ногам (рынок, покрытие, поиск) выбирают id своих ставок подзапросом по своим
же ногам: Bet.id IN (…) PostgreSQL выполняет полусоединением, и время зависит только от
числа своих ставок (EXISTS внутри OR он считал бы по ногам всех участников).
"""

import asyncio
import csv
import io
import re
from collections.abc import AsyncIterator, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import (
    ColumnElement,
    Float,
    Numeric,
    Select,
    and_,
    case,
    cast,
    exists,
    func,
    literal,
    literal_column,
    null,
    or_,
    select,
    true,
    tuple_,
    union,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.csv_safe import csv_cell
from app.core.errors import AppError
from app.core.i18n import t
from app.db.models import (
    Analysis,
    BankrollLedger,
    Bet,
    BetLeg,
    IngestionRun,
    Match,
    Player,
    Prediction,
    Tournament,
    User,
)
from app.ml.market import REFERENCE_ORDER
from app.ml.metrics import clv, clv_fair, clv_fair_parlay, clv_parlay
from app.ml.sets import SetCount, parse_set_count, score_outcomes
from app.ml.strategy import StrategyParams
from app.schemas.bets import (
    AdaptationOut,
    BankOut,
    BetCountsOut,
    BetFiltersIn,
    BetIn,
    BetItemOut,
    BetLegItemOut,
    BetLegOut,
    BetOut,
    BetPageIn,
    BetPageOut,
    BetsSummaryOut,
    ClosingOut,
    LegMatchOut,
    PlayerRefOut,
    Verdict,
)
from app.services import bookmakers as bookmakers_service
from app.services import play_limits
from app.services.analysis_input import short_odds
from app.services.app_settings import check_currency, get_app_settings
from app.services.bank import (
    MONEY_MAX,
    BankState,
    bank_state,
    day_start,
    drawdown_level,
    equity_after_bets,
    local_today,
    lock_member_money,
    period_start,
    user_zone,
)
from app.services.data_status import archive_matches_to, last_ok_loads, next_upload_day
from app.services.news_hints import news_results
from app.services.sessions import utcnow
from app.services.strategy_versions import active_version, params_of

ODDS_MIN = Decimal("1.01")
ODDS_MAX = Decimal("50")
TOTAL_MAX = Decimal("999.999")
ODDS_STEP = Decimal("0.001")
CENT = Decimal("0.01")
# Рассчитанная ставка: фильтр «Ставок» status=settled
SETTLED_STATUSES = ("won", "lost", "void")


@dataclass(frozen=True)
class PlacedBet:
    bet: Bet
    legs: list[BetLeg]
    created: bool


async def _legs(db: AsyncSession, bet_id: int) -> list[BetLeg]:
    return list(await db.scalars(select(BetLeg).where(BetLeg.bet_id == bet_id).order_by(BetLeg.id)))


def bet_out(placed: PlacedBet) -> BetOut:
    bet = placed.bet
    return BetOut(
        id=bet.id,
        analysis_id=bet.analysis_id,
        placed_at=bet.placed_at,
        bookmaker=bet.bookmaker,
        stake=bet.stake,
        currency=bet.currency,
        total_odds=short_odds(bet.total_odds),
        status=bet.status,  # type: ignore[arg-type]
        legs=[
            BetLegOut(
                id=leg.id,
                prediction_id=leg.prediction_id,
                match_id=leg.match_id,
                market=leg.market,  # type: ignore[arg-type]
                selection=leg.selection,
                odds_taken=short_odds(leg.odds_taken),
            )
            for leg in placed.legs
        ],
        client_ref=bet.source_ref,
    )


def _express_ids(analysis: Analysis) -> list[int]:
    express = (analysis.result or {}).get("express") or {}
    return [int(leg["prediction_id"]) for leg in express.get("legs") or []]


async def place_bet(db: AsyncSession, user: User, body: BetIn) -> PlacedBet:
    """«Поставил»: ставка по экспрессу анализа с фактическими кэфами. Делает commit."""
    await lock_member_money(db, user.id)
    existing = await db.scalar(
        select(Bet).where(
            Bet.user_id == user.id, Bet.source == "app", Bet.source_ref == body.client_ref
        )
    )
    if existing is not None:
        if existing.analysis_id != body.analysis_id:
            raise AppError(409, "bet.duplicate")
        legs = await _legs(db, existing.id)
        await db.commit()
        return PlacedBet(existing, legs, created=False)
    analysis = await db.scalar(
        select(Analysis)
        .where(Analysis.id == body.analysis_id, Analysis.user_id == user.id)
        .with_for_update()
    )
    if analysis is None:
        raise AppError(404, "analysis.not_found")
    if analysis.status != "done":
        raise AppError(409, "bet.analysis_state")
    if await db.scalar(select(Bet.id).where(Bet.analysis_id == analysis.id).limit(1)) is not None:
        raise AppError(409, "bet.duplicate")
    expected = _express_ids(analysis)
    given = [leg.prediction_id for leg in body.legs]
    if not expected or sorted(given) != sorted(expected) or len(set(given)) != len(given):
        raise AppError(422, "bet.bad_legs")
    predictions = {
        row.id: row
        for row in await db.scalars(
            select(Prediction).where(
                Prediction.id.in_(given), Prediction.analysis_id == analysis.id
            )
        )
    }
    if set(predictions) != set(given):
        raise AppError(422, "bet.bad_legs")
    settings = await get_app_settings(db)
    # Сумма из формы, открытой до смены валюты, в новой валюте не записывается
    check_currency(settings, body.currency)
    stake_sum = body.stake.quantize(CENT)
    # Ответственная игра: пауза и лимиты дня — под той же блокировкой, что и сама ставка
    await play_limits.check(db, user, stake=stake_sum)
    total = Decimal(1)
    for leg in body.legs:
        if not ODDS_MIN <= leg.odds_taken <= ODDS_MAX:
            raise AppError(422, "bet.odds_range", odds=str(leg.odds_taken))
        total *= leg.odds_taken
    total = total.quantize(ODDS_STEP, rounding=ROUND_HALF_UP)
    if total > TOTAL_MAX:
        raise AppError(422, "bet.odds_range", odds=str(total))
    state = await bank_state(db, user.id)
    bank = analysis.bank_input if state.empty else state.balance
    if bank is None or stake_sum > bank:
        raise AppError(422, "bet.stake_range", bank=str(bank or 0), currency=settings.currency)
    # Выплата и прибыль хранятся в NUMERIC(12, 2): большую выплату не рассчитать
    payout = money(stake_sum * total)
    if payout > MONEY_MAX:
        raise AppError(
            422,
            "bet.payout_range",
            payout=str(payout),
            max=str(MONEY_MAX),
            currency=settings.currency,
        )
    now = utcnow()
    if state.empty and analysis.bank_input is not None:
        db.add(
            BankrollLedger(
                user_id=user.id,
                at=now,
                kind="deposit",
                amount=analysis.bank_input,
                currency=settings.currency,
                note=t("bets.initial_deposit"),
            )
        )
        await db.flush()
    bet = Bet(
        user_id=user.id,
        analysis_id=analysis.id,
        placed_at=now,
        bookmaker=body.bookmaker,
        stake=stake_sum,
        currency=settings.currency,
        total_odds=total,
        status="open",
        source="app",
        source_ref=body.client_ref,
    )
    db.add(bet)
    await db.flush()
    legs = [
        BetLeg(
            bet_id=bet.id,
            match_id=predictions[leg.prediction_id].match_id,
            market=predictions[leg.prediction_id].market,
            selection=predictions[leg.prediction_id].selection,
            odds_taken=leg.odds_taken.quantize(ODDS_STEP),
            prediction_id=leg.prediction_id,
        )
        for leg in body.legs
    ]
    db.add_all(legs)
    db.add(
        BankrollLedger(
            user_id=user.id,
            at=now,
            kind="stake",
            amount=-stake_sum,
            currency=settings.currency,
            bet_id=bet.id,
        )
    )
    analysis.decision = "bet"
    # Новое название букмекера — в «Мои букмекеры»; скрытый возвращается в список: у него
    # теперь ставка в игре (скрыть можно только букмекера без них)
    await bookmakers_service.remember(db, user.id, [bet.bookmaker], restore=True)
    await db.commit()
    return PlacedBet(bet, legs, created=True)


# --- банк ---


def _adaptations(state: BankState, params: StrategyParams) -> list[AdaptationOut]:
    """Правила адаптации: active — правило включено и действует (из лимитов просадки —
    только самый строгий достигнутый), met — условие выполнено, даже если правило
    выключено или действует более строгий лимит."""
    level = drawdown_level(state, params)
    growth, week = params.growth, params.week
    change = state.week_change
    # (ключ, действует при включенном правиле, условие выполнено, параметры)
    rules: list[tuple[str, bool, bool, dict[str, Any]]] = []
    for item in params.drawdown:
        rules.append(
            (
                item.key,
                level is not None and level.key == item.key,
                state.drawdown >= item.start,
                {"from": str(item.start), "max_pct": str(item.max_pct)},
            )
        )
    grown = (
        state.growth is not None
        and state.winrate is not None
        and state.growth >= growth.bank_up
        and state.winrate >= growth.min_winrate
    )
    rules.append(
        (
            "up15",
            grown,
            grown,
            {
                "bank_up": str(growth.bank_up),
                "min_winrate": str(growth.min_winrate),
                "max_pct": str(growth.max_pct),
            },
        )
    )
    lost_week = change is not None and change <= week.loss
    rules.append(
        (
            "week_loss",
            lost_week,
            lost_week,
            {"loss": str(week.loss), "max_pct": str(week.loss_max_pct)},
        )
    )
    won_week = change is not None and change >= week.win
    rules.append(
        (
            "week_win",
            won_week,
            won_week,
            {"win": str(week.win), "add": str(week.win_add)},
        )
    )
    return [
        AdaptationOut(
            key=key,  # type: ignore[arg-type]
            enabled=params.adapt_on(key),
            active=active and params.adapt_on(key),
            met=met,
            params=values,
        )
        for key, active, met, values in rules
    ]


async def bank_out(db: AsyncSession, user: User) -> BankOut:
    """Банк участника для экрана и формы: учет, просадка и действующие адаптации."""
    state = await bank_state(db, user.id)
    params = params_of(await active_version(db, user.id))
    level = drawdown_level(state, params)
    return BankOut(
        currency=state.currency,
        empty=state.empty,
        balance=state.balance,
        in_play=state.in_play,
        equity=state.equity,
        peak=state.peak,
        drawdown=state.drawdown.quantize(Decimal("0.0001")),
        invested=state.invested,
        growth=state.growth.quantize(Decimal("0.0001")) if state.growth is not None else None,
        week_change=(
            state.week_change.quantize(Decimal("0.0001")) if state.week_change is not None else None
        ),
        winrate=state.winrate.quantize(Decimal("0.0001")) if state.winrate is not None else None,
        settled_bets=state.settled_bets,
        drawdown_level=level.key if level is not None else None,  # type: ignore[arg-type]
        adaptations=_adaptations(state, params),
    )


# --- список, итоги, карточка ---

_BET_NUMBER = re.compile(r"^\u2116?\s*(\d{1,18})$")
# Путь к покрытию события матча в analyses.confirmed (match_id — переменная $m)
_EVENT_SURFACE: ColumnElement[Any] = literal_column(
    "'$.events[*] ? (@.match_id == $m).surface'::jsonpath"
)
_LIVE_RESULT = BetLeg.result.is_distinct_from("void")


def money(value: Decimal) -> Decimal:
    """Деньги до копеек, половина — вверх (как у букмекера)."""
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _norm(expr: Any) -> ColumnElement[str]:
    """Текст для поиска: нижний регистр, «е с двумя точками» — как «е»."""
    return func.translate(func.lower(expr), "\u0451", "\u0435")


def _like(text: str) -> str:
    escaped = text.lower().replace("\u0451", "\u0435")
    for char in ("\\", "%", "_"):
        escaped = escaped.replace(char, "\\" + char)
    return f"%{escaped}%"


def _confirmed_surface(bet: Any, leg: Any) -> ColumnElement[str | None]:
    """Покрытие события ноги из подтвержденного ввода анализа ставки (Т29). Подзапрос:
    COALESCE считает его, только если у турнира архива покрытия нет."""
    found = func.jsonb_path_query_first(
        Analysis.confirmed, _EVENT_SURFACE, func.jsonb_build_object("m", leg.match_id)
    )
    return (
        select(found.op("#>>")(literal_column("'{}'")))
        .where(Analysis.id == bet.analysis_id)
        .correlate_except(Analysis)
        .scalar_subquery()
    )


def leg_surface_sql(bet: Any, leg: Any, tournament: Any) -> ColumnElement[str | None]:
    """Покрытие ноги в SQL, как LegContext.surface: турнир архива, иначе свой ввод."""
    archive = case((tournament.source == "user", null()), else_=tournament.surface)
    return func.coalesce(archive, _confirmed_surface(bet, leg))


def _date_bounds(
    filters: BetFiltersIn, user: User, now: datetime
) -> tuple[datetime | None, datetime | None]:
    """Начало и конец периода (UTC) по поясу участника: даты from–to включительно или
    последние N дней с сегодняшним."""
    zone = user_zone(user.tz)
    if filters.date_from is not None or filters.date_to is not None:
        start = day_start(filters.date_from, zone) if filters.date_from else None
        end = day_start(filters.date_to + timedelta(days=1), zone) if filters.date_to else None
        return start, end
    first = period_start(filters.period, local_today(zone, now))
    return (day_start(first, zone) if first is not None else None), None


@dataclass(frozen=True)
class _Legs:
    """Ноги для условия фильтра: ставка, нога, матч, турнир (псевдонимы или таблицы)."""

    bet: Any
    leg: Any
    match: Any
    tournament: Any


def _own_legs(user: User) -> tuple[_Legs, Select[Any]]:
    """Ноги своих ставок с матчем и турниром и SELECT id ставки по ним. Свои псевдонимы
    таблиц: подзапрос не сливается со ставкой внешнего запроса."""
    legs = _Legs(
        aliased(Bet, name="own_bet"),
        aliased(BetLeg, name="own_leg"),
        aliased(Match, name="own_match"),
        aliased(Tournament, name="own_tour"),
    )
    query = (
        select(legs.leg.bet_id)
        .join(legs.bet, legs.bet.id == legs.leg.bet_id)
        .join(legs.match, legs.match.id == legs.leg.match_id)
        .outerjoin(legs.tournament, legs.tournament.id == legs.match.tournament_id)
        .where(legs.bet.user_id == user.id)
    )
    return legs, query


def _any_leg(
    user: User, page: bool, condition: Callable[[_Legs], ColumnElement[bool]]
) -> ColumnElement[bool]:
    """У ставки есть нога под условие. Страница списка (LIMIT) — EXISTS по ногам самой
    ставки: ставки проверяются по порядку до 21-й подходящей. Итоги и выгрузка — Bet.id IN
    (свои ноги под условие): множество считается один раз и только по своим ставкам."""
    if not page:
        legs, query = _own_legs(user)
        return Bet.id.in_(query.where(condition(legs)))
    legs = _Legs(
        Bet,
        aliased(BetLeg, name="page_leg"),
        aliased(Match, name="page_match"),
        aliased(Tournament, name="page_tour"),
    )
    return exists(
        select(literal(1))
        .select_from(legs.leg)
        .join(legs.match, legs.match.id == legs.leg.match_id)
        .outerjoin(legs.tournament, legs.tournament.id == legs.match.tournament_id)
        .where(legs.leg.bet_id == Bet.id, condition(legs))
    )


def _surface_condition(surfaces: Sequence[str]) -> Callable[[_Legs], ColumnElement[bool]]:
    wanted = [value for value in surfaces if value != "unknown"]

    def condition(legs: _Legs) -> ColumnElement[bool]:
        surface = leg_surface_sql(legs.bet, legs.leg, legs.tournament)
        options: list[ColumnElement[bool]] = []
        if wanted:
            options.append(surface.in_(wanted))
        if "unknown" in surfaces:
            options.append(surface.is_(None))
        return or_(*options)

    return condition


def bet_conditions(
    filters: BetFiltersIn, user: User, now: datetime, *, page: bool = False
) -> list[ColumnElement[bool]]:
    """Условия на Bet по фильтрам «Ставок» (только ставки участника). page — для страницы
    списка с LIMIT (см. _any_leg)."""
    if filters.date_from and filters.date_to and filters.date_from > filters.date_to:
        raise AppError(422, "bet.bad_dates")
    conds: list[ColumnElement[bool]] = [Bet.user_id == user.id]
    start, end = _date_bounds(filters, user, now)
    if start is not None:
        conds.append(Bet.placed_at >= start)
    if end is not None:
        conds.append(Bet.placed_at < end)
    if filters.status == "settled":
        conds.append(Bet.status.in_(SETTLED_STATUSES))
    elif filters.status is not None:
        conds.append(Bet.status == filters.status)
    if filters.source is not None:
        conds.append(Bet.source == filters.source)
    if filters.market is not None:
        market = filters.market
        conds.append(_any_leg(user, page, lambda legs: legs.leg.market == market))
    if filters.surface:
        conds.append(_any_leg(user, page, _surface_condition(filters.surface)))
    if filters.q:
        conds.append(_search(filters.q, user))
    return conds


def _search(query: str, user: User) -> ColumnElement[bool]:
    """Поиск по игрокам (латиница и кириллица), турниру архива, турниру из своего ввода,
    букмекеру и номеру ставки: id своих ставок, найденных хоть одной веткой."""
    pattern = _like(query)

    def found(expr: Any) -> ColumnElement[bool]:
        return _norm(expr).like(pattern, escape="\\")

    players = select(Player.id).where(
        or_(found(Player.name), found(func.coalesce(Player.name_ru, "")))
    )
    legs, own = _own_legs(user)
    # Игроки — множеством id (хешируется один раз), турнир архива — по строке ноги. Поиск
    # всегда — множеством id: EXISTS внутри OR PostgreSQL считал бы по ногам всех участников
    by_legs = own.where(
        or_(
            legs.match.player1_id.in_(players),
            legs.match.player2_id.in_(players),
            and_(legs.tournament.source.is_distinct_from("user"), found(legs.tournament.name)),
        )
    )
    bet = aliased(Bet, name="own_bet")
    events = (
        func.jsonb_array_elements(Analysis.confirmed["events"]).table_valued("value").lateral("ev")
    )
    by_input = (
        select(bet.id)
        .join(Analysis, Analysis.id == bet.analysis_id)
        .join(events, true())
        .where(
            bet.user_id == user.id,
            Analysis.user_id == user.id,
            found(events.c.value.op("->>")("tournament_name")),
        )
    )
    direct: list[ColumnElement[bool]] = [found(bet.bookmaker)]
    number = _BET_NUMBER.match(query.strip())
    if number is not None:
        direct.append(bet.id == int(number.group(1)))
    by_bet = select(bet.id).where(bet.user_id == user.id, or_(*direct))
    return Bet.id.in_(union(by_legs, by_input, by_bet))


@dataclass(frozen=True)
class _EventInfo:
    surface: str | None
    best_of: int | None
    tournament: str | None


def _events_by_match(confirmed: dict[str, Any] | None) -> dict[int, _EventInfo]:
    found: dict[int, _EventInfo] = {}
    for event in (confirmed or {}).get("events") or []:
        match_id = event.get("match_id")
        if match_id is None:
            continue
        best_of = event.get("best_of")
        found[int(match_id)] = _EventInfo(
            surface=event.get("surface") or None,
            best_of=int(best_of) if best_of in (3, 5) else None,
            tournament=event.get("tournament_name") or None,
        )
    return found


def _from_input(row: Match | Tournament | None) -> bool:
    """Строка из ввода участника: общая у всех, ее мог создать другой участник."""
    return row is not None and row.source == "user"


@dataclass(frozen=True)
class LegContext:
    """Нога с матчем и тем, что о нем известно участнику: формат и покрытие — из архива,
    иначе из своего подтвержденного ввода (строки из ввода — только свои, Т29). zone —
    пояс участника: день матча без даты — по нему, как «Мои матчи сегодня» главной."""

    leg: BetLeg
    match: Match
    tournament: Tournament | None
    event: _EventInfo | None
    p_base: float | None
    p_claude: float | None
    p_final: float | None
    zone: ZoneInfo | None = None

    def _local(self, moment: datetime) -> date:
        return moment.astimezone(self.zone).date() if self.zone else moment.date()

    @property
    def best_of(self) -> int | None:
        values: list[int | None] = []
        if not _from_input(self.match):
            values.append(self.match.best_of)
        if self.tournament is not None and not _from_input(self.tournament):
            values.append(self.tournament.best_of)
        values.append(self.event.best_of if self.event else None)
        return next((value for value in values if value in (3, 5)), None)

    @property
    def surface(self) -> str | None:
        tournament = self.tournament
        if tournament is not None and not _from_input(tournament) and tournament.surface:
            return tournament.surface
        return self.event.surface if self.event else None

    @property
    def tournament_name(self) -> str | None:
        if self.tournament is not None and not _from_input(self.tournament):
            return self.tournament.name
        return self.event.tournament if self.event else None

    @property
    def day(self) -> date | None:
        match = self.match
        if match.match_date is not None:
            return match.match_date
        if match.scheduled_at is not None:
            return self._local(match.scheduled_at)
        if match.source == "user":
            return self._local(match.created_at)
        return self.tournament.start_date if self.tournament else None


async def leg_contexts(
    db: AsyncSession, user: User, bets: Sequence[Bet]
) -> dict[int, list[LegContext]]:
    """Ноги ставок с матчами, турнирами, прогнозами и вводом анализа: bet_id → ноги по id."""
    ids = [bet.id for bet in bets]
    if not ids:
        return {}
    rows = await db.execute(
        select(
            BetLeg, Match, Tournament, Prediction.p_base, Prediction.p_claude, Prediction.p_final
        )
        .join(Match, Match.id == BetLeg.match_id)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .outerjoin(Prediction, Prediction.id == BetLeg.prediction_id)
        .where(BetLeg.bet_id.in_(ids))
        .order_by(BetLeg.bet_id, BetLeg.id)
        .execution_options(populate_existing=True)
    )
    analysis_ids = {bet.analysis_id for bet in bets if bet.analysis_id is not None}
    confirmed: dict[int, dict[int, _EventInfo]] = {}
    if analysis_ids:
        found = await db.execute(
            select(Analysis.id, Analysis.confirmed).where(
                Analysis.id.in_(analysis_ids), Analysis.user_id == user.id
            )
        )
        confirmed = {analysis_id: _events_by_match(data) for analysis_id, data in found}
    by_bet = {bet.id: bet for bet in bets}
    zone = user_zone(user.tz)
    out: dict[int, list[LegContext]] = {bet_id: [] for bet_id in ids}
    for leg, match, tournament, p_base, p_claude, p_final in rows:
        analysis_id = by_bet[leg.bet_id].analysis_id
        events = confirmed.get(analysis_id, {}) if analysis_id is not None else {}
        out[leg.bet_id].append(
            LegContext(
                leg, match, tournament, events.get(match.id), p_base, p_claude, p_final, zone
            )
        )
    return out


def score_from_own(score: str | None, selection: int) -> str | None:
    """Счет ноги для показа (первым — игрок 1) из хранимого со стороны выбранного игрока."""
    count = parse_set_count(score) if score else None
    if count is None:
        return score
    return (count if selection == 1 else count.swapped()).text()


def score_to_own(count: SetCount, selection: int) -> str:
    """Счет из ввода (первым — игрок 1) — для хранения со стороны выбранного игрока."""
    return (count if selection == 1 else count.swapped()).text()


def closing_by(bookmaker: str | None) -> tuple[str, str | None]:
    """Чей закрывающий кэф: код эталона или bookmaker с названием своего букмекера."""
    if bookmaker in REFERENCE_ORDER:
        return bookmaker, None
    return "bookmaker", bookmaker


def _closing_out(leg: BetLeg) -> ClosingOut | None:
    if leg.closing_odds is None:
        return None
    by, name = closing_by(leg.closing_bookmaker)
    return ClosingOut(
        odds=short_odds(leg.closing_odds),
        opp_odds=short_odds(leg.closing_opp_odds) if leg.closing_opp_odds is not None else None,
        by=by,  # type: ignore[arg-type]
        bookmaker=name,
        source=leg.closing_source or "user",  # type: ignore[arg-type]
        q_close=leg.q_close,
        unverified=leg.closing_source == "archive",
    )


def settle_odds(
    status: str, total_odds: Decimal, legs: Sequence[tuple[Decimal, str | None]]
) -> Decimal | None:
    """Кэф расчета по итогу ставки и (кэф ноги, исход ноги): у выигрыша возврат ноги — кэф
    1.00, остальное — произведение кэфов выигравших ног (до 0.001, как итоговый кэф при
    ставке); без возвратов — итоговый кэф ставки (у ставок бота он мог отличаться от
    произведения). Не выигрыш — None."""
    if status != "won":
        return None
    if not any(result == "void" for _, result in legs):
        return total_odds
    product = Decimal(1)
    for odds, result in legs:
        if result == "win":
            product *= odds
    return product.quantize(ODDS_STEP, rounding=ROUND_HALF_UP)


def effective_odds(bet: Bet, legs: Sequence[BetLeg]) -> Decimal | None:
    """Кэф расчета выигранной ставки по ее ногам (settle_odds)."""
    return settle_odds(bet.status, bet.total_odds, [(leg.odds_taken, leg.result) for leg in legs])


def verdict(bet: Bet, legs: Sequence[BetLeg], bet_clv: float | None) -> Verdict | None:
    """Вердикт по CLV кодом (без Claude): отделяет дисперсию от возможной ошибки модели."""
    if bet.status == "open":
        return None
    if bet.source == "legacy":
        return "legacy"
    if bet.status == "void":
        return "void"
    if bet.status == "won":
        if bet_clv is None:
            return "no_closing"
        return "won_against_market" if bet_clv < 0 else "edge_confirmed"
    lost = [leg for leg in legs if leg.result == "loss"]
    clvs = [clv(leg.odds_taken, leg.closing_odds) for leg in lost if leg.closing_odds is not None]
    if not clvs:
        return "no_closing"
    return "model_error" if any(value < 0 for value in clvs) else "variance"


def _player(players: dict[int, Player], player_id: int) -> PlayerRefOut:
    found = players.get(player_id)
    if found is None:
        return PlayerRefOut(id=player_id, name="", name_ru=None)
    return PlayerRefOut(id=found.id, name=found.name, name_ru=found.name_ru)


def _leg_out(context: LegContext, players: dict[int, Player], *, open_bet: bool) -> BetLegItemOut:
    leg, match = context.leg, context.match
    leg_clv = clv(leg.odds_taken, leg.closing_odds) if leg.closing_odds is not None else None
    fair = clv_fair(leg.odds_taken, leg.q_close) if leg.q_close is not None else None
    # Прогноз ноги: итоговая вероятность, у ставок бота — оценка Claude
    p = context.p_final if context.p_final is not None else context.p_claude
    return BetLegItemOut(
        id=leg.id,
        match=LegMatchOut(
            id=match.id,
            player1=_player(players, match.player1_id),
            player2=_player(players, match.player2_id),
            day=context.day,
            tournament=context.tournament_name,
            category=context.tournament.category if context.tournament else None,
            surface=context.surface,  # type: ignore[arg-type]
            round=match.round,
            best_of=context.best_of,
        ),
        market=leg.market,  # type: ignore[arg-type]
        selection=leg.selection,
        odds_taken=short_odds(leg.odds_taken),
        prediction_id=leg.prediction_id,
        p_final=context.p_final,
        p_base=context.p_base,
        p_claude=context.p_claude,
        edge=p - 1 / float(leg.odds_taken) if p is not None and leg.odds_taken > 0 else None,
        result=leg.result,  # type: ignore[arg-type]
        score=score_from_own(leg.score, leg.selection),
        settled_at=leg.settled_at,
        result_source=leg.result_source,  # type: ignore[arg-type]
        closing=_closing_out(leg),
        clv=leg_clv,
        clv_fair=fair,
        score_outcomes=(
            score_outcomes(leg.market, leg.selection, context.best_of)  # type: ignore[arg-type]
            if open_bet
            else None
        ),
        archive_result=leg.archive_result,  # type: ignore[arg-type]
        archive_score=score_from_own(leg.archive_score, leg.selection),
    )


def awaiting_result(contexts: Sequence[LegContext], today: date) -> bool:
    """Открытая ставка ждет результата: все ее матчи уже прошли (день матча раньше
    сегодняшнего по поясу участника), а исхода нет."""
    days = [context.day for context in contexts]
    return bool(days) and all(day is not None and day < today for day in days)


def _payout(bet: Bet) -> Decimal | None:
    if bet.status == "open":
        return money(bet.stake * bet.total_odds)
    if bet.status == "void":
        return bet.stake
    if bet.profit is None:
        return None
    return bet.stake + bet.profit


def bet_item(
    bet: Bet,
    contexts: Sequence[LegContext],
    players: dict[int, Player],
    bank_after: Decimal | None = None,
    *,
    today: date | None = None,
    archive_to: date | None = None,
    archive_now: tuple[date | None, date | None] = (None, None),
) -> BetItemOut:
    """archive_now — последний день матчей в архиве и день следующего файла: только для
    ставки, которая ждет результата."""
    legs = [context.leg for context in contexts]
    waiting = bet.status == "open" and today is not None and awaiting_result(contexts, today)
    live = [leg for leg in legs if leg.result != "void"]
    bet_clv = clv_parlay([(leg.odds_taken, leg.closing_odds) for leg in live])
    bet_fair = clv_fair_parlay([(leg.odds_taken, leg.q_close) for leg in live])
    return BetItemOut(
        id=bet.id,
        analysis_id=bet.analysis_id,
        placed_at=bet.placed_at,
        bookmaker=bet.bookmaker,
        stake=bet.stake,
        currency=bet.currency,
        total_odds=short_odds(bet.total_odds),
        effective_odds=(
            short_odds(odds) if (odds := effective_odds(bet, legs)) is not None else None
        ),
        status=bet.status,  # type: ignore[arg-type]
        profit=bet.profit,
        payout=_payout(bet),
        bank_after=bank_after,
        settled_at=bet.settled_at,
        settled_by=bet.settled_by,  # type: ignore[arg-type]
        source=bet.source,  # type: ignore[arg-type]
        updated_at=bet.updated_at,
        clv=bet_clv,
        clv_fair=bet_fair,
        verdict=verdict(bet, legs, bet_clv),
        legs=[_leg_out(context, players, open_bet=bet.status == "open") for context in contexts],
        archive_to=archive_to if bet.settled_by == "auto" else None,
        awaiting_result=waiting,
        archive_matches_to=archive_now[0] if waiting else None,
        next_upload=archive_now[1] if waiting else None,
    )


async def _archive_days(db: AsyncSession, bets: Sequence[Bet]) -> dict[int, date]:
    """Последний день архива на момент расчета ставки (отчет запуска settle)."""
    run_ids = {bet.settle_run_id for bet in bets if bet.settle_run_id is not None}
    if not run_ids:
        return {}
    rows = await db.execute(
        select(IngestionRun.id, IngestionRun.details["freshness"]["archive_to"].astext).where(
            IngestionRun.id.in_(run_ids)
        )
    )
    found: dict[int, date] = {}
    for run_id, value in rows:
        if not value:
            continue
        try:
            found[int(run_id)] = date.fromisoformat(value)
        except ValueError:
            continue
    return {
        bet.id: found[bet.settle_run_id]
        for bet in bets
        if bet.settle_run_id is not None and bet.settle_run_id in found
    }


async def bet_items(
    db: AsyncSession,
    user: User,
    bet_ids: Sequence[int],
    *,
    after: Mapping[int, Decimal] | None = None,
) -> list[BetItemOut]:
    """Ставки участника по id в том же порядке (чужие и несуществующие пропускаются).
    after — «банк после» уже посчитан (выгрузка считает его один раз на все ставки)."""
    if not bet_ids:
        return []
    found = {
        bet.id: bet
        for bet in await db.scalars(
            select(Bet)
            .where(Bet.id.in_(bet_ids), Bet.user_id == user.id)
            .execution_options(populate_existing=True)
        )
    }
    bets = [found[bet_id] for bet_id in bet_ids if bet_id in found]
    contexts = await leg_contexts(db, user, bets)
    player_ids = {
        player_id
        for legs in contexts.values()
        for context in legs
        for player_id in (context.match.player1_id, context.match.player2_id)
    }
    players = {
        player.id: player
        for player in await db.scalars(select(Player).where(Player.id.in_(player_ids)))
    }
    # «Банк после» — капитал сразу после расчета, как в последних ставках главной
    if after is None:
        after = await equity_after_bets(
            db, user.id, [bet.id for bet in bets if bet.status != "open"]
        )
    zone = user_zone(user.tz)
    today = local_today(zone)
    archive = await _archive_days(db, bets)
    archive_now: tuple[date | None, date | None] = (None, None)
    if any(bet.status == "open" and awaiting_result(contexts[bet.id], today) for bet in bets):
        last_load = (await last_ok_loads(db))["tennis_data"]
        archive_now = (
            await archive_matches_to(db),
            next_upload_day(last_load, zone, today),
        )
    return [
        bet_item(
            bet,
            contexts[bet.id],
            players,
            after.get(bet.id),
            today=today,
            archive_to=archive.get(bet.id),
            archive_now=archive_now,
        )
        for bet in bets
    ]


async def bet_counts(db: AsyncSession, user: User, now: datetime | None = None) -> BetCountsOut:
    """Счетчики для меню: открытые ставки и из них ждущие результата (все матчи прошли по
    поясу участника)."""
    bets = list(
        await db.scalars(
            select(Bet).where(Bet.user_id == user.id, Bet.status == "open").order_by(Bet.id)
        )
    )
    contexts = await leg_contexts(db, user, bets)
    today = local_today(user_zone(user.tz), now)
    waiting = sum(1 for bet in bets if awaiting_result(contexts.get(bet.id, []), today))
    return BetCountsOut(open=len(bets), awaiting_result=waiting)


async def bet_detail(db: AsyncSession, user: User, bet_id: int) -> BetItemOut:
    """Карточка своей ставки; чужая или несуществующая — 404. У открытой ставки ноги,
    чей матч прошел, получают подсказку исхода по новостям (этап 5, В1-Г)."""
    items = await bet_items(db, user, [bet_id])
    if not items:
        raise AppError(404, "bet.not_found")
    item = items[0]
    if item.status != "open":
        return item
    today = local_today(user_zone(user.tz))
    waiting = [
        (leg.id, leg.match.player1.id, leg.match.player2.id, leg.match.day, leg.match.best_of)
        for leg in item.legs
        if leg.result is None and leg.match.day is not None and leg.match.day < today
    ]
    hints = await news_results(db, waiting)
    if not hints:
        return item
    legs = [leg.model_copy(update={"news_result": hints.get(leg.id)}) for leg in item.legs]
    return item.model_copy(update={"legs": legs})


def _ordered(conds: Sequence[ColumnElement[bool]]) -> Select[int]:
    return select(Bet.id).where(*conds).order_by(Bet.placed_at.desc(), Bet.id.desc())


async def list_bets(
    db: AsyncSession, user: User, page: BetPageIn, *, now: datetime | None = None
) -> BetPageOut:
    """Страница своих ставок по фильтрам, новые сверху (время ставки, затем номер).
    before — номер последней ставки прошлой страницы (своей, иначе 422)."""
    conds = bet_conditions(page, user, now or utcnow(), page=True)
    if page.before is not None:
        cursor = (
            await db.execute(
                select(Bet.placed_at, Bet.id).where(Bet.id == page.before, Bet.user_id == user.id)
            )
        ).first()
        if cursor is None:
            raise AppError(422, "bet.bad_cursor")
        conds.append(tuple_(Bet.placed_at, Bet.id) < tuple_(cursor.placed_at, cursor.id))
    ids = list(await db.scalars(_ordered(conds).limit(page.limit + 1)))
    items = await bet_items(db, user, ids[: page.limit])
    return BetPageOut(items=items, next_before=items[-1].id if len(ids) > page.limit else None)


def _ln(column: Any) -> ColumnElement[float]:
    return func.ln(cast(column, Float))


# Знаков CLV ставки в итогах: логарифмы в double precision ошибаются на 1e-15, и экспресс
# с равными произведениями кэфов и закрытий иначе дал бы ±1e-16 вместо ровно 0
_CLV_DIGITS = 12


def summary_query(conds: Sequence[ColumnElement[bool]]) -> Select[Any]:
    """Итоги ставок по условиям одним запросом: ставки по фильтрам выбираются один раз
    (CTE picked), из них — деньги и счетчики (totals) и CLV по ставкам (clvs)."""
    picked = (
        select(Bet.id, Bet.status, Bet.stake, Bet.profit, Bet.source).where(*conds).cte("picked")
    )
    played = picked.c.status.in_(("won", "lost"))
    settled = picked.c.status != "open"
    totals = select(
        func.count().filter(settled).label("settled"),
        func.count().filter(picked.c.status == "won").label("won"),
        func.count().filter(picked.c.status == "lost").label("lost"),
        func.count().filter(picked.c.status == "void").label("void"),
        func.coalesce(func.sum(picked.c.stake).filter(played), 0).label("turnover"),
        func.coalesce(func.sum(picked.c.profit).filter(played), 0).label("profit"),
        func.count().filter(picked.c.status == "open").label("open"),
        func.coalesce(func.sum(picked.c.stake).filter(picked.c.status == "open"), 0).label(
            "open_stake"
        ),
        func.count().filter(and_(settled, picked.c.source == "legacy")).label("legacy"),
    ).subquery("totals")
    live = _LIVE_RESULT
    bet_clv = func.exp(
        func.sum(_ln(BetLeg.odds_taken)).filter(live)
        - func.sum(_ln(BetLeg.closing_odds)).filter(live)
    )
    per_bet = (
        select(
            BetLeg.bet_id,
            case(
                (
                    func.bool_and(BetLeg.closing_odds.is_not(None)).filter(live),
                    func.round(cast(bet_clv - 1, Numeric), _CLV_DIGITS),
                ),
                else_=None,
            ).label("clv"),
        )
        .join(picked, picked.c.id == BetLeg.bet_id)
        .where(picked.c.source == "app", settled)
        .group_by(BetLeg.bet_id)
        .subquery("per_bet")
    )
    clvs = select(
        func.avg(per_bet.c.clv).label("mean"),
        func.count(per_bet.c.clv).label("n"),
        func.count().filter(per_bet.c.clv > 0).label("positive"),
    ).subquery("clvs")
    return select(totals, clvs).select_from(totals.join(clvs, true()))


async def bets_summary(
    db: AsyncSession, user: User, filters: BetFiltersIn, *, now: datetime | None = None
) -> BetsSummaryOut:
    """Итоги по фильтрам «Ставок» (правила — в docstring модуля): суммы в SQL, одним
    запросом."""
    settings = await get_app_settings(db)
    conds = bet_conditions(filters, user, now or utcnow())
    row = (await db.execute(summary_query(conds))).one()
    turnover, profit = Decimal(row.turnover), Decimal(row.profit)
    won, lost = int(row.won), int(row.lost)
    decided = won + lost
    return BetsSummaryOut(
        currency=settings.currency,
        settled=int(row.settled),
        won=won,
        lost=lost,
        void=int(row.void),
        winrate=won / decided if decided else None,
        turnover=turnover,
        profit=profit,
        roi=float(profit / turnover) if turnover > 0 else None,
        avg_stake=money(turnover / decided) if decided else None,
        open=int(row.open),
        open_stake=Decimal(row.open_stake),
        clv=float(row.mean) if row.mean is not None else None,
        clv_positive=int(row.positive),
        clv_n=int(row.n),
        legacy_settled=int(row.legacy),
    )


# --- выгрузка CSV ---

CSV_COLUMNS: tuple[str, ...] = (
    "bet_id",
    "placed_at",
    "source",
    "bookmaker",
    "status",
    "stake",
    "currency",
    "total_odds",
    "effective_odds",
    "payout",
    "profit",
    "settled_at",
    "bet_clv",
    "leg_no",
    "match_day",
    "player1",
    "player2",
    "tournament",
    "surface",
    "round",
    "best_of",
    "market",
    "pick",
    "odds_taken",
    "p_final",
    "p_base",
    "p_claude",
    "result",
    "score",
    "closing_odds",
    "closing_opp_odds",
    "closing_by",
    "q_close",
    "clv",
    "clv_fair",
)


def _local(moment: datetime | None, zone: Any) -> str | None:
    return moment.astimezone(zone).strftime("%Y-%m-%d %H:%M") if moment else None


def _csv_rows(item: BetItemOut, zone: Any) -> Iterable[list[str]]:
    for number, leg in enumerate(item.legs, start=1):
        match = leg.match
        names = (match.player1.name, match.player2.name)
        closing = leg.closing
        values: list[Any] = [
            item.id,
            _local(item.placed_at, zone),
            item.source,
            item.bookmaker,
            item.status,
            item.stake,
            item.currency,
            item.total_odds,
            item.effective_odds,
            item.payout if item.status != "open" else None,
            item.profit,
            _local(item.settled_at, zone),
            item.clv,
            number,
            match.day.isoformat() if match.day else None,
            names[0],
            names[1],
            match.tournament,
            match.surface,
            match.round,
            match.best_of,
            leg.market,
            names[leg.selection - 1],
            leg.odds_taken,
            leg.p_final,
            leg.p_base,
            leg.p_claude,
            leg.result,
            leg.score,
            closing.odds if closing else None,
            closing.opp_odds if closing else None,
            (closing.bookmaker or closing.by) if closing else None,
            closing.q_close if closing else None,
            leg.clv,
            leg.clv_fair,
        ]
        yield [csv_cell(value) for value in values]


# Ставок в одной части выгрузки: между частями цикл событий обслуживает другие запросы
_CSV_CHUNK = 200


def _csv_text(rows: Iterable[list[str]]) -> str:
    out = io.StringIO()
    csv.writer(out, lineterminator="\r\n").writerows(rows)
    return out.getvalue()


async def export_csv(
    db: AsyncSession, user: User, filters: BetFiltersIn, *, now: datetime | None = None
) -> AsyncIterator[str]:
    """CSV своих ставок по фильтрам «Ставок»: строка на событие (ногу), новые сверху.
    Заголовки — из локали, время — по поясу участника, BOM — чтобы Excel узнал UTF-8.

    Фильтры проверяются сразу (ошибка — до начала ответа), файл отдается частями по
    _CSV_CHUNK ставок: целиком в памяти он не собирается, а сборка частей не занимает
    цикл событий секундами. Сеанс БД должен жить, пока ответ не отдан (зависимость
    маршрута с yield так и живет)."""
    conds = bet_conditions(filters, user, now or utcnow())
    ids = list(await db.scalars(_ordered(conds)))
    zone = user_zone(user.tz)

    async def chunks() -> AsyncIterator[str]:
        yield "\ufeff" + _csv_text([[t(f"bets.csv.{column}") for column in CSV_COLUMNS]])
        # «Банк после» — одним запросом на все ставки: он идет по всему журналу
        after = await equity_after_bets(db, user.id, ids)
        for start in range(0, len(ids), _CSV_CHUNK):
            items = await bet_items(db, user, ids[start : start + _CSV_CHUNK], after=after)
            yield _csv_text(row for item in items for row in _csv_rows(item, zone))
            await asyncio.sleep(0)

    return chunks()
