"""Правила стратегии v3 для боевого кода и бэктеста (Стратегия-ставок.md, шаги 3–5;
решения Р21 и Р22 в PLAN.md, раздел 0).

Числа считает код, а не Claude: валуй, маржа, отбор исходов в экспресс, сумма ставки и
ограничение поправки Claude к вероятности модели. Параметры живут в
strategy_versions.params (StrategyParams.from_params / to_params), значения по
умолчанию — версия v3. Бэктест берет отсюда StrategyRules, candidates и pick_parlay.

Кэфы, доли банка и суммы — Decimal: граница 1.80 × 1.80 = 3.24 в плавающей точке дала бы
3.2400000000000003 и отсекла бы экспресс. Вероятности и валуй — float; валуй считается
через Decimal (value), чтобы p = 0,70 и кэф 1.50 давали ровно 5%, а не 4,99999%.

Сумма ставки (stake): доля банка по итоговому кэфу (середина диапазона шага 5) →
поправка на средний валуй ног → прибыльная неделя (+0,5 п.п.) → потолок: 3% или 4% при
росте банка на 15% и винрейте от 60%, не больше лимита просадки Р22 и лимита убыточной
недели → округление вниз до шага валюты → меньше минимума — суммы нет. Правила серий не
применяются (Р22). Каждое правило адаптации включается и выключается в params.adapt.
"""

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_FLOOR, Decimal, InvalidOperation
from typing import Any, Protocol, Self

from app.core.i18n import t
from app.ml.sets import MARKET_MINUS, MARKETS, PROBS3_FIELDS, SHOWN_DIGITS, Probs3

CURRENCIES: tuple[str, ...] = ("RUB", "USD", "EUR")
# Ключи правил адаптации суммы в params.adapt (карточка «Адаптации ставки» макета)
ADAPT_KEYS: tuple[str, ...] = ("dd10", "dd20", "up15", "week_loss", "week_win")
# Флаги Claude, при которых исходы на игрока не берутся в экспресс (шаг 4: «нет травм
# или перегруза»)
BLOCKING_FLAGS: tuple[str, ...] = ("injury", "fatigue")
# Градации валуя (шаг 3): не меньше порога → уровень; больше 0 — low, иначе none
VALUE_TIERS: tuple[tuple[str, float], ...] = (("strong", 0.15), ("good", 0.10), ("small", 0.05))
# Сколько знаков сравнивать у float на стыках (|p_claude − p_base| = 0,08 ровно — не
# больше 0,08, хотя в плавающей точке выходит 0,08000000000000007)
_FLOAT_DIGITS = 9
_CENT = Decimal("0.01")
# Точность среднего валуя ног в расчете суммы (0,0001 = 0,01 п.п.)
_VALUE_STEP = Decimal("0.0001")


def _dec(value: Decimal | float | int | str) -> Decimal:
    """Число как Decimal. float — по кратчайшей записи (repr): 0.7 → Decimal("0.7")."""
    if isinstance(value, Decimal):
        return value
    if isinstance(value, float):
        return Decimal(repr(value))
    return Decimal(str(value))


# --- валуй и маржа ---


def value(p: float, odds: Decimal | float) -> float:
    """Валуй исхода: p·кэф − 1 (больше 0 — ставка с перевесом)."""
    return float(_dec(p) * _dec(odds) - 1)


def value_tier(value: float) -> str:
    """Уровень валуя: strong ≥ 15%, good ≥ 10%, small ≥ 5%, low > 0, иначе none."""
    rounded = round(value, _FLOAT_DIGITS)
    for tier, threshold in VALUE_TIERS:
        if rounded >= threshold:
            return tier
    return "low" if rounded > 0 else "none"


def margin(odds1: Decimal | float, odds2: Decimal | float) -> float:
    """Маржа рынка из двух исходов: 1/k1 + 1/k2 − 1. 1.17 / 5.10 → 0,0508."""
    return float(1 / _dec(odds1) + 1 / _dec(odds2) - 1)


def fair_odds(p: float) -> Decimal | None:
    """Справедливый кэф 1/p с тремя знаками; p = 0 — None."""
    if p <= 0:
        return None
    return (1 / _dec(p)).quantize(Decimal("0.001"))


# --- параметры ---


@dataclass(frozen=True)
class StrategyRules:
    """Правила отбора событий (шаг 4): вероятность и кэф ноги, тройка, итоговый кэф.
    Ими же пользуется бэктест (поля и их порядок попадают в eval_runs.metrics)."""

    min_p: float = 0.65
    min_odds: Decimal = Decimal("1.13")
    max_odds: Decimal = Decimal("1.80")
    triple_min_p: float = 0.70
    triple_max_odds: Decimal = Decimal("1.60")
    double_total: tuple[Decimal, Decimal] = (Decimal("1.28"), Decimal("3.24"))
    triple_total: tuple[Decimal, Decimal] = (Decimal("1.44"), Decimal("4.10"))


