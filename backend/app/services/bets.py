"""Ставка по итогу анализа («Сохранить ставку»), банк и букмекеры участника.

Ставка — рекомендованный экспресс анализа: состав ног менять нельзя, кэфы — можно
(фактические кэфы при ставке). Итоговый кэф — произведение кэфов ног. Сумма — больше
нуля и не больше банка (по учету; пустой журнал — банк из ввода анализа). Все
считается под блокировкой участника (pg_advisory_xact_lock): две ставки не списываются
с одного банка параллельно. Пустой журнал и банк из ввода — сначала запись deposit
«начальный банк», затем ставка и запись stake. Повтор с тем же client_ref возвращает
ту же ставку. Валюта — валюта программы.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, literal, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.i18n import t
from app.db.models import Analysis, BankrollLedger, Bet, BetLeg, Prediction, User
from app.ml.strategy import StrategyParams
from app.schemas.bets import AdaptationOut, BankOut, BetIn, BetLegOut, BetOut
from app.services.analysis_input import short_odds
from app.services.app_settings import get_app_settings
from app.services.bank import BankState, bank_state, drawdown_level
from app.services.sessions import utcnow
from app.services.strategy_versions import active_version, params_of

# Ключ блокировки ставок участника: пространство «bets» плюс id участника
BETS_LOCK = 0x6265747300000000
ODDS_MIN = Decimal("1.01")
ODDS_MAX = Decimal("50")
TOTAL_MAX = Decimal("999.999")
ODDS_STEP = Decimal("0.001")
CENT = Decimal("0.01")
BOOKMAKERS_LIMIT = 20


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
    await db.execute(select(func.pg_advisory_xact_lock(BETS_LOCK + user.id)))
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
    stake_sum = body.stake.quantize(CENT)
    total = Decimal(1)
    for leg in body.legs:
        if not ODDS_MIN <= leg.odds_taken <= ODDS_MAX:
            raise AppError(422, "bet.odds_range", odds=str(leg.odds_taken))
        total *= leg.odds_taken
    total = total.quantize(ODDS_STEP, rounding=ROUND_HALF_UP)
    if total > TOTAL_MAX:
        raise AppError(422, "bet.odds_range", odds=str(total))
    settings = await get_app_settings(db)
    state = await bank_state(db, user.id)
    bank = analysis.bank_input if state.empty else state.balance
    if bank is None or stake_sum > bank:
        raise AppError(422, "bet.stake_range", bank=str(bank or 0), currency=settings.currency)
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
    await db.commit()
    return PlacedBet(bet, legs, created=True)


# --- банк и букмекеры ---


def _adaptations(state: BankState, params: StrategyParams) -> list[AdaptationOut]:
    level = drawdown_level(state, params)
    growth, week = params.growth, params.week
    change = state.week_change
    rules: list[tuple[str, bool, dict[str, Any]]] = []
    for item in params.drawdown:
        rules.append(
            (
                item.key,
                level is not None and level.key == item.key,
                {"from": str(item.start), "max_pct": str(item.max_pct)},
            )
        )
    rules.append(
        (
            "up15",
            state.growth is not None
            and state.winrate is not None
            and state.growth >= growth.bank_up
            and state.winrate >= growth.min_winrate,
            {
                "bank_up": str(growth.bank_up),
                "min_winrate": str(growth.min_winrate),
                "max_pct": str(growth.max_pct),
            },
        )
    )
    rules.append(
        (
            "week_loss",
            change is not None and change <= week.loss,
            {"loss": str(week.loss), "max_pct": str(week.loss_max_pct)},
        )
    )
    rules.append(
        (
            "week_win",
            change is not None and change >= week.win,
            {"win": str(week.win), "add": str(week.win_add)},
        )
    )
    return [
        AdaptationOut(
            key=key,  # type: ignore[arg-type]
            enabled=params.adapt_on(key),
            active=active and params.adapt_on(key),
            params=values,
        )
        for key, active, values in rules
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


async def bookmakers(db: AsyncSession, user: User) -> list[str]:
    """Букмекеры участника из ставок и анализов, частые первыми."""
    names = union_all(
        select(Bet.bookmaker.label("name")).where(Bet.user_id == user.id),
        select(Analysis.bookmaker.label("name")).where(
            Analysis.user_id == user.id, Analysis.bookmaker.is_not(None)
        ),
    ).subquery()
    rows = await db.execute(
        select(names.c.name, func.count().label("uses"))
        .where(func.length(func.trim(names.c.name)) > literal(0))
        .group_by(names.c.name)
        .order_by(func.count().desc(), names.c.name)
        .limit(BOOKMAKERS_LIMIT)
    )
    return [str(name) for name, _ in rows]
