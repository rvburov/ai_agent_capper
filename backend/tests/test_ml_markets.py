"""Р28: коды рынков с линией, модель рынков по сетам, исход ноги по счету по сетам и по
геймам, валуй с возвратом, статус рынка и отбор в экспресс."""

import math
from decimal import Decimal

import pytest

from app.ml.markets import (
    ExtraLine,
    extra_into,
    extra_lines,
    fits_format,
    games_complete,
    games_leg_result,
    is_market,
    market_code,
    market_spec,
    opposite,
    parse_games,
    set_finished,
    swapped_side,
)
from app.ml.sets import (
    SET30_PLATT,
    SETS_PLATT,
    SetCount,
    base_probs,
    leg_result,
    market_prob,
    match_leg_outcome,
    score_outcomes,
    set_score_probs,
)
from app.ml.strategy import (
    StrategyParams,
    candidates,
    express_codes,
    legs_for_match,
    make_leg,
    market_meta,
    market_status,
    value,
)
from app.services.analysis_input import swapped_odds

D = Decimal


@pytest.mark.parametrize(
    ("code", "family", "line"),
    [
        ("ML", "ml", None),
        ("HCP_-1.5", "h15", D("-1.5")),
        ("HCP_+2.5", "shcp", D("2.5")),
        ("STOT_2.5", "stot", D("2.5")),
        ("STOT_4.5", "stot", D("4.5")),
        ("GHCP_-3", "ghcp", D("-3")),
        ("GHCP_+4.5", "ghcp", D("4.5")),
        ("GTOT_22", "gtot", D("22")),
        ("GTOT_38.5", "gtot", D("38.5")),
    ],
)
def test_market_spec(code: str, family: str, line: Decimal | None) -> None:
    spec = market_spec(code)
    assert (spec.family, spec.line) == (family, line)
    assert market_code(family, line) == code


@pytest.mark.parametrize(
    "code",
    ["HCP_1.5", "HCP_-3.5", "STOT_5.5", "STOT_+2.5", "GTOT_5", "GHCP_0", "GHCP_-0.25",
     "GTOT_22.0", "GTOT_22.25", "ml", ""],
)  # fmt: skip
def test_bad_codes(code: str) -> None:
    assert not is_market(code)
    with pytest.raises(ValueError, match="Неизвестный рынок"):
        market_spec(code)


def test_pairs_sides_and_formats() -> None:
    assert opposite("ML", 1) == ("ML", 2)
    assert opposite("HCP_-1.5", 1) == ("HCP_+1.5", 2)
    assert opposite("GHCP_+3.5", 2) == ("GHCP_-3.5", 1)
    assert opposite("GTOT_22", 1) == ("GTOT_22", 2)
    # Игроки меняются местами: у тотала сторона (больше, меньше) та же
    assert swapped_side("GTOT_22", 1) == 1 and swapped_side("STOT_2.5", 2) == 2
    assert swapped_side("GHCP_-3.5", 1) == 2 and swapped_side("ML", 2) == 1
    assert fits_format("HCP_-2.5", 5) and not fits_format("HCP_-2.5", 3)
    assert fits_format("STOT_2.5", 3) and not fits_format("STOT_2.5", 5)
    assert fits_format("STOT_3.5", 5) and not fits_format("STOT_4.5", 3)
    assert fits_format("GTOT_22.5", 3) and fits_format("GTOT_38.5", 5)


def test_extra_lines_roundtrip_and_swap() -> None:
    rows = [
        ExtraLine("ghcp", D("-3.5"), D("1.85"), D("1.95")),
        ExtraLine("gtot", D("22"), D("1.75"), D("2.05")),
        ExtraLine("shcp", D("2.5"), None, D("2.40")),
    ]
    odds: dict[str, list[Decimal | None]] = {"ML": [D("1.3"), D("3.6")]}
    extra_into(odds, rows)
    assert odds["GHCP_-3.5"] == [D("1.85"), None] and odds["GHCP_+3.5"] == [None, D("1.95")]
    assert odds["GTOT_22"] == [D("1.75"), D("2.05")]
    assert odds["HCP_-2.5"] == [None, D("2.40")]
    assert extra_lines(odds) == rows
    # Игроки введены наоборот: у форы линия игрока 1 меняет знак, стороны меняются; у тотала
    # больше и меньше остаются
    swapped = swapped_odds(odds)
    assert swapped["ML"] == [D("3.6"), D("1.3")]
    assert extra_lines(swapped) == [
        ExtraLine("ghcp", D("3.5"), D("1.95"), D("1.85")),
        ExtraLine("gtot", D("22"), D("1.75"), D("2.05")),
        ExtraLine("shcp", D("-2.5"), D("2.40"), None),
    ]


