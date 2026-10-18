"""Правила стратегии v3 (app/ml/strategy.py): параметры, валуй, отбор в экспресс,
поправка Claude (Р22) и сумма ставки."""

from decimal import Decimal

import pytest

from app.ml import strategy as strategy_module
from app.ml.backtest import StrategyRules as BacktestRules
from app.ml.sets import MARKET_MINUS, MARKET_ML, MARKET_PLUS, Probs3
from app.ml.strategy import (
    BankSignals,
    DrawdownLevel,
    Leg,
    StakeCalc,
    StrategyParams,
    StrategyRules,
    apply_claude,
    candidates,
    fair_odds,
    leg_issues,
    legs_for_match,
    make_leg,
    margin,
    parlay_issues,
    parlay_total,
    pick_parlay,
    selection_blocks,
    stake,
    value,
    value_tier,
)

PARAMS = StrategyParams()
D = Decimal


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


# --- параметры ---


def test_default_params_match_brief() -> None:
    params = PARAMS.to_params()
    assert params == {
        "markets": ["ML", "HCP_-1.5", "HCP_+1.5"],
        "min_p": 0.65,
        "triple_min_p": 0.70,
        "leg_odds": ["1.13", "1.80"],
        "triple_max_leg_odds": "1.60",
        "double_total": ["1.28", "3.24"],
        "triple_total": ["1.44", "4.10"],
        "require_value": True,
        "cover_min_p": 0.55,
        "form_min_wins_last5": 3,
        "stake_bands": [
            ["1.28", "1.70", "0.0275"],
            ["1.71", "2.20", "0.0225"],
            ["2.21", "3.24", "0.0175"],
            ["3.25", "4.10", "0.0175"],
        ],
        "value_adjust": [["0.15", "0.005"], ["0.10", "0.0025"], ["0.05", "0"], [None, "-0.0025"]],
        "drawdown": [
            {"from": "0.10", "max_pct": "0.025"},
            {"from": "0.20", "max_pct": "0.015", "max_legs": 2, "max_leg_odds": "1.50"},
        ],
        "claude_max_shift": 0.10,
        "claude_highlight": 0.08,
        "rounding": {"RUB": "10", "USD": "1", "EUR": "1"},
        "min_stake": {"RUB": "50", "USD": "0.50", "EUR": "0.50"},
        "max_pct": "0.03",
        "growth": {"bank_up": "0.15", "min_winrate": "0.60", "max_pct": "0.04"},
        "week": {"loss": "-0.05", "loss_max_pct": "0.02", "win": "0.10", "win_add": "0.005"},
        # Рост ставки и прибыльная неделя выключены по умолчанию (В7, Р24)
        "adapt": {"dd10": True, "dd20": True, "up15": False, "week_loss": True, "week_win": False},
        # Р29: ординар — своя таблица, в защитном режиме не больше 1%; «Экспресс из лучших» —
        # не больше 1,5%; «надежнее» — кэф от 1.30, «лучший валуй» — вероятность от 50%
        "single_bands": [
            ["1.01", "1.60", "0.015"],
            ["1.61", "2.20", "0.0125"],
            ["2.21", "50", "0.01"],
        ],
        "single_protect_pct": "0.01",
        "best_express_max_pct": "0.015",
        "safer_min_odds": "1.30",
        "value_min_p": 0.5,
    }
    # Поля правил — те же, что у бэктеста (класс один)
    assert BacktestRules is StrategyRules
    assert PARAMS.rules == StrategyRules()


