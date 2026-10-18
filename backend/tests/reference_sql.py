"""Эталонные запросы «как в учебнике» для чисел экранов этапа 4 (PLAN.md, этап 4: «цифры
на экранах совпадают с эталонными SQL»).

Запросы написаны здесь заново и не берутся из сервисов: если сервис ошибется в правиле
(возвраты в обороте, ставки бота в CLV, сторно в банке, день по поясу), тест увидит
расхождение. Деньги сравниваются точно (Decimal), доли — до 1e-9.

- summary — итоги «Ставок»: рассчитано, выигрыш · проигрыш · возврат, оборот и прибыль без
  возвратов, ROI = прибыль / оборот, винрейт = выигрыш / (выигрыш + проигрыш), открытые;
  по желанию — только ставки одного вида (Р29: strategy, single, own);
- clv — средний CLV рассчитанных ставок приложения: по ногам без возвратов, только если
  закрытие внесено у всех, Π кэфов / Π закрытий − 1 (дробями, без плавающей точки);
- equity_by_day — капитал на конец дня по поясу участника: пополнения, выводы и
  корректировки до конца дня плюс прибыль ставок, рассчитанных до конца дня (открытая
  ставка — не убыток; отмененный расчет не считается: у ставки текущий расчет);
- аналитика — срезы ROI по событиям, калибровка, Brier против рынка, итоговый кэф,
  экспрессы против ординаров (правила — у раздела «аналитика» ниже).
"""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from fractions import Fraction
from typing import Any

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
    kind: str | None = None,
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
                  AND (CAST(:kind AS text) IS NULL OR kind = :kind)
                """
            ),
            {"user_id": user_id, "source": source, "since": since, "kind": kind},
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


async def clv(
    db: AsyncSession, user_id: int, *, since: datetime | None = None, kind: str | None = None
) -> ClvSummary:
    rows = (
        await db.execute(
            text(
                """
                SELECT b.id, l.result, l.odds_taken, l.closing_odds
                FROM bets b JOIN bet_legs l ON l.bet_id = b.id
                WHERE b.user_id = :user_id AND b.source = 'app' AND b.status <> 'open'
                  AND (CAST(:since AS timestamptz) IS NULL OR b.placed_at >= :since)
                  AND (CAST(:kind AS text) IS NULL OR b.kind = :kind)
                ORDER BY b.id, l.id
                """
            ),
            {"user_id": user_id, "since": since, "kind": kind},
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


# --- аналитика (этап 4, волна 2) ---
#
# - события — ноги рассчитанных ставок с исходом «выиграл» или «проиграл», кроме ног
#   экспрессов старого бота; покрытие — турнир архива, иначе свой подтвержденный ввод (Т29);
# - срез ROI по событиям — среднее (кэф − 1 при выигрыше, −1 при проигрыше);
# - калибровка и Brier — ноги ставок приложения с p_final; прогноз — последняя замена
#   (supersedes) не позже начала матча, проверочные прогоны (is_eval) не берутся; на пару
#   исходов матча — одно событие (последняя ставка);
# - ROI по итоговому кэфу — реальные ставки (выигрыш и проигрыш) по диапазонам таблицы
#   стратегии v3;
# - экспрессы против ординаров (Р21) — экспрессы приложения: Σ прибыли / Σ сумм против
#   Σ результатов их событий / число событий.

_DECIDED_LEGS = """
SELECT b.id AS bet_id, b.placed_at, b.source, l.id AS leg_id, l.match_id, l.market,
       l.selection, l.odds_taken, l.result, l.closing_odds, l.q_close, l.prediction_id,
       coalesce(
           CASE WHEN t.source <> 'user' THEN t.surface END,
           (SELECT jsonb_path_query_first(
                       a.confirmed, '$.events[*] ? (@.match_id == $m).surface',
                       jsonb_build_object('m', l.match_id)) #>> '{}'
            FROM analyses a WHERE a.id = b.analysis_id AND a.user_id = b.user_id),
           'unknown') AS surface,
       CASE WHEN l.result = 'win' THEN l.odds_taken - 1 ELSE -1 END AS ret
FROM bets b
JOIN bet_legs l ON l.bet_id = b.id
JOIN matches m ON m.id = l.match_id
LEFT JOIN tournaments t ON t.id = m.tournament_id
WHERE b.user_id = :user_id AND b.status <> 'open' AND l.result IN ('win', 'loss')
  AND NOT (b.source = 'legacy' AND (SELECT count(*) FROM bet_legs x WHERE x.bet_id = b.id) > 1)
  AND (CAST(:source AS text) IS NULL OR b.source = :source)
  AND (CAST(:kind AS text) IS NULL OR b.kind = :kind)
