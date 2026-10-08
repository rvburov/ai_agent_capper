"""Журнал банка из истории старого бота и сверка с его числами.

Старый бот хранил банк одним числом (meta.текущий_банк) и ошибался (PLAN.md, раздел 2,
п. 8): не списывал сумму открытой ставки, считал пустой банк нулем, второе нажатие
«Победа» снова прибавляло выигрыш. Здесь журнал строится заново по правилам приложения:
пополнение на первый известный банк, stake при ставке, payout при выигрыше
(сумма × итоговый кэф), refund при возврате.

Перед каждой записью ее «банк до ставки» сверяется с журналом. Журнал при этом считается
так, как его видел бот: открытые ставки не списаны. Без корректировки обходится только
расхождение из-за времени: результат последних ставок внесли уже после этой записи.
Любое другое расхождение (обычно пополнение или вывод денег) записывается корректировкой.
Ошибки самого числа бота (счет с нуля, двойное нажатие, незнание о корректировках) при
сверке записи деньги не двигают: если сумма корректировки с ними совпадает, в отчете
появляется подсказка проверить ее. Этими ошибками объясняется только итоговая разница
журнала с meta.текущий_банк.

Модуль ничего не знает о базе: на входе ставки, на выходе план записей журнала и итоги
сверки. Так его логика проверяется отдельно от импорта.
"""

from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from itertools import combinations, product
from typing import Literal

CENT = Decimal("0.01")
# Бот округлял float до копеек, поэтому разница в копейку — не расхождение
TOLERANCE = Decimal("0.01")
# Сколько последних результатов, еще не попавших в банк ни одной записи, проверять на
# «результат внесли позже» и на двойное нажатие (для подсказки) при сверке записи. Окна
# короткие нарочно: чем больше вариантов, тем чаще настоящее пополнение случайно совпадет
# с суммой итогов ставок (при ставках по 200 пять проигрышей подряд дают ровно 1 000)
LATE_WINDOW = 2
DOUBLE_WINDOW = 3

BetStatus = Literal["open", "won", "lost", "void"]
CauseKind = Literal["start_from_zero", "unknown_corrections", "late_result", "double_click"]
CheckOutcome = Literal["start", "explained", "corrected", "missing", "nonpositive"]


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass(frozen=True)
class BankBet:
    """Ставка для расчета журнала: id записи бота, суммы и итог."""

    ref: str
    placed_at: datetime
    stake: Decimal
    total_odds: Decimal
    status: BetStatus
    # «банк_до_ставки» из записи; None — в записи его нет
    bank_before: Decimal | None

    @property
    def payout(self) -> Decimal:
        return money(self.stake * self.total_odds)

    @property
    def profit(self) -> Decimal | None:
        """Как считал бот: выигрыш — сумма × кэф − сумма, поражение — −сумма,
        возврат — 0, открытая — None."""
        if self.status == "won":
            return self.payout - self.stake
        if self.status == "lost":
            return -self.stake
        if self.status == "void":
            return Decimal(0)
        return None


@dataclass(frozen=True)
class PlannedEntry:
    """Запись журнала. ref — запись бота, вместе с которой она пишется в базу."""

    ref: str
    kind: Literal["deposit", "stake", "payout", "refund", "correction"]
    amount: Decimal
    at: datetime
    # Ссылка на ставку ref (stake, payout, refund)
    with_bet: bool
    note_key: str | None = None
    note_ref: str | None = None


@dataclass(frozen=True)
class Cause:
    """Одна причина расхождения и ее вклад в разницу (банк бота минус журнал)."""

    kind: CauseKind
    amount: Decimal
    refs: tuple[str, ...] = ()


@dataclass(frozen=True)
class BankCheck:
    """Сверка «банка до ставки» записи ref с журналом (только записи с расхождением).

    causes: у explained — объяснение расхождения; у corrected — ошибки бота, с которыми
    совпала сумма корректировки (подсказка проверить ее), пусто — совпадений нет.
    """

    ref: str
    outcome: CheckOutcome
    reported: Decimal | None = None
    expected: Decimal | None = None
    diff: Decimal = Decimal(0)
    causes: tuple[Cause, ...] = ()