def test_params_round_trip_and_partial() -> None:
    assert StrategyParams.from_params(PARAMS.to_params()) == PARAMS
    assert StrategyParams.from_params({}) == PARAMS
    custom = StrategyParams.from_params(
        {
            "min_p": 0.7,
            "leg_odds": ["1.20", "1.75"],
            "adapt": {"dd10": False},
            "week": {"win_add": "0.0025"},
        }
    )
    assert custom.min_p == 0.7
    assert custom.rules.min_odds == D("1.20") and custom.rules.max_odds == D("1.75")
    assert custom.adapt_on("dd10") is False and custom.adapt_on("dd20") is True
    # Ключа нет — значение по умолчанию В7: рост ставки и прибыльная неделя выключены
    assert custom.adapt_on("up15") is False and custom.adapt_on("week_win") is False
    assert StrategyParams(adapt={}).adapt_on("up15") is False
    assert StrategyParams(adapt={}).adapt_on("week_loss") is True
    assert custom.week.win_add == D("0.0025") and custom.week.loss == D("-0.05")
    assert StrategyParams.from_params(custom.to_params()) == custom


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({"min_pp": 0.6}, "неизвестные ключи: min_pp"),
        ({"min_p": "много"}, "«min_p»"),
        ({"min_p": 1.5}, "«min_p»"),
        ({"require_value": "yes"}, "«require_value»"),
        ({"leg_odds": ["1.80", "1.13"]}, "«leg_odds»"),
        ({"leg_odds": ["1.13"]}, "«leg_odds»"),
        ({"stake_bands": [["1.70", "1.28", "0.02"]]}, "«stake_bands»"),
        ({"value_adjust": [["0.05", "0"]]}, "«value_adjust»"),
        ({"drawdown": [{"from": "0.1", "max_pct": "0.02", "extra": 1}]}, "«drawdown»"),
        ({"rounding": {"RUB": "10"}}, "«rounding»"),
        ({"adapt": {"lose3": True}}, "«adapt»"),
        ({"markets": "ML"}, "«markets»"),
        ({"markets": ["TOTAL"]}, "«markets»"),
        ({"form_min_wins_last5": 2.5}, "«form_min_wins_last5»"),
    ],
)
def test_bad_params(data: dict[str, object], message: str) -> None:
    with pytest.raises(ValueError, match=message):
        StrategyParams.from_params(data)


def test_drawdown_levels() -> None:
    assert PARAMS.drawdown_level(D("0.0999")) is None
    ten = PARAMS.drawdown_level(D("0.10"))
    assert ten is not None and ten.max_pct == D("0.025") and ten.key == "dd10"
    twenty = PARAMS.drawdown_level(D("0.25"))
    assert twenty is not None and twenty.max_legs == 2 and twenty.max_leg_odds == D("1.50")
    assert twenty.key == "dd20"
    # Выключенное правило не действует, включенное мягкое — действует
    no20 = StrategyParams.from_params({"adapt": {"dd20": False}})
    level = no20.drawdown_level(D("0.25"))
    assert level is not None and level.key == "dd10"
    off = StrategyParams.from_params({"adapt": {"dd10": False, "dd20": False}})
    assert off.drawdown_level(D("0.5")) is None


# --- валуй и маржа ---


def test_value_and_tiers() -> None:
    # Ровно 5% без хвостов плавающей точки
    assert value(0.7, D("1.50")) == 0.05
    assert value(0.62, D("1.62")) == pytest.approx(0.0044)
    assert value_tier(value(0.7, D("1.50"))) == "small"
    assert value_tier(value(0.7, D("1.60"))) == "good"  # 12%
    assert value_tier(value(0.7, D("1.65"))) == "strong"  # 15,5%
    assert value_tier(0.155) == "strong"
    assert value_tier(0.15) == "strong"
    assert value_tier(0.1499) == "good"
    assert value_tier(0.10) == "good"
    assert value_tier(0.0999) == "small"
    assert value_tier(0.0499) == "low"
    assert value_tier(0.0) == "none"
    assert value_tier(-0.1) == "none"


def test_margin_and_fair_odds() -> None:
    assert margin(D("1.17"), D("5.10")) == pytest.approx(0.0508, abs=1e-4)
    assert margin(D("1.90"), D("1.90")) == pytest.approx(0.0526, abs=1e-4)
    assert fair_odds(0.625) == D("1.600")
    assert fair_odds(0.66) == D("1.515")
    assert fair_odds(0.0) is None