"""


async def roi_by(
    db: AsyncSession,
    user_id: int,
    dimension: str,
    *,
    source: str | None = None,
    kind: str | None = None,
) -> dict[Any, tuple[int, float]]:
    """ROI событий как ординаров: покрытие (surface), исход (outcome — рынок и сторона)
    или нижняя граница кэфа события (odds). Ключ → (событий, ROI)."""
    key = {
        "surface": "surface",
        "outcome": "market || ':' || selection",
        "odds": (
            "CASE WHEN odds_taken < 1.30 THEN '1.01' WHEN odds_taken < 1.50 THEN '1.30'"
            " WHEN odds_taken < 1.65 THEN '1.50' WHEN odds_taken < 2.00 THEN '1.65'"
            " ELSE '2.00' END"
        ),
    }[dimension]
    rows = await db.execute(
        text(
            f"SELECT {key} AS k, count(*) AS n, avg(ret) AS roi"
            f" FROM ({_DECIDED_LEGS}) AS legs GROUP BY 1"
        ),
        {"user_id": user_id, "source": source, "kind": kind},
    )
    return {row.k: (int(row.n), float(row.roi)) for row in rows}


async def events_count(
    db: AsyncSession, user_id: int, *, source: str | None = None, kind: str | None = None
) -> int:
    value = await db.scalar(
        text(f"SELECT count(*) FROM ({_DECIDED_LEGS}) AS legs"),
        {"user_id": user_id, "source": source, "kind": kind},
    )
    return int(value or 0)


_FORECAST_EVENTS = (
    """
