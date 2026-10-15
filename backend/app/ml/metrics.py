"""Метрики качества вероятностей и денег (LLM_LEARNING.md, 3.1 и 3.4).

Лог-лосс и Brier считаются по отдельным событиям, ROI — по ставкам (экспресс — одна
ставка). Вероятности обрезаются в [1e-6, 1 − 1e-6]: одна «уверенная» ошибка с p = 0
иначе дала бы бесконечный лог-лосс.

Доверительные интервалы — бутстрэп по событиям или ставкам (по умолчанию 10 000
пересэмплирований, перцентили 2,5 и 97,5) с заданным seed: одинаковые данные дают
одинаковые интервалы. Разницу двух прогнозов на одних и тех же событиях сравниваем
парно: пересэмплируются события, а не прогнозы по отдельности. Сравнение версий на
eval-наборе — блочный бутстрэп по дням (события одного дня коррелированы, Т11).

CLV (насколько кэф ставки лучше закрывающего, решение В1, Р24): на экранах — кэф /
закрытие − 1 (просто, но чуть завышен: 1/закрытие с маржой больше вероятности рынка); при
двух сторонах закрытия — еще «без маржи» кэф · q_close − 1, где q_close — вероятность
своего исхода без маржи степенным методом (app/ml/market.py). У экспресса — по всем ногам,
кроме возвратов, и только если закрытие внесено у каждой: Π кэфов / Π закрытий − 1.
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

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
# Пересэмплирование счетчиками значений — если различных значений в 20 раз меньше, чем
# строк (иначе быстрее индексы строк)
_GROUPED_SHARE = 20


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


def _grouped_sums(values: FloatArray, samples: int, seed: int) -> FloatArray | None:
    """Суммы пересэмплирований через счетчики различных значений: число выпадений каждого
    значения в выборке с возвращением — полиномиальное распределение, поэтому вместо
    индексов строк берутся счетчики значений. Распределение то же, работы в n / K раз
    меньше. Различных значений больше n / _GROUPED_SHARE — None (выгоднее индексы)."""
    unique, counts = np.unique(values, return_counts=True)
    if unique.size * _GROUPED_SHARE > values.size:
        return None
    rng = np.random.default_rng(seed)
    sums = np.empty(samples)
    shares = counts / values.size
    step = max(1, min(samples, _BOOTSTRAP_CHUNK // unique.size))
    for start in range(0, samples, step):
        count = min(step, samples - start)
        drawn = rng.multinomial(values.size, shares, size=count)
        sums[start : start + count] = drawn @ unique
    return sums


def bootstrap_mean_ci(
    values: npt.ArrayLike,
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
    grouped: bool = False,
) -> Estimate:
    """Среднее значений и его бутстрэп-интервал (перцентили). grouped — пересэмплировать
    счетчиками различных значений, если их мало (результат события как ординара: кэф − 1
    или −1): тот же бутстрэп, в разы быстрее на тысячах событий, но другая
    последовательность случайных чисел, чем без grouped."""
    array = _as_values(values)
    sums = _grouped_sums(array, n, seed) if grouped else None
    if sums is None:
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


def _block_index(groups: Sequence[object] | npt.ArrayLike) -> tuple[npt.NDArray[np.int64], int]:
    """Номер блока (группы) каждого события и число блоков."""
    keys = np.asarray([str(group) for group in np.asarray(groups, dtype=object).reshape(-1)])
    _, inverse = np.unique(keys, return_inverse=True)
    index = inverse.astype(np.int64).reshape(-1)
    return index, int(index.max()) + 1 if index.size else 0


def block_bootstrap_mean_ci(
    values: npt.ArrayLike,
    groups: Sequence[object] | npt.ArrayLike,
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
) -> Estimate:
    """Среднее значений и интервал блочного бутстрэпа: пересэмплируются блоки (дни)
    целиком, с возвращением, среднее — по всем событиям выбранных блоков. События одного
    дня коррелированы (ноги одного экспресса, один турнир): бутстрэп по событиям дал бы
    обманчиво узкий интервал (TOKEN_ECONOMY.md, 2.4)."""
    array = _as_values(values)
    index, blocks = _block_index(groups)
    if index.size != array.size:
        raise ValueError(t("ml.metrics.shape", n_p=array.size, n_y=index.size))
    sums = np.bincount(index, weights=array, minlength=blocks)
    counts = np.bincount(index, minlength=blocks).astype(np.float64)
    rng = np.random.default_rng(seed)
    means = np.empty(n)
    step = max(1, min(n, _BOOTSTRAP_CHUNK // max(1, blocks)))
    for start in range(0, n, step):
        count = min(step, n - start)
        drawn = rng.integers(0, blocks, size=(count, blocks))
        means[start : start + count] = sums[drawn].sum(axis=1) / counts[drawn].sum(axis=1)
    low, high = _percentiles(means, level)
    return Estimate(value=float(array.mean()), low=low, high=high, n=int(array.size))


def block_bootstrap_diff_ci(
    a: npt.ArrayLike,
    b: npt.ArrayLike,
    groups: Sequence[object] | npt.ArrayLike,
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
) -> Estimate:
    """Парная разница mean(a − b) на одних событиях, блочный бутстрэп по groups."""
    first, second = _as_values(a), _as_values(b)
    if first.size != second.size:
        raise ValueError(t("ml.metrics.shape", n_p=first.size, n_y=second.size))
    return block_bootstrap_mean_ci(first - second, groups, n=n, seed=seed, level=level)


def block_bootstrap_ece_diff(
    p_a: npt.ArrayLike,
    p_b: npt.ArrayLike,
    y: npt.ArrayLike,
    groups: Sequence[object] | npt.ArrayLike,
    *,
    n: int = 2_000,
    seed: int = 0,
    level: float = CI_LEVEL,
    bin_width: float = BIN_WIDTH,
) -> Estimate:
    """Разница ECE(b) − ECE(a) на одних событиях и ее интервал блочного бутстрэпа: точечное
    сравнение ECE на 200–300 событиях шумит на несколько п.п. (TOKEN_ECONOMY.md, 2.4).
    ECE пересчитывается на каждой выборке, поэтому пересэмплирований меньше (n = 2000)."""
    first, outcomes = _pair(p_a, y)
    second, _ = _pair(p_b, y)
    index, blocks = _block_index(groups)
    if index.size != first.size or second.size != first.size:
        raise ValueError(t("ml.metrics.shape", n_p=first.size, n_y=index.size))
    members = [np.flatnonzero(index == block) for block in range(blocks)]
    rng = np.random.default_rng(seed)
    diffs = np.empty(n)
    for number in range(n):
        drawn = rng.integers(0, blocks, size=blocks)
        rows = np.concatenate([members[block] for block in drawn])
        diffs[number] = ece(second[rows], outcomes[rows], bin_width=bin_width) - ece(
            first[rows], outcomes[rows], bin_width=bin_width
        )
    low, high = _percentiles(diffs, level)
    value = ece(second, outcomes, bin_width=bin_width) - ece(first, outcomes, bin_width=bin_width)
    return Estimate(value=value, low=low, high=high, n=int(first.size))


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


def _positive_denominators(values: npt.ArrayLike) -> FloatArray:
    array = _as_values(values)
    if (array <= 0).any():
        raise ValueError(t("ml.metrics.bad_stakes"))
    return array


def bootstrap_ratio_ci(
    numerators: npt.ArrayLike,
    denominators: npt.ArrayLike,
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
) -> Estimate:
    """Отношение сумм Σ числителей / Σ знаменателей и его бутстрэп-интервал по строкам
    (пара «числитель — знаменатель» сохраняется): ROI ставок — прибыль к сумме ставок,
    ROI ординаров экспресса — их результат к числу ног. Знаменатели — больше нуля."""
    top, bottom = _as_values(numerators), _positive_denominators(denominators)
    if top.size != bottom.size:
        raise ValueError(t("ml.metrics.shape", n_p=top.size, n_y=bottom.size))
    top_sums, bottom_sums = _resample_sums([top, bottom], n, seed)
    low, high = _percentiles(top_sums / bottom_sums, level)
    return Estimate(value=float(top.sum() / bottom.sum()), low=low, high=high, n=int(top.size))


@dataclass(frozen=True)
class PairedRatios:
    """Два отношения сумм на одних и тех же строках и их разница first − second."""

    first: Estimate
    second: Estimate
    diff: Estimate


def paired_ratio_ci(
    first: tuple[npt.ArrayLike, npt.ArrayLike],
    second: tuple[npt.ArrayLike, npt.ArrayLike],
    *,
    n: int = BOOTSTRAP_SAMPLES,
    seed: int = 0,
    level: float = CI_LEVEL,
) -> PairedRatios:
    """Два отношения (числитель, знаменатель) по одним и тем же строкам с общими
    пересэмплированиями: решение Р21 — ROI экспрессов (прибыль / сумма) против ROI тех же
    событий ординарами (результат ног / число ног), строка — экспресс. Интервал разницы —
    парный: пересэмплируются экспрессы, а не ноги и ставки по отдельности."""
    columns = [
        _as_values(first[0]),
        _positive_denominators(first[1]),
        _as_values(second[0]),
        _positive_denominators(second[1]),
    ]
    if len({column.size for column in columns}) != 1:
        raise ValueError(t("ml.metrics.shape", n_p=columns[0].size, n_y=columns[2].size))
    a_top, a_bottom, b_top, b_bottom = _resample_sums(columns, n, seed)
    a_ratio, b_ratio = a_top / a_bottom, b_top / b_bottom
    size = int(columns[0].size)

    def estimate(value: float, samples: FloatArray) -> Estimate:
        low, high = _percentiles(samples, level)
        return Estimate(value=value, low=low, high=high, n=size)

    a_value = float(columns[0].sum() / columns[1].sum())
    b_value = float(columns[2].sum() / columns[3].sum())
    return PairedRatios(
        first=estimate(a_value, a_ratio),
        second=estimate(b_value, b_ratio),
        diff=estimate(a_value - b_value, a_ratio - b_ratio),
    )


def rolling_means(
    a: npt.ArrayLike, b: npt.ArrayLike, *, window: int, step: int
) -> list[tuple[int, float, float]]:
    """Скользящие средние двух рядов по окну window с шагом step: (индекс последнего
    элемента окна, среднее a, среднее b). Первое окно кончается на window − 1; ряд
    короче окна — пусто. Так считается скользящий Brier модели и рынка."""
    first, second = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    if first.size != second.size:
        raise ValueError(t("ml.metrics.shape", n_p=first.size, n_y=second.size))
    out: list[tuple[int, float, float]] = []
    for end in range(window - 1, first.size, step):
        start = end - window + 1
        out.append(
            (end, float(first[start : end + 1].mean()), float(second[start : end + 1].mean()))
        )
    return out


# --- CLV ---

OddsLike = Decimal | float | int | str


def _odds(value: OddsLike) -> Decimal:
    """Кэф как Decimal: float — по кратчайшей записи (0.1 + 0.2 не тянет хвост)."""
    number = Decimal(repr(value)) if isinstance(value, float) else Decimal(str(value))
    if not number.is_finite() or number <= 0:
        raise ValueError(t("ml.metrics.bad_odds", odds=value))
    return number


def clv(odds_taken: OddsLike, closing: OddsLike) -> float:
    """CLV ноги: кэф / закрывающий − 1. Больше 0 — взяли кэф лучше закрытия."""
    return float(_odds(odds_taken) / _odds(closing) - 1)


def clv_fair(odds_taken: OddsLike, q_close: float) -> float:
    """CLV ноги без маржи: кэф · q_close − 1 (q_close — вероятность своего исхода по
    закрытию без маржи, обе стороны закрытия)."""
    if not 0.0 <= q_close <= 1.0:
        raise ValueError(t("ml.metrics.bad_probability"))
    return float(_odds(odds_taken)) * q_close - 1.0


def clv_parlay(legs: Sequence[tuple[OddsLike, OddsLike | None]]) -> float | None:
    """CLV экспресса по ногам (кэф, закрывающий) без возвратов: Π кэфов / Π закрытий − 1.
    Закрытия нет хотя бы у одной ноги или ног нет — None."""
    if not legs or any(closing is None for _, closing in legs):
        return None
    taken = math.prod((_odds(odds) for odds, _ in legs), start=Decimal(1))
    closed = math.prod(
        (_odds(closing) for _, closing in legs if closing is not None), start=Decimal(1)
    )
    return float(taken / closed - 1)


def clv_fair_parlay(legs: Sequence[tuple[OddsLike, float | None]]) -> float | None:
    """CLV экспресса без маржи: Π кэфов · Π q_close − 1; нет q_close у ноги — None."""
    if not legs or any(q is None for _, q in legs):
        return None
    value = 1.0
    for odds, q in legs:
        if q is None or not 0.0 <= q <= 1.0:
            raise ValueError(t("ml.metrics.bad_probability"))
        value *= float(_odds(odds)) * q
    return value - 1.0
