"""Варианты ставки в итоге анализа (Р29, PLAN.md, раздел 0; макет analysis.js,
buildVariants). Чистые функции: числа и выбор — код, сумму считает strategy.stake.

Варианты по порядку:
- strategy — экспресс стратегии (pick_parlay), если собран;
- safer — ординар «надежнее»: наибольшая вероятность среди исходов с кэфом от
  params.safer_min_odds и валуем от нуля; таких нет — среди валуя от нуля с любым кэфом;
  нет и их — наибольшая вероятность среди исходов с p от params.value_min_p (валуя нет);
- value — ординар «лучший валуй»: наибольший валуй при p от params.value_min_p (может быть
  и ниже нуля); совпал с safer — одна карточка safer с also = ("value",);
- best_express — только если экспресса стратегии нет, а матчей 2+: лучший по валую исход
  каждого матча с p от value_min_p (один рынок на матч), ног 2+; вне правил стратегии.

В варианты идут только исходы, которые разрешены экспрессу: рынок из params.markets, не
на проверке (SUSPENDED_MARKETS), без причин blocks (форма, травма, перегруз).
Число рынков и их имена здесь не перечисляются: новые рынки Р28 придут через
params.markets, а рынки «для сравнения» в него не входят.

Равенства решаются однозначно: при равной вероятности — больший валуй, при равном валуе —
большая вероятность, дальше — порядок матча в анализе, рынка (MARKETS) и сторона.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal

from app.ml.strategy import (
    SUSPENDED_MARKETS,
    DrawdownLevel,
    Leg,
    StakeMode,
    StrategyParams,
    parlay_issues,
    parlay_total,
)

VariantCode = Literal["strategy", "safer", "value", "best_express"]
# Вид ставки, которой вариант сохраняется (bets.kind)
VARIANT_KIND: dict[str, str] = {
    "strategy": "strategy",
    "safer": "single",
    "value": "single",
    "best_express": "own",
}
# Вид суммы варианта (strategy.stake, mode)
VARIANT_STAKE: dict[str, StakeMode] = {
    "strategy": "strategy",
    "safer": "single",
    "value": "single",
    "best_express": "best_express",
}
# Сколько знаков сравнивать у float (валуй 0 ровно — «от нуля», а не −1e-17)
_DIGITS = 9


@dataclass(frozen=True)
class Variant:
    """Вариант ставки: ноги, почему выбран (why — код причины, why_params — числа
    строками), с чем совпал (also), вне правил ли стратегии, issues — какие правила
    экспресса не пройдены (parlay_issues, у best_express)."""

    code: VariantCode
    legs: tuple[Leg, ...]
    why: str
    why_params: dict[str, str] = field(default_factory=dict)
    also: tuple[str, ...] = ()
    outside_strategy: bool = False
    issues: tuple[str, ...] = ()

    @property
    def kind(self) -> str:
        return VARIANT_KIND[self.code]

    @property
    def stake_mode(self) -> StakeMode:
        return VARIANT_STAKE[self.code]

    @property
    def total_odds(self) -> Decimal:
        return parlay_total(self.legs)

    @property
    def p(self) -> float:
        result = 1.0
        for leg in self.legs:
            result *= leg.p
        return result

    @property
    def value(self) -> float:
        """Валуй варианта: p·кэф − 1 (у ординара — валуй ноги)."""
        if len(self.legs) == 1:
            return self.legs[0].value
        return self.p * float(self.total_odds) - 1.0

    @property
    def no_value(self) -> bool:
        return round(self.value, _DIGITS) < 0


def allowed(leg: Leg, params: StrategyParams) -> bool:
    """Исход можно брать в варианты: рынок стратегии, не на проверке, без blocks."""
    return leg.market in params.markets and leg.market not in SUSPENDED_MARKETS and not leg.blocks


def _has_value(leg: Leg) -> bool:
    return round(leg.value, _DIGITS) >= 0


@dataclass(frozen=True)
class _Ranker:
    """Однозначный порядок исходов: порядок матча в анализе, рынка и сторона."""

    order: dict[int, int]
    markets: tuple[str, ...]

    def place(self, leg: Leg) -> tuple[int, int, int]:
        market = self.markets.index(leg.market) if leg.market in self.markets else len(self.markets)
        return (self.order.get(leg.match_id, len(self.order)), market, leg.selection)

    def by_p(self, leg: Leg) -> tuple[float, float, tuple[int, int, int]]:
        return (-round(leg.p, _DIGITS), -round(leg.value, _DIGITS), self.place(leg))

    def by_value(self, leg: Leg) -> tuple[float, float, tuple[int, int, int]]:
        return (-round(leg.value, _DIGITS), -round(leg.p, _DIGITS), self.place(leg))


def _safer(pool: Sequence[Leg], params: StrategyParams, rank: _Ranker) -> Variant | None:
    positive = [leg for leg in pool if _has_value(leg)]
    strong = [leg for leg in positive if leg.odds >= params.safer_min_odds]
    min_odds = str(params.safer_min_odds)
    if strong:
        leg = min(strong, key=rank.by_p)
        return Variant("safer", (leg,), "safer", {"min_odds": min_odds})
    if positive:
        leg = min(positive, key=rank.by_p)
        return Variant("safer", (leg,), "safer_low_odds", {"min_odds": min_odds})
    likely = [leg for leg in pool if round(leg.p, _DIGITS) >= params.value_min_p]
    if likely:
        leg = min(likely, key=rank.by_p)
        return Variant("safer", (leg,), "safer_no_value", {"min_odds": min_odds})
    return None


def _value(pool: Sequence[Leg], params: StrategyParams, rank: _Ranker) -> Variant | None:
    likely = [leg for leg in pool if round(leg.p, _DIGITS) >= params.value_min_p]
    if not likely:
        return None
    leg = min(likely, key=rank.by_value)
    why = "value" if _has_value(leg) else "value_no_value"
    return Variant("value", (leg,), why, {"min_p": str(params.value_min_p)})


def _best_express(
    pool: Sequence[Leg],
    matches: Sequence[int],
    params: StrategyParams,
    rank: _Ranker,
    level: DrawdownLevel | None,
) -> Variant | None:
    legs: list[Leg] = []
    for match_id in matches:
        found = [
            leg
            for leg in pool
            if leg.match_id == match_id and round(leg.p, _DIGITS) >= params.value_min_p
        ]
        if found:
            legs.append(min(found, key=rank.by_value))
    if len(legs) < 2:
        return None
    issues = parlay_issues(legs, params, level)
    return Variant(
        "best_express",
        tuple(legs),
        "best_express",
        {"min_p": str(params.value_min_p), "max_pct": str(params.best_express_max_pct)},
        outside_strategy=True,
        issues=issues,
    )


def pick_variants(
    legs: Sequence[Leg],
    matches: Sequence[int],
    express: Sequence[Leg] | None,
    params: StrategyParams,
    level: DrawdownLevel | None = None,
) -> list[Variant]:
    """Варианты ставки по исходам анализа (правила — в docstring модуля). matches — id
    матчей в порядке анализа; express — экспресс стратегии (None — не собран); level —
    действующий лимит просадки (для issues «Экспресса из лучших»)."""
    rank = _Ranker({match_id: n for n, match_id in enumerate(matches)}, tuple(params.markets))
    pool = [leg for leg in legs if allowed(leg, params)]
    out: list[Variant] = []
    if express:
        out.append(Variant("strategy", tuple(express), "strategy"))
    safer = _safer(pool, params, rank)
    value = _value(pool, params, rank)
    if safer is not None and value is not None and safer.legs == value.legs:
        out.append(Variant(safer.code, safer.legs, safer.why, safer.why_params, also=("value",)))
    else:
        out.extend(item for item in (safer, value) if item is not None)
    if not express and len(set(matches)) >= 2:
        best = _best_express(pool, matches, params, rank, level)
        if best is not None:
            out.append(best)
    return out
