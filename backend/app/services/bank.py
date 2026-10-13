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

bank_from_entries — эти правила по строкам журнала в Python (эталон для тестов).
bank_state считает то же в SQL: события капитала (запись без ставки, рассчитанная ставка
одним событием, прочие записи открытых ставок) и их сумма нарастающим итогом; в Python
остаются только отрезки между пополнениями и выводами (их единицы), а не каждая ставка.
Баланс, ставки в игре, отрезки и число выигрышей читаются одним запросом — одним снимком
базы: расчет, сохраненный между двумя запросами, дал бы капитал «до» и пик «после», то
есть ложную просадку (bank_state зовут и без блокировки участника — например, анализ).
Ряд «капитал по дням» (bank_history) — те же события по дням пояса участника.

Деньги участника меняют расчет ставки, сторно, новая ставка и движение банка: все они
идут под lock_member_money — разделяемая блокировка смены валюты (Т30) и блокировка
участника, плюс SELECT … FOR UPDATE своих строк.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from fractions import Fraction
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import DEFAULT_TZ, BankrollLedger, Bet, User
from app.ml.strategy import BankSignals, DrawdownLevel, StrategyParams
from app.schemas.bets import (
    BankEntriesOut,
    BankEntryIn,
    BankEntryOut,
    BankHistoryOut,
    BankPointOut,
    Period,
)
from app.services.app_settings import get_app_settings
from app.services.sessions import utcnow

WEEK = timedelta(days=7)
_ZERO = Decimal(0)
_CENT = Decimal("0.01")
# Ключ блокировки денег участника: пространство «bets» плюс id участника
BETS_LOCK = 0x6265747300000000
# Ключ блокировки смены валюты программы (Т30): смена берет ее исключительно, движение
# денег участников — разделяемо
CURRENCY_LOCK = 0x6375727200000001
# Сумма в NUMERIC(12, 2)
MONEY_MAX = Decimal("9999999999.99")
# Дней в периоде ряда банка и фильтров «Ставок»; all — с первого события
PERIOD_DAYS: dict[str, int | None] = {"7d": 7, "30d": 30, "90d": 90, "all": None}
ENTRIES_LIMIT = 50


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


async def ledger_entries(db: AsyncSession, user_id: int) -> list[LedgerEntry]:
    """Все строки журнала участника со статусом ставки (для эталона и проверок)."""
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
    return [LedgerEntry(*row) for row in rows]


# События капитала (правила — в docstring модуля): пара «запись и ее сторно» не входит,
# рассчитанная ставка — одно событие (сумма ее записей) в момент расчета, записи без
# ставки — пополнения и выводы (flow), открытая ставка — только записи кроме списания
_EVENTS_SQL = """
WITH reversed AS (
    SELECT reversed_by AS id FROM bankroll_ledger
    WHERE user_id = :user_id AND reversed_by IS NOT NULL
), live AS (
    SELECT l.id, l.at, l.kind, l.amount, l.bet_id, b.status AS bet_status, b.settled_at
    FROM bankroll_ledger l LEFT JOIN bets b ON b.id = l.bet_id
    WHERE l.user_id = :user_id AND l.reversed_by IS NULL
      AND l.id NOT IN (SELECT id FROM reversed)
), events AS (
    SELECT at AS moment, id AS ord, amount, true AS flow FROM live WHERE bet_id IS NULL
    UNION ALL
    SELECT at, id, amount, false FROM live
    WHERE bet_id IS NOT NULL AND bet_status = 'open' AND kind <> 'stake'
    UNION ALL
    SELECT greatest(max(at), max(settled_at)), max(id), sum(amount), false FROM live
    WHERE bet_id IS NOT NULL AND bet_status <> 'open' GROUP BY bet_id
)
"""

