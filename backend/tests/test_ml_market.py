"""Снятие маржи (app/ml/market.py): степенной метод — единый для проекта,
пропорциональный — только для справки."""

from collections.abc import Mapping
from decimal import Decimal

import numpy as np
import pytest

from app.ml.market import (
    REFERENCE_ORDER,
    OddsPair,
    devig_pair,
    devig_power,
    devig_power_matrix,
    devig_proportional,
    implied,
    overround,
    pick_reference,
    power_exponents,
    reference_odds,
    usable_odds,
)


def test_proportional_example_from_docs() -> None:
    """Пример LLM_LEARNING.md, 3.2: кэфы 1.17 и 5.10."""
    q1, q2 = devig_proportional([1.17, 5.10])
    assert q1 == pytest.approx(0.813, abs=5e-4)
    assert q2 == pytest.approx(0.187, abs=5e-4)
    assert overround([1.17, 5.10]) == pytest.approx(0.0508, abs=1e-4)
    assert implied([Decimal("2.00"), Decimal("4.00")]) == pytest.approx([0.5, 0.25])


@pytest.mark.parametrize(
    "odds",
    [
        [1.17, 5.10],
        [1.90, 1.90],
        [1.01, 25.0],
        [2.10, 3.40, 3.60],
        # Сумма 1/o меньше 1 (максимум по рынку): k < 1
        [2.10, 2.10],
        [Decimal("1.531"), Decimal("2.650")],
    ],
)
def test_power_sums_to_one_and_solves_equation(odds: list[float | Decimal]) -> None:
    q = devig_power(odds)
    assert sum(q) == pytest.approx(1.0, abs=1e-12)
    assert all(0 < value < 1 for value in q)
    k = float(power_exponents([[float(value) for value in odds]])[0])
    total = sum((1.0 / float(value)) ** k for value in odds)
    assert total == pytest.approx(1.0, abs=1e-10)
    if overround(odds) > 0:
        assert k > 1
    else:
        assert k <= 1


def test_power_takes_more_margin_from_longshot() -> None:
    """Степенной метод учитывает перекос «фаворит — аутсайдер»: фаворит получает
    больше вероятности, чем при пропорциональном методе."""
    power = devig_power([1.17, 5.10])
    proportional = devig_proportional([1.17, 5.10])
    assert power[0] > proportional[0]
    assert power[1] < proportional[1]
    # Равные кэфы — равные вероятности
    assert devig_power([1.9, 1.9]) == pytest.approx([0.5, 0.5])


def test_power_is_monotonic() -> None:
    """Чем меньше кэф, тем выше вероятность исхода; при росте кэфа соперника — тоже."""
    q = devig_power([1.5, 2.2, 6.0])
    assert q[0] > q[1] > q[2]
    previous = 0.0
    for other in (1.5, 2.0, 3.0, 5.0, 10.0):
        current = devig_pair(1.5, other)
        assert current > previous
        previous = current


def test_matrix_matches_scalar() -> None:
    odds = np.array([[1.17, 5.10], [1.9, 1.9], [1.45, 2.95], [2.1, 2.1]])
    matrix = devig_power_matrix(odds)
    for row, expected in zip(odds, matrix, strict=True):
        assert devig_power(list(row)) == pytest.approx(list(expected), abs=1e-12)
    assert matrix.sum(axis=1) == pytest.approx(np.ones(4))


@pytest.mark.parametrize(
    "odds",
    [[1.0, 3.0], [0.9, 3.0], [1.5], [], [1.5, float("nan")], [1.5, float("inf")], [2.0, -1.0]],
)
def test_bad_odds_raise(odds: list[float]) -> None:
    with pytest.raises(ValueError):
        devig_power(odds)
    with pytest.raises(ValueError):
        devig_proportional(odds)
    with pytest.raises(ValueError):
        overround(odds)


# --- эталон рынка ---

PINNACLE = (Decimal("1.531"), Decimal("2.650"))
EXCHANGE = (Decimal("1.560"), Decimal("2.700"))
AVERAGE = (Decimal("1.480"), Decimal("2.550"))