# --- отбор ---


def test_candidates_with_markets() -> None:
    pool = [
        leg(1, 0.70, "1.50"),  # перевес 1,05
        leg(1, 0.68, "1.62", market=MARKET_MINUS),  # 1,1016 — лучший в матче 1
        leg(2, 0.66, "1.70", market=MARKET_MINUS, selection=2),  # 1,122
        leg(3, 0.60, "1.80", market=MARKET_MINUS),  # p меньше 0,65
        leg(4, 0.90, "1.12"),  # кэф меньше 1,13
        leg(5, 0.70, "1.60", blocks=("injury",)),  # травма
        leg(6, 0.66, "1.45"),  # перевеса нет
    ]
    found = candidates(pool, PARAMS)
    assert [(item.match_id, item.market) for item in found] == [
        (2, MARKET_MINUS),
        (1, MARKET_MINUS),
    ]
    # require_value из параметров (Р21) можно переопределить для сравнения
    relaxed = candidates(pool, PARAMS, require_value=False)
    assert [item.match_id for item in relaxed] == [2, 1, 6]
    # Рынок не из списка версии не берется
    ml_only = StrategyParams.from_params({"markets": ["ML"]})
    assert [item.match_id for item in candidates(pool, ml_only)] == [1]
    # П(−1.5) ниже cover_min_p не берется, даже если p ≥ min_p
    strict_cover = StrategyParams.from_params({"cover_min_p": 0.69, "min_p": 0.6})
    picked = candidates([leg(1, 0.68, "1.62", market=MARKET_MINUS)], strict_cover)
    assert picked == []


def test_tie_break_is_stable() -> None:
    # Одинаковый перевес на разных рынках одного матча: ML раньше форы
    same = [leg(1, 0.7, "1.6", market=MARKET_MINUS), leg(1, 0.7, "1.6")]
    assert candidates(same, PARAMS)[0].market == MARKET_ML


def test_parlay_boundaries_decimal() -> None:
    # 1,80 × 1,80 = 3,24 — еще можно (в float было бы 3,2400000000000003)
    top = pick_parlay([leg(1, 0.66, "1.80"), leg(2, 0.66, "1.80")], PARAMS)
    assert top is not None and parlay_total(top) == D("3.24")
    # 1,13 × 1,13 = 1,2769 — меньше 1,28: ставки нет
    assert pick_parlay([leg(1, 0.95, "1.13"), leg(2, 0.95, "1.13")], PARAMS) is None
    assert pick_parlay([leg(1, 0.7, "1.6")], PARAMS) is None


def test_parlay_of_three_and_drawdown_modes() -> None:
    strong = [
        leg(1, 0.75, "1.50"),  # 1,125
        leg(2, 0.72, "1.55"),  # 1,116
        leg(3, 0.71, "1.45"),  # 1,0295
        leg(4, 0.80, "1.35"),  # 1,08
    ]
    legs = pick_parlay(strong, PARAMS)
    assert legs is not None and [item.match_id for item in legs] == [1, 2, 4]
    # Просадка 10%: ног не меньше, правила те же
    ten = PARAMS.drawdown_level(D("0.12"))
    assert pick_parlay(strong, PARAMS, drawdown=ten) == legs
    # Просадка 20%: только 2 ноги с кэфами до 1.50
    twenty = PARAMS.drawdown_level(D("0.2"))
    guarded = pick_parlay(strong, PARAMS, drawdown=twenty)
    assert guarded is not None and [item.match_id for item in guarded] == [1, 4]
    assert all(item.odds <= D("1.50") for item in guarded)
    # Две ноги до 1.50 — экспресс есть; одна — ставки нет
    assert pick_parlay([*strong[1:3], leg(5, 0.8, "1.45")], PARAMS, drawdown=twenty) is not None
    assert pick_parlay(strong[1:3], PARAMS, drawdown=twenty) is None