# Все числа банка одним запросом (одним снимком базы). Отрезки между пополнениями и
# выводами: номер отрезка seg (0 — до первого), сумма записи, с которой он начался, и
# капитал после нее, максимум и последний капитал в отрезке, последний капитал до начала
# недели и пополнения за неделю. Итоги журнала (баланс, в игре, число записей) и число
# выигрышей и проигрышей — в каждой строке; журнал без событий — одна строка, seg = NULL
_STATE_SQL = (
    _EVENTS_SQL
    + """
, seq AS (
    SELECT moment, ord, amount, flow,
           sum(amount) OVER w AS capital,
           count(*) FILTER (WHERE flow) OVER w AS seg
    FROM events
    WINDOW w AS (ORDER BY moment, ord ROWS UNBOUNDED PRECEDING)
), segments AS (
    SELECT seg,
           (array_agg(amount ORDER BY moment, ord) FILTER (WHERE flow))[1] AS flow_amount,
           (array_agg(capital ORDER BY moment, ord) FILTER (WHERE flow))[1] AS flow_capital,
           max(capital) AS top,
           (array_agg(capital ORDER BY moment DESC, ord DESC))[1] AS last_capital,
           (array_agg(capital ORDER BY moment DESC, ord DESC)
                FILTER (WHERE moment < :cutoff))[1] AS before_week,
           coalesce(sum(amount) FILTER (WHERE flow AND moment >= :cutoff), 0) AS flows_week
    FROM seq GROUP BY seg
), totals AS (
    SELECT coalesce(sum(l.amount), 0) AS balance,
           coalesce(-sum(l.amount) FILTER (
               WHERE l.kind = 'stake' AND l.reversed_by IS NULL AND b.status = 'open'), 0)
               AS in_play,
           count(*) AS entries
    FROM bankroll_ledger l LEFT JOIN bets b ON b.id = l.bet_id
    WHERE l.user_id = :user_id
), counts AS (
    SELECT count(*) FILTER (WHERE status = 'won') AS won,
           count(*) FILTER (WHERE status = 'lost') AS lost
    FROM bets WHERE user_id = :user_id AND status IN ('won', 'lost')
)
SELECT t.balance, t.in_play, t.entries, c.won, c.lost, s.*
FROM totals t CROSS JOIN counts c LEFT JOIN segments s ON true
ORDER BY s.seg
"""
)


def _fraction_decimal(value: Fraction) -> Decimal:
    return Decimal(value.numerator) / Decimal(value.denominator)


async def bank_state(db: AsyncSession, user_id: int, *, now: datetime | None = None) -> BankState:
    """Банк участника (только чтение): суммы и события капитала — в SQL, пик и просадка —
    по отрезкам между пополнениями и выводами. Совпадает с bank_from_entries."""
    settings = await get_app_settings(db)
    moment = now or datetime.now(UTC)
    rows = (await db.execute(text(_STATE_SQL), {"user_id": user_id, "cutoff": moment - WEEK})).all()
    first = rows[0]
    balance, in_play = Decimal(first.balance), Decimal(first.in_play)
    won, lost = int(first.won), int(first.lost)
    segments = [row for row in rows if row.seg is not None]

    peak = Fraction(0)
    invested = flows_week = start_of_week = capital = _ZERO
    for row in segments:
        if row.flow_amount is not None:
            after = Decimal(row.flow_capital)
            before = after - Decimal(row.flow_amount)
            if before > 0 and after > 0:
                peak = peak * Fraction(after) / Fraction(before)
            else:
                peak = Fraction(max(after, _ZERO))
            invested += Decimal(row.flow_amount)
        peak = max(peak, Fraction(Decimal(row.top)))
        if row.before_week is not None:
            start_of_week = Decimal(row.before_week)
        flows_week += Decimal(row.flows_week)
        capital = Decimal(row.last_capital)
    equity = balance + in_play
    peak = max(peak, Fraction(equity))
    drawdown = _ZERO
    if peak > 0:
        share = min(Fraction(1), max(Fraction(0), (peak - Fraction(equity)) / peak))
        drawdown = _fraction_decimal(share)
    week_base = start_of_week + flows_week
    settled = won + lost
    return BankState(
        balance=balance,
        currency=settings.currency,
        in_play=in_play,
        equity=equity,
        peak=_fraction_decimal(peak).quantize(_CENT),
        drawdown=drawdown,
        invested=invested,
        growth=(equity - invested) / invested if invested > 0 else None,
        week_change=(capital - week_base) / week_base if week_base > 0 else None,
        winrate=Decimal(won) / Decimal(settled) if settled else None,
        settled_bets=settled,
        empty=int(first.entries) == 0,
    )