WITH RECURSIVE legs AS ("""
    + _DECIDED_LEGS
    + """
), chain(root, id, depth) AS (
    SELECT p.id, p.id, 0 FROM predictions p
    WHERE p.id IN (SELECT prediction_id FROM legs) AND NOT p.is_eval
    UNION ALL
    SELECT c.root, n.id, c.depth + 1
    FROM chain c
    JOIN predictions n ON n.supersedes = c.id AND NOT n.is_eval AND n.user_id = :user_id
    JOIN predictions r ON r.id = c.root
    JOIN matches m ON m.id = r.match_id
    WHERE m.scheduled_at IS NULL OR n.as_of < m.scheduled_at
), latest AS (
    SELECT DISTINCT ON (root) root, id FROM chain ORDER BY root, depth DESC
), events AS (
    SELECT DISTINCT ON (legs.match_id,
                        CASE WHEN legs.market = 'ML' THEN 'ML'
                             WHEN legs.market = 'HCP_-1.5' THEN 'HCP' || legs.selection
                             ELSE 'HCP' || (3 - legs.selection) END)
           legs.leg_id, legs.placed_at, p.p_final, p.p_base, p.p_claude,
           p.q_market_at_pred AS q_market, legs.q_close,
           CASE WHEN legs.result = 'win' THEN 1 ELSE 0 END AS y
    FROM legs
    JOIN latest ON latest.root = legs.prediction_id
    JOIN predictions p ON p.id = latest.id
    WHERE legs.source = 'app' AND p.p_final IS NOT NULL
    ORDER BY legs.match_id,
             CASE WHEN legs.market = 'ML' THEN 'ML'
                  WHEN legs.market = 'HCP_-1.5' THEN 'HCP' || legs.selection
                  ELSE 'HCP' || (3 - legs.selection) END,
             legs.placed_at DESC, legs.leg_id DESC
)
"""
)


@dataclass(frozen=True)
class BrierRef:
    n: int
    model: float | None
    market: float | None
    closing_n: int
    closing_model: float | None
    closing_market: float | None


async def brier(db: AsyncSession, user_id: int) -> BrierRef:
    row = (
        await db.execute(
            text(
                _FORECAST_EVENTS
                + """
                SELECT count(*) FILTER (WHERE q_market IS NOT NULL) AS n,
                       avg(power(p_final - y, 2)) FILTER (WHERE q_market IS NOT NULL) AS model,
                       avg(power(q_market - y, 2)) FILTER (WHERE q_market IS NOT NULL)
                           AS market,
                       -- Закрытие — по всем событиям с двумя сторонами, и без рынка при
                       -- прогнозе
                       count(*) FILTER (WHERE q_close IS NOT NULL) AS closing_n,
                       avg(power(p_final - y, 2)) FILTER (WHERE q_close IS NOT NULL)
                           AS closing_model,
                       avg(power(q_close - y, 2)) FILTER (WHERE q_close IS NOT NULL)
                           AS closing_market
                FROM events
                """
            ),
            {"user_id": user_id, "source": "app", "kind": None},
        )
    ).one()
    return BrierRef(
        n=int(row.n),
        model=row.model,
        market=row.market,
        closing_n=int(row.closing_n),
        closing_model=row.closing_model,
        closing_market=row.closing_market,
    )


@dataclass(frozen=True)
class CalibrationRef:
    low: float
    n: int
    p: float
    p_base: float | None
    p_claude: float | None
    actual: float


async def calibration(db: AsyncSession, user_id: int) -> tuple[int, list[CalibrationRef]]:
    """Событий всего и корзины 5 п.п. от 50 до 95% (width_bucket)."""
    params = {"user_id": user_id, "source": "app", "kind": None}
    total = await db.scalar(text(_FORECAST_EVENTS + "SELECT count(*) FROM events"), params)
    rows = await db.execute(
        text(
            _FORECAST_EVENTS
            + """
            SELECT width_bucket(p_final, 0.5, 0.95, 9) AS bucket, count(*) AS n,
                   avg(p_final) AS p, avg(p_base) AS p_base, avg(p_claude) AS p_claude,
                   avg(y) AS actual
            FROM events WHERE p_final >= 0.5 AND p_final < 0.95
            GROUP BY 1 ORDER BY 1
            """
        ),
        params,
    )
    return int(total or 0), [
        CalibrationRef(
            low=round(0.5 + (row.bucket - 1) * 0.05, 10),
            n=int(row.n),
            p=float(row.p),
            p_base=row.p_base,
            p_claude=row.p_claude,
            actual=float(row.actual),
        )
        for row in rows
    ]


async def roi_by_total(db: AsyncSession, user_id: int) -> dict[str, tuple[int, Decimal, Decimal]]:
    """Реальные ставки по диапазонам итогового кэфа v3: диапазон → (ставок, оборот, прибыль).
    Полоса — как у стратегии: первая, у которой high ≥ кэфа (1.703 — во второй)."""
    rows = await db.execute(
        text(
            """
            SELECT CASE WHEN total_odds < 1.28 THEN 'outside'
                        WHEN total_odds <= 1.70 THEN '1.28'
                        WHEN total_odds <= 2.20 THEN '1.71'
                        WHEN total_odds <= 3.24 THEN '2.21'
                        WHEN total_odds <= 4.10 THEN '3.25'
                        ELSE 'outside' END AS band,
                   count(*) AS n, sum(stake) AS turnover, sum(profit) AS profit
            FROM bets
            WHERE user_id = :user_id AND status IN ('won', 'lost')
            GROUP BY 1
            """
        ),
        {"user_id": user_id},
    )
    return {row.band: (int(row.n), Decimal(row.turnover), Decimal(row.profit)) for row in rows}


@dataclass(frozen=True)
class ParlaysRef:
    parlays: int
    events: int
    profit: Decimal
    parlays_roi: float
    singles_roi: float


async def parlays_vs_singles(db: AsyncSession, user_id: int) -> ParlaysRef:
    row = (
        await db.execute(
            text(
                """
                WITH parlays AS (
                    SELECT b.id, b.stake, b.profit,
                           sum(CASE WHEN l.result = 'win' THEN l.odds_taken - 1 ELSE -1 END)
                               FILTER (WHERE l.result IN ('win', 'loss')) AS ret,
                           count(*) FILTER (WHERE l.result IN ('win', 'loss')) AS legs
                    FROM bets b JOIN bet_legs l ON l.bet_id = b.id
                    WHERE b.user_id = :user_id AND b.source = 'app'
                      AND b.status IN ('won', 'lost')
                    GROUP BY b.id HAVING count(*) > 1
                )
                SELECT count(*) AS n, sum(legs) AS events, sum(profit) AS profit,
                       sum(profit) / sum(stake) AS parlays_roi,
                       sum(ret) / sum(legs) AS singles_roi
                FROM parlays
                """
            ),
            {"user_id": user_id},
        )
    ).one()
    return ParlaysRef(
        parlays=int(row.n),
        events=int(row.events),
        profit=Decimal(row.profit),
        parlays_roi=float(row.parlays_roi),
        singles_roi=float(row.singles_roi),
    )


# --- банк после ставки (этап 4, волна 3) ---


async def bank_after(db: AsyncSession, user_id: int) -> dict[int, Decimal]:
    """Капитал сразу после расчета каждой рассчитанной ставки: действующие пополнения,
    выводы и корректировки не позже момента расчета плюс прибыль (bets.profit, у возврата
    0) рассчитанных ставок, рассчитанных не позже нее (по времени расчета, затем id).
    Подзапросами по ставкам, а не окном по журналу, как bank.equity_after_bets."""
    rows = await db.execute(
        text(
            """
            SELECT b.id,
                   (SELECT coalesce(sum(l.amount), 0) FROM bankroll_ledger l
                    WHERE l.user_id = b.user_id AND l.bet_id IS NULL
                      AND l.reversed_by IS NULL
                      AND NOT EXISTS (SELECT 1 FROM bankroll_ledger r
                                      WHERE r.reversed_by = l.id)
                      AND l.at <= b.settled_at)
                   + (SELECT coalesce(sum(o.profit), 0) FROM bets o
                      WHERE o.user_id = b.user_id AND o.status IN ('won', 'lost', 'void')
                        AND (o.settled_at, o.id) <= (b.settled_at, b.id)) AS capital
            FROM bets b
            WHERE b.user_id = :user_id AND b.status IN ('won', 'lost', 'void')
            """
        ),
        {"user_id": user_id},
    )
    return {int(bet_id): Decimal(capital) for bet_id, capital in rows}


# --- расход на ИИ (этап 4, волна 3) ---
#
# Видимые вызовы участника — свои (user_id), администратора — еще общие без участника на
# ключе администратора; проверки (eval, shadow) не входят. Месяц и дни — по UTC. Доля
# кэша — PLAN.md, раздел 8: cache_read / (input + cache_write + cache_read).

_AI_SCOPE = """
    created_at >= :start AND created_at < :end AND kind NOT IN ('eval', 'shadow')
    AND (user_id = :user_id OR (:admin AND user_id IS NULL AND key_source = 'admin'))