def test_parlay_takes_fitting_outcome_of_each_match() -> None:
    twenty = PARAMS.drawdown_level(D("0.2"))
    assert twenty is not None and twenty.max_leg_odds == D("1.50")
    # Просадка 20%: лучший по перевесу исход матча 1 стоит 1.60, но у матча есть годный
    # исход до 1.50 — он и идет в экспресс, матч не выпадает
    match1 = [
        leg(1, 0.66, "1.60"),  # перевес 1,056
        leg(1, 0.90, "1.15", market=MARKET_MINUS),  # 1,035
    ]
    match2 = [leg(2, 0.75, "1.40")]  # 1,05
    guarded = pick_parlay([*match1, *match2], PARAMS, drawdown=twenty)
    assert guarded is not None
    assert [(item.match_id, item.market) for item in guarded] == [(2, MARKET_ML), (1, MARKET_MINUS)]
    assert parlay_issues(list(guarded), PARAMS, twenty) == ()
    # candidates с тем же лимитом просадки — те же исходы
    picked = candidates([*match1, *match2], PARAMS, drawdown=twenty)
    assert [(item.match_id, item.market) for item in picked] == [(2, MARKET_ML), (1, MARKET_MINUS)]
    assert [item.market for item in candidates(match1, PARAMS)] == [MARKET_ML]

    # Тройка: исход матча 1 с наибольшим перевесом (1.70) для тройки не годится, его фора
    # −1.5 (p 0,85, кэф 1.30) годится — получается тройка, а не двойник
    match1 = [
        leg(1, 0.72, "1.70"),  # 1,224
        leg(1, 0.85, "1.30", market=MARKET_MINUS),  # 1,105
    ]
    others = [leg(2, 0.75, "1.45"), leg(3, 0.74, "1.45")]
    triple = pick_parlay([*match1, *others], PARAMS)
    assert triple is not None
    assert [(item.match_id, item.market) for item in triple] == [
        (1, MARKET_MINUS),
        (2, MARKET_ML),
        (3, MARKET_ML),
    ]
    assert parlay_total(triple) == D("2.733250") and parlay_issues(list(triple), PARAMS) == ()
    # Просадка 10% числа ног не ограничивает — та же тройка
    ten = PARAMS.drawdown_level(D("0.1"))
    assert pick_parlay([*match1, *others], PARAMS, drawdown=ten) == triple


@pytest.mark.usefixtures("suspend_plus")
def test_suspended_market_is_never_picked() -> None:
    # Ф(+1.5) на проверке (SUSPENDED_MARKETS): даже с большим валуем и в списке рынков
    # версии исход не идет ни в кандидаты, ни в экспресс, а экран получает свою причину
    assert MARKET_PLUS in strategy_module.SUSPENDED_MARKETS
    plus = leg(1, 0.85, "1.50", market=MARKET_PLUS, selection=2)  # перевес 1,275
    others = [leg(2, 0.75, "1.45"), leg(3, 0.74, "1.45")]
    stored = StrategyParams.from_params({"markets": ["ML", "HCP_-1.5", "HCP_+1.5"]})
    for params in (PARAMS, stored):
        assert MARKET_PLUS in params.markets
        assert candidates([plus, *others], params) == [others[0], others[1]]
        assert candidates([plus], params, require_value=False) == []
        express = pick_parlay([plus, *others], params)
        assert express is not None and plus not in express
        assert leg_issues(plus, params) == ("market_suspended",)
    # Причина рынка на проверке — первой: ее и показывает экран
    weak = leg(1, 0.6, "1.9", market=MARKET_PLUS, blocks=("form",))
    assert leg_issues(weak, PARAMS) == ("market_suspended", "form", "p_low", "odds_high")
    # Без +1.5 в версии — обе причины
    no_plus = StrategyParams.from_params({"markets": ["ML"]})
    assert leg_issues(plus, no_plus) == ("market_suspended", "market")
    # Вероятность и кэф исхода по-прежнему есть (строка таблицы анализа)
    probs = Probs3(p1_win=0.8, p1_cover=0.55, p2_cover=0.05)
    odds: dict[str, list[Decimal | None]] = {"HCP_+1.5": [D("1.10"), D("2.30")]}
    shown = legs_for_match(9, probs, odds, PARAMS)
    assert [(item.market, item.selection) for item in shown] == [
        (MARKET_PLUS, 1),
        (MARKET_PLUS, 2),
    ]
    assert pick_parlay([*shown, *others], PARAMS) == tuple(others)


