"""Банк участника по журналу bankroll_ledger: баланс, пик, просадка и сигналы для суммы
ставки (решение Р22 в PLAN.md, раздел 0; app/ml/strategy.py, stake).

Банк — сумма журнала в валюте программы (app_settings.currency). Просадка считается не по
балансу, а по капиталу: баланс плюс открытые ставки. Ставка, которая еще не рассчитана,
не убыток, иначе три открытые ставки по 2,75% выглядели бы просадкой 8%.

Пик и просадка (Р22: «просадка — только от ставок»):
- запись без ставки (пополнение, вывод, корректировка) сдвигает капитал и пик в одной
  пропорции: доля просадки не меняется. Сдвиг пика на ту же сумму менял бы ее без единой
  ставки: банк 9 000 при пике 10 000 (−10%) после вывода 5 000 стал бы −20% и включил бы
  защитный режим, а пополнение выводило бы из него. Капитал дошел до нуля (вывели все) —
  следующее пополнение начинает банк заново, без просадки;
- рассчитанная ставка — одно событие в момент расчета: списание и выплата вместе, иначе
  выплата раньше списания подняла бы пик на сумму ставки;
- пара «запись и ее сторно» (reversed_by) в расчет пика не входит: ошибочная выплата не
  оставляет завышенный пик.
Вложено — сумма записей без ставки; рост — капитал к вложенному. Итог недели — результат
рассчитанных за 7 дней ставок к капиталу в начале недели с учетом пополнений и выводов.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from fractions import Fraction

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankrollLedger, Bet
from app.ml.strategy import BankSignals, DrawdownLevel, StrategyParams
from app.services.app_settings import get_app_settings

WEEK = timedelta(days=7)
_ZERO = Decimal(0)
_CENT = Decimal("0.01")


@dataclass(frozen=True)
class LedgerEntry:
    """Строка журнала со статусом ставки (если запись по ставке)."""

    id: int
    at: datetime
    kind: str
    amount: Decimal
    bet_id: int | None = None
    reversed_by: int | None = None
    bet_status: str | None = None
    bet_settled_at: datetime | None = None


@dataclass(frozen=True)
class BankState:
    """Банк участника. balance — сумма журнала (из нее считается сумма ставки);
    in_play — открытые ставки; equity — капитал (balance + in_play); peak (до копеек) и
    drawdown (0..1, без округления) — по капиталу; invested — пополнения минус выводы с
    корректировками; growth — рост капитала к вложенному; week_change — итог 7 дней;
    winrate — доля выигранных среди рассчитанных ставок (won и lost). None — посчитать не
    из чего. empty — журнал пуст."""

    balance: Decimal
    currency: str
    in_play: Decimal
    equity: Decimal
    peak: Decimal
    drawdown: Decimal
    invested: Decimal
    growth: Decimal | None
    week_change: Decimal | None
    winrate: Decimal | None
    settled_bets: int
    empty: bool

    def signals(self) -> BankSignals:
        """Сигналы для адаптаций суммы ставки (strategy.stake)."""
        return BankSignals(
            drawdown=self.drawdown,
            growth=self.growth,
            winrate=self.winrate,
            week_change=self.week_change,
        )


@dataclass(frozen=True)
class _Event:
    when: datetime
    order: int
    amount: Decimal
    flow: bool


def _events(entries: Sequence[LedgerEntry]) -> tuple[list[_Event], Decimal]:
    """События капитала по времени и сумма открытых ставок."""
    reversals = {entry.reversed_by for entry in entries if entry.reversed_by is not None}
    live = [entry for entry in entries if entry.reversed_by is None and entry.id not in reversals]
    events: list[_Event] = []
    in_play = _ZERO
    by_bet: dict[int, list[LedgerEntry]] = defaultdict(list)
    for entry in live:
        if entry.bet_id is None:
            events.append(_Event(entry.at, entry.id, entry.amount, flow=True))
        elif entry.bet_status == "open":
            # Открытая ставка — не убыток: списание идет в «в игре», прочие записи — как есть
            if entry.kind == "stake":
                in_play -= entry.amount
            else:
                events.append(_Event(entry.at, entry.id, entry.amount, flow=False))
        else:
            by_bet[entry.bet_id].append(entry)
    for rows in by_bet.values():
        settled = rows[0].bet_settled_at
        when = max(entry.at for entry in rows)
        if settled is not None:
            when = max(when, settled)
        net = sum((entry.amount for entry in rows), _ZERO)
        events.append(_Event(when, max(entry.id for entry in rows), net, flow=False))
    events.sort(key=lambda event: (event.when, event.order))
    return events, in_play


def bank_from_entries(
    entries: Sequence[LedgerEntry],
    *,
    currency: str,
    won: int = 0,
    lost: int = 0,
    now: datetime | None = None,
) -> BankState:
    """Состояние банка по строкам журнала (порядок любой) и числу выигранных и
    проигранных ставок; правила — в docstring модуля."""
    moment = now or datetime.now(UTC)
    balance = sum((entry.amount for entry in entries), _ZERO)
    events, in_play = _events(entries)
    equity = balance + in_play

    capital = invested = _ZERO
    start_of_week = flows_in_week = _ZERO
    # Пик — дробью без округления: после масштабирования просадка ровно 20% не должна
    # стать 19,999...% и выпасть из защитного режима
    peak = Fraction(0)
    cutoff = moment - WEEK
    for event in events:
        before = capital
        capital += event.amount
        if event.flow:
            if before > 0 and capital > 0:
                peak = peak * Fraction(capital) / Fraction(before)
            else:
                peak = Fraction(max(capital, _ZERO))
            invested += event.amount
            if event.when >= cutoff:
                flows_in_week += event.amount
        peak = max(peak, Fraction(capital))
        if event.when < cutoff:
            start_of_week = capital
    peak = max(peak, Fraction(equity))
    drawdown = _ZERO
    if peak > 0:
        share = min(Fraction(1), max(Fraction(0), (peak - Fraction(equity)) / peak))
        drawdown = Decimal(share.numerator) / Decimal(share.denominator)
    growth = (equity - invested) / invested if invested > 0 else None

    week_base = start_of_week + flows_in_week
    week_result = capital - week_base
    week_change = week_result / week_base if week_base > 0 else None

    settled = won + lost
    return BankState(
        balance=balance,
        currency=currency,
        in_play=in_play,
        equity=equity,
        peak=(Decimal(peak.numerator) / Decimal(peak.denominator)).quantize(_CENT),
        drawdown=drawdown,
        invested=invested,
        growth=growth,
        week_change=week_change,
        winrate=Decimal(won) / Decimal(settled) if settled else None,
        settled_bets=settled,
        empty=not entries,
    )


async def bank_state(db: AsyncSession, user_id: int, *, now: datetime | None = None) -> BankState:
    """Банк участника из журнала и его ставок (только чтение)."""
    settings = await get_app_settings(db)
    rows = await db.execute(
        select(
            BankrollLedger.id,
            BankrollLedger.at,
            BankrollLedger.kind,
            BankrollLedger.amount,
            BankrollLedger.bet_id,
            BankrollLedger.reversed_by,
            Bet.status,
            Bet.settled_at,
        )
        .outerjoin(Bet, Bet.id == BankrollLedger.bet_id)
        .where(BankrollLedger.user_id == user_id)
    )
    entries = [LedgerEntry(*row) for row in rows]
    counted = await db.execute(
        select(Bet.status, func.count())
        .where(Bet.user_id == user_id, Bet.status.in_(("won", "lost")))
        .group_by(Bet.status)
    )
    counts = {status: int(number) for status, number in counted}
    return bank_from_entries(
        entries,
        currency=settings.currency,
        won=int(counts.get("won", 0)),
        lost=int(counts.get("lost", 0)),
        now=now,
    )


def drawdown_level(state: BankState, params: StrategyParams) -> DrawdownLevel | None:
    """Лимит просадки Р22, который действует сейчас (с учетом выключенных правил)."""
    return params.drawdown_level(state.drawdown)