def test_reference_order() -> None:
    """Порядок проекта: Pinnacle → биржа → среднее по рынку."""
    assert REFERENCE_ORDER == ("pinnacle", "betfair_ex", "avg")


def test_pick_reference_takes_first_bookmaker_with_both_odds() -> None:
    books: dict[str, OddsPair] = {"pinnacle": PINNACLE, "betfair_ex": EXCHANGE, "avg": AVERAGE}
    found = pick_reference(books, REFERENCE_ORDER)
    assert found is not None
    bookmaker, (q1, q2) = found
    assert bookmaker == "pinnacle"
    assert [q1, q2] == devig_power(list(PINNACLE))
    assert q1 + q2 == pytest.approx(1.0, abs=1e-12)

    # Нет кэфа одной стороны у Pinnacle — биржа; нет и биржи — среднее по рынку
    books["pinnacle"] = (PINNACLE[0], None)
    found = pick_reference(books, REFERENCE_ORDER)
    assert found is not None and found[0] == "betfair_ex"
    assert list(found[1]) == devig_power(list(EXCHANGE))
    del books["betfair_ex"]
    found = pick_reference(books, REFERENCE_ORDER)
    assert found is not None and found[0] == "avg"
    assert list(found[1]) == devig_power(list(AVERAGE))
    # Свой порядок
    full: dict[str, OddsPair] = {"pinnacle": PINNACLE, "avg": AVERAGE}
    found = pick_reference(full, ("avg", "pinnacle"))
    assert found is not None and found[0] == "avg"


@pytest.mark.parametrize(
    "bad",
    [
        (None, Decimal("2.10")),
        (Decimal("1.00"), Decimal("9.00")),
        (Decimal("0.95"), Decimal("2.10")),
        (Decimal("NaN"), Decimal("2.10")),
        (Decimal("1.80"), Decimal("Infinity")),
        (float("nan"), 2.1),
    ],
)
def test_pick_reference_skips_unusable_odds(bad: OddsPair) -> None:
    books: dict[str, OddsPair] = {"pinnacle": bad, "avg": AVERAGE}
    found = pick_reference(books, REFERENCE_ORDER)
    assert found is not None and found[0] == "avg"
    assert reference_odds(books, ("pinnacle",)) is None


def test_pick_reference_none_without_reference() -> None:
    """Букмекеры не из порядка (максимум по рынку, bet365) эталоном не бывают."""
    only_other: Mapping[str, tuple[Decimal, Decimal]] = {
        "max": (Decimal("1.60"), Decimal("2.80")),
        "bet365": (Decimal("1.50"), Decimal("2.60")),
    }
    assert pick_reference(only_other, REFERENCE_ORDER) is None
    assert pick_reference({}, REFERENCE_ORDER) is None
    assert pick_reference({"pinnacle": PINNACLE}, ()) is None


def test_reference_odds_returns_odds_as_given() -> None:
    books: dict[str, OddsPair] = {"betfair_ex": EXCHANGE, "avg": AVERAGE}
    assert reference_odds(books, REFERENCE_ORDER) == ("betfair_ex", EXCHANGE)
    assert usable_odds(Decimal("1.01")) and usable_odds(5.0)
    assert not usable_odds(None) and not usable_odds(1.0) and not usable_odds(Decimal("sNaN"))


@pytest.mark.parametrize("order", ["pinnacle", "pinnacle,betfair_ex", ""])
def test_reference_order_string_is_error(order: str) -> None:
    """Строка — тоже Sequence[str]: без проверки цикл шел бы по буквам и эталон тихо
    пропадал бы (так выйдет, если порядок взять из настроек одной строкой)."""
    books: dict[str, OddsPair] = {"pinnacle": PINNACLE, "avg": AVERAGE}
    with pytest.raises(TypeError, match="список кодов букмекеров"):
        pick_reference(books, order)
    with pytest.raises(TypeError, match="список кодов букмекеров"):
        reference_odds(books, order)
    # Список и кортеж из одного кода — правильный вызов
    assert reference_odds(books, ["pinnacle"]) == ("pinnacle", PINNACLE)
    found = pick_reference(books, ("pinnacle",))
    assert found is not None and found[0] == "pinnacle"