def test_backtest_rules_still_work() -> None:
    # Правила бэктеста (StrategyRules) — без рынков, blocks и cover_min_p
    rules = StrategyRules()
    found = candidates([leg(1, 0.6, "1.9", market=MARKET_MINUS), leg(2, 0.7, "1.6")], rules)
    assert [item.match_id for item in found] == [2]


def test_selection_blocks_and_legs_for_match() -> None:
    assert selection_blocks([True, True, True, False, False], [], PARAMS) == ()
    assert selection_blocks([True, False, False, False, True], [], PARAMS) == ("form",)
    # Меньше 5 матчей: считаются поражения, что есть
    assert selection_blocks([False, False], [], PARAMS) == ()
    assert selection_blocks([False, False, False], ["fatigue", "motivation"], PARAMS) == (
        "form",
        "fatigue",
    )
    assert selection_blocks([], ["injury", "fatigue"], PARAMS) == ("injury", "fatigue")

    probs = Probs3(p1_win=0.8, p1_cover=0.55, p2_cover=0.05)
    odds: dict[str, list[Decimal | None]] = {
        "ML": [D("1.17"), D("5.10")],
        "HCP_-1.5": [D("1.62"), None],
        "HCP_+1.5": [None, D("2.30")],
    }
    legs = legs_for_match(9, probs, odds, PARAMS, blocks={2: ("injury",)})
    assert [(item.market, item.selection, item.p, item.blocks) for item in legs] == [
        ("ML", 1, 0.8, ()),
        ("ML", 2, pytest.approx(0.2), ("injury",)),
        ("HCP_-1.5", 1, 0.55, ()),
        ("HCP_+1.5", 2, pytest.approx(0.45), ("injury",)),
    ]
    assert legs[0].value == pytest.approx(0.8 * 1.17 - 1)


def test_leg_and_parlay_issues() -> None:
    good = leg(1, 0.7, "1.6")
    assert leg_issues(good, PARAMS) == ()
    bad = leg(2, 0.6, "1.9", market=MARKET_MINUS, blocks=("form",))
    assert leg_issues(bad, PARAMS) == ("form", "p_low", "odds_high")
    assert leg_issues(leg(3, 0.95, "1.10"), PARAMS) == ("odds_low",)
    assert leg_issues(leg(3, 0.66, "1.45"), PARAMS) == ("no_value",)
    twenty = PARAMS.drawdown_level(D("0.3"))
    assert leg_issues(good, PARAMS, twenty) == ("drawdown_odds",)

    assert parlay_issues([good, leg(2, 0.7, "1.6")], PARAMS) == ()
    assert "same_match" in parlay_issues([good, leg(1, 0.7, "1.6", selection=2)], PARAMS)
    assert parlay_issues([good], PARAMS) == ("legs_count",)
    triple = [good, leg(2, 0.68, "1.65"), leg(3, 0.75, "1.5")]
    assert parlay_issues(triple, PARAMS) == ("triple_p", "triple_odds")
    assert "drawdown_legs" in parlay_issues(triple, PARAMS, twenty)
    assert "total_high" in parlay_issues([leg(1, 0.9, "1.80"), leg(2, 0.9, "1.81")], PARAMS)


# --- поправка Claude (Р22) ---