@dataclass(frozen=True)
class DrawdownLevel:
    """Лимит просадки Р22: банк ниже пика на start и больше → ставка не больше max_pct
    банка; max_legs и max_leg_odds — защитный режим (только экспресс из 2 событий с
    кэфами до 1.50)."""

    start: Decimal
    max_pct: Decimal
    max_legs: int | None = None
    max_leg_odds: Decimal | None = None

    @property
    def key(self) -> str:
        """Ключ правила в params.adapt: 0.10 → dd10."""
        return f"dd{int(self.start * 100)}"


@dataclass(frozen=True)
class StakeBand:
    """Доля банка pct для итогового кэфа до high включительно (от low у первой полосы)."""

    low: Decimal
    high: Decimal
    pct: Decimal


@dataclass(frozen=True)
class ValueAdjust:
    """Поправка доли add при среднем валуе ног не меньше min_value (None — иначе)."""

    min_value: Decimal | None
    add: Decimal


@dataclass(frozen=True)
class GrowthRule:
    """Потолок max_pct вместо обычного, если банк вырос на bank_up к вложенному и
    винрейт не меньше min_winrate."""

    bank_up: Decimal = Decimal("0.15")
    min_winrate: Decimal = Decimal("0.60")
    max_pct: Decimal = Decimal("0.04")


@dataclass(frozen=True)
class WeekRule:
    """Итог 7 дней: loss и хуже → ставка не больше loss_max_pct; win и лучше → +win_add
    к доле, но не выше потолка."""

    loss: Decimal = Decimal("-0.05")
    loss_max_pct: Decimal = Decimal("0.02")
    win: Decimal = Decimal("0.10")
    win_add: Decimal = Decimal("0.005")


def _default_bands() -> tuple[StakeBand, ...]:
    rows = (
        ("1.28", "1.70", "0.0275"),
        ("1.71", "2.20", "0.0225"),
        ("2.21", "3.24", "0.0175"),
        ("3.25", "4.10", "0.0175"),
    )
    return tuple(StakeBand(Decimal(lo), Decimal(hi), Decimal(pct)) for lo, hi, pct in rows)


def _default_value_adjust() -> tuple[ValueAdjust, ...]:
    rows = (("0.15", "0.005"), ("0.10", "0.0025"), ("0.05", "0"), (None, "-0.0025"))
    return tuple(
        ValueAdjust(Decimal(threshold) if threshold is not None else None, Decimal(add))
        for threshold, add in rows
    )


def _default_drawdown() -> tuple[DrawdownLevel, ...]:
    return (
        DrawdownLevel(Decimal("0.10"), Decimal("0.025")),
        DrawdownLevel(Decimal("0.20"), Decimal("0.015"), 2, Decimal("1.50")),
    )