@dataclass
class BankPlan:
    entries: list[PlannedEntry] = field(default_factory=list)
    checks: list[BankCheck] = field(default_factory=list)
    starting_bank: Decimal | None = None
    starting_ref: str | None = None
    # Запись, с которой начата сверка: первый положительный банк до ставки. Если журнал
    # перед ней уже не меньше ее банка, пополнения нет и starting_bank остается None
    start_ref: str | None = None
    ledger_total: Decimal = Decimal(0)
    open_count: int = 0
    open_stakes: Decimal = Decimal(0)
    corrections_total: Decimal = Decimal(0)
    json_bank: Decimal | None = None
    # Банк в JSON минус журнал без списания открытых ставок; None — сверить не с чем
    final_diff: Decimal | None = None
    # Объяснение итоговой разницы; None — объяснить не удалось
    final_causes: tuple[Cause, ...] | None = None

    @property
    def bot_view_total(self) -> Decimal:
        """Журнал так, как считал бот: открытые ставки не списаны."""
        return self.ledger_total + self.open_stakes

    @property
    def corrections(self) -> list[PlannedEntry]:
        return [entry for entry in self.entries if entry.kind == "correction"]

    @property
    def adjustments_total(self) -> Decimal:
        """Сумма записей журнала без ставки: начальное пополнение и корректировки."""
        return sum((entry.amount for entry in self.entries if not entry.with_bet), Decimal(0))


def plan_bank(bets: Sequence[BankBet], json_bank: Decimal | None) -> BankPlan:
    """Строит журнал по ставкам (в порядке записей бота) и сверяет его с банком бота."""
    plan = BankPlan(json_bank=json_bank)
    balance = Decimal(0)
    # Рассчитанные ставки с ненулевым итогом по порядку: (ref, итог так, как считал бот)
    settled: list[tuple[str, Decimal]] = []
    # Из них те, чей итог еще не подтвержден банком до ставки ни одной следующей записи:
    # только их результат мог быть внесен позже. Итог, который уже вошел в банк записи,
    # «опоздать» к следующей не может
    pending: list[tuple[str, Decimal]] = []
    for bet in bets:
        if plan.start_ref is None:
            _start_or_check(plan, bets[0], bet, balance, pending)
        else:
            _check(plan, bet, balance, pending)
        balance = plan.ledger_total
        plan.entries.append(
            PlannedEntry(bet.ref, "stake", -bet.stake, bet.placed_at, with_bet=True)
        )
        balance -= bet.stake
        if bet.status == "won":
            plan.entries.append(
                PlannedEntry(bet.ref, "payout", bet.payout, bet.placed_at, with_bet=True)
            )
            balance += bet.payout
        elif bet.status == "void":
            plan.entries.append(
                PlannedEntry(bet.ref, "refund", bet.stake, bet.placed_at, with_bet=True)
            )
            balance += bet.stake
        elif bet.status == "open":
            plan.open_count += 1
            plan.open_stakes += bet.stake
        profit = bet.profit
        if profit:
            settled.append((bet.ref, profit))
            pending.append((bet.ref, profit))
        plan.ledger_total = balance
    _final(plan, settled)
    return plan


def _start_or_check(
    plan: BankPlan,
    first: BankBet,
    bet: BankBet,
    balance: Decimal,
    pending: list[tuple[str, Decimal]],
) -> None:
    """Начальный банк — из первой записи, где он есть. Если у первых записей банка нет,
    он выводится так, чтобы журнал перед этой записью совпал с ее банком."""
    plan.ledger_total = balance
    reported = bet.bank_before
    if reported is None or reported <= 0:
        plan.checks.append(
            BankCheck(bet.ref, "missing" if reported is None else "nonpositive", reported=reported)
        )
        return
    # Дальше все записи сверяются обычным порядком, даже если пополнения здесь нет
    plan.start_ref = bet.ref
    deposit = money(reported - (balance + plan.open_stakes))
    if deposit <= 0:
        _check(plan, bet, balance, pending)
        return
    at = first.placed_at - timedelta(minutes=1)
    inferred = bet.ref != first.ref
    # Пишется вместе с записью, из которой взят банк, но датой до первой ставки
    plan.entries.insert(
        0,
        PlannedEntry(
            bet.ref,
            "deposit",
            deposit,
            at,
            with_bet=False,
            note_key="deposit_inferred" if inferred else "deposit",
            note_ref=bet.ref,
        ),
    )
    plan.starting_bank = deposit
    plan.starting_ref = bet.ref
    plan.ledger_total = balance + deposit
    # Пополнение подобрано под банк записи: все прежние итоги в нем учтены
    pending.clear()
    if inferred:
        plan.checks.append(BankCheck(bet.ref, "start", reported=reported, diff=deposit))


