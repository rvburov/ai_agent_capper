"""Закрывающий кэф ноги ставки и CLV (решение В1, Р24; Р22: по своим ставкам закрытие
вносит участник на экране «Ставки»).

Участник вносит кэф на свой исход (обязательно) и на обратный (по желанию) и выбирает,
чей это кэф: эталон рынка по Р17 (pinnacle → betfair_ex → avg) или свой букмекер. При двух
сторонах маржа снимается степенным методом (app/ml/market.py): q_close — вероятность своего
исхода без маржи, по ней «CLV без маржи». CLV ноги хранится в bet_legs.clv (кэф /
закрывающий − 1); CLV экспресса считается при чтении (app/services/bets.py).

Закрытие не меняет деньги, но идет под той же блокировкой участника и FOR UPDATE ставки,
что и расчет: расчет тоже пишет закрытие. Ставки старого бота, рассчитанные импортом, не
меняются; открытую ставку бота участник рассчитывает сам, как свою (settled_by = manual).
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import Bet, BetLeg, User
from app.ml.market import devig_pair
from app.ml.metrics import clv
from app.schemas.bets import BetItemOut, ClosingIn
from app.services import bet_versions
from app.services.bank import lock_member_money
from app.services.bets import ODDS_MAX, ODDS_MIN, ODDS_STEP, bet_detail

CLOSING_SOURCE_USER = "user"
SETTLED_MANUAL = "manual"


def imported_result(bet: Bet) -> bool:
    """Результат ставки старого бота перенесен импортом: его не пересчитываем. Открытая
    ставка бота и ставка бота, которую рассчитал сам участник, — обычные."""
    return bet.source == "legacy" and bet.status != "open" and bet.settled_by != SETTLED_MANUAL


def check_closing(closing: ClosingIn) -> None:
    """Кэфы закрытия 1.01–50 — иначе 422 bet.closing_range."""
    for value in (closing.odds, closing.opp_odds):
        if value is not None and not ODDS_MIN <= value <= ODDS_MAX:
            raise AppError(422, "bet.closing_range", odds=str(value))


def apply_closing(leg: BetLeg, closing: ClosingIn | None, *, bet_bookmaker: str) -> None:
    """Записать (или стереть, closing = None) закрывающий кэф ноги, q_close и CLV."""
    if closing is None:
        leg.closing_odds = None
        leg.closing_opp_odds = None
        leg.closing_bookmaker = None
        leg.closing_source = None
        leg.q_close = None
        leg.clv = None
        return
    check_closing(closing)
    odds = closing.odds.quantize(ODDS_STEP)
    opposite = closing.opp_odds.quantize(ODDS_STEP) if closing.opp_odds is not None else None
    leg.closing_odds = odds
    leg.closing_opp_odds = opposite
    leg.closing_bookmaker = (
        closing.by if closing.by != "bookmaker" else (closing.bookmaker or bet_bookmaker)
    )
    leg.closing_source = CLOSING_SOURCE_USER
    leg.q_close = devig_pair(odds, opposite) if opposite is not None else None
    leg.clv = clv(leg.odds_taken, odds)


def same_closing(leg: BetLeg, closing: ClosingIn | None, *, bet_bookmaker: str) -> bool:
    """Закрытие ноги уже такое (повтор того же запроса)."""
    if closing is None:
        return leg.closing_odds is None
    by = closing.by if closing.by != "bookmaker" else (closing.bookmaker or bet_bookmaker)
    return (
        leg.closing_odds == closing.odds
        and leg.closing_opp_odds == closing.opp_odds
        and leg.closing_bookmaker == by
    )


async def locked_bet(db: AsyncSession, user: User, bet_id: int) -> tuple[Bet, list[BetLeg]]:
    """Своя ставка и ее ноги под блокировкой денег участника и FOR UPDATE. Чужая или
    несуществующая — 404, результат из импорта старого бота — 409 (его не пересчитываем)."""
    await lock_member_money(db, user.id)
    bet = await db.scalar(
        select(Bet)
        .where(Bet.id == bet_id, Bet.user_id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if bet is None:
        raise AppError(404, "bet.not_found")
    if imported_result(bet):
        raise AppError(409, "bet.legacy")
    legs = list(
        await db.scalars(
            select(BetLeg)
            .where(BetLeg.bet_id == bet.id)
            .order_by(BetLeg.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    return bet, legs


async def set_leg_closing(
    db: AsyncSession, user: User, bet_id: int, leg_id: int, closing: ClosingIn | None
) -> BetItemOut:
    """Закрывающий кэф ноги своей ставки (в том числе рассчитанной: «Внести закрытие»).
    Нога не этой ставки — 404. Делает commit."""
    bet, legs = await locked_bet(db, user, bet_id)
    leg = next((item for item in legs if item.id == leg_id), None)
    if leg is None:
        raise AppError(404, "bet.leg_not_found")
    if closing is not None:
        check_closing(closing)
    if not same_closing(leg, closing, bet_bookmaker=bet.bookmaker):
        apply_closing(leg, closing, bet_bookmaker=bet.bookmaker)
        bet_versions.touch(bet)
    await db.commit()
    return await bet_detail(db, user, bet_id)