@dataclass(frozen=True)
class StrategyParams:
    """Параметры версии стратегии (strategy_versions.params). Значения по умолчанию —
    v3 с поправками Р21 (нет валуя — нет ставки) и Р22 (лимиты просадки вместо серий)."""

    markets: tuple[str, ...] = MARKETS
    min_p: float = 0.65
    triple_min_p: float = 0.70
    leg_odds: tuple[Decimal, Decimal] = (Decimal("1.13"), Decimal("1.80"))
    triple_max_leg_odds: Decimal = Decimal("1.60")
    double_total: tuple[Decimal, Decimal] = (Decimal("1.28"), Decimal("3.24"))
    triple_total: tuple[Decimal, Decimal] = (Decimal("1.44"), Decimal("4.10"))
    require_value: bool = True
    # П(−1.5): вероятность победы с разницей ≥ 2 сета
    cover_min_p: float = 0.55
    # Форма за последние 5 матчей не хуже 3–2
    form_min_wins_last5: int = 3
    stake_bands: tuple[StakeBand, ...] = field(default_factory=_default_bands)
    value_adjust: tuple[ValueAdjust, ...] = field(default_factory=_default_value_adjust)
    drawdown: tuple[DrawdownLevel, ...] = field(default_factory=_default_drawdown)
    claude_max_shift: float = 0.10
    claude_highlight: float = 0.08
    rounding: Mapping[str, Decimal] = field(
        default_factory=lambda: {"RUB": Decimal("10"), "USD": Decimal("1"), "EUR": Decimal("1")}
    )
    min_stake: Mapping[str, Decimal] = field(
        default_factory=lambda: {
            "RUB": Decimal("50"),
            "USD": Decimal("0.50"),
            "EUR": Decimal("0.50"),
        }
    )
    max_pct: Decimal = Decimal("0.03")
    growth: GrowthRule = field(default_factory=GrowthRule)
    week: WeekRule = field(default_factory=WeekRule)
    adapt: Mapping[str, bool] = field(default_factory=lambda: dict.fromkeys(ADAPT_KEYS, True))

    @property
    def rules(self) -> StrategyRules:
        """Правила отбора в виде, общем с бэктестом."""
        return StrategyRules(
            min_p=self.min_p,
            min_odds=self.leg_odds[0],
            max_odds=self.leg_odds[1],
            triple_min_p=self.triple_min_p,
            triple_max_odds=self.triple_max_leg_odds,
            double_total=self.double_total,
            triple_total=self.triple_total,
        )

    def adapt_on(self, key: str) -> bool:
        """Правило адаптации включено (нет ключа — включено)."""
        return self.adapt.get(key, True)

    def drawdown_level(self, drawdown: Decimal) -> DrawdownLevel | None:
        """Самый строгий включенный лимит просадки, порог которого достигнут."""
        active = [
            level for level in self.drawdown if drawdown >= level.start and self.adapt_on(level.key)
        ]
        return max(active, key=lambda level: level.start, default=None)

    def to_params(self) -> dict[str, Any]:
        """Параметры для strategy_versions.params (JSON): Decimal — строкой."""
        return {
            "markets": list(self.markets),
            "min_p": self.min_p,
            "triple_min_p": self.triple_min_p,
            "leg_odds": [str(value) for value in self.leg_odds],
            "triple_max_leg_odds": str(self.triple_max_leg_odds),
            "double_total": [str(value) for value in self.double_total],
            "triple_total": [str(value) for value in self.triple_total],
            "require_value": self.require_value,
            "cover_min_p": self.cover_min_p,
            "form_min_wins_last5": self.form_min_wins_last5,
            "stake_bands": [
                [str(band.low), str(band.high), str(band.pct)] for band in self.stake_bands
            ],
            "value_adjust": [
                [str(row.min_value) if row.min_value is not None else None, str(row.add)]
                for row in self.value_adjust
            ],
            "drawdown": [_level_params(level) for level in self.drawdown],
            "claude_max_shift": self.claude_max_shift,
            "claude_highlight": self.claude_highlight,
            "rounding": {key: str(value) for key, value in self.rounding.items()},
            "min_stake": {key: str(value) for key, value in self.min_stake.items()},
            "max_pct": str(self.max_pct),
            "growth": {
                "bank_up": str(self.growth.bank_up),
                "min_winrate": str(self.growth.min_winrate),
                "max_pct": str(self.growth.max_pct),
            },
            "week": {
                "loss": str(self.week.loss),
                "loss_max_pct": str(self.week.loss_max_pct),
                "win": str(self.week.win),
                "win_add": str(self.week.win_add),
            },
            "adapt": dict(self.adapt),
        }

    @classmethod
    def from_params(cls, data: Mapping[str, Any]) -> Self:
        """Параметры из strategy_versions.params поверх значений по умолчанию.
        Неизвестный ключ или неверное значение — ValueError с именем ключа."""
        unknown = sorted(set(data) - set(_PARSERS))
        if unknown:
            raise ValueError(t("ml.strategy.unknown_params", keys=", ".join(unknown)))
        values: dict[str, Any] = {}
        for key, raw in data.items():
            try:
                values[key] = _PARSERS[key](raw)
            except (TypeError, ValueError, KeyError, IndexError, InvalidOperation):
                raise ValueError(t("ml.strategy.bad_param", key=key)) from None
        params = cls(**values)
        params.validate()
        return params

    def validate(self) -> None:
        """Согласованность значений; ошибка — ValueError с именем ключа."""
        checks: list[tuple[str, bool]] = [
            ("markets", bool(self.markets) and set(self.markets) <= set(MARKETS)),
            ("min_p", 0 < self.min_p < 1),
            ("triple_min_p", 0 < self.triple_min_p < 1),
            ("leg_odds", 1 < self.leg_odds[0] <= self.leg_odds[1]),
            ("double_total", self.double_total[0] <= self.double_total[1]),
            ("triple_total", self.triple_total[0] <= self.triple_total[1]),
            ("cover_min_p", 0 <= self.cover_min_p < 1),
            ("form_min_wins_last5", 0 <= self.form_min_wins_last5 <= 5),
            ("stake_bands", _bands_ok(self.stake_bands)),
            ("value_adjust", bool(self.value_adjust) and self.value_adjust[-1].min_value is None),
            ("drawdown", all(0 < level.start < 1 for level in self.drawdown)),
            ("claude_max_shift", 0 <= self.claude_max_shift <= 1),
            ("claude_highlight", 0 <= self.claude_highlight <= 1),
            ("rounding", all(self.rounding.get(code, 0) > 0 for code in CURRENCIES)),
            ("min_stake", all(self.min_stake.get(code, 0) > 0 for code in CURRENCIES)),
            ("max_pct", 0 < self.max_pct < 1),
            ("growth", 0 < self.growth.max_pct < 1),
            ("week", self.week.loss < 0 < self.week.win),
            ("adapt", set(self.adapt) <= set(ADAPT_KEYS)),
        ]
        for key, ok in checks:
            if not ok:
                raise ValueError(t("ml.strategy.bad_param", key=key))


def _level_params(level: DrawdownLevel) -> dict[str, Any]:
    out: dict[str, Any] = {"from": str(level.start), "max_pct": str(level.max_pct)}
    if level.max_legs is not None:
        out["max_legs"] = level.max_legs
    if level.max_leg_odds is not None:
        out["max_leg_odds"] = str(level.max_leg_odds)
    return out


