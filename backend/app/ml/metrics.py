"""Метрики качества вероятностей и денег (LLM_LEARNING.md, 3.1 и 3.4).

Лог-лосс и Brier считаются по отдельным событиям, ROI — по ставкам (экспресс — одна
ставка). Вероятности обрезаются в [1e-6, 1 − 1e-6]: одна «уверенная» ошибка с p = 0
иначе дала бы бесконечный лог-лосс.

Доверительные интервалы — бутстрэп по событиям или ставкам (по умолчанию 10 000
пересэмплирований, перцентили 2,5 и 97,5) с заданным seed: одинаковые данные дают
одинаковые интервалы. Разницу двух прогнозов на одних и тех же событиях сравниваем
парно: пересэмплируются события, а не прогнозы по отдельности.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from app.core.i18n import t

FloatArray = npt.NDArray[np.float64]

EPS = 1e-6
# Лог-лосс и Brier монетки (p = 0,5 на каждое событие)
COIN_LOG_LOSS = math.log(2.0)
COIN_BRIER = 0.25
BOOTSTRAP_SAMPLES = 10_000
CI_LEVEL = 0.95
# Ширина корзины калибровки: 5 п. п.
BIN_WIDTH = 0.05
# z для 95% интервала Уилсона
Z95 = 1.959963984540054
# Сколько чисел держать в памяти за один шаг бутстрэпа
_BOOTSTRAP_CHUNK = 2_000_000


def clip_probabilities(p: npt.ArrayLike) -> FloatArray:
    """Вероятности как массив, обрезанные в [EPS, 1 − EPS]. Не число или вне [0, 1] —
    ValueError."""
    values = np.asarray(p, dtype=np.float64).reshape(-1)
    if not np.isfinite(values).all() or (values < 0).any() or (values > 1).any():
        raise ValueError(t("ml.metrics.bad_probability"))
    clipped: FloatArray = np.clip(values, EPS, 1.0 - EPS)
    return clipped


def _outcomes(y: npt.ArrayLike, size: int) -> FloatArray:
    values = np.asarray(y, dtype=np.float64).reshape(-1)
    if values.size != size:
        raise ValueError(t("ml.metrics.shape", n_p=size, n_y=values.size))
    if not np.isin(values, (0.0, 1.0)).all():
        raise ValueError(t("ml.metrics.bad_outcome"))
    return values


def _pair(p: npt.ArrayLike, y: npt.ArrayLike) -> tuple[FloatArray, FloatArray]:
    probs = clip_probabilities(p)
    if probs.size == 0:
        raise ValueError(t("ml.metrics.empty"))
    return probs, _outcomes(y, probs.size)


def log_losses(p: npt.ArrayLike, y: npt.ArrayLike) -> FloatArray:
    """Лог-лосс каждого события: −[y·ln p + (1 − y)·ln(1 − p)]."""
    probs, outcomes = _pair(p, y)
    losses: FloatArray = -(outcomes * np.log(probs) + (1.0 - outcomes) * np.log(1.0 - probs))
    return losses


def brier_losses(p: npt.ArrayLike, y: npt.ArrayLike) -> FloatArray:
    """Brier каждого события: (p − y)²."""
    probs, outcomes = _pair(p, y)
    losses: FloatArray = (probs - outcomes) ** 2
    return losses


def log_loss(p: npt.ArrayLike, y: npt.ArrayLike) -> float:
    """Средний лог-лосс. Монетка — 0,693, меньше — лучше."""
    return float(log_losses(p, y).mean())


def brier(p: npt.ArrayLike, y: npt.ArrayLike) -> float:
    """Средний Brier. Монетка — 0,25, меньше — лучше."""
    return float(brier_losses(p, y).mean())


def brier_skill_score(model_brier: float, reference_brier: float) -> float:
    """1 − Brier модели / Brier эталона (рынка): больше 0 — модель лучше рынка."""
    return 1.0 - model_brier / reference_brier


def _bin_index(probs: FloatArray, width: float) -> npt.NDArray[np.int64]:
    """Номер корзины. Поправка 1e-9: 0,70 / 0,05 в плавающей точке дает 13,999…,
    а 0,70 должна попасть в корзину [0,70; 0,75)."""
    bins = math.ceil(1.0 / width - 1e-9)
    index = np.floor(probs / width + 1e-9).astype(np.int64)
    result: npt.NDArray[np.int64] = np.clip(index, 0, bins - 1)
    return result


def ece(p: npt.ArrayLike, y: npt.ArrayLike, *, bin_width: float = BIN_WIDTH) -> float:
    """Ожидаемая ошибка калибровки: Σ_b (n_b / N)·|p̄_b − ȳ_b| по корзинам bin_width."""
    probs, outcomes = _pair(p, y)
    index = _bin_index(probs, bin_width)
    total = 0.0
    for bin_no in np.unique(index):
        mask = index == bin_no
        total += float(mask.sum()) * abs(float(probs[mask].mean()) - float(outcomes[mask].mean()))
    return total / probs.size


def wilson_interval(successes: int, n: int, *, z: float = Z95) -> tuple[float, float]:
    """Интервал Уилсона для доли successes / n (n = 0 — весь отрезок [0, 1])."""
    if n <= 0:
        return 0.0, 1.0
    share = successes / n
    denominator = 1.0 + z * z / n
    center = (share + z * z / (2 * n)) / denominator
    half = z * math.sqrt(share * (1 - share) / n + z * z / (4 * n * n)) / denominator
    return max(0.0, center - half), min(1.0, center + half)


@dataclass(frozen=True)
class CalibrationBin:
    """Корзина калибровки: прогнозы в [low, high), их средняя p, доля сбывшихся и
    95% интервал Уилсона для этой доли."""

    low: float
    high: float
    n: int
    mean_p: float
    rate: float
    ci_low: float
    ci_high: float


def calibration_table(
    p: npt.ArrayLike, y: npt.ArrayLike, *, bin_width: float = BIN_WIDTH, z: float = Z95
) -> list[CalibrationBin]:
    """Таблица калибровки по непустым корзинам ширины bin_width. В корзине нужно от
    30–50 событий, иначе это шум (интервал Уилсона это и показывает)."""
    probs, outcomes = _pair(p, y)
    index = _bin_index(probs, bin_width)
    table: list[CalibrationBin] = []
    for bin_no in np.unique(index):
        mask = index == bin_no
        n = int(mask.sum())
        wins = int(outcomes[mask].sum())
        low, high = wilson_interval(wins, n, z=z)
        table.append(
            CalibrationBin(
                low=round(float(bin_no) * bin_width, 10),
                high=round(min(1.0, float(bin_no + 1) * bin_width), 10),
                n=n,
                mean_p=float(probs[mask].mean()),
                rate=wins / n,
                ci_low=low,
                ci_high=high,
            )
        )
    return table


@dataclass(frozen=True)
class Estimate:
    """Среднее и его бутстрэп-интервал."""

    value: float
    low: float
    high: float
    n: int


def _as_values(values: npt.ArrayLike) -> FloatArray:
    array = np.asarray(values, dtype=np.float64).reshape(-1)
    if array.size == 0:
        raise ValueError(t("ml.metrics.empty"))
    if not np.isfinite(array).all():
        raise ValueError(t("ml.metrics.not_finite"))
    return array


def _resample_sums(columns: Sequence[FloatArray], samples: int, seed: int) -> list[FloatArray]:
    """Суммы каждой колонки по samples пересэмплированиям строк (с возвращением).
    Индексы общие для всех колонок: так сохраняется пара «ставка — выплата»."""
    size = columns[0].size
    rng = np.random.default_rng(seed)
    sums = [np.empty(samples) for _ in columns]
    step = max(1, min(samples, _BOOTSTRAP_CHUNK // size))
    for start in range(0, samples, step):
        count = min(step, samples - start)
        index = rng.integers(0, size, size=(count, size))
        for column, out in zip(columns, sums, strict=True):
            out[start : start + count] = column[index].sum(axis=1)
    return sums


def _percentiles(values: FloatArray, level: float) -> tuple[float, float]:
    tail = (1.0 - level) / 2.0 * 100.0
    low, high = np.percentile(values, [tail, 100.0 - tail])
    return float(low), float(high)


def bootstrap_mean_ci(
    values: npt.ArrayLike,
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
) -> Estimate:
    """Среднее значений и его бутстрэп-интервал (перцентили)."""
    array = _as_values(values)
    (sums,) = _resample_sums([array], n, seed)
    low, high = _percentiles(sums / array.size, level)
    return Estimate(value=float(array.mean()), low=low, high=high, n=int(array.size))


def bootstrap_diff_ci(
    a: npt.ArrayLike,
    b: npt.ArrayLike,
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
) -> Estimate:
    """Парная разница средних mean(a − b) на одних и тех же событиях и ее интервал:
    например, потери модели минус потери рынка. Интервал целиком выше нуля — a хуже."""
    first, second = _as_values(a), _as_values(b)
    if first.size != second.size:
        raise ValueError(t("ml.metrics.shape", n_p=first.size, n_y=second.size))
    return bootstrap_mean_ci(first - second, n=n, seed=seed, level=level)


@dataclass(frozen=True)
class RoiEstimate:
    """ROI ставок: прибыль / оборот и бутстрэп-интервал по ставкам. Без ставок ROI и
    интервала нет (None)."""

    bets: int
    staked: float
    returned: float
    profit: float
    roi: float | None
    low: float | None
    high: float | None


def roi_with_ci(
    stakes: npt.ArrayLike,
    returns: npt.ArrayLike,
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
) -> RoiEstimate:
    """ROI = (Σ выплат − Σ ставок) / Σ ставок. returns — выплата по ставке целиком
    (ставка × кэф при выигрыше, 0 при проигрыше, ставка при возврате)."""
    stake = np.asarray(stakes, dtype=np.float64).reshape(-1)
    paid = np.asarray(returns, dtype=np.float64).reshape(-1)
    if stake.size != paid.size:
        raise ValueError(t("ml.metrics.shape", n_p=stake.size, n_y=paid.size))
    if stake.size == 0:
        return RoiEstimate(0, 0.0, 0.0, 0.0, None, None, None)
    if (
        not (np.isfinite(stake).all() and np.isfinite(paid).all())
        or (stake <= 0).any()
        or (paid < 0).any()
    ):
        raise ValueError(t("ml.metrics.bad_stakes"))
    staked, returned = float(stake.sum()), float(paid.sum())
    stake_sums, paid_sums = _resample_sums([stake, paid], n, seed)
    low, high = _percentiles((paid_sums - stake_sums) / stake_sums, level)
    return RoiEstimate(
        bets=int(stake.size),
        staked=staked,
        returned=returned,
        profit=returned - staked,
        roi=(returned - staked) / staked,
        low=low,
        high=high,
    )
