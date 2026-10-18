"""Варианты ставки (Р29, app/ml/variants.py) и сумма ординара и «Экспресса из лучших»
(app/ml/strategy.stake, mode): края отбора — равные вероятности, совпадение «надежнее» и
«лучшего валуя», нет валуя, один матч, матч с блоком, Ф(+1.5) с огромным валуем, рынок вне
стратегии; таблица ординара на стыках, поправка на валуй, защитный режим, неделя,
округление и минимум; параметры старых версий читаются."""

from decimal import Decimal

from app.ml.sets import MARKET_MINUS, MARKET_ML, MARKET_PLUS
from app.ml.strategy import (
    BankSignals,
    Leg,
    StrategyParams,
    make_leg,
    pick_parlay,
    stake,
)
from app.ml.variants import pick_variants

D = Decimal
PARAMS = StrategyParams()
BANK = D("10000")
CALM = BankSignals()


def leg(
    match_id: int,
    p: float,
    odds: str,
    *,
    market: str = MARKET_ML,
    selection: int = 1,
    blocks: tuple[str, ...] = (),
) -> Leg:
    return make_leg(match_id, market, selection, p, D(odds), blocks=blocks)


def codes(legs: list[Leg], matches: list[int], express: list[Leg] | None = None) -> list[str]:
    return [item.code for item in pick_variants(legs, matches, express, PARAMS)]


# --- отбор вариантов ---


def test_strategy_first_then_singles_and_no_best_express() -> None:
    legs = [
        leg(1, 0.80, "1.40"),
        leg(1, 0.20, "3.00", selection=2),
        leg(2, 0.75, "1.50"),
        leg(2, 0.25, "2.80", selection=2),
    ]
    express = pick_parlay(legs, PARAMS)
    assert express is not None
    variants = pick_variants(legs, [1, 2], express, PARAMS)
    assert [item.code for item in variants] == ["strategy", "safer", "value"]
    strategy = variants[0]
    assert strategy.kind == "strategy" and strategy.legs == express
    assert not strategy.outside_strategy and strategy.stake_mode == "strategy"
    # «Надежнее»: наибольшая p при кэфе от 1.30 и валуе от нуля — 0,80 @1.40 (валуй 12%);
    # «лучший валуй» при p от 50% — 0,75 @1.50 (валуй 12,5%)
    safer, value = variants[1], variants[2]
    assert safer.legs == (legs[0],) and safer.kind == "single" and safer.why == "safer"
    assert value.legs == (legs[2],) and value.kind == "single" and value.why == "value"
    assert safer.why_params == {"min_odds": "1.30"} and value.why_params == {"min_p": "0.5"}


def test_safer_equals_value_gives_one_card() -> None:
    legs = [leg(1, 0.70, "1.60"), leg(1, 0.30, "2.50", selection=2)]
    variants = pick_variants(legs, [1], None, PARAMS)
    assert [item.code for item in variants] == ["safer"]
    assert variants[0].also == ("value",) and variants[0].legs == (legs[0],)


def test_equal_p_prefers_value_then_match_order() -> None:
    # Равные p: «надежнее» берет больший валуй
    legs = [leg(1, 0.70, "1.50"), leg(2, 0.70, "1.55")]
    assert pick_variants(legs, [1, 2], None, PARAMS)[0].legs == (legs[1],)
    # Равные p и валуй — порядок матча в анализе (матч 7 стоит раньше матча 3)
    same = [leg(3, 0.70, "1.50"), leg(7, 0.70, "1.50")]
    variants = pick_variants(same, [7, 3], None, PARAMS)
    assert variants[0].legs == (same[1],) and variants[0].also == ("value",)
    # Равный валуй у «лучшего валуя» — большая вероятность
    tie = [leg(1, 0.60, "2.00"), leg(2, 0.80, "1.50")]
    found = pick_variants(tie, [1, 2], None, PARAMS)
    # 0,80 @1.50 — и самый вероятный, и (при равном валуе 20%) лучший валуй
    assert found[0].legs == (tie[1],) and found[0].also == ("value",)


def test_safer_low_odds_and_no_value_fallbacks() -> None:
    # Валуй от нуля только у кэфа ниже 1.30 — он и «надежнее» (выигрыш небольшой)
    legs = [leg(1, 0.85, "1.20"), leg(1, 0.15, "5.00", selection=2), leg(2, 0.55, "1.70")]
    variants = pick_variants(legs, [1, 2], None, PARAMS)
    safer = variants[0]
    assert safer.code == "safer" and safer.why == "safer_low_odds" and safer.legs == (legs[0],)
    assert not safer.no_value
    # Валуя нет нигде: варианты есть (по вероятности), с пометкой no_value
    none = [
        leg(1, 0.70, "1.30"),
        leg(1, 0.30, "3.00", selection=2),
        leg(2, 0.60, "1.62"),
        leg(2, 0.40, "2.20", selection=2),
    ]
    variants = pick_variants(none, [1, 2], None, PARAMS)
    assert [item.code for item in variants] == ["safer", "value", "best_express"]
    safer, value, best = variants
    assert safer.why == "safer_no_value" and safer.legs == (none[0],) and safer.no_value
    # Наименьший минус при p от 50%: 0,60 @1.62 (−2,8%) против 0,70 @1.30 (−9%)
    assert value.why == "value_no_value" and value.legs == (none[2],)
    assert all(item.no_value for item in variants)
    assert best.outside_strategy and "no_value" in best.issues


