"""Модель сетов (app/ml/sets.py): формулы, обратная функция, форы и шесть исходов."""

import pytest

from app.ml.sets import (
    MARKET_MINUS,
    MARKET_ML,
    MARKET_PLUS,
    Probs3,
    base_probs,
    cover_prob,
    market_probs,
    match_prob_from_set,
    set_prob_from_match,
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