def _bands_ok(bands: Sequence[StakeBand]) -> bool:
    if not bands:
        return False
    previous = Decimal(0)
    for band in bands:
        if not (previous <= band.low <= band.high and 0 < band.pct < 1):
            return False
        previous = band.high
    return True


def _to_float(raw: Any) -> float:
    if isinstance(raw, bool) or not isinstance(raw, int | float | str):
        raise TypeError(raw)
    return float(raw)


def _to_int(raw: Any) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise TypeError(raw)
    return raw


def _to_bool(raw: Any) -> bool:
    if not isinstance(raw, bool):
        raise TypeError(raw)
    return raw


def _to_dec(raw: Any) -> Decimal:
    if isinstance(raw, bool) or not isinstance(raw, int | float | str | Decimal):
        raise TypeError(raw)
    result = _dec(raw)
    if not result.is_finite():
        raise ValueError(raw)
    return result


def _to_pair(raw: Any) -> tuple[Decimal, Decimal]:
    low, high = raw
    return _to_dec(low), _to_dec(high)


def _to_markets(raw: Any) -> tuple[str, ...]:
    if isinstance(raw, str):
        raise TypeError(raw)
    return tuple(str(item) for item in raw)


def _to_bands(raw: Any) -> tuple[StakeBand, ...]:
    return tuple(StakeBand(_to_dec(lo), _to_dec(hi), _to_dec(pct)) for lo, hi, pct in raw)


def _to_value_adjust(raw: Any) -> tuple[ValueAdjust, ...]:
    return tuple(
        ValueAdjust(_to_dec(threshold) if threshold is not None else None, _to_dec(add))
        for threshold, add in raw
    )


def _to_levels(raw: Any) -> tuple[DrawdownLevel, ...]:
    levels: list[DrawdownLevel] = []
    for item in raw:
        extra = set(item) - {"from", "max_pct", "max_legs", "max_leg_odds"}
        if extra:
            raise KeyError(extra)
        legs = item.get("max_legs")
        odds = item.get("max_leg_odds")
        levels.append(
            DrawdownLevel(
                start=_to_dec(item["from"]),
                max_pct=_to_dec(item["max_pct"]),
                max_legs=_to_int(legs) if legs is not None else None,
                max_leg_odds=_to_dec(odds) if odds is not None else None,
            )
        )
    return tuple(levels)


def _to_money_map(raw: Any) -> dict[str, Decimal]:
    return {str(key): _to_dec(value) for key, value in dict(raw).items()}


def _to_growth(raw: Any) -> GrowthRule:
    base = GrowthRule()
    data = dict(raw)
    if set(data) - {"bank_up", "min_winrate", "max_pct"}:
        raise KeyError(data)
    return GrowthRule(
        bank_up=_to_dec(data.get("bank_up", base.bank_up)),
        min_winrate=_to_dec(data.get("min_winrate", base.min_winrate)),
        max_pct=_to_dec(data.get("max_pct", base.max_pct)),
    )


def _to_week(raw: Any) -> WeekRule:
    base = WeekRule()
    data = dict(raw)
    if set(data) - {"loss", "loss_max_pct", "win", "win_add"}:
        raise KeyError(data)
    return WeekRule(
        loss=_to_dec(data.get("loss", base.loss)),
        loss_max_pct=_to_dec(data.get("loss_max_pct", base.loss_max_pct)),
        win=_to_dec(data.get("win", base.win)),
        win_add=_to_dec(data.get("win_add", base.win_add)),
    )


def _to_adapt(raw: Any) -> dict[str, bool]:
    given = {str(key): _to_bool(flag) for key, flag in dict(raw).items()}
    return {**dict.fromkeys(ADAPT_KEYS, True), **given}


_PARSERS: dict[str, Callable[[Any], Any]] = {
    "markets": _to_markets,
    "min_p": _to_float,
    "triple_min_p": _to_float,
    "leg_odds": _to_pair,
    "triple_max_leg_odds": _to_dec,
    "double_total": _to_pair,
    "triple_total": _to_pair,
    "require_value": _to_bool,
    "cover_min_p": _to_float,
    "form_min_wins_last5": _to_int,
    "stake_bands": _to_bands,
    "value_adjust": _to_value_adjust,
    "drawdown": _to_levels,
    "claude_max_shift": _to_float,
    "claude_highlight": _to_float,
    "rounding": _to_money_map,
    "min_stake": _to_money_map,
    "max_pct": _to_dec,
    "growth": _to_growth,
    "week": _to_week,
    "adapt": _to_adapt,
}


# --- исходы и экспресс ---


class Pick(Protocol):
    """Исход, который можно взять в экспресс: Leg боевого кода или Outcome бэктеста."""

    @property
    def match_id(self) -> int: ...
    @property
    def market(self) -> str: ...
    @property
    def selection(self) -> int: ...
    @property
    def p(self) -> float: ...
    @property
    def odds(self) -> Decimal: ...
    @property
    def edge(self) -> float: ...


