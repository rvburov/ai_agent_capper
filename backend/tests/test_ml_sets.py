"""Модель сетов (app/ml/sets.py): формулы, обратная функция, форы и шесть исходов,
поправка p(−1.5) по формату; счет по сетам и исход ноги ставки по счету."""

import pytest

from app.ml.sets import (
    MARKET_MINUS,
    MARKET_ML,
    MARKET_PLUS,
    OUTCOME_INCOMPLETE,
    OUTCOME_NO_RESULT,
    OUTCOME_RETIRED,
    OUTCOME_WALKOVER,
    SETS_PLATT,
    CoverPlatt,
    LegOutcome,
    Probs3,
    SetCount,
    base_probs,
    cover_prob,
    infer_best_of,
    leg_result,
    market_probs,
    match_leg_outcome,
    match_prob_from_set,
    parse_set_count,
    parse_sets,
    score_for,
    score_outcomes,
    set_count_from_score,
    set_prob_from_match,
    sets_calibration_json,
    sets_calibration_of,
    wins_needed,
)


def test_match_probability_formulas() -> None:
    # До двух побед: s²(3 − 2s); до трех: s³(10 − 15s + 6s²)
    assert match_prob_from_set(0.6, 3) == pytest.approx(0.36 * 1.8)
    assert match_prob_from_set(0.6, 5) == pytest.approx(0.216 * (10 - 9 + 2.16))
    for best_of in (3, 5):
        assert match_prob_from_set(0.5, best_of) == pytest.approx(0.5)
        assert match_prob_from_set(0.0, best_of) == 0.0
        assert match_prob_from_set(1.0, best_of) == pytest.approx(1.0)
        # Симметрия сторон
        assert match_prob_from_set(0.3, best_of) + match_prob_from_set(0.7, best_of) == (
            pytest.approx(1.0)
        )
    # В матче до трех побед фаворит выигрывает чаще
    assert match_prob_from_set(0.6, 5) > match_prob_from_set(0.6, 3) > 0.6


@pytest.mark.parametrize("best_of", [3, 5])
def test_inverse_round_trip(best_of: int) -> None:
    for p in (0.01, 0.2, 0.5, 0.65, 0.75, 0.83, 0.99):
        s = set_prob_from_match(p, best_of)
        assert 0.0 < s < 1.0
        assert match_prob_from_set(s, best_of) == pytest.approx(p, abs=1e-10)
    assert set_prob_from_match(0.5, best_of) == pytest.approx(0.5)
    assert set_prob_from_match(0.0, best_of) == 0.0
    assert set_prob_from_match(1.0, best_of) == 1.0
    # Возрастает
    values = [set_prob_from_match(p / 20, best_of) for p in range(1, 20)]
    assert values == sorted(values)


def test_cover_example_from_docs() -> None:
    # LLM_LEARNING.md, 1.4: p = 0,75 → s ≈ 0,674, P(2:0) ≈ 0,45
    s = set_prob_from_match(0.75, 3)
    assert s == pytest.approx(0.674, abs=0.001)
    assert cover_prob(s, 3) == pytest.approx(0.45, abs=0.005)
    # Правило «П(−1.5) ≥ 55%» в этой модели требует p ≈ 0,83
    assert cover_prob(set_prob_from_match(0.83, 3), 3) == pytest.approx(0.55, abs=0.01)


def test_cover_formulas() -> None:
    assert cover_prob(0.6, 3) == pytest.approx(0.36)
    # 3:0 + 3:1 = s³ + 3s³(1 − s)
    assert cover_prob(0.6, 5) == pytest.approx(0.216 + 3 * 0.216 * 0.4)
    for best_of in (3, 5):
        for s in (0.2, 0.5, 0.8):
            # Победа с разницей ≥ 2 сета не вероятнее победы
            assert cover_prob(s, best_of) <= match_prob_from_set(s, best_of)


def test_bad_arguments() -> None:
    with pytest.raises(ValueError, match="best_of"):
        match_prob_from_set(0.5, 4)
    with pytest.raises(ValueError, match="best_of"):
        set_prob_from_match(0.5, 1)
    with pytest.raises(ValueError, match="best_of"):
        cover_prob(0.5, 2)
    with pytest.raises(ValueError, match="от 0 до 1"):
        set_prob_from_match(1.2, 3)
    with pytest.raises(ValueError, match="от 0 до 1"):
        cover_prob(-0.1, 3)