def test_apply_claude_clamps_and_flags() -> None:
    base = Probs3(0.65, 0.40, 0.15)
    claude = Probs3(0.80, 0.48, 0.10)
    final = apply_claude(base, claude, PARAMS)
    assert final.p_claude == claude
    assert final.p_final.p1_win == pytest.approx(0.75)  # +15 п.п. → +10
    assert final.p_final.p1_cover == pytest.approx(0.48)  # +8 — в окне, без подсветки
    assert final.p_final.p2_cover == pytest.approx(0.10)
    assert final.clamped == ("p1_win",)
    assert final.divergent == ("p1_win",)  # 8 п.п. ровно — не больше 8
    assert final.needs_note
    assert final.shift("p1_win") == pytest.approx(0.10)
    assert final.reconciled == ()


def test_highlight_uses_p_base_shown_in_dossier() -> None:
    """Подсветка расхождения — по p_base из досье (3 знака), как и проверка ответа:
    0,78 при p_base 0,6996 (в досье 0,7) — ровно 8 п.п., без подсветки и без пояснения."""
    final = apply_claude(Probs3(0.6996, 0.4404, 0.1196), Probs3(0.78, 0.44, 0.12), PARAMS)
    assert final.divergent == ()
    assert final.p_final.p1_win == pytest.approx(0.78)


def test_apply_claude_reconciles() -> None:
    base = Probs3(0.60, 0.35, 0.20)
    # Claude поднял фору П1 выше победы и фору П2 выше 1 − победы
    final = apply_claude(base, Probs3(0.52, 0.45, 0.30), PARAMS)
    assert final.p_final.p1_win == pytest.approx(0.52)
    assert final.p_final.p1_cover == pytest.approx(0.45)
    assert final.p_final.p2_cover == pytest.approx(0.30)
    # Согласование: p1_cover ≤ p1_win, p2_cover ≤ 1 − p1_win
    final = apply_claude(base, Probs3(0.50, 0.45, 0.30), PARAMS)
    assert final.p_final.p1_cover == pytest.approx(0.45)
    final = apply_claude(Probs3(0.50, 0.45, 0.40), Probs3(0.42, 0.50, 0.50), PARAMS)
    assert final.p_final.p1_win == pytest.approx(0.42)
    assert final.p_final.p1_cover == pytest.approx(0.42)
    assert final.p_final.p2_cover == pytest.approx(0.50)
    assert final.reconciled == ("p1_cover",)
    final = apply_claude(Probs3(0.70, 0.40, 0.25), Probs3(0.78, 0.40, 0.30), PARAMS)
    assert final.p_final.p2_cover == pytest.approx(0.22)
    assert final.reconciled == ("p2_cover",)
    # Без расхождений — без подсветки; Claude вне [0, 1] не ломает расчет
    calm = apply_claude(base, base, PARAMS)
    assert calm.p_final == base and not calm.needs_note and calm.clamped == ()
    wild = apply_claude(Probs3(0.95, 0.80, 0.01), Probs3(1.2, 0.9, -0.1), PARAMS)
    assert wild.p_final.p1_win == 1.0 and wild.p_final.p2_cover == 0.0
    # Края окна и согласование — без хвостов плавающей точки: 0,80 и 0,20 ровно
    edge = apply_claude(Probs3(0.70, 0.40, 0.25), Probs3(0.85, 0.40, 0.40), PARAMS)
    assert edge.p_final.p1_win == 0.8 and edge.p_final.p2_cover == 0.2
    assert edge.reconciled == ("p2_cover",)


# --- сумма ставки ---


def calc(
    bank: str,
    total: str,
    values: tuple[float, ...] = (0.07, 0.07),
    *,
    currency: str = "RUB",
    signals: BankSignals | None = None,
    params: StrategyParams = PARAMS,
) -> StakeCalc:
    legs = [
        Leg(index, MARKET_ML, 1, 0.7, D("1.5"), item) for index, item in enumerate(values, start=1)
    ]
    return stake(D(bank), D(total), legs, params, signals or BankSignals(), currency)