def test_value_exactly_zero_counts_as_value() -> None:
    # p · кэф = 1 ровно: валуй от нуля (в плавающей точке 0,8 · 1,25 − 1 не меньше нуля)
    legs = [leg(1, 0.80, "1.25"), leg(1, 0.20, "4.00", selection=2)]
    safer = pick_variants(legs, [1], None, PARAMS)[0]
    assert safer.why == "safer_low_odds" and not safer.no_value


def test_one_match_has_no_best_express() -> None:
    legs = [leg(1, 0.60, "1.60"), leg(1, 0.40, "2.40", selection=2)]
    assert "best_express" not in codes(legs, [1])


def test_best_express_one_market_per_match() -> None:
    legs = [
        leg(1, 0.62, "1.80"),
        leg(1, 0.55, "2.10", market=MARKET_MINUS),
        leg(1, 0.38, "2.40", selection=2),
        leg(2, 0.58, "1.90"),
        leg(2, 0.42, "2.10", selection=2),
        leg(3, 0.45, "2.30"),
        leg(3, 0.55, "1.65", selection=2),
    ]
    assert pick_parlay(legs, PARAMS) is None
    variants = pick_variants(legs, [1, 2, 3], None, PARAMS)
    best = variants[-1]
    assert best.code == "best_express" and best.kind == "own" and best.outside_strategy
    # По матчу — лучший по валую исход с p от 50%: Ф1(−1.5) 0,55 @2.10 (+15,5%), П1 матча 2,
    # П2 матча 3 — в порядке матчей анализа
    assert [(item.match_id, item.market, item.selection) for item in best.legs] == [
        (1, MARKET_MINUS, 1),
        (2, MARKET_ML, 1),
        (3, MARKET_ML, 2),
    ]
    assert best.stake_mode == "best_express"
    assert {"p_low", "triple_p", "no_value"} <= set(best.issues)


def test_blocked_match_and_suspended_market_never_picked() -> None:
    # Травма у игрока 1 матча 1: его исходы в варианты не идут
    injured = leg(1, 0.90, "1.50", blocks=("injury",))
    # Ф(+1.5) на проверке: огромный валуй не делает ее вариантом
    plus = leg(2, 0.95, "3.00", market=MARKET_PLUS)
    other = leg(2, 0.60, "1.70")
    variants = pick_variants([injured, plus, other], [1, 2], None, PARAMS)
    chosen = {item for variant in variants for item in variant.legs}
    assert injured not in chosen and plus not in chosen
    assert [item.code for item in variants] == ["safer"] and variants[0].legs == (other,)


def test_market_outside_strategy_not_picked() -> None:
    params = StrategyParams(markets=(MARKET_ML,))
    cover = leg(1, 0.70, "1.80", market=MARKET_MINUS)
    plain = leg(1, 0.60, "1.70")
    variants = pick_variants([cover, plain], [1], None, params)
    assert [item.legs for item in variants] == [(plain,)]
    assert pick_variants([cover], [1], None, params) == []


# --- сумма ординара ---


def single(
    odds: str, p: float, signals: BankSignals = CALM, bank: Decimal = BANK
) -> Decimal | None:
    legs = [leg(1, p, odds)]
    calc = stake(bank, D(odds), legs, PARAMS, signals, "RUB", mode="single", ev=legs[0].value)
    return calc.amount


def test_single_table_edges() -> None:
    # Сумма ординара — ровно по таблице при любом валуе
    assert single("1.60", 0.66) == D("150.00")  # до 1.60 — 1,5%
    assert single("1.605", 0.66) == D("120.00")  # 1.61–2.20 — 1,25% (1.605 > 1.60)
    assert single("2.20", 0.48) == D("120.00")
    assert single("2.21", 0.48) == D("100.00")  # от 2.21 — 1%
    assert single("1.01", 1.0) == D("150.00")  # валуй 1%