def drawdown_level(state: BankState, params: StrategyParams) -> DrawdownLevel | None:
    """Лимит просадки Р22, который действует сейчас (с учетом выключенных правил)."""
    return params.drawdown_level(state.drawdown)


# --- блокировка денег участника ---


async def lock_member_money(db: AsyncSession, user_id: int) -> None:
    """Блокировки до конца транзакции: разделяемая — смены валюты (Т30), исключительная —
    денег участника. Порядок всегда этот: иначе смена валюты и расчет ждали бы друг друга."""
    await db.execute(select(func.pg_advisory_xact_lock_shared(CURRENCY_LOCK)))
    await db.execute(select(func.pg_advisory_xact_lock(BETS_LOCK + user_id)))


# --- ряд по дням ---


def user_zone(tz_name: str | None) -> ZoneInfo:
    """Пояс участника; неизвестный — пояс по умолчанию."""
    try:
        return ZoneInfo(tz_name or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TZ)


def local_today(zone: ZoneInfo, now: datetime | None = None) -> date:
    return (now or utcnow()).astimezone(zone).date()


def day_start(day: date, zone: ZoneInfo) -> datetime:
    """Начало дня day по поясу zone как момент UTC."""
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(UTC)


def period_start(period: str, today: date) -> date | None:
    """Первый день периода (включительно): последние N дней вместе с сегодняшним."""
    days = PERIOD_DAYS.get(period)
    return None if days is None else today - timedelta(days=days - 1)


_HISTORY_SQL = (
    _EVENTS_SQL
    + """
SELECT (moment AT TIME ZONE :tz)::date AS day, sum(amount) AS delta
FROM events GROUP BY 1 ORDER BY 1
"""
)


async def bank_history(
    db: AsyncSession, user: User, period: Period, *, now: datetime | None = None
) -> BankHistoryOut:
    """Капитал на конец каждого дня периода по поясу участника (те же события, что у
    bank_state): последний день — сегодня, капитал сегодня равен BankOut.equity."""
    settings = await get_app_settings(db)
    zone = user_zone(user.tz)
    today = local_today(zone, now)
    rows = (await db.execute(text(_HISTORY_SQL), {"user_id": user.id, "tz": zone.key})).all()
    deltas = {row.day: Decimal(row.delta) for row in rows}
    start = period_start(period, today)
    if start is None:
        start = min(min(deltas, default=today), today)
    equity = sum((delta for day, delta in deltas.items() if day < start), _ZERO)
    points: list[BankPointOut] = []
    day = start
    while day <= today:
        equity += deltas.get(day, _ZERO)
        points.append(BankPointOut(day=day, equity=equity))
        day += timedelta(days=1)
    return BankHistoryOut(currency=settings.currency, tz=zone.key, period=period, points=points)


# --- журнал и движение банка ---

_ENTRIES_SQL = """
SELECT * FROM (
    SELECT id, at, kind, amount, currency, bet_id, note, reversed_by,
           sum(amount) OVER (ORDER BY at, id ROWS UNBOUNDED PRECEDING) AS balance_after
    FROM bankroll_ledger WHERE user_id = :user_id
) AS journal
WHERE (CAST(:before_at AS timestamptz) IS NULL
       OR (at, id) < (CAST(:before_at AS timestamptz), CAST(:before_id AS bigint)))
  AND (NOT :flows_only OR kind IN ('deposit', 'withdrawal', 'correction'))
ORDER BY at DESC, id DESC
LIMIT :limit
"""


def _entry_out(row: Any) -> BankEntryOut:
    return BankEntryOut(
        id=row.id,
        at=row.at,
        kind=row.kind,
        amount=row.amount,
        currency=row.currency,
        bet_id=row.bet_id,
        note=row.note,
        reversed_by=row.reversed_by,
        balance_after=row.balance_after,
    )