def test_stake_example_from_mockup() -> None:
    # 48 000 × 2,25% = 1 080 (кэф 2.17, средний валуй 7% — без поправки)
    result = calc("48000", "2.17")
    assert result.amount == D("1080.00") and result.reason is None
    assert result.pct == D("0.0225")
    assert [step.kind for step in result.steps] == ["band", "value", "limit", "round"]
    assert result.steps[0].params == {"low": "1.71", "high": "2.20", "pct": "0.0225"}
    assert result.steps[1].params["tier"] == "small"


@pytest.mark.parametrize(
    ("total", "legs", "pct"),
    [
        ("1.27", 2, None),
        ("1.28", 2, "0.0275"),
        ("1.70", 2, "0.0275"),
        ("1.705", 2, "0.0225"),  # стык 1.70 / 1.71
        ("1.71", 2, "0.0225"),
        ("2.20", 2, "0.0225"),
        ("2.21", 2, "0.0175"),
        ("3.24", 2, "0.0175"),
        ("3.24", 3, "0.0175"),
        # Полоса 3.25–4.10 — только для экспресса из 3: двойник выше 3.24 суммы не получает
        ("3.245", 2, None),
        ("3.25", 2, None),
        ("3.50", 2, None),
        ("4.10", 2, None),
        ("3.245", 3, "0.0175"),
        ("3.25", 3, "0.0175"),
        ("4.10", 3, "0.0175"),
        ("4.11", 3, None),
        ("3.50", 1, None),
        ("3.50", 4, None),
    ],
)
def test_stake_bands(total: str, legs: int, pct: str | None) -> None:
    result = calc("100000", total, (0.07,) * legs)
    if pct is None:
        assert result.amount is None and result.reason == "total_range"
        assert result.steps == ()
    else:
        assert result.pct == D(pct) and result.reason is None


@pytest.mark.parametrize(
    ("values", "pct"),
    [
        ((0.15, 0.15), "0.0275"),  # 2,25 + 0,5
        ((0.12, 0.08), "0.0250"),  # средний 10% → +0,25
        ((0.05, 0.05), "0.0225"),  # 5% → без поправки
        ((0.06, 0.03), "0.0200"),  # 4,5% → −0,25
    ],
)
def test_stake_value_adjust(values: tuple[float, ...], pct: str) -> None:
    assert calc("100000", "2.00", values).pct == D(pct)


def test_stake_value_on_window_edge() -> None:
    # p_base 0,70, Claude 0,85: окно Р22 дает ровно 0,80 (во float было 0,7999999999999999)
    final = apply_claude(Probs3(0.70, 0.40, 0.20), Probs3(0.85, 0.40, 0.20), PARAMS)
    assert final.p_final.p1_win == 0.8
    legs = [make_leg(index, MARKET_ML, 1, final.p_final.p1_win, D("1.375")) for index in (1, 2)]
    assert all(item.value == 0.1 for item in legs)
    result = stake(D("10000"), D("1.890625"), legs, PARAMS, BankSignals(), "RUB")
    step = result.steps[1]
    assert step.params == {"avg_value": "0.1000", "tier": "good", "add": "0.0025"}
    assert result.pct == D("0.0250") and result.amount == D("250.00")
    # Валуй чуть меньше 10% из-за плавающей точки — тот же уровень и та же поправка
    near = [Leg(index, MARKET_ML, 1, 0.8, D("1.375"), 0.09999999999999987) for index in (1, 2)]
    again = stake(D("10000"), D("1.890625"), near, PARAMS, BankSignals(), "RUB")
    assert again.steps[1].params == step.params and again.pct == result.pct
    # Уровень и поправка — по одному и тому же числу, как на экране: 9,99% — small, 0
    below = calc("10000", "2.00", (0.0999, 0.0999))
    assert below.steps[1].params == {"avg_value": "0.0999", "tier": "small", "add": "0"}


