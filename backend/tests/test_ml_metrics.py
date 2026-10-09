"""Метрики (app/ml/metrics.py) против ручного расчета."""

import math

import numpy as np
import pytest

from app.ml.metrics import (
    COIN_BRIER,
    COIN_LOG_LOSS,
    EPS,
    bootstrap_diff_ci,
    bootstrap_mean_ci,
    brier,
    brier_losses,
    brier_skill_score,
    calibration_table,
    clip_probabilities,
    ece,
    log_loss,
    log_losses,
    roi_with_ci,
    wilson_interval,
)

P = [0.9, 0.2, 0.6, 0.5]
Y = [1, 0, 0, 1]


def test_log_loss_and_brier_by_hand() -> None:
    expected_ll = -(math.log(0.9) + math.log(0.8) + math.log(0.4) + math.log(0.5)) / 4
    assert log_loss(P, Y) == pytest.approx(expected_ll)
    assert brier(P, Y) == pytest.approx((0.01 + 0.04 + 0.36 + 0.25) / 4)
    assert log_losses(P, Y)[0] == pytest.approx(-math.log(0.9))
    assert brier_losses(P, Y)[2] == pytest.approx(0.36)
    assert log_loss([0.5] * 10, [1, 0] * 5) == pytest.approx(COIN_LOG_LOSS)
    assert brier([0.5] * 10, [1, 0] * 5) == pytest.approx(COIN_BRIER)
    assert brier_skill_score(0.2, 0.25) == pytest.approx(0.2)


def test_probabilities_are_clipped() -> None:
    """p = 0 при исходе 1 дает конечный лог-лосс −ln(1e-6), а не бесконечность."""
    assert log_loss([0.0], [1]) == pytest.approx(-math.log(EPS))
    assert log_loss([1.0], [1]) == pytest.approx(-math.log(1 - EPS))
    assert clip_probabilities([0.0, 1.0]).tolist() == [EPS, 1 - EPS]


@pytest.mark.parametrize(
    ("p", "y"),
    [([1.2], [1]), ([-0.1], [0]), ([float("nan")], [1]), ([0.5], [2]), ([0.5, 0.5], [1]), ([], [])],
)
def test_bad_inputs(p: list[float], y: list[int]) -> None:
    with pytest.raises(ValueError):
        log_loss(p, y)


def test_ece_by_hand() -> None:
    # Корзина [0,60; 0,65): p 0,60 и 0,62, сбылось 1 из 2 → |0,61 − 0,5| = 0,11
    # Корзина [0,90; 0,95): p 0,90, сбылось → |0,90 − 1| = 0,10
    p = [0.60, 0.62, 0.90]
    y = [1, 0, 1]
    assert ece(p, y) == pytest.approx((2 * 0.11 + 1 * 0.10) / 3)
    # Идеально откалиброванные корзины
    assert ece([0.5, 0.5], [1, 0]) == pytest.approx(0.0)


def test_calibration_table_bins_and_wilson() -> None:
    p = [0.70] * 10 + [0.12, 0.13]
    y = [1] * 8 + [0] * 2 + [0, 1]
    table = calibration_table(p, y)
    assert [(item.low, item.high, item.n) for item in table] == [
        (0.10, 0.15, 2),
        (0.70, 0.75, 10),
    ]
    top = table[1]
    assert top.mean_p == pytest.approx(0.70)
    assert top.rate == pytest.approx(0.8)
    # Интервал Уилсона для 8 из 10 — 0,490…0,943
    assert top.ci_low == pytest.approx(0.4902, abs=1e-4)
    assert top.ci_high == pytest.approx(0.9433, abs=1e-4)


def test_wilson_interval() -> None:
    assert wilson_interval(0, 0) == (0.0, 1.0)
    low, high = wilson_interval(0, 10)
    assert low == 0.0 and high == pytest.approx(0.2775, abs=1e-4)
    low, high = wilson_interval(50, 100)
    assert low == pytest.approx(0.4038, abs=1e-4) and high == pytest.approx(0.5962, abs=1e-4)


def test_bootstrap_is_deterministic_and_covers_mean() -> None:
    values = np.random.default_rng(1).normal(0.3, 1.0, 500)
    first = bootstrap_mean_ci(values, n=2000, seed=42)
    second = bootstrap_mean_ci(values, n=2000, seed=42)
    other = bootstrap_mean_ci(values, n=2000, seed=43)
    assert first == second
    assert first != other
    assert first.value == pytest.approx(float(values.mean()))
    assert first.low < first.value < first.high
    # Ширина ≈ 2 × 1,96 × σ / √n
    assert first.high - first.low == pytest.approx(2 * 1.96 / math.sqrt(500), rel=0.15)
    assert first.n == 500
    with pytest.raises(ValueError):
        bootstrap_mean_ci([], n=10)


def test_paired_difference() -> None:
    """Парная разница: общий шум событий сокращается, интервал узкий и выше нуля."""
    rng = np.random.default_rng(5)
    shared = rng.normal(0.0, 1.0, 400)
    a = shared + 0.05 + rng.normal(0.0, 0.01, 400)
    b = shared
    diff = bootstrap_diff_ci(a, b, n=2000, seed=1)
    assert diff.value == pytest.approx(0.05, abs=0.005)
    assert 0 < diff.low < diff.value < diff.high < 0.1
    with pytest.raises(ValueError):
        bootstrap_diff_ci([1.0, 2.0], [1.0], n=10)


def test_roi_by_hand() -> None:
    # Три ставки по 1: выигрыш с кэфом 2,0, проигрыш, выигрыш с кэфом 1,5
    roi = roi_with_ci([1, 1, 1], [2.0, 0.0, 1.5], n=1000, seed=3)
    assert roi.bets == 3
    assert roi.staked == 3.0 and roi.returned == 3.5
    assert roi.profit == pytest.approx(0.5)
    assert roi.roi == pytest.approx(0.5 / 3)
    assert roi.low is not None and roi.high is not None and roi.roi is not None
    assert -1.0 <= roi.low <= roi.roi <= roi.high
    assert roi_with_ci([1, 1, 1], [2.0, 0.0, 1.5], n=1000, seed=3) == roi
    empty = roi_with_ci([], [])
    assert empty.bets == 0 and empty.roi is None and empty.low is None
    with pytest.raises(ValueError):
        roi_with_ci([0.0], [1.0])
    with pytest.raises(ValueError):
        roi_with_ci([1.0], [-1.0])