async def list_entries(
    db: AsyncSession,
    user: User,
    *,
    before: int | None = None,
    limit: int = ENTRIES_LIMIT,
    flows_only: bool = False,
) -> BankEntriesOut:
    """Журнал банка, новые сверху (по времени записи), с балансом после каждой строки.
    before — id последней строки прошлой страницы; flows_only — только пополнения,
    выводы и корректировки."""
    before_at: datetime | None = None
    if before is not None:
        before_at = await db.scalar(
            select(BankrollLedger.at).where(
                BankrollLedger.id == before, BankrollLedger.user_id == user.id
            )
        )
        if before_at is None:
            raise AppError(422, "bank.bad_cursor")
    rows = (
        await db.execute(
            text(_ENTRIES_SQL),
            {
                "user_id": user.id,
                "before_at": before_at,
                "before_id": before,
                "flows_only": flows_only,
                "limit": limit + 1,
            },
        )
    ).all()
    items = [_entry_out(row) for row in rows[:limit]]
    last_id = await db.scalar(
        select(func.max(BankrollLedger.id)).where(BankrollLedger.user_id == user.id)
    )
    return BankEntriesOut(
        items=items, next_before=items[-1].id if len(rows) > limit else None, last_id=last_id
    )


async def _entry_by_id(db: AsyncSession, user_id: int, entry_id: int) -> BankEntryOut:
    found = (
        await db.execute(
            text(
                "SELECT * FROM (SELECT id, at, kind, amount, currency, bet_id, note,"
                " reversed_by, sum(amount) OVER (ORDER BY at, id ROWS UNBOUNDED PRECEDING)"
                " AS balance_after FROM bankroll_ledger WHERE user_id = :user_id) AS journal"
                " WHERE id = :entry_id"
            ),
            {"user_id": user_id, "entry_id": entry_id},
        )
    ).one()
    return _entry_out(found)


def _signed(kind: str, amount: Decimal) -> Decimal:
    """Сумма записи со знаком журнала: вывод — минус, корректировка — как задана."""
    return -amount if kind == "withdrawal" else amount


@dataclass(frozen=True)
class AddedEntry:
    entry: BankEntryOut
    created: bool


async def add_entry(db: AsyncSession, user: User, body: BankEntryIn) -> AddedEntry:
    """Пополнение, вывод или корректировка под блокировкой денег участника. Вывод — не
    больше баланса по учету (ставки в игре вывести нельзя), корректировка не уводит баланс
    в минус. expected_last_id не совпал с последней строкой журнала: если последняя строка
    — эта же запись (двойная отправка), возвращается она; иначе 409. Делает commit."""
    amount = body.amount
    if body.kind == "correction" and amount == 0:
        raise AppError(422, "bank.amount_zero")
    if body.kind != "correction" and amount <= 0:
        raise AppError(422, "bank.amount_positive")
    await lock_member_money(db, user.id)
    settings = await get_app_settings(db)
    last = await db.scalar(
        select(func.max(BankrollLedger.id)).where(BankrollLedger.user_id == user.id)
    )
    signed = _signed(body.kind, amount)
    note = body.note or None
    if last != body.expected_last_id:
        latest = await db.get(BankrollLedger, last) if last is not None else None
        previous = await db.scalar(
            select(func.max(BankrollLedger.id)).where(
                BankrollLedger.user_id == user.id, BankrollLedger.id < (last or 0)
            )
        )
        if (
            latest is not None
            and previous == body.expected_last_id
            and (latest.kind, latest.amount, latest.note) == (body.kind, signed, note)
        ):
            entry = await _entry_by_id(db, user.id, latest.id)
            await db.commit()
            return AddedEntry(entry, created=False)
        raise AppError(409, "bank.changed")
    balance = Decimal(
        await db.scalar(
            select(func.coalesce(func.sum(BankrollLedger.amount), 0)).where(
                BankrollLedger.user_id == user.id
            )
        )
        or 0
    )
    after = balance + signed
    if body.kind == "withdrawal" and after < 0:
        raise AppError(
            422, "bank.withdrawal_range", balance=str(balance), currency=settings.currency
        )
    if body.kind == "correction" and after < 0:
        raise AppError(
            422, "bank.correction_range", balance=str(balance), currency=settings.currency
        )
    # Предел — только на рост: вывод и минус-корректировка банк не увеличивают
    if signed > 0 and after > MONEY_MAX:
        raise AppError(422, "bank.amount_range")
    row = BankrollLedger(
        user_id=user.id,
        at=utcnow(),
        kind=body.kind,
        amount=signed,
        currency=settings.currency,
        note=note,
    )
    db.add(row)
    await db.flush()
    entry = await _entry_by_id(db, user.id, row.id)
    await db.commit()
    return AddedEntry(entry, created=True)