@dataclass(frozen=True)
class Leg:
    """Исход матча с кэфом участника: рынок, сторона (1 — на игрока 1), итоговая
    вероятность, кэф и валуй p·кэф − 1. blocks — причины не брать исход в экспресс,
    которые не видны по числам: форма, травма, перегруз (selection_blocks)."""

    match_id: int
    market: str
    selection: int
    p: float
    odds: Decimal
    value: float
    blocks: tuple[str, ...] = ()

    @property
    def edge(self) -> float:
        """Перевес p·кэф, как у Outcome бэктеста: больше 1 — есть валуй."""
        return self.p * float(self.odds)


def make_leg(
    match_id: int,
    market: str,
    selection: int,
    p: float,
    odds: Decimal,
    *,
    blocks: Sequence[str] = (),
) -> Leg:
    """Leg с посчитанным валуем."""
    return Leg(match_id, market, selection, p, odds, value(p, odds), tuple(blocks))


def selection_blocks(
    form_last5: Sequence[bool], flags: Iterable[str], params: StrategyParams
) -> tuple[str, ...]:
    """Причины не брать исходы на игрока (шаг 4): form — в последних 5 матчах
    поражений больше, чем позволяет «не хуже 3–2» (при меньшем числе матчей считаются
    те, что есть); injury, fatigue — флаги Claude. form_last5 — исходы от последнего
    матча (True — победа)."""
    blocks: list[str] = []
    losses = sum(1 for won in form_last5[:5] if not won)
    if losses > 5 - params.form_min_wins_last5:
        blocks.append("form")
    flagged = set(flags)
    blocks.extend(flag for flag in BLOCKING_FLAGS if flag in flagged)
    return tuple(blocks)


def legs_for_match(
    match_id: int,
    probs: Probs3,
    odds: Mapping[str, Sequence[Decimal | None]],
    params: StrategyParams,
    *,
    blocks: Mapping[int, Sequence[str]] | None = None,
) -> list[Leg]:
    """Исходы матча с кэфами участника: odds — рынок → [кэф на игрока 1, на игрока 2]
    (None — кэфа нет), как в analyses.confirmed; рынки — только из params.markets.
    blocks — selection → причины (selection_blocks)."""
    probabilities = probs.markets()
    legs: list[Leg] = []
    for market in params.markets:
        pair = odds.get(market)
        if not pair:
            continue
        for selection, price in enumerate(pair, start=1):
            if price is None or price <= 1:
                continue
            reasons = tuple((blocks or {}).get(selection, ()))
            legs.append(
                make_leg(
                    match_id,
                    market,
                    selection,
                    probabilities[(market, selection)],
                    price,
                    blocks=reasons,
                )
            )
    return legs


@dataclass(frozen=True)
class _Limits:
    rules: StrategyRules
    require_value: bool
    cover_min_p: float | None = None
    markets: tuple[str, ...] | None = None


def _limits(rules: StrategyRules | StrategyParams, require_value: bool | None) -> _Limits:
    if isinstance(rules, StrategyParams):
        need = rules.require_value if require_value is None else require_value
        return _Limits(rules.rules, need, rules.cover_min_p, rules.markets)
    return _Limits(rules, True if require_value is None else require_value)


def _qualifies(item: Pick, limits: _Limits) -> bool:
    rules = limits.rules
    if isinstance(item, Leg) and item.blocks:
        return False
    if limits.markets is not None and item.market not in limits.markets:
        return False
    if (
        limits.cover_min_p is not None
        and item.market == MARKET_MINUS
        and item.p < limits.cover_min_p
    ):
        return False
    return (
        item.p >= rules.min_p
        and rules.min_odds <= item.odds <= rules.max_odds
        and (item.edge > 1.0 or not limits.require_value)
    )


def _market_rank(market: str) -> int:
    return MARKETS.index(market) if market in MARKETS else len(MARKETS)


def _by_edge(item: Pick) -> tuple[float, int, int, int]:
    return (-item.edge, item.match_id, _market_rank(item.market), item.selection)


def _fits(
    rules: StrategyRules | StrategyParams,
    require_value: bool | None,
    drawdown: DrawdownLevel | None,
) -> Callable[[Pick], bool]:
    """Исход годится в экспресс: правила отбора и кэф защитного режима просадки."""
    limits = _limits(rules, require_value)
    cap = drawdown.max_leg_odds if drawdown is not None else None
    return lambda item: _qualifies(item, limits) and (cap is None or item.odds <= cap)


def _best_per_match[T: Pick](outcomes: Iterable[T], keep: Callable[[T], bool]) -> list[T]:
    """Из исходов, которые прошли keep, по одному на матч (с наибольшим перевесом), по
    убыванию перевеса. Условия — до выбора: иначе лучший по перевесу, но негодный исход
    вытеснил бы годный исход того же матча на другом рынке."""
    best: dict[int, T] = {}
    for outcome in outcomes:
        if not keep(outcome):
            continue
        current = best.get(outcome.match_id)
        if current is None or _by_edge(outcome) < _by_edge(current):
            best[outcome.match_id] = outcome
    return sorted(best.values(), key=_by_edge)