@pytest.mark.parametrize("best_of", [3, 5])
def test_base_probs_are_consistent(best_of: int) -> None:
    for p in (0.1, 0.35, 0.5, 0.65, 0.9):
        probs = base_probs(p, best_of)
        assert probs.p1_win == p
        assert 0 <= probs.p1_cover <= probs.p1_win
        assert 0 <= probs.p2_cover <= 1 - probs.p1_win
    # Перестановка игроков меняет форы местами
    first, second = base_probs(0.7, best_of), base_probs(0.3, best_of)
    assert first.p1_cover == pytest.approx(second.p2_cover)
    assert first.p2_cover == pytest.approx(second.p1_cover)


@pytest.mark.parametrize("best_of", [3, 5])
def test_calibrated_base_probs(best_of: int) -> None:
    # Без изменений (a = 0, b = 1) — те же числа, что у независимых сетов
    same = {best_of: CoverPlatt()}
    for p in (0.2, 0.5, 0.8):
        same_probs = base_probs(p, best_of, same).as_dict()
        assert same_probs == pytest.approx(base_probs(p, best_of).as_dict())
    for p in (0.0, 0.05, 0.35, 0.5, 0.65, 0.95, 1.0):
        raw, fixed = base_probs(p, best_of), base_probs(p, best_of, SETS_PLATT)
        # Победа в матче не меняется, форы не больше победы, решающий сет не отрицателен
        assert fixed.p1_win == p
        assert 0 <= fixed.p1_cover <= fixed.p1_win
        assert 0 <= fixed.p2_cover <= 1 - fixed.p1_win
        if 0.05 <= p <= 0.95:
            # Поправка снижает решающий сет (проверка фор ±1.5: он завышен на 10 п.п.)
            assert 1 - fixed.p1_cover - fixed.p2_cover < 1 - raw.p1_cover - raw.p2_cover
    # Перестановка игроков меняет форы местами и с поправкой
    first, second = base_probs(0.7, best_of, SETS_PLATT), base_probs(0.3, best_of, SETS_PLATT)
    assert first.p1_cover == pytest.approx(second.p2_cover)
    assert first.p2_cover == pytest.approx(second.p1_cover)


def test_calibrated_example_numbers() -> None:
    # Равный матч до 2 побед: решающий сет 0,5 → 0,394 (факт 2023–2025 при p фаворита
    # 0,5–0,6 — 0,398); до 3 побед 0,375 → 0,241 (факт — 0,244)
    even3 = base_probs(0.5, 3, SETS_PLATT)
    assert 1 - even3.p1_cover - even3.p2_cover == pytest.approx(0.394, abs=0.001)
    even5 = base_probs(0.5, 5, SETS_PLATT)
    assert 1 - even5.p1_cover - even5.p2_cover == pytest.approx(0.241, abs=0.001)
    # Формат без поправки — как без нее
    assert base_probs(0.6, 5, {3: SETS_PLATT[3]}) == base_probs(0.6, 5)
    # Край: σ без переполнения
    assert CoverPlatt(a=0.0, b=50.0).apply(1e-9) == pytest.approx(0.0, abs=1e-12)
    assert CoverPlatt(a=0.0, b=50.0).apply(1.0) == pytest.approx(1.0)


def test_sets_calibration_of_params() -> None:
    assert sets_calibration_of(None) == SETS_PLATT
    assert sets_calibration_of({}) == SETS_PLATT
    own = sets_calibration_of({"3": {"a": 0.1, "b": 1.1}, "5": {"a": "x", "b": 1}})
    assert own[3] == CoverPlatt(0.1, 1.1) and own[5] == SETS_PLATT[5]
    # b ≤ 0 перевернул бы порядок вероятностей — такая запись не берется
    assert sets_calibration_of({"3": {"a": 0.1, "b": 0}})[3] == SETS_PLATT[3]
    assert sets_calibration_of({"3": [0.1, 1.1]})[3] == SETS_PLATT[3]
    stored = sets_calibration_json(SETS_PLATT)
    assert stored == {"3": {"a": 0.179, "b": 0.921}, "5": {"a": 0.554, "b": 1.325}}
    assert sets_calibration_of(stored) == SETS_PLATT


def test_market_probs() -> None:
    probs = market_probs(0.7, 0.45, 0.1)
    assert probs == {
        (MARKET_ML, 1): 0.7,
        (MARKET_ML, 2): pytest.approx(0.3),
        (MARKET_MINUS, 1): 0.45,
        (MARKET_MINUS, 2): 0.1,
        (MARKET_PLUS, 1): pytest.approx(0.9),
        (MARKET_PLUS, 2): pytest.approx(0.55),
    }
    # Исходы каждого рынка: (−1.5 у П1) + (+1.5 у П2) = 1
    assert probs[(MARKET_MINUS, 1)] + probs[(MARKET_PLUS, 2)] == pytest.approx(1.0)
    assert probs[(MARKET_MINUS, 2)] + probs[(MARKET_PLUS, 1)] == pytest.approx(1.0)
    triple = Probs3(0.7, 0.45, 0.1)
    assert triple.markets() == probs
    assert triple.as_dict() == {"p1_win": 0.7, "p1_cover": 0.45, "p2_cover": 0.1}


