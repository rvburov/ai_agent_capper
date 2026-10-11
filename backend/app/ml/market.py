"""Вероятности рынка без маржи (LLM_LEARNING.md, 3.2).

Во всем проекте маржа снимается одним методом — степенным: ищется показатель k, при
котором Σ(1/o_i)^k = 1, и q_i = (1/o_i)^k. В отличие от пропорционального метода он
снимает больше маржи с аутсайдера, чем с фаворита: так учитывается перекос
«фаворит — аутсайдер» (favorite–longshot bias). Пропорциональный метод здесь только
для справки и тестов.

Сумма 1/o_i бывает и меньше 1 (например, у максимума кэфов по рынку): тогда k < 1,
и метод так же дает вероятности с суммой 1.

Эталон рынка для события (pick_reference) — первый букмекер по порядку, у которого есть
кэфы обеих сторон. Порядок проекта REFERENCE_ORDER: Pinnacle (острая линия), биржа
Betfair (маржа минимальна), среднее по рынку. Запасные нужны потому, что в tennis-data
2026 года кэфы Pinnacle есть только у 3% строк.
"""

import math
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import TypeGuard

import numpy as np
import numpy.typing as npt

from app.core.i18n import t

FloatArray = npt.NDArray[np.float64]
OddsValue = float | Decimal
# Кэфы обеих сторон у одного букмекера; None — кэфа нет
OddsPair = tuple[OddsValue | None, OddsValue | None]

# Эталон рынка по порядку: острая линия → биржа → среднее по рынку (коды букмекеров
# odds_snapshots.bookmaker)
REFERENCE_ORDER: tuple[str, ...] = ("pinnacle", "betfair_ex", "avg")

# Точность показателя k при бисекции
POWER_TOLERANCE = 1e-12
_MAX_ITERATIONS = 200


def _odds_matrix(odds: npt.ArrayLike) -> FloatArray:
    """Кэфы как матрица (рынков × исходов). Каждый кэф конечен и больше 1."""
    matrix = np.asarray(odds, dtype=np.float64)
    if matrix.ndim == 1:
        matrix = matrix[np.newaxis, :]
    if matrix.ndim != 2 or matrix.shape[1] < 2:
        size = matrix.shape[-1] if matrix.ndim else 0
        raise ValueError(t("ml.market.too_few", n=size))
    bad = ~np.isfinite(matrix) | (matrix <= 1.0)
    if bad.any():
        raise ValueError(t("ml.market.bad_odds", odds=matrix[bad][0]))
    return matrix


def _row(odds: Sequence[OddsValue]) -> FloatArray:
    return _odds_matrix([float(value) for value in odds])


def implied(odds: Sequence[OddsValue]) -> list[float]:
    """Вероятности «как есть»: 1/o_i, с маржой."""
    return [float(value) for value in 1.0 / _row(odds)[0]]


def overround(odds: Sequence[OddsValue]) -> float:
    """Маржа рынка: Σ1/o_i − 1. Для 1.17 / 5.10 — 0,0508 (5,1%)."""
    return float((1.0 / _row(odds)).sum() - 1.0)


def devig_proportional(odds: Sequence[OddsValue]) -> list[float]:
    """Пропорциональный метод: q_i = (1/o_i) / Σ(1/o_j). Только для справки:
    1.17 / 5.10 → 0,813 / 0,187."""
    inverse = 1.0 / _row(odds)[0]
    return [float(value) for value in inverse / inverse.sum()]


def power_exponents(odds: npt.ArrayLike) -> FloatArray:
    """Показатель k степенного метода для каждого рынка (строки матрицы кэфов).

    f(k) = Σ(1/o_i)^k − 1 строго убывает: f(0) = n − 1 > 0, а при k → ∞ стремится
    к −1. Поэтому корень один, и бисекция находит его для всех рынков сразу.
    """
    inverse = 1.0 / _odds_matrix(odds)

    def excess(k: FloatArray) -> FloatArray:
        result: FloatArray = (inverse ** k[:, np.newaxis]).sum(axis=1) - 1.0
        return result

    low = np.zeros(inverse.shape[0])
    high = np.ones(inverse.shape[0])
    # Верхняя граница: удваиваем, пока сумма не станет меньше 1
    for _ in range(_MAX_ITERATIONS):
        above = excess(high) > 0
        if not above.any():
            break
        low = np.where(above, high, low)
        high = np.where(above, high * 2.0, high)
    for _ in range(_MAX_ITERATIONS):
        middle = (low + high) / 2.0
        above = excess(middle) > 0
        low = np.where(above, middle, low)
        high = np.where(above, high, middle)
        if float((high - low).max()) <= POWER_TOLERANCE:
            break
    exponents: FloatArray = (low + high) / 2.0
    return exponents


def devig_power_matrix(odds: npt.ArrayLike) -> FloatArray:
    """Степенной метод для многих рынков сразу: матрица кэфов (рынков × исходов) →
    матрица вероятностей без маржи, сумма по строке равна 1."""
    inverse = 1.0 / _odds_matrix(odds)
    powered = inverse ** power_exponents(odds)[:, np.newaxis]
    # После бисекции сумма отличается от 1 на ~1e-12; нормировка делает ее точной
    result: FloatArray = powered / powered.sum(axis=1, keepdims=True)
    return result


def devig_power(odds: Sequence[OddsValue]) -> list[float]:
    """Вероятности исходов без маржи степенным методом (единый метод проекта)."""
    return [float(value) for value in devig_power_matrix(_row(odds))[0]]


def devig_pair(odds1: OddsValue, odds2: OddsValue) -> float:
    """Вероятность первого исхода рынка из двух исходов (победа в матче)."""
    return devig_power([odds1, odds2])[0]


def usable_odds(value: OddsValue | None) -> TypeGuard[OddsValue]:
    """Кэф годится для расчета: есть, конечный и больше 1."""
    if value is None:
        return False
    finite = value.is_finite() if isinstance(value, Decimal) else math.isfinite(value)
    return finite and value > 1


def reference_odds(
    odds_by_bookmaker: Mapping[str, OddsPair], order: Sequence[str]
) -> tuple[str, tuple[OddsValue, OddsValue]] | None:
    """Эталон рынка для события: первый букмекер из order, у которого годны кэфы обеих
    сторон, и эти кэфы. None — ни у одного букмекера из order пары кэфов нет.

    Отдельно от pick_reference — для бэктеста: он выбирает эталон для тысяч событий, а
    маржу снимает одной матрицей (devig_power_matrix).

    Строка вместо списка — ошибка (TypeError): str — тоже Sequence[str], и mypy ее
    пропустит, а цикл пошел бы по буквам, и эталон тихо пропал бы у всех событий."""
    if isinstance(order, str):
        raise TypeError(t("ml.market.order_is_string", order=order))
    for bookmaker in order:
        pair = odds_by_bookmaker.get(bookmaker)
        if pair is None:
            continue
        odds1, odds2 = pair
        if usable_odds(odds1) and usable_odds(odds2):
            return bookmaker, (odds1, odds2)
    return None


def pick_reference(
    odds_by_bookmaker: Mapping[str, OddsPair], order: Sequence[str]
) -> tuple[str, tuple[float, float]] | None:
    """Букмекер-эталон события (reference_odds) и вероятности сторон без маржи
    степенным методом. Принимает и пары без None: Mapping[str, tuple[Decimal, Decimal]]."""
    found = reference_odds(odds_by_bookmaker, order)
    if found is None:
        return None
    bookmaker, (odds1, odds2) = found
    q1, q2 = devig_power([odds1, odds2])
    return bookmaker, (q1, q2)