def candidates[T: Pick](
    outcomes: Iterable[T],
    rules: StrategyRules | StrategyParams,
    *,
    require_value: bool | None = None,
    drawdown: DrawdownLevel | None = None,
) -> list[T]:
    """Подходящие исходы (p ≥ 0,65, кэф 1.13–1.80, перевес p·кэф > 1, если он требуется;
    у StrategyParams еще рынок из списка, П(−1.5) не ниже cover_min_p и нет blocks; в
    защитном режиме просадки — кэф до drawdown.max_leg_odds), не больше одного из матча
    (с наибольшим перевесом), по убыванию перевеса.
    require_value: None — из params (у StrategyRules — True)."""
    return _best_per_match(outcomes, _fits(rules, require_value, drawdown))


def parlay_total(legs: Iterable[Pick]) -> Decimal:
    """Итоговый кэф экспресса: произведение кэфов ног (Decimal, без округления)."""
    total = Decimal(1)
    for leg in legs:
        total *= leg.odds
    return total


def pick_parlay[T: Pick](
    outcomes: Iterable[T],
    rules: StrategyRules | StrategyParams,
    *,
    require_value: bool | None = None,
    drawdown: DrawdownLevel | None = None,
) -> tuple[T, ...] | None:
    """Экспресс по шагу 4 стратегии: меньше 2 кандидатов — ставки нет; три лучших по
    перевесу кандидата с p ≥ 0,70 и кэфом ≤ 1.60 с итогом 1.44–4.10 — экспресс из 3;
    иначе два лучших по перевесу с итогом 1.28–3.24 — экспресс из 2; иначе ставки нет.
    drawdown — лимит просадки Р22: в защитном режиме только max_legs ног с кэфами до
    max_leg_odds. Один исход на матч выбирается среди исходов, годных для своей роли:
    для тройки матч дает лучший исход с p ≥ 0,70 и кэфом ≤ 1.60, даже если по перевесу
    лучше его исход с кэфом 1.70."""
    items = list(outcomes)
    fits = _fits(rules, require_value, drawdown)
    pool = _best_per_match(items, fits)
    base = _limits(rules, require_value).rules
    max_legs = 3
    if drawdown is not None and drawdown.max_legs is not None:
        max_legs = drawdown.max_legs
    if len(pool) < 2 or max_legs < 2:
        return None
    if max_legs >= 3:
        strong = _best_per_match(
            items,
            lambda item: (
                fits(item) and item.p >= base.triple_min_p and item.odds <= base.triple_max_odds
            ),
        )
        if len(strong) >= 3:
            low, high = base.triple_total
            if low <= parlay_total(strong[:3]) <= high:
                return tuple(strong[:3])
    low, high = base.double_total
    if low <= parlay_total(pool[:2]) <= high:
        return tuple(pool[:2])
    return None


def leg_issues(
    leg: Leg, params: StrategyParams, drawdown: DrawdownLevel | None = None
) -> tuple[str, ...]:
    """Почему исход не годится в экспресс (для экрана): blocks, market, p_low,
    cover_p_low, odds_low, odds_high, no_value, drawdown_odds. Пусто — годится."""
    issues = list(leg.blocks)
    if leg.market not in params.markets:
        issues.append("market")
    if leg.p < params.min_p:
        issues.append("p_low")
    if leg.market == MARKET_MINUS and leg.p < params.cover_min_p:
        issues.append("cover_p_low")
    if leg.odds < params.leg_odds[0]:
        issues.append("odds_low")
    if leg.odds > params.leg_odds[1]:
        issues.append("odds_high")
    if params.require_value and leg.edge <= 1.0:
        issues.append("no_value")
    limit = drawdown.max_leg_odds if drawdown is not None else None
    if limit is not None and leg.odds > limit:
        issues.append("drawdown_odds")
    return tuple(issues)


def parlay_issues(
    legs: Sequence[Leg], params: StrategyParams, drawdown: DrawdownLevel | None = None
) -> tuple[str, ...]:
    """Чем экспресс (например, с фактическими кэфами участника) выходит за правила:
    legs_count, drawdown_legs, same_match, triple_p, triple_odds, total_low, total_high и
    причины ног (leg_issues) без повторов. Пусто — экспресс по правилам."""
    issues: list[str] = []
    if not 2 <= len(legs) <= 3:
        issues.append("legs_count")
    if drawdown is not None and drawdown.max_legs is not None and len(legs) > drawdown.max_legs:
        issues.append("drawdown_legs")
    if len({leg.match_id for leg in legs}) != len(legs):
        issues.append("same_match")
    if len(legs) == 3:
        if any(leg.p < params.triple_min_p for leg in legs):
            issues.append("triple_p")
        if any(leg.odds > params.triple_max_leg_odds for leg in legs):
            issues.append("triple_odds")
    if legs:
        low, high = params.triple_total if len(legs) == 3 else params.double_total
        total = parlay_total(legs)
        if total < low:
            issues.append("total_low")
        if total > high:
            issues.append("total_high")
    for leg in legs:
        for issue in leg_issues(leg, params, drawdown):
            if issue not in issues:
                issues.append(issue)
    return tuple(issues)