# --- счет по сетам и исход ноги ---


def test_parse_sets_and_score_for_side() -> None:
    # Разбор счета архива — тот же, что был в досье (app/services/dossier.py)
    assert parse_sets("6-4 3-6 7-6(5)") == [(6, 4, ""), (3, 6, ""), (7, 6, "(5)")]
    assert parse_sets("6-3 [10-8]") == [(6, 3, ""), (10, 8, "")]
    assert parse_sets("6-4 3-2 RET") == [(6, 4, ""), (3, 2, "")]
    assert parse_sets("W/O") == [] and parse_sets(None) == []
    assert score_for("6-4 3-6 7-6(5)", True) == "6-4 3-6 7-6(5)"
    assert score_for("6-4 3-6 7-6(5) RET", False) == "4-6 6-3 6-7(5) RET"
    assert score_for("6-3 [10-8]", False) == "3-6 [8-10]"
    assert score_for(None, False) is None


@pytest.mark.parametrize(
    ("text", "best_of", "expected"),
    [
        ("2:0", 3, SetCount(2, 0)),
        ("1-2", 3, SetCount(1, 2)),
        (" 2 : 1 ", 3, SetCount(2, 1)),
        ("21", 3, SetCount(2, 1)),
        ("3:2", 5, SetCount(3, 2)),
        ("0–3", 5, SetCount(0, 3)),
        ("2:1", 5, None),  # до трех побед — неполный
        ("3:0", 3, None),
        ("2:2", 3, None),
        ("1:1", None, None),
        ("3:1", None, SetCount(3, 1)),
        ("2:0", None, SetCount(2, 0)),
        ("6-4", 3, None),
        ("", 3, None),
        (None, 3, None),
    ],
)
def test_parse_set_count(text: str | None, best_of: int | None, expected: SetCount | None) -> None:
    assert parse_set_count(text, best_of) == expected


def test_wins_needed_and_infer() -> None:
    assert wins_needed(3) == 2 and wins_needed(5) == 3
    with pytest.raises(ValueError):
        wins_needed(4)
    assert infer_best_of(SetCount(3, 1)) == 5
    assert infer_best_of(SetCount(0, 2)) == 3
    assert infer_best_of(SetCount(2, 2)) is None
    assert infer_best_of(SetCount(1, 1)) is None
    assert SetCount(2, 1).swapped() == SetCount(1, 2) and SetCount(2, 1).text() == "2:1"


# Исход ноги по счету (сеты игрока 1 : игрока 2): все шесть исходов при обоих форматах
LEG_CASES = [
    # best_of = 3
    (3, "2:0", {("ML", 1): "win", ("ML", 2): "loss", ("HCP_-1.5", 1): "win",
                ("HCP_-1.5", 2): "loss", ("HCP_+1.5", 1): "win", ("HCP_+1.5", 2): "loss"}),
    (3, "2:1", {("ML", 1): "win", ("ML", 2): "loss", ("HCP_-1.5", 1): "loss",
                ("HCP_-1.5", 2): "loss", ("HCP_+1.5", 1): "win", ("HCP_+1.5", 2): "win"}),
    (3, "1:2", {("ML", 1): "loss", ("ML", 2): "win", ("HCP_-1.5", 1): "loss",
                ("HCP_-1.5", 2): "loss", ("HCP_+1.5", 1): "win", ("HCP_+1.5", 2): "win"}),
    (3, "0:2", {("ML", 1): "loss", ("ML", 2): "win", ("HCP_-1.5", 1): "loss",
                ("HCP_-1.5", 2): "win", ("HCP_+1.5", 1): "loss", ("HCP_+1.5", 2): "win"}),
    # best_of = 5: фора −1.5 — 3:0 и 3:1
    (5, "3:0", {("ML", 1): "win", ("HCP_-1.5", 1): "win", ("HCP_+1.5", 2): "loss"}),
    (5, "3:1", {("ML", 1): "win", ("HCP_-1.5", 1): "win", ("HCP_+1.5", 2): "loss",
                ("HCP_-1.5", 2): "loss"}),
    (5, "3:2", {("ML", 1): "win", ("HCP_-1.5", 1): "loss", ("HCP_+1.5", 2): "win",
                ("HCP_+1.5", 1): "win"}),
    (5, "2:3", {("ML", 2): "win", ("HCP_-1.5", 2): "loss", ("HCP_+1.5", 1): "win"}),
    (5, "1:3", {("ML", 2): "win", ("HCP_-1.5", 2): "win", ("HCP_+1.5", 1): "loss"}),
]  # fmt: skip