def _check_scores(probs_p1: float, best_of: int) -> None:
    probs = base_probs(probs_p1, best_of, SETS_PLATT)
    scores = set_score_probs(probs, best_of)
    assert math.isclose(sum(scores.values()), 1.0, abs_tol=1e-12)
    assert all(value >= 0 for value in scores.values())
    need = best_of // 2 + 1
    won = sum(p for (a, b), p in scores.items() if a == need)
    cover1 = sum(p for (a, b), p in scores.items() if a - b >= 2)
    cover2 = sum(p for (a, b), p in scores.items() if b - a >= 2)
    assert math.isclose(won, probs.p1_win, abs_tol=1e-12)
    assert math.isclose(cover1, probs.p1_cover, abs_tol=1e-12)
    assert math.isclose(cover2, probs.p2_cover, abs_tol=1e-12)


@pytest.mark.parametrize("p1", [0.2, 0.5, 0.73, 0.9])
def test_set_scores_agree_with_three_numbers(p1: float) -> None:
    _check_scores(p1, 3)
    _check_scores(p1, 5)


def test_market_prob_new_set_markets() -> None:
    probs = base_probs(0.7, 3, SETS_PLATT)
    decider = 1 - probs.p1_cover - probs.p2_cover
    assert market_prob(probs, 3, "STOT_2.5", 1) == pytest.approx(decider)
    assert market_prob(probs, 3, "STOT_2.5", 2) == pytest.approx(1 - decider)
    assert market_prob(probs, 3, "ML", 1) == pytest.approx(0.7)
    # Фора ±2.5 и тоталы 3.5 и 4.5 — только до 3 побед; рынки по геймам — без модели
    assert market_prob(probs, 3, "HCP_-2.5", 1) is None
    assert market_prob(probs, 3, "STOT_3.5", 1) is None
    assert market_prob(probs, 3, "GTOT_22.5", 1) is None
    five = base_probs(0.7, 5, SETS_PLATT)
    scores = set_score_probs(five, 5)
    assert market_prob(five, 5, "HCP_-2.5", 1) == pytest.approx(scores[(3, 0)])
    assert market_prob(five, 5, "HCP_+2.5", 2) == pytest.approx(1 - scores[(3, 0)])
    assert market_prob(five, 5, "HCP_+2.5", 1) == pytest.approx(1 - scores[(0, 3)])
    assert market_prob(five, 5, "STOT_3.5", 2) == pytest.approx(scores[(3, 0)] + scores[(0, 3)])
    assert market_prob(five, 5, "STOT_4.5", 1) == pytest.approx(1 - five.p1_cover - five.p2_cover)


def test_three_nil_correction_raises_three_nil() -> None:
    """Независимые сеты занижают 3:0 (проверка 18.10.2026): поправка доли его повышает,
    а победа и Ф(−1.5) стороны не меняются."""
    probs = base_probs(0.65, 5, SETS_PLATT)
    raw = set_score_probs(probs, 5, None)
    fixed = set_score_probs(probs, 5, SET30_PLATT)
    assert fixed[(3, 0)] > raw[(3, 0)] and fixed[(0, 3)] > raw[(0, 3)]
    assert fixed[(3, 0)] + fixed[(3, 1)] == pytest.approx(raw[(3, 0)] + raw[(3, 1)])
    assert fixed[(3, 2)] == pytest.approx(raw[(3, 2)])


def test_claude_shift_moves_new_markets() -> None:
    """Поправка Claude к трем числам переносится на тотал сетов кодом."""
    base = base_probs(0.7, 3, SETS_PLATT)
    final = type(base)(0.75, base.p1_cover + 0.04, base.p2_cover - 0.01)
    assert market_prob(final, 3, "STOT_2.5", 1) == pytest.approx(
        1 - final.p1_cover - final.p2_cover
    )
    assert market_prob(final, 3, "STOT_2.5", 1) != market_prob(base, 3, "STOT_2.5", 1)


