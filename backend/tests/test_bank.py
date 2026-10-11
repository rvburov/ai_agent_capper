"""Банк участника (app/services/bank.py): баланс, пик и просадка по правилу Р22,
открытые ставки, сторно, итог недели, рост и винрейт."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankrollLedger, Bet
from app.ml.strategy import StrategyParams
from app.services.bank import (
    LedgerEntry,
    bank_from_entries,
    bank_state,
    drawdown_level,
)
from tests.support import UserFactory

D = Decimal
NOW = datetime(2026, 10, 11, 12, 0, tzinfo=UTC)
PARAMS = StrategyParams()


def at(days: float) -> datetime:
    """Момент за days дней до NOW."""
    return NOW - timedelta(days=days)


class Journal:
    """Строки журнала для bank_from_entries: id по порядку записи."""

    def __init__(self) -> None:
        self.entries: list[LedgerEntry] = []

    def add(
        self,
        kind: str,
        amount: str,
        when: datetime,
        *,
        bet: int | None = None,
        status: str | None = None,
        settled: datetime | None = None,
        reversed_by: int | None = None,
    ) -> int:
        entry_id = len(self.entries) + 1
        self.entries.append(
            LedgerEntry(entry_id, when, kind, D(amount), bet, reversed_by, status, settled)
        )
        return entry_id

    def bet(
        self,
        bet_id: int,
        stake: str,
        payout: str | None,
        placed: datetime,
        settled: datetime | None,
        status: str,
    ) -> None:
        self.add("stake", f"-{stake}", placed, bet=bet_id, status=status, settled=settled)
        if payout is not None and settled is not None:
            kind = "refund" if status == "void" else "payout"
            self.add(kind, payout, settled, bet=bet_id, status=status, settled=settled)


def test_empty_journal() -> None:
    state = bank_from_entries([], currency="EUR", now=NOW)
    assert state.empty and state.currency == "EUR"
    assert state.balance == state.equity == state.peak == state.drawdown == 0
    assert state.growth is None and state.week_change is None and state.winrate is None
    signals = state.signals()
    assert signals.drawdown == 0 and signals.growth is None
    assert drawdown_level(state, PARAMS) is None


def test_balance_peak_and_open_bets() -> None:
    journal = Journal()
    journal.add("deposit", "10000", at(30))
    journal.bet(1, "275", "500", at(20), at(19), "won")
    journal.bet(2, "275", None, at(15), at(14), "lost")
    journal.bet(3, "250", None, at(1), None, "open")
    state = bank_from_entries(journal.entries, currency="RUB", won=1, lost=1, now=NOW)
    assert state.balance == D("9700")
    assert state.in_play == D("250") and state.equity == D("9950")
    # Пик после выигрыша: 10 225; открытая ставка просадкой не считается
    assert state.peak == D("10225")
    assert state.drawdown == D("275") / D("10225")
    assert state.invested == D("10000") and state.growth == D("-0.005")
    assert state.winrate == D("0.5") and state.settled_bets == 2 and not state.empty


def test_withdrawal_moves_peak_and_drawdown_levels() -> None:
    journal = Journal()
    journal.add("deposit", "10000", at(60))
    journal.bet(1, "1000", "2000", at(50), at(49), "won")  # 11 000 — пик
    journal.add("withdrawal", "-5000", at(40))  # 6 000: пик тоже 6 000
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.peak == D("6000") and state.drawdown == 0
    journal.bet(2, "600", None, at(30), at(29), "lost")  # 5 400: −10% от пика
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.drawdown == D("0.1")
    level = drawdown_level(state, PARAMS)
    assert level is not None and level.max_pct == D("0.025")
    journal.bet(3, "600", None, at(20), at(19), "lost")  # 4 800: −20%
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.drawdown == D("0.2")
    level = drawdown_level(state, PARAMS)
    assert level is not None and level.max_legs == 2
    # Пополнение не уменьшает просадку: пик растет в той же пропорции, что и капитал
    journal.add("deposit", "1200", at(10))
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.equity == D("6000") and state.peak == D("7500")
    assert state.drawdown == D("0.2")
    level = drawdown_level(state, PARAMS)
    assert level is not None and level.max_legs == 2
    # Корректировка без ставки — тоже движение денег, а не результат
    journal.add("correction", "-200", at(9))
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.peak == D("7250") and state.drawdown == D("0.2")
    assert state.invested == D("6000")


def test_money_flows_keep_drawdown_share() -> None:
    journal = Journal()
    journal.add("deposit", "10000", at(60))
    journal.bet(1, "1000", None, at(50), at(49), "lost")  # 9 000: −10%
    # Вывод половины не углубляет просадку и не включает защитный режим
    journal.add("withdrawal", "-5000", at(40))
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.equity == D("4000") and state.peak == D("4444.44")
    assert state.drawdown == D("0.1")
    level = drawdown_level(state, PARAMS)
    assert level is not None and level.max_legs is None
    # Повторяющаяся дробь (3 000 / 9 000): ровно 10%, а не 9,999...% ниже порога
    edge = Journal()
    edge.add("deposit", "10000", at(60))
    edge.bet(1, "1000", None, at(50), at(49), "lost")
    edge.add("withdrawal", "-6000", at(40))
    state = bank_from_entries(edge.entries, currency="RUB", now=NOW)
    assert state.drawdown == D("0.1") and drawdown_level(state, PARAMS) is not None
    # Вывели все после проигрыша — новое пополнение начинает банк без просадки
    fresh = Journal()
    fresh.add("deposit", "1000", at(60))
    fresh.bet(1, "200", None, at(50), at(49), "lost")
    fresh.add("withdrawal", "-800", at(40))
    state = bank_from_entries(fresh.entries, currency="RUB", now=NOW)
    assert state.equity == 0 and state.peak == 0 and state.drawdown == 0
    fresh.add("deposit", "1000", at(30))
    state = bank_from_entries(fresh.entries, currency="RUB", now=NOW)
    assert state.peak == D("1000") and state.drawdown == 0
    fresh.bet(2, "100", None, at(20), at(19), "lost")
    state = bank_from_entries(fresh.entries, currency="RUB", now=NOW)
    assert state.drawdown == D("0.1")


def test_payout_before_settlement_does_not_inflate_peak() -> None:
    journal = Journal()
    journal.add("deposit", "1000", at(10))
    # Выплата записана раньше отметки расчета: ставка — одно событие
    journal.add("stake", "-100", at(5), bet=1, status="won", settled=at(3))
    journal.add("payout", "150", at(4), bet=1, status="won", settled=at(3))
    journal.add("stake", "-100", at(2), bet=2, status="lost", settled=at(1))
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.balance == D("950")
    assert state.peak == D("1050") and state.drawdown == D("100") / D("1050")


def test_reversed_payout_is_ignored_for_peak() -> None:
    journal = Journal()
    journal.add("deposit", "1000", at(10))
    journal.add("stake", "-100", at(9), bet=1, status="void", settled=at(8))
    # Ошибочная выплата 300 исправлена: сторно и возврат ставки
    wrong = journal.add("payout", "300", at(8), bet=1, status="void", settled=at(8))
    fix = journal.add("reversal", "-300", at(7), bet=1, status="void", settled=at(8))
    journal.entries[wrong - 1] = LedgerEntry(
        wrong, at(8), "payout", D("300"), 1, fix, "void", at(8)
    )
    journal.add("refund", "100", at(7), bet=1, status="void", settled=at(8))
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.balance == D("1000")
    assert state.peak == D("1000") and state.drawdown == 0


def test_week_change_growth_and_winrate() -> None:
    journal = Journal()
    journal.add("deposit", "10000", at(30))
    journal.bet(1, "500", "1000", at(12), at(10), "won")  # к началу недели 10 500
    # Ставка сделана до недели, рассчитана внутри нее: в итог недели
    journal.bet(2, "525", None, at(9), at(2), "lost")
    state = bank_from_entries(journal.entries, currency="RUB", won=1, lost=1, now=NOW)
    assert state.week_change == D("-525") / D("10500")
    assert state.week_change == D("-0.05")
    # Пополнение внутри недели входит в базу недели, но не в результат
    journal.add("deposit", "1000", at(1))
    state = bank_from_entries(journal.entries, currency="RUB", now=NOW)
    assert state.week_change == D("-525") / D("11500")
    # Рост к вложенному: 10 975 к 11 000
    assert state.growth == (D("10975") - D("11000")) / D("11000")
    journal.bet(3, "1000", "2700", at(1), at(0.5), "won")
    state = bank_from_entries(journal.entries, currency="RUB", won=2, lost=1, now=NOW)
    assert state.equity == D("12675")
    assert state.growth == D("1675") / D("11000")
    assert state.week_change == D("1175") / D("11500")
    assert state.winrate == D(2) / D(3)
    signals = state.signals()
    assert signals.week_change == state.week_change and signals.winrate == state.winrate
    # Только пополнение на этой неделе: результата недели нет
    fresh = Journal()
    fresh.add("deposit", "500", at(1))
    assert bank_from_entries(fresh.entries, currency="RUB", now=NOW).week_change == 0


async def test_bank_state_from_database(db: AsyncSession, make_user: UserFactory) -> None:
    member = await make_user()
    other = await make_user()

    def bet(user_id: int, status: str, placed: datetime, settled: datetime | None) -> Bet:
        return Bet(
            user_id=user_id,
            placed_at=placed,
            bookmaker="Fonbet",
            stake=D("100.00"),
            currency="RUB",
            total_odds=D("2.000"),
            status=status,
            settled_at=settled,
        )

    won = bet(member.id, "won", at(5), at(4))
    lost = bet(member.id, "lost", at(3), at(2))
    open_bet = bet(member.id, "open", at(1), None)
    foreign = bet(other.id, "lost", at(3), at(2))
    db.add_all([won, lost, open_bet, foreign])
    await db.flush()
    rows = [
        (member.id, "deposit", "1000.00", at(10), None),
        (member.id, "stake", "-100.00", at(5), won.id),
        (member.id, "payout", "200.00", at(4), won.id),
        (member.id, "stake", "-100.00", at(3), lost.id),
        (member.id, "stake", "-100.00", at(1), open_bet.id),
        (other.id, "deposit", "5000.00", at(10), None),
        (other.id, "stake", "-100.00", at(3), foreign.id),
    ]
    db.add_all(
        BankrollLedger(
            user_id=user_id, kind=kind, amount=D(amount), currency="RUB", at=when, bet_id=bet_id
        )
        for user_id, kind, amount, when, bet_id in rows
    )
    await db.commit()

    state = await bank_state(db, member.id, now=NOW)
    assert state.currency == "RUB"
    assert state.balance == D("900.00") and state.in_play == D("100.00")
    assert state.equity == D("1000.00") and state.peak == D("1100.00")
    assert state.drawdown == D("100") / D("1100")
    assert state.winrate == D("0.5") and state.settled_bets == 2
    assert state.week_change == D("0") and not state.empty

    empty = await bank_state(db, (await make_user()).id, now=NOW)
    assert empty.empty and empty.balance == 0