@pytest.mark.parametrize(("best_of", "score", "expected"), LEG_CASES)
def test_leg_result_by_score(
    best_of: int, score: str, expected: dict[tuple[str, int], str]
) -> None:
    count = parse_set_count(score, best_of)
    assert count is not None
    for (market, selection), result in expected.items():
        assert leg_result(market, selection, count, best_of) == result, (market, selection)


def test_leg_result_incomplete_and_bad_input() -> None:
    assert leg_result(MARKET_ML, 1, SetCount(1, 1), 3) is None
    assert leg_result(MARKET_MINUS, 1, SetCount(2, 1), 5) is None
    with pytest.raises(ValueError):
        leg_result("TOTAL", 1, SetCount(2, 0), 3)
    with pytest.raises(ValueError):
        leg_result(MARKET_ML, 3, SetCount(2, 0), 3)


def test_set_count_from_archive_score() -> None:
    # Счет архива — со стороны победителя
    assert set_count_from_score("6-4 3-6 7-6(5)", winner_is_first=True) == SetCount(2, 1)
    assert set_count_from_score("6-4 3-6 7-6(5)", winner_is_first=False) == SetCount(1, 2)
    assert set_count_from_score("6-3 6-4 6-2", winner_is_first=True) == SetCount(3, 0)


def _finished(market: str, selection: int, *, winner_is_p1: bool, score: str | None) -> LegOutcome:
    return match_leg_outcome(
        market, selection, status="finished", winner_is_p1=winner_is_p1, score=score, best_of=3
    )


def test_match_leg_outcome() -> None:
    assert _finished(MARKET_MINUS, 1, winner_is_p1=True, score="6-4 6-3") == LegOutcome("win")
    assert _finished(MARKET_MINUS, 2, winner_is_p1=True, score="6-4 3-6 6-3") == LegOutcome("loss")
    assert _finished(MARKET_PLUS, 2, winner_is_p1=True, score="6-4 3-6 6-3") == LegOutcome("win")
    # Игрок 2 выиграл: счет архива со стороны победителя
    assert _finished(MARKET_MINUS, 2, winner_is_p1=False, score="6-1 6-2") == LegOutcome("win")
    # Формат неизвестен — по полному счету
    unknown = match_leg_outcome(
        MARKET_MINUS,
        1,
        status="finished",
        winner_is_p1=True,
        score="6-4 4-6 6-3 6-4",
        best_of=None,
    )
    assert unknown == LegOutcome("win")
    # Отказ и снятие — выбор участника (В16)
    walkover = match_leg_outcome(
        MARKET_ML, 1, status="walkover", winner_is_p1=True, score="W/O", best_of=3
    )
    assert walkover == LegOutcome(None, OUTCOME_WALKOVER)
    retired = match_leg_outcome(
        MARKET_ML, 1, status="retired", winner_is_p1=True, score="6-4 2-1 RET", best_of=3
    )
    assert retired == LegOutcome(None, OUTCOME_RETIRED)
    scheduled = match_leg_outcome(
        MARKET_ML, 1, status="scheduled", winner_is_p1=None, score=None, best_of=3
    )
    assert scheduled == LegOutcome(None, OUTCOME_NO_RESULT)
    # Счета нет: у ML хватает победителя, у форы — нет
    assert _finished(MARKET_ML, 2, winner_is_p1=True, score=None) == LegOutcome("loss")
    no_score = _finished(MARKET_PLUS, 1, winner_is_p1=True, score=None)
    assert no_score == LegOutcome(None, OUTCOME_INCOMPLETE)


def test_score_outcomes_table() -> None:
    """Таблица «счет → исход» для окна расчета совпадает с leg_result по каждому полному
    счету; формат неизвестен — счета обоих форматов."""
    assert score_outcomes("HCP_+1.5", 2, 3) == {
        "2:0": "loss",
        "2:1": "win",
        "1:2": "win",
        "0:2": "win",
    }
    both = score_outcomes("ML", 1, None)
    assert len(both) == 10 and both["3:2"] == "win" and both["1:2"] == "loss"
    for market in ("ML", "HCP_-1.5", "HCP_+1.5"):
        for selection in (1, 2):
            for best_of in (3, 5):
                table = score_outcomes(market, selection, best_of)
                assert len(table) == 2 * wins_needed(best_of)
                for text, result in table.items():
                    count = parse_set_count(text, best_of)
                    assert count is not None
                    assert leg_result(market, selection, count, best_of) == result