# --- поправка Claude (Р22) ---


@dataclass(frozen=True)
class Final3:
    """Итог поправки Claude: p_final — ограниченная ±claude_max_shift и согласованная
    вероятность; p_claude — исходные числа Claude (в predictions.p_claude). clamped —
    числа, которые уперлись в ограничение; divergent — |p_claude − p_base| больше
    claude_highlight (подсветка, ответ обязан объяснить расхождение); reconciled —
    числа, уменьшенные согласованием."""

    p_base: Probs3
    p_claude: Probs3
    p_final: Probs3
    clamped: tuple[str, ...]
    divergent: tuple[str, ...]
    reconciled: tuple[str, ...]

    @property
    def needs_note(self) -> bool:
        return bool(self.divergent)

    def shift(self, name: str) -> float:
        """Итоговая поправка к p_base по числу name (p1_win, p1_cover, p2_cover)."""
        return float(getattr(self.p_final, name)) - float(getattr(self.p_base, name))


def _clip01(value: float) -> float:
    return min(1.0, max(0.0, value))


def apply_claude(p_base3: Probs3, p_claude3: Probs3, params: StrategyParams) -> Final3:
    """Р22: каждое число Claude ограничивается окном p_base ± claude_max_shift, затем
    согласуется: p1_cover ≤ p1_win, p2_cover ≤ 1 − p1_win (форы уменьшаются, победа в
    матче — главное число). Согласование не выводит из окна: у p_base форы не больше
    победы (модель сетов)."""
    shift = params.claude_max_shift
    clamped: list[str] = []
    divergent: list[str] = []
    values: dict[str, float] = {}
    for name in PROBS3_FIELDS:
        base = float(getattr(p_base3, name))
        claude = float(getattr(p_claude3, name))
        # Края окна — через Decimal: 0,70 + 0,10 = 0,80 ровно, а не 0,7999999999999999
        # (иначе валуй ноги на краю окна выходит чуть меньше 10% и сумма теряет поправку)
        low = _clip01(float(_dec(base) - _dec(shift)))
        high = _clip01(float(_dec(base) + _dec(shift)))
        final = min(high, max(low, _clip01(claude)))
        if round(claude, _FLOAT_DIGITS) != round(final, _FLOAT_DIGITS):
            clamped.append(name)
        # Подсветка — по числу из досье (3 знака), как проверка ответа Claude: иначе
        # подсветка без пояснения, которого проверка не потребовала
        if round(abs(claude - round(base, SHOWN_DIGITS)), _FLOAT_DIGITS) > params.claude_highlight:
            divergent.append(name)
        values[name] = final
    reconciled: list[str] = []
    win = values["p1_win"]
    if values["p1_cover"] > win:
        values["p1_cover"] = win
        reconciled.append("p1_cover")
    rest = float(1 - _dec(win))  # 1 − 0,80 = 0,20 ровно, а не 0,19999999999999996
    if values["p2_cover"] > rest:
        values["p2_cover"] = rest
        reconciled.append("p2_cover")
    return Final3(
        p_base=p_base3,
        p_claude=p_claude3,
        p_final=Probs3(**values),
        clamped=tuple(clamped),
        divergent=tuple(divergent),
        reconciled=tuple(reconciled),
    )


# --- сумма ставки ---


@dataclass(frozen=True)
class BankSignals:
    """Состояние банка для адаптаций суммы (services/bank.py, BankState.signals):
    просадка от пика 0..1, рост к вложенному (+0,15 — на 15%), винрейт 0..1 и итог 7
    дней (−0,05 — минус 5%). None — посчитать нельзя (правило не действует)."""

    drawdown: Decimal = Decimal(0)
    growth: Decimal | None = None
    winrate: Decimal | None = None
    week_change: Decimal | None = None


@dataclass(frozen=True)
class StakeStep:
    """Шаг расчета суммы для экрана «Как посчитана сумма». kind: band, value, week_win,
    limit, growth, drawdown, week_loss, cap, round, below_min. pct — доля банка после
    шага; params — числа шага строками (Decimal без потери точности)."""

    kind: str
    pct: Decimal
    params: dict[str, str]


@dataclass(frozen=True)
class StakeCalc:
    """Сумма ставки и как она получена. amount None — суммы нет, reason: no_legs,
    no_bank, currency, total_range (итоговый кэф вне полос, а не у экспресса из 3 — выше
    double_total), below_min (после округления меньше минимума)."""

    amount: Decimal | None
    currency: str
    bank: Decimal
    total_odds: Decimal
    pct: Decimal
    steps: tuple[StakeStep, ...]
    reason: str | None = None
    drawdown_level: DrawdownLevel | None = None