"""


async def ai_by_day(
    db: AsyncSession, user_id: int, start: datetime, end: datetime, *, admin: bool = False
) -> dict[date, Decimal]:
    rows = await db.execute(
        text(
            "SELECT (created_at AT TIME ZONE 'UTC')::date AS day, sum(cost_usd) "
            f"FROM agent_runs WHERE {_AI_SCOPE} GROUP BY 1"
        ),
        {"user_id": user_id, "start": start, "end": end, "admin": admin},
    )
    return {day: Decimal(cost) for day, cost in rows}


async def ai_by_kind(
    db: AsyncSession, user_id: int, start: datetime, end: datetime, *, admin: bool = False
) -> dict[str, tuple[int, Decimal]]:
    rows = await db.execute(
        text(
            f"SELECT kind, count(*), sum(cost_usd) FROM agent_runs WHERE {_AI_SCOPE} GROUP BY kind"
        ),
        {"user_id": user_id, "start": start, "end": end, "admin": admin},
    )
    return {kind: (int(count), Decimal(cost)) for kind, count, cost in rows}


async def ai_cache_share(
    db: AsyncSession, user_id: int, start: datetime, end: datetime, *, admin: bool = False
) -> float | None:
    value = await db.scalar(
        text(
            "SELECT sum(cache_read_tokens)::numeric"
            " / nullif(sum(input_tokens + cache_write_tokens + cache_read_tokens), 0) "
            f"FROM agent_runs WHERE {_AI_SCOPE}"
        ),
        {"user_id": user_id, "start": start, "end": end, "admin": admin},
    )
    return float(value) if value is not None else None


async def ai_key_spend(
    db: AsyncSession, start: datetime, end: datetime
) -> dict[tuple[int | None, str], Decimal]:
    """Расход по людям и ключам за месяц, без проверок (Р14: только деньги)."""
    rows = await db.execute(
        text(
            "SELECT user_id, key_source, sum(cost_usd) FROM agent_runs"
            " WHERE created_at >= :start AND created_at < :end"
            " AND kind NOT IN ('eval', 'shadow') GROUP BY user_id, key_source"
        ),
        {"start": start, "end": end},
    )
    return {(user_id, source): Decimal(cost) for user_id, source, cost in rows}