def test_leg_result_by_sets() -> None:
    assert leg_result("STOT_2.5", 1, SetCount(2, 1), 3) == "win"
    assert leg_result("STOT_2.5", 2, SetCount(2, 0), 3) == "win"
    assert leg_result("STOT_3.5", 1, SetCount(3, 0), 5) == "loss"
    assert leg_result("STOT_4.5", 1, SetCount(2, 3), 5) == "win"
    assert leg_result("HCP_-2.5", 1, SetCount(3, 0), 5) == "win"
    assert leg_result("HCP_-2.5", 1, SetCount(3, 1), 5) == "loss"
    assert leg_result("HCP_+2.5", 2, SetCount(3, 1), 5) == "win"
    assert leg_result("HCP_-1.5", 2, SetCount(0, 2), 3) == "win"
    assert leg_result("STOT_2.5", 1, SetCount(1, 1), 3) is None
    with pytest.raises(ValueError, match="Неизвестный рынок"):
        leg_result("GTOT_22.5", 1, SetCount(2, 0), 3)
    assert score_outcomes("STOT_2.5", 1, 3) == {
        "2:0": "loss", "2:1": "win", "1:2": "win", "0:2": "loss"
    }  # fmt: skip
    assert score_outcomes("GTOT_22.5", 1, 3) == {}


def test_games_score_and_result() -> None:
    games = parse_games("6:4 7:6(5)")
    assert games == [(6, 4), (7, 6)] and games_complete(games, 3)
    assert parse_games("6-4, 3-6, [10-8]") == [(6, 4), (3, 6), (1, 0)]
    assert parse_games("2:1") == [(2, 1)] and not games_complete([(2, 1)], 3)
    assert parse_games("шесть") is None and parse_games("") is None
    assert set_finished(13, 11) and set_finished(7, 5) and not set_finished(6, 5)
    # 6:4 7:6 — 23 гейма, Синнер +3: целая линия «ровно» — возврат
    assert games_leg_result("GTOT_23", 2, games) == "void"
    assert games_leg_result("GTOT_22.5", 1, games) == "win"
    assert games_leg_result("GTOT_22", 2, games) == "loss"
    assert games_leg_result("GHCP_-3", 1, games) == "void"
    assert games_leg_result("GHCP_-2.5", 1, games) == "win"
    assert games_leg_result("GHCP_+3.5", 2, games) == "win"
    assert games_leg_result("GHCP_-3.5", 2, games) == "loss"


def test_archive_outcome_for_game_markets() -> None:
    """Авторасчет: счет архива со стороны победителя, рынки по геймам — по нему; снятие и
    недоигранный счет — выбор участника."""
    outcome = match_leg_outcome(
        "GHCP_-3.5", 1, status="finished", winner_is_p1=True, score="6-4 6-3", best_of=3
    )
    assert outcome.result == "win"
    outcome = match_leg_outcome(
        "GTOT_22", 2, status="finished", winner_is_p1=False, score="6-4 6-4 6-4", best_of=5
    )
    assert outcome.result == "loss"
    outcome = match_leg_outcome(
        "GHCP_+6", 1, status="finished", winner_is_p1=False, score="6-3 6-3", best_of=3
    )
    assert outcome.result == "void"
    retired = match_leg_outcome(
        "GTOT_22.5", 1, status="retired", winner_is_p1=True, score="6-4 2-1 RET", best_of=3
    )
    assert retired.result is None and retired.reason == "retired"
    short = match_leg_outcome(
        "GTOT_22.5", 1, status="finished", winner_is_p1=True, score="6-4", best_of=3
    )
    assert short.result is None and short.reason == "incomplete"
    sets = match_leg_outcome(
        "STOT_2.5", 2, status="finished", winner_is_p1=False, score="6-4 6-3", best_of=3
    )
    assert sets.result == "win"