def _band(total: Decimal, bands: Sequence[StakeBand]) -> StakeBand | None:
    """Полоса по итоговому кэфу: первая, у которой high ≥ кэфа (стык 1.70/1.71 — кэф
    1.705 идет во вторую); ниже low первой полосы — None."""
    if not bands or total < bands[0].low:
        return None
    return next((band for band in bands if total <= band.high), None)


def _value_add(avg: Decimal, rows: Sequence[ValueAdjust]) -> ValueAdjust:
    """Поправка по среднему валую avg (уже округленному, как на экране)."""
    for row in rows:
        if row.min_value is None or avg >= row.min_value:
            return row
    return rows[-1]


def stake(
    bank: Decimal,
    total_odds: Decimal,
    legs: Sequence[Leg],
    params: StrategyParams,
    signals: BankSignals,
    currency: str,
) -> StakeCalc:
    """Сумма ставки на экспресс по шагу 5 стратегии с Р21/Р22 (порядок — в docstring
    модуля). Правила отбора ног здесь не проверяются (для этого parlay_issues): сумма
    считается и для экспресса с фактическими кэфами участника."""
    steps: list[StakeStep] = []
    level = params.drawdown_level(signals.drawdown)

    def result(amount: Decimal | None, pct: Decimal, reason: str | None = None) -> StakeCalc:
        return StakeCalc(
            amount=amount,
            currency=currency,
            bank=bank,
            total_odds=total_odds,
            pct=pct,
            steps=tuple(steps),
            reason=reason,
            drawdown_level=level,
        )

    zero = Decimal(0)
    if not legs:
        return result(None, zero, "no_legs")
    if currency not in params.rounding or currency not in params.min_stake:
        return result(None, zero, "currency")
    if bank <= 0:
        return result(None, zero, "no_bank")
    band = _band(total_odds, params.stake_bands)
    # Полосы выше double_total — только для экспресса из 3 (шаг 5: «для экспресса из 3 до
    # 4.10»); двойник с итогом 3.30 (кэфы поправлены при «Поставил») суммы не получает
    if len(legs) != 3 and total_odds > params.double_total[1]:
        band = None
    if band is None:
        return result(None, zero, "total_range")
    pct = band.pct
    steps.append(
        StakeStep("band", pct, {"low": str(band.low), "high": str(band.high), "pct": str(pct)})
    )

    # Средний валуй округляется до 0,01 п.п. один раз: по нему и уровень, и поправка, и
    # число на экране (0,09999999999999987 — это 10%, а не «меньше 10%»)
    avg = (sum((_dec(leg.value) for leg in legs), Decimal(0)) / len(legs)).quantize(_VALUE_STEP)
    adjust = _value_add(avg, params.value_adjust)
    pct += adjust.add
    steps.append(
        StakeStep(
            "value",
            pct,
            {"avg_value": str(avg), "tier": value_tier(float(avg)), "add": str(adjust.add)},
        )
    )

    week = params.week
    change = signals.week_change
    if params.adapt_on("week_win") and change is not None and change >= week.win:
        pct += week.win_add
        steps.append(StakeStep("week_win", pct, {"change": str(change), "add": str(week.win_add)}))

    limit = params.max_pct
    steps.append(StakeStep("limit", pct, {"max_pct": str(limit)}))
    growth = params.growth
    if (
        params.adapt_on("up15")
        and signals.growth is not None
        and signals.winrate is not None
        and signals.growth >= growth.bank_up
        and signals.winrate >= growth.min_winrate
    ):
        limit = growth.max_pct
        steps.append(
            StakeStep(
                "growth",
                pct,
                {
                    "growth": str(signals.growth),
                    "winrate": str(signals.winrate),
                    "max_pct": str(limit),
                },
            )
        )
    if level is not None:
        limit = min(limit, level.max_pct)
        steps.append(
            StakeStep(
                "drawdown",
                pct,
                {
                    "drawdown": str(signals.drawdown),
                    "from": str(level.start),
                    "max_pct": str(level.max_pct),
                },
            )
        )
    if params.adapt_on("week_loss") and change is not None and change <= week.loss:
        limit = min(limit, week.loss_max_pct)
        steps.append(
            StakeStep("week_loss", pct, {"change": str(change), "max_pct": str(week.loss_max_pct)})
        )
    if pct > limit:
        steps.append(StakeStep("cap", limit, {"before": str(pct), "max_pct": str(limit)}))
        pct = limit
    pct = max(pct, zero)

    step = params.rounding[currency]
    raw = bank * pct
    amount = ((raw / step).to_integral_value(rounding=ROUND_FLOOR) * step).quantize(_CENT)
    steps.append(
        StakeStep(
            "round",
            pct,
            {
                "bank": str(bank),
                "raw": str(raw.quantize(_CENT)),
                "step": str(step),
                "amount": str(amount),
            },
        )
    )
    minimum = params.min_stake[currency]
    if amount < minimum:
        steps.append(StakeStep("below_min", pct, {"min": str(minimum), "amount": str(amount)}))
        return result(None, pct, "below_min")
    return result(amount, pct)
