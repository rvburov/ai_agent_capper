"""Эталонные запросы «как в учебнике» для чисел экранов этапа 4 (PLAN.md, этап 4: «цифры
на экранах совпадают с эталонными SQL»).

Запросы написаны здесь заново и не берутся из сервисов: если сервис ошибется в правиле
(возвраты в обороте, ставки бота в CLV, сторно в банке, день по поясу), тест увидит
расхождение. Деньги сравниваются точно (Decimal), доли — до 1e-9.

- summary — итоги «Ставок»: рассчитано, выигрыш · проигрыш · возврат, оборот и прибыль без
  возвратов, ROI = прибыль / оборот, винрейт = выигрыш / (выигрыш + проигрыш), открытые;
- clv — средний CLV рассчитанных ставок приложения: по ногам без возвратов, только если
  закрытие внесено у всех, Π кэфов / Π закрытий − 1 (дробями, без плавающей точки);
- equity_by_day — капитал на конец дня по поясу участника: пополнения, выводы и
  корректировки до конца дня плюс прибыль ставок, рассчитанных до конца дня (открытая
  ставка — не убыток; отмененный расчет не считается: у ставки текущий расчет).
"""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from fractions import Fraction

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class Summary:
    settled: int
    won: int
    lost: int
    void: int
    turnover: Decimal
    profit: Decimal
    open: int
    open_stake: Decimal
    legacy_settled: int

    @property
    def roi(self) -> float | None:
        return float(self.profit / self.turnover) if self.turnover else None

    @property
    def winrate(self) -> float | None:
        decided = self.won + self.lost
        return self.won / decided if decided else None


async def summary(
    db: AsyncSession,
    user_id: int,
    *,
    source: str | None = None,
    since: datetime | None = None,
) -> Summary:
    row = (
        await db.execute(
            text(
                """
                SELECT
                    count(*) FILTER (WHERE status IN ('won', 'lost', 'void')) AS settled,
                    count(*) FILTER (WHERE status = 'won') AS won,
                    count(*) FILTER (WHERE status = 'lost') AS lost,
                    count(*) FILTER (WHERE status = 'void') AS void,
                    coalesce(sum(stake) FILTER (WHERE status IN ('won', 'lost')), 0) AS turnover,
                    coalesce(sum(profit) FILTER (WHERE status IN ('won', 'lost')), 0) AS profit,
                    count(*) FILTER (WHERE status = 'open') AS open,
                    coalesce(sum(stake) FILTER (WHERE status = 'open'), 0) AS open_stake,
                    count(*) FILTER (WHERE status <> 'open' AND source = 'legacy') AS legacy
                FROM bets
                WHERE user_id = :user_id
                  AND (CAST(:source AS text) IS NULL OR source = :source)
                  AND (CAST(:since AS timestamptz) IS NULL OR placed_at >= :since)
                """
            ),
            {"user_id": user_id, "source": source, "since": since},
        )
    ).one()
    return Summary(
        settled=row.settled,
        won=row.won,
        lost=row.lost,
        void=row.void,
        turnover=Decimal(row.turnover),
        profit=Decimal(row.profit),
        open=row.open,
        open_stake=Decimal(row.open_stake),
        legacy_settled=row.legacy,
    )


@dataclass(frozen=True)
class ClvSummary:
    mean: float | None
    n: int
    positive: int


async def clv(db: AsyncSession, user_id: int, *, since: datetime | None = None) -> ClvSummary:
    rows = (
        await db.execute(
            text(
                """
                SELECT b.id, l.result, l.odds_taken, l.closing_odds
                FROM bets b JOIN bet_legs l ON l.bet_id = b.id
                WHERE b.user_id = :user_id AND b.source = 'app' AND b.status <> 'open'
                  AND (CAST(:since AS timestamptz) IS NULL OR b.placed_at >= :since)
                ORDER BY b.id, l.id
                """
            ),
            {"user_id": user_id, "since": since},
        )
    ).all()
    legs: dict[int, list[tuple[Decimal, Decimal | None]]] = {}
    for bet_id, result, odds, closing in rows:
        legs.setdefault(bet_id, [])
        if result != "void":
            legs[bet_id].append((odds, closing))
    values: list[Fraction] = []
    for live in legs.values():
        if not live or any(closing is None for _, closing in live):
            continue
        taken = closed = Fraction(1)
        for odds, closing in live:
            assert closing is not None
            taken *= Fraction(odds)
            closed *= Fraction(closing)
        values.append(taken / closed - 1)
    if not values:
        return ClvSummary(None, 0, 0)
    mean = sum(values, Fraction(0)) / len(values)
    return ClvSummary(float(mean), len(values), sum(1 for value in values if value > 0))


async def equity_by_day(
    db: AsyncSession, user_id: int, tz: str, start: date, end: date
) -> dict[date, Decimal]:
    rows = await db.execute(
        text(
            """
            SELECT d::date AS day,
                (SELECT coalesce(sum(amount), 0) FROM bankroll_ledger
                 WHERE user_id = :user_id AND bet_id IS NULL AND reversed_by IS NULL
                   AND at < ((d::date + 1)::timestamp AT TIME ZONE :tz))
              + (SELECT coalesce(sum(profit), 0) FROM bets
                 WHERE user_id = :user_id AND status <> 'open'
                   AND settled_at < ((d::date + 1)::timestamp AT TIME ZONE :tz)) AS equity
            FROM generate_series(CAST(:start AS date), CAST(:end AS date), interval '1 day') AS d
            ORDER BY 1
            """
        ),
        {"user_id": user_id, "tz": tz, "start": start, "end": end},
    )
    return {day: Decimal(equity) for day, equity in rows}