def _check(
    plan: BankPlan,
    bet: BankBet,
    balance: Decimal,
    pending: list[tuple[str, Decimal]],
) -> None:
    plan.ledger_total = balance
    reported = bet.bank_before
    if reported is None:
        plan.checks.append(BankCheck(bet.ref, "missing"))
        return
    if reported <= 0:
        plan.checks.append(BankCheck(bet.ref, "nonpositive", reported=reported))
        return
    expected = balance + plan.open_stakes
    diff = money(reported - expected)
    if abs(diff) <= TOLERANCE:
        pending.clear()
        return
    late = pending[-LATE_WINDOW:]
    # Без корректировки — только время: результат внесли уже после этой записи
    causes = explain(diff, starting_bank=None, corrections=Decimal(0), late=late, doubles=())
    if causes is not None:
        plan.checks.append(BankCheck(bet.ref, "explained", reported, expected, diff, causes))
        # Опоздавшие итоги ждут следующей записи, остальные в банке этой уже учтены
        late_refs = {ref for cause in causes for ref in cause.refs}
        pending[:] = [item for item in pending if item[0] in late_refs]
        return
    # Ошибки числа бота денег не двигают: корректировка пишется, совпадение — подсказка
    hint = explain(
        diff,
        starting_bank=plan.starting_bank,
        corrections=plan.corrections_total,
        late=late,
        doubles=pending[-DOUBLE_WINDOW:],
    )
    plan.entries.append(
        PlannedEntry(
            bet.ref,
            "correction",
            diff,
            bet.placed_at - timedelta(seconds=1),
            with_bet=False,
            note_key="correction_up" if diff > 0 else "correction_down",
            note_ref=bet.ref,
        )
    )
    plan.corrections_total += diff
    plan.ledger_total = balance + diff
    plan.checks.append(BankCheck(bet.ref, "corrected", reported, expected, diff, hint or ()))
    pending.clear()


def _final(plan: BankPlan, settled: list[tuple[str, Decimal]]) -> None:
    if plan.json_bank is None:
        return
    diff = money(plan.json_bank - plan.bot_view_total)
    plan.final_diff = diff
    if abs(diff) <= TOLERANCE:
        plan.final_causes = ()
        return
    plan.final_causes = explain(
        diff,
        starting_bank=plan.starting_bank,
        corrections=plan.corrections_total,
        late=[],
        doubles=settled,
    )


def explain(
    diff: Decimal,
    *,
    starting_bank: Decimal | None,
    corrections: Decimal,
    late: Sequence[tuple[str, Decimal]],
    doubles: Sequence[tuple[str, Decimal]],
) -> tuple[Cause, ...] | None:
    """Подбирает известные ошибки бота, которые в сумме дают diff (банк бота минус
    журнал). Из подходящих наборов берется самый короткий. None — объяснения нет.

    - start_from_zero: банк в JSON был пуст, бот считал от нуля — минус начальный банк;
    - unknown_corrections: бот не знал о корректировках журнала — минус их сумма;
    - late_result: результат последних ставок внесли после этой записи — минус их итог;
    - double_click: результат одной ставки внесен дважды — плюс ее итог еще раз.
    """
    for causes in _candidates(starting_bank, corrections, late, doubles):
        total = sum((cause.amount for cause in causes), Decimal(0))
        if abs(total - diff) <= TOLERANCE:
            return causes
    return None


def _candidates(
    starting_bank: Decimal | None,
    corrections: Decimal,
    late: Sequence[tuple[str, Decimal]],
    doubles: Sequence[tuple[str, Decimal]],
) -> Iterator[tuple[Cause, ...]]:
    zero: list[Cause | None] = [None]
    if starting_bank:
        zero.append(Cause("start_from_zero", -starting_bank))
    unknown: list[Cause | None] = [None]
    if corrections:
        unknown.append(Cause("unknown_corrections", -corrections))
    late_options: list[Cause | None] = [None]
    # Свежие ставки — первыми: их результат вероятнее внесли позже
    recent_first = list(reversed(late))
    for size in range(1, len(recent_first) + 1):
        for chosen in combinations(recent_first, size):
            refs = tuple(ref for ref, _ in reversed(chosen))
            late_options.append(
                Cause("late_result", -sum((p for _, p in chosen), Decimal(0)), refs)
            )
    double_options: list[Cause | None] = [None]
    double_options += [Cause("double_click", p, (ref,)) for ref, p in reversed(doubles)]
    options = [
        tuple(cause for cause in combo if cause is not None)
        for combo in product(zero, unknown, late_options, double_options)
    ]
    # Сначала меньше причин, при равенстве — по порядку в _CAUSE_RANK
    options.sort(key=lambda causes: (len(causes), [_CAUSE_RANK[c.kind] for c in causes]))
    yield from options


_CAUSE_RANK: dict[CauseKind, int] = {
    "start_from_zero": 0,
    "unknown_corrections": 1,
    "late_result": 2,
    "double_click": 3,
}
