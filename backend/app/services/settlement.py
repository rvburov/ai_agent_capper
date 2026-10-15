"""Ручной расчет ставки и исправление результата (этап 4); общая запись расчета для
ручного расчета и авторасчета по архиву (этап 5, app/services/auto_settlement.py).

Расчет: участник вносит исход каждой ноги (выиграл, проиграл, возврат), по желанию счет
по сетам и закрывающий кэф. Снятие и отказ — исход по правилам своего букмекера (В16).
Итог ставки: есть проигрыш — lost; все возвраты — void; иначе won с кэфом расчета —
произведением кэфов выигравших ног (возврат — кэф 1.00, app/services/bets.py,
effective_odds). Выплата — сумма × кэф до копеек (ROUND_HALF_UP), запись payout; у
возврата — refund на сумму ставки; у проигрыша записи нет (сумма списана при ставке).
Уведомления нет: участник сам нажал кнопку, ему — баннер (Т12). Запись расчета — одна
функция apply_settlement: ее же зовет авторасчет (settled_by = auto) под теми же
блокировками.

Исправление (сторно): действующая выплата или возврат получает запись reversal на ту же
сумму с обратным знаком и ссылку reversed_by на нее; ставка снова открыта, исходы ног
стерты, закрытие остается. У проигрыша выплаты не было — в журнале ничего не меняется.
Пик и просадка (Р22) пересчитываются сами: они считаются по журналу (app/services/bank.py).

Счет по сетам исход не выбирает: при снятии, отказе и ошибке букмекера исход — по его
расчету (В16), поэтому счет, который расходится с исходом, принимается (в окне расчета —
предупреждение по score_outcomes карточки, app/services/bets.py).

Выплата и прибыль хранятся в NUMERIC(12, 2): выплата больше MONEY_MAX — 422 (новую такую
ставку не принимает place_bet, но ставки бота и старые ставки могли быть больше).

Гонки: все — под блокировкой денег участника (lock_member_money) и FOR UPDATE ставки и ног;
запрос несет версию ставки, которую видел участник (app/services/bet_versions.py). Не
совпала — 409, кроме повтора того же действия (двойной клик): тот же расчет уже сохранен
или ставка уже открыта — возвращается ставка как есть. Результат из импорта старого бота
не пересчитывается (409); открытую ставку бота участник рассчитывает сам.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.i18n import t
from app.db.models import BankrollLedger, Bet, BetLeg, User
from app.ml.sets import BEST_OF, parse_set_count
from app.schemas.bets import BetItemOut, LegSettleIn, ReverseIn, SettleIn
from app.services import postmortems
from app.services.bank import MONEY_MAX
from app.services.bet_versions import same_version, touch
from app.services.bets import bet_detail, leg_contexts, money, score_to_own, settle_odds
from app.services.closing import (
    SETTLED_MANUAL,
    apply_closing,
    check_closing,
    locked_bet,
    same_closing,
)
from app.services.sessions import utcnow

PAYOUT_KINDS = ("payout", "refund")
# Примеры полного счета для текста ошибки: первым — игрок 1
_SCORE_EXAMPLES = {3: "2:0, 2:1, 1:2, 0:2", 5: "3:0, 3:1, 3:2, 2:3, 1:3, 0:3"}


def bet_outcome(results: Sequence[str]) -> str:
    """Итог ставки по исходам ног: есть проигрыш — lost, все возвраты — void, иначе won."""
    if "loss" in results:
        return "lost"
    if all(result == "void" for result in results):
        return "void"
    return "won"


def payout_amount(stake: Decimal, status: str, odds: Decimal | None) -> Decimal:
    """Выплата: выигрыш — сумма × кэф расчета до копеек, возврат — сумма, проигрыш — 0."""
    if status == "won":
        if odds is None:
            raise ValueError("won без кэфа расчета")
        return money(stake * odds)
    if status == "void":
        return stake
    return Decimal(0)


def _own_score(text: str | None, leg: BetLeg, best_of: int | None) -> str | None:
    """Счет из ввода (первым — игрок 1) → хранимый со стороны выбранного игрока. Неполный
    или не тот формат — 422 bet.bad_score."""
    if text is None:
        return None
    count = parse_set_count(text, best_of)
    if count is None:
        formats = (best_of,) if best_of in BEST_OF else BEST_OF
        examples = ", ".join(_SCORE_EXAMPLES[value] for value in formats if value is not None)
        raise AppError(422, "bet.bad_score", score=text, examples=examples)
    return score_to_own(count, leg.selection)


def _same_result(
    bet: Bet, legs: Sequence[BetLeg], given: dict[int, LegSettleIn], scores: dict[int, str | None]
) -> bool:
    """Ставка уже рассчитана ровно так (повтор того же запроса)."""
    for leg in legs:
        item = given[leg.id]
        if leg.result != item.result or leg.score != scores[leg.id]:
            return False
        if "closing" in item.model_fields_set and not same_closing(
            leg, item.closing, bet_bookmaker=bet.bookmaker
        ):
            return False
    return True


@dataclass(frozen=True)
class LegSettlement:
    """Исход ноги и счет со стороны выбранного игрока (как хранится в bet_legs.score)."""

    result: str
    score: str | None


def apply_settlement(
    db: AsyncSession,
    bet: Bet,
    legs: Sequence[BetLeg],
    outcome: Mapping[int, LegSettlement],
    *,
    settled_by: str,
    now: datetime,
    settle_run_id: int | None = None,
) -> Decimal:
    """Записать расчет открытой ставки: исходы ног, итог, прибыль и выплату в журнал (у
    проигрыша записи нет). Блокировки — у вызывающего (lock_member_money и FOR UPDATE
    ставки и ног). Выплата больше MONEY_MAX — 422 bet.payout_overflow, и ставка не
    меняется. Возвращает выплату. Только add; flush и commit — за вызывающим."""
    status = bet_outcome([outcome[leg.id].result for leg in legs])
    odds = settle_odds(
        status, bet.total_odds, [(leg.odds_taken, outcome[leg.id].result) for leg in legs]
    )
    payout = payout_amount(bet.stake, status, odds)
    if payout > MONEY_MAX:
        raise AppError(
            422,
            "bet.payout_overflow",
            payout=str(payout),
            max=str(MONEY_MAX),
            currency=bet.currency,
        )
    for leg in legs:
        leg.result = outcome[leg.id].result
        leg.score = outcome[leg.id].score
        leg.settled_at = now
        leg.result_source = settled_by
        leg.archive_result = None
        leg.archive_score = None
    bet.status = status
    bet.profit = payout - bet.stake
    bet.settled_at = now
    bet.settled_by = settled_by
    bet.settle_run_id = settle_run_id
    touch(bet)
    if payout > 0:
        db.add(
            BankrollLedger(
                user_id=bet.user_id,
                at=now,
                kind="payout" if status == "won" else "refund",
                amount=payout,
                currency=bet.currency,
                bet_id=bet.id,
            )
        )
    return payout


async def settle_bet(db: AsyncSession, user: User, bet_id: int, body: SettleIn) -> BetItemOut:
    """Ручной расчет своей открытой ставки (правила — в docstring модуля). Делает commit."""
    bet, legs = await locked_bet(db, user, bet_id)
    given = {item.leg_id: item for item in body.legs}
    if len(given) != len(body.legs) or set(given) != {leg.id for leg in legs}:
        raise AppError(422, "bet.legs_mismatch")
    contexts = {
        context.leg.id: context for context in (await leg_contexts(db, user, [bet]))[bet.id]
    }
    scores: dict[int, str | None] = {}
    for leg in legs:
        item = given[leg.id]
        if item.closing is not None:
            check_closing(item.closing)
        scores[leg.id] = _own_score(item.score, leg, contexts[leg.id].best_of)
    if not same_version(bet.updated_at, body.expected_updated_at):
        if bet.status != "open" and _same_result(bet, legs, given, scores):
            await db.commit()
            return await bet_detail(db, user, bet.id)
        raise AppError(409, "bet.changed")
    if bet.status != "open":
        raise AppError(409, "bet.settled")
    now = utcnow()
    outcome = {leg.id: LegSettlement(given[leg.id].result, scores[leg.id]) for leg in legs}
    apply_settlement(db, bet, legs, outcome, settled_by=SETTLED_MANUAL, now=now)
    for leg in legs:
        item = given[leg.id]
        if "closing" in item.model_fields_set:
            apply_closing(leg, item.closing, bet_bookmaker=bet.bookmaker)
    await db.commit()
    return await bet_detail(db, user, bet.id)


async def reverse_settlement(
    db: AsyncSession, user: User, bet_id: int, body: ReverseIn
) -> BetItemOut:
    """Исправить результат: сторно действующей выплаты или возврата, ставка снова открыта
    (правила — в docstring модуля). Делает commit."""
    bet, legs = await locked_bet(db, user, bet_id)
    if not same_version(bet.updated_at, body.expected_updated_at):
        if bet.status == "open":
            await db.commit()
            return await bet_detail(db, user, bet.id)
        raise AppError(409, "bet.changed")
    if bet.status == "open":
        raise AppError(409, "bet.not_settled")
    rows = list(
        await db.scalars(
            select(BankrollLedger)
            .where(
                BankrollLedger.user_id == user.id,
                BankrollLedger.bet_id == bet.id,
                BankrollLedger.kind.in_(PAYOUT_KINDS),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    reversals = await db.scalar(
        select(func.count()).where(
            BankrollLedger.user_id == user.id,
            BankrollLedger.bet_id == bet.id,
            BankrollLedger.kind == "reversal",
        )
    )
    live = [row for row in rows if row.reversed_by is None]
    # По одному сторно на каждую отмененную выплату и одна действующая выплата у выигрыша
    # и возврата (у проигрыша — ни одной): иначе журнал уже испорчен, исправлять нельзя
    expected_live = 0 if bet.status == "lost" else 1
    if int(reversals or 0) != len(rows) - len(live) or len(live) != expected_live:
        raise AppError(409, "bet.ledger_conflict")
    now = utcnow()
    for row in live:
        reversal = BankrollLedger(
            user_id=user.id,
            at=now,
            kind="reversal",
            amount=-row.amount,
            currency=row.currency,
            bet_id=bet.id,
            note=t("bets.reversal_note", bet=bet.id),
        )
        db.add(reversal)
        await db.flush()
        row.reversed_by = reversal.id
    bet.status = "open"
    bet.profit = None
    bet.settled_at = None
    bet.settled_by = None
    bet.settle_run_id = None
    bet.reversed_at = now
    touch(bet)
    for leg in legs:
        leg.result = None
        leg.score = None
        leg.settled_at = None
        leg.result_source = None
        leg.archive_result = None
        leg.archive_score = None
    # Общий разбор матча строится только по архиву: свой исход участника его не меняет, а
    # вердикт по ноге считается на лету. Разбор, построенный на другом исходе архива
    # (архив исправлен), — снова в очередь (m5)
    await postmortems.refresh_stale(db, sorted({leg.match_id for leg in legs}))
    await db.commit()
    return await bet_detail(db, user, bet.id)