def test_single_has_no_value_adjust() -> None:
    """Решение владельца: поправки на валуй у ординара нет, сумма не выше доли полосы."""
    legs = [leg(1, 0.80, "1.50")]  # валуй 20%: у экспресса было бы +0,5 п.п.
    calc = stake(BANK, D("1.50"), legs, PARAMS, CALM, "RUB", mode="single", ev=legs[0].value)
    assert calc.amount == D("150.00") and calc.pct == D("0.015")
    band = calc.steps[0]
    assert band.kind == "band" and band.params["table"] == "single" and band.pct == D("0.015")
    assert [step.kind for step in calc.steps] == ["band", "limit", "round"]
    # Валуй ниже 5% (у экспресса −0,25 п.п.) и 2,5% у кэфа 2.50 — тоже по таблице
    assert single("1.50", 0.68) == D("150.00")
    assert single("2.50", 0.41) == D("100.00")
    for odds, p in (("1.30", 0.95), ("1.90", 0.70), ("3.00", 0.60)):
        calc = stake(BANK, D(odds), [leg(1, p, odds)], PARAMS, CALM, "RUB", mode="single", ev=0.3)
        assert calc.pct == calc.steps[0].pct, odds
    # Прибыльная неделя (+0,5 п.п.) — как у экспресса: 1,5% → 2%
    week_win = StrategyParams.from_params({"adapt": {"week_win": True}})
    calc = stake(
        BANK,
        D("1.50"),
        legs,
        week_win,
        BankSignals(week_change=D("0.12")),
        "RUB",
        mode="single",
        ev=legs[0].value,
    )
    assert calc.amount == D("200.00")
    assert [step.kind for step in calc.steps] == ["band", "week_win", "limit", "round"]


def test_single_no_value_has_no_stake() -> None:
    legs = [leg(1, 0.60, "1.50")]
    calc = stake(BANK, D("1.50"), legs, PARAMS, CALM, "RUB", mode="single", ev=legs[0].value)
    assert calc.amount is None and calc.reason == "no_value"
    assert [step.kind for step in calc.steps] == ["band", "no_value"]


def test_single_adaptations() -> None:
    # Защитный режим (−20% от пика): ординар не больше 1%, хотя уровень дает 1,5%
    protect = stake(
        BANK,
        D("1.50"),
        [leg(1, 0.80, "1.50")],
        PARAMS,
        BankSignals(drawdown=D("0.21")),
        "RUB",
        mode="single",
        ev=0.2,
    )
    assert protect.amount == D("100.00")
    drawdown = next(step for step in protect.steps if step.kind == "drawdown")
    assert drawdown.params["max_pct"] == "0.01"
    # Просадка 10%: потолок 2,5% — ординар 1,5% не трогает
    assert single("1.50", 0.80, BankSignals(drawdown=D("0.12"))) == D("150.00")
    # Неделя −5%: не больше 2% — ординар 1,5% не трогает
    week = BankSignals(week_change=D("-0.06"))
    assert single("1.50", 0.80, week) == D("150.00")
    # Экспресс в защитном режиме — по своему уровню (1,5%), правило ординара его не трогает
    parlay = [leg(1, 0.80, "1.40"), leg(2, 0.80, "1.40")]
    calc = stake(BANK, D("1.96"), parlay, PARAMS, BankSignals(drawdown=D("0.21")), "RUB")
    assert calc.amount == D("150.00")


def test_single_rounding_and_minimum() -> None:
    # 1 237 × 1,5% = 18,555 → вниз до 10 ₽ = 10 < 50 — суммы нет
    calc = stake(
        D("1237"), D("1.60"), [leg(1, 0.66, "1.60")], PARAMS, CALM, "RUB", mode="single", ev=0.05
    )
    assert calc.amount is None and calc.reason == "below_min"
    # 9 999 × 1,5% = 149,985 → 140 ₽
    assert single("1.60", 0.66, bank=D("9999")) == D("140.00")
    usd = stake(
        D("999"), D("1.60"), [leg(1, 0.66, "1.60")], PARAMS, CALM, "USD", mode="single", ev=0.05
    )
    assert usd.amount == D("14.00")


# --- «Экспресс из лучших» ---


def test_best_express_stake_capped() -> None:
    legs = [leg(1, 0.80, "1.50"), leg(2, 0.80, "1.50")]
    calc = stake(BANK, D("2.25"), legs, PARAMS, CALM, "RUB", mode="best_express", ev=0.44)
    # Таблица экспресса 1,75% + 0,5 п.п. за валуй 20% — потолок 1,5%
    assert calc.amount == D("150.00") and calc.pct == D("0.015")
    assert any(step.kind == "outside" for step in calc.steps)
    assert calc.steps[0].params["table"] == "best_express"
    # Итоговый кэф выше полос — по ближайшей полосе, потолок тот же
    high = [leg(n, 0.60, "2.00") for n in range(1, 4)]
    calc = stake(BANK, D("8.00"), high, PARAMS, CALM, "RUB", mode="best_express", ev=0.728)
    assert calc.amount == D("150.00")
    none = stake(BANK, D("2.25"), legs, PARAMS, CALM, "RUB", mode="best_express", ev=-0.1)
    assert none.amount is None and none.reason == "no_value"


# --- параметры ---


def test_old_params_read_with_single_defaults() -> None:
    old = {"min_p": 0.65, "adapt": {"dd10": True}}
    params = StrategyParams.from_params(old)
    assert params.single_bands == PARAMS.single_bands
    assert params.single_protect_pct == D("0.01") and params.best_express_max_pct == D("0.015")
    assert params.safer_min_odds == D("1.30") and params.value_min_p == 0.5
    assert StrategyParams.from_params(PARAMS.to_params()) == PARAMS
    custom = StrategyParams.from_params({"single_bands": [["1.01", "50", "0.02"]]})
    assert custom.single_bands[0].pct == D("0.02")