def test_stake_caps_and_adaptations() -> None:
    # 2,75 + 0,5 = 3,25% → потолок 3%
    capped = calc("100000", "1.50", (0.2, 0.2))
    assert capped.pct == D("0.03") and capped.amount == D("3000.00")
    assert [step.kind for step in capped.steps][-2:] == ["cap", "round"]
    # Рост ставки и прибыльная неделя по умолчанию выключены (В7): сумма не меняется
    grown = BankSignals(growth=D("0.15"), winrate=D("0.6"))
    week_win = BankSignals(week_change=D("0.10"))
    assert calc("100000", "1.50", (0.2, 0.2), signals=grown).pct == D("0.03")
    assert calc("100000", "2.00", signals=week_win).pct == D("0.0225")
    # Включенные в версии стратегии: рост на 15% и винрейт 60% — потолок 4%
    on = StrategyParams.from_params({"adapt": {"up15": True, "week_win": True}})
    assert calc("100000", "1.50", (0.2, 0.2), signals=grown, params=on).pct == D("0.0325")
    no_winrate = BankSignals(growth=D("0.2"))
    assert calc("100000", "1.50", (0.2, 0.2), signals=no_winrate, params=on).pct == D("0.03")
    # Прибыльная неделя: +0,5 п.п., но не выше потолка
    assert calc("100000", "2.00", signals=week_win, params=on).pct == D("0.0275")
    assert calc("100000", "1.50", (0.2, 0.2), signals=week_win, params=on).pct == D("0.03")
    # Убыточная неделя: не больше 2%
    week_loss = BankSignals(week_change=D("-0.05"))
    assert calc("100000", "1.50", signals=week_loss).pct == D("0.02")
    # Просадка 10%: не больше 2,5%; 20%: не больше 1,5%
    dd10 = calc("100000", "1.50", signals=BankSignals(drawdown=D("0.10")))
    assert dd10.pct == D("0.025") and dd10.drawdown_level is not None
    dd20 = calc("100000", "1.50", signals=BankSignals(drawdown=D("0.2")))
    assert dd20.pct == D("0.015") and dd20.amount == D("1500.00")
    assert calc("100000", "2.50", signals=BankSignals(drawdown=D("0.2"))).pct == D("0.015")
    # Правила выключены — не действуют
    off = StrategyParams.from_params(
        {"adapt": {"dd10": False, "dd20": False, "week_loss": False, "week_win": False}}
    )
    plain = calc("100000", "1.50", signals=BankSignals(drawdown=D("0.3")), params=off)
    assert plain.pct == D("0.0275") and plain.drawdown_level is None
    assert calc("100000", "2.00", signals=week_win, params=off).pct == D("0.0225")
    no_growth = StrategyParams.from_params({"adapt": {"up15": False, "week_win": True}})
    assert calc("100000", "1.50", (0.2, 0.2), signals=grown, params=no_growth).pct == D("0.03")


def test_stake_rounding_and_minimum() -> None:
    # ₽ — вниз до 10
    assert calc("12345", "2.00").amount == D("270.00")  # 277,76 → 270
    # $ и € — вниз до 1
    assert calc("1234.56", "2.00", currency="USD").amount == D("27.00")  # 27,78
    assert calc("1234.56", "2.00", currency="EUR").amount == D("27.00")
    # Меньше минимума — суммы нет
    small = calc("2000", "2.00")  # 45 ₽ → 40 < 50
    assert small.amount is None and small.reason == "below_min"
    assert small.steps[-1].kind == "below_min"
    assert calc("2300", "2.00").amount == D("50.00")  # 51,75 → 50: минимум
    assert calc("30", "2.00", currency="USD").reason == "below_min"  # 0,675 → 0
    assert calc("50", "2.00", currency="USD").amount == D("1.00")


def test_stake_without_bank_or_legs() -> None:
    assert calc("0", "2.00").reason == "no_bank"
    assert calc("-10", "2.00").reason == "no_bank"
    assert calc("1000", "2.00", currency="GBP").reason == "currency"
    empty = stake(D("1000"), D("2.00"), [], PARAMS, BankSignals(), "RUB")
    assert empty.amount is None and empty.reason == "no_legs"


def test_drawdown_level_key() -> None:
    assert DrawdownLevel(D("0.15"), D("0.02")).key == "dd15"