def test_value_with_push() -> None:
    assert value(0.5, D("1.9")) == pytest.approx(-0.05)
    assert value(0.47, D("1.75"), 0.07) == pytest.approx(0.47 * 1.75 + 0.07 - 1)
    leg = make_leg(1, "GTOT_22", 2, 0.47, D("2.05"), push=0.07)
    assert leg.edge == pytest.approx(0.47 * 2.05 + 0.07)
    assert leg.value == pytest.approx(0.47 * 2.05 + 0.07 - 1)


def test_status_and_express_codes() -> None:
    params = StrategyParams()
    assert market_status("ML") == "express" and market_status("HCP_+1.5") == "express"
    assert market_status("STOT_2.5") == "compare"
    assert market_status("STOT_2.5", ("stot",)) == "express"
    # Модель геймов прошла проверку (этап 7, волна 3): переведенный рынок идет в экспресс
    assert market_status("GTOT_22.5", ("gtot",)) == "express"
    assert market_status("GTOT_22.5") == "compare"
    assert market_meta("GHCP_-3", ()) == {
        "family": "ghcp", "line": -3.0, "status": "compare", "suspended": False,
        "has_model": True, "model_state": "ok",
    }  # fmt: skip
    codes = ["ML", "STOT_2.5", "GTOT_22.5", "HCP_-2.5"]
    assert express_codes(codes, params) == params.markets
    assert express_codes(codes, params, ("stot", "gtot")) == (
        *params.markets, "STOT_2.5", "GTOT_22.5",
    )  # fmt: skip


def test_new_markets_only_in_express_when_promoted() -> None:
    """Новый рынок без перевода в экспресс исхода в отбор не дает; переведенный — дает и
    проходит те же правила (p от 65%, кэф 1.13–1.80, валуй)."""
    probs = base_probs(0.85, 3, SETS_PLATT)
    odds = {"ML": [D("1.05"), D("9")], "STOT_2.5": [D("3.5"), D("1.55")]}
    params = StrategyParams()
    legs = legs_for_match(1, probs, odds, params, best_of=3)
    assert {leg.market for leg in legs} == {"ML"}
    markets = express_codes(odds, params, ("stot",))
    from dataclasses import replace

    promoted = replace(params, markets=markets)
    legs = legs_for_match(1, probs, odds, promoted, best_of=3, markets=markets)
    under = next(leg for leg in legs if (leg.market, leg.selection) == ("STOT_2.5", 2))
    assert under.p == pytest.approx(probs.p1_cover + probs.p2_cover)
    assert [leg.market for leg in candidates(legs, promoted)] == ["STOT_2.5"]
    assert candidates(legs, params) == []


def test_archive_verdict_stores_games_score() -> None:
    """Авторасчет ноги по геймам: исход по счету архива, в ноге — счет по геймам (у форы —
    со стороны выбранного игрока, у тотала — игрока 1); ноги по сетам — как раньше."""
    from app.db.models import BetLeg
    from app.services.auto_settlement import ArchiveMatch, leg_verdict
    from app.services.bets import score_from_own

    match = ArchiveMatch(status="finished", winner_is_p1=False, score="6-4 6-3", best_of=3)
    hcp = BetLeg(market="GHCP_+4.5", selection=1, odds_taken=D("1.8"))
    verdict = leg_verdict(hcp, match)
    assert verdict.settlement is not None
    # Игрок 1 проиграл 4:6 3:6 (−5 геймов): Ф1(+4.5) не сыграла
    assert verdict.settlement.result == "loss" and verdict.settlement.score == "4:6 3:6"
    total = BetLeg(market="GTOT_19", selection=2, odds_taken=D("1.8"))
    verdict = leg_verdict(total, match)
    assert verdict.settlement is not None
    assert verdict.settlement.result == "void" and verdict.settlement.score == "4:6 3:6"
    away = BetLeg(market="GHCP_-4.5", selection=2, odds_taken=D("1.8"))
    verdict = leg_verdict(away, match)
    assert verdict.settlement is not None and verdict.settlement.result == "win"
    assert verdict.settlement.score == "6:4 6:3"
    assert score_from_own("6:4 6:3", 2, "GHCP_-4.5") == "4:6 3:6"
    sets = BetLeg(market="STOT_2.5", selection=2, odds_taken=D("1.6"))
    verdict = leg_verdict(sets, match)
    assert verdict.settlement is not None and verdict.settlement.result == "win"
    assert verdict.settlement.score == "0:2"
