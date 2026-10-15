"""Закрывающий кэф ног П1/П2 из архива tennis-data (этап 5, Т1; Р22: «для остальных
разобранных матчей — из tennis-data»).

В архиве есть только рынок ML пяти букмекеров (odds_snapshots.kind = archive), и когда
сняты кэфы, сайт не сообщает: закрытие из архива везде подписано «момент снятия не
проверен» (ClosingOut.unverified). Эталон — как у участника и в бэктесте (Р17): первый из
pinnacle → betfair_ex → avg, у кого есть кэфы обеих сторон. q_close — вероятность своего
исхода без маржи степенным методом (app/ml/market.py), CLV — кэф / закрытие − 1.

Закрытие, которое внес участник (closing_source = user), не трогается. У ног фор, ставок
старого бота, ног без пары кэфов архива и ног на прошлой встрече пары (матч архива раньше
ставки, app/ingest/match_link.py, played_before) закрытия из архива нет. Закрытие не
меняет деньги, но идет под той же блокировкой участника и FOR UPDATE ставки и ног, что
расчет: расчет тоже пишет закрытие, а новое закрытие — новая версия ставки (bet_versions).
"""

from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import Select, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet, BetLeg, Match, OddsSnapshot
from app.ingest.match_link import archive_days, played_before
from app.ml.market import REFERENCE_ORDER, devig_pair, reference_odds
from app.ml.metrics import clv
from app.ml.sets import MARKET_ML
from app.services.bank import lock_member_money
from app.services.bet_versions import touch
from app.services.bets import ODDS_STEP

ARCHIVE_SOURCES = ("sackmann", "tennis_data")
ARCHIVE_KIND = "archive"
CLOSING_SOURCE_ARCHIVE = "archive"


@dataclass(frozen=True)
class ArchiveClosing:
    """Закрытие из архива для исхода selection: свой кэф, обратный, чей."""

    odds: Decimal
    opp_odds: Decimal
    bookmaker: str


async def archive_pairs(
    db: AsyncSession, match_ids: list[int]
) -> dict[int, dict[str, tuple[Decimal | None, Decimal | None]]]:
    """Кэфы архива рынка ML: матч → букмекер → (кэф игрока 1, кэф игрока 2)."""
    pairs: dict[int, dict[str, list[Decimal | None]]] = defaultdict(dict)
    if not match_ids:
        return {}
    rows = await db.execute(
        select(
            OddsSnapshot.match_id, OddsSnapshot.bookmaker, OddsSnapshot.selection, OddsSnapshot.odds
        ).where(
            OddsSnapshot.match_id.in_(match_ids),
            OddsSnapshot.kind == ARCHIVE_KIND,
            OddsSnapshot.market == MARKET_ML,
            OddsSnapshot.bookmaker.in_(REFERENCE_ORDER),
        )
    )
    for match_id, bookmaker, selection, odds in rows:
        pair = pairs[int(match_id)].setdefault(bookmaker, [None, None])
        pair[int(selection) - 1] = odds
    return {
        match_id: {name: (pair[0], pair[1]) for name, pair in by_book.items()}
        for match_id, by_book in pairs.items()
    }


def closing_for(
    by_book: dict[str, tuple[Decimal | None, Decimal | None]], selection: int
) -> ArchiveClosing | None:
    """Закрытие исхода selection по эталону Р17; пары кэфов нет ни у кого — None."""
    found = reference_odds(by_book, REFERENCE_ORDER)
    if found is None:
        return None
    bookmaker, (odds1, odds2) = found
    own, other = (odds1, odds2) if selection == 1 else (odds2, odds1)
    return ArchiveClosing(
        odds=Decimal(own).quantize(ODDS_STEP),
        opp_odds=Decimal(other).quantize(ODDS_STEP),
        bookmaker=bookmaker,
    )


def apply_archive_closing(leg: BetLeg, closing: ArchiveClosing) -> bool:
    """Записать закрытие из архива в ногу; True — что-то изменилось."""
    q_close = devig_pair(closing.odds, closing.opp_odds)
    if (
        leg.closing_source == CLOSING_SOURCE_ARCHIVE
        and leg.closing_odds == closing.odds
        and leg.closing_opp_odds == closing.opp_odds
        and leg.closing_bookmaker == closing.bookmaker
    ):
        return False
    leg.closing_odds = closing.odds
    leg.closing_opp_odds = closing.opp_odds
    leg.closing_bookmaker = closing.bookmaker
    leg.closing_source = CLOSING_SOURCE_ARCHIVE
    leg.q_close = q_close
    leg.clv = clv(leg.odds_taken, closing.odds)
    return True


def _candidate_legs() -> Select[int, int]:
    """Ноги П1/П2 ставок приложения на матчах архива с кэфами архива, без закрытия
    участника."""
    return (
        select(Bet.user_id, BetLeg.bet_id)
        .join(Bet, Bet.id == BetLeg.bet_id)
        .join(Match, Match.id == BetLeg.match_id)
        .where(
            Bet.source == "app",
            BetLeg.market == MARKET_ML,
            Match.source.in_(ARCHIVE_SOURCES),
            or_(BetLeg.closing_source.is_(None), BetLeg.closing_source == CLOSING_SOURCE_ARCHIVE),
            exists().where(
                OddsSnapshot.match_id == BetLeg.match_id,
                OddsSnapshot.kind == ARCHIVE_KIND,
                OddsSnapshot.market == MARKET_ML,
            ),
        )
        .distinct()
    )


async def close_from_archive(db: AsyncSession) -> tuple[int, set[int]]:
    """Закрытие из архива у всех подходящих ног (правила — в docstring модуля). Возвращает
    число ног, где закрытие появилось или изменилось, и участников с такими ногами. Делает
    commit по участнику: блокировка денег держится недолго."""
    rows = (await db.execute(_candidate_legs())).all()
    bets_by_user: dict[int, list[int]] = defaultdict(list)
    for user_id, bet_id in rows:
        bets_by_user[int(user_id)].append(int(bet_id))
    changed = 0
    users: set[int] = set()
    for user_id, bet_ids in sorted(bets_by_user.items()):
        await lock_member_money(db, user_id)
        bets = {
            bet.id: bet
            for bet in await db.scalars(
                select(Bet)
                .where(Bet.id.in_(bet_ids), Bet.user_id == user_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        }
        legs = list(
            await db.scalars(
                select(BetLeg)
                .where(BetLeg.bet_id.in_(list(bets)))
                .order_by(BetLeg.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        match_ids = sorted({leg.match_id for leg in legs})
        pairs = await archive_pairs(db, match_ids)
        days = await archive_days(db, match_ids)
        touched: set[int] = set()
        for leg in legs:
            if leg.market != MARKET_ML or leg.closing_source not in (None, CLOSING_SOURCE_ARCHIVE):
                continue
            if played_before(days.get(leg.match_id), bets[leg.bet_id].placed_at):
                continue
            closing = closing_for(pairs.get(leg.match_id, {}), leg.selection)
            if closing is not None and apply_archive_closing(leg, closing):
                changed += 1
                touched.add(leg.bet_id)
        for bet_id in touched:
            touch(bets[bet_id])
        if touched:
            users.add(user_id)
        await db.commit()
    return changed, users
