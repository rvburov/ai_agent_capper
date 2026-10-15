"""Правила сравнения версий на eval-наборе (этап 5, волна 3; LLM_LEARNING.md 3.4,
TOKEN_ECONOMY.md 2.4) — эталонные расчеты на фикстуре: d = loss_new − loss_old по
событиям, ДИ блочного по дням бутстрэпа с seed, решение кода по правилам «улучшение» и
«экономия не хуже»."""

import math
from datetime import date, timedelta

import numpy as np
import pytest

from app.ml import eval_compare
from app.ml.eval_compare import EventResult, RunResult, compare, noise_level
from app.ml.metrics import (
    block_bootstrap_diff_ci,
    block_bootstrap_ece_diff,
    block_bootstrap_mean_ci,
    bootstrap_mean_ci,
)

DAY = date(2026, 8, 1)


def _run(
    probs: list[float],
    ys: list[int],
    *,
    per_day: int = 3,
    fmt: int = 0,
    cost: float | None = 0.02,
    tokens: float | None = 9000.0,
    decisions: list[frozenset[str]] | None = None,
) -> RunResult:
    events = {
        index: EventResult(
            day=DAY + timedelta(days=index // per_day),
            y=y,
            p=p,
            decisions=decisions[index] if decisions else frozenset({"ML:1"} if p >= 0.65 else ()),
        )
        for index, (p, y) in enumerate(zip(probs, ys, strict=True))
    }
    return RunResult(events=events, format_errors=fmt, cost_per_event=cost, tokens_per_event=tokens)


def _fixture(n: int = 240, seed: int = 5) -> tuple[list[float], list[int]]:
    rng = np.random.default_rng(seed)
    p = rng.uniform(0.2, 0.85, n)
    y = (rng.random(n) < p).astype(int)
    return [float(value) for value in p], [int(value) for value in y]


def _ll(p: float, y: int) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return -(y * math.log(p) + (1 - y) * math.log(1 - p))


def test_reference_difference_is_new_minus_old() -> None:
    """Эталон: d — среднее (loss_new − loss_old) по общим событиям, считается вручную."""
    base_p, ys = _fixture()
    sharper = [min(0.99, max(0.01, 0.5 + (p - 0.5) * 1.2)) for p in base_p]
    result = compare(_run(base_p, ys), _run(sharper, ys), rule="improve", bootstrap=2000)
    expected = sum(
        _ll(b, y) - _ll(a, y) for a, b, y in zip(base_p, sharper, ys, strict=True)
    ) / len(ys)
    assert result.log_loss.estimate is not None
    assert result.log_loss.estimate.value == pytest.approx(expected, abs=1e-12)
    assert result.log_loss.a == pytest.approx(
        sum(_ll(p, y) for p, y in zip(base_p, ys, strict=True)) / len(ys)
    )
    assert result.n == len(ys) and result.seed == eval_compare.SEED
    # Брайер и ECE — тоже кандидат минус база
    brier_expected = sum(
        (b - y) ** 2 - (a - y) ** 2 for a, b, y in zip(base_p, sharper, ys, strict=True)
    ) / len(ys)
    assert result.brier.estimate is not None
    assert result.brier.estimate.value == pytest.approx(brier_expected, abs=1e-12)


def test_bootstrap_is_deterministic_by_seed_and_blocks_by_day() -> None:
    base_p, ys = _fixture()
    worse = [min(0.99, max(0.01, p + 0.08)) for p in base_p]
    one = compare(_run(base_p, ys), _run(worse, ys), rule="improve", bootstrap=2000, seed=11)
    two = compare(_run(base_p, ys), _run(worse, ys), rule="improve", bootstrap=2000, seed=11)
    other = compare(_run(base_p, ys), _run(worse, ys), rule="improve", bootstrap=2000, seed=12)
    assert one.to_json() == two.to_json()
    assert one.log_loss.estimate != other.log_loss.estimate
    # Блоки — дни: если все события одного дня одинаковы, блочный бутстрэп по дням дает
    # шире интервал, чем по событиям (события одного дня коррелированы)
    values = np.repeat(np.random.default_rng(3).normal(0, 1, 40), 6)
    days = np.repeat(np.arange(40), 6)
    block = block_bootstrap_mean_ci(values, days, n=4000, seed=1)
    plain = bootstrap_mean_ci(values, n=4000, seed=1)
    assert block.high - block.low > 1.8 * (plain.high - plain.low)
    assert block.value == pytest.approx(plain.value)
    with pytest.raises(ValueError):
        block_bootstrap_diff_ci([1.0, 2.0], [1.0], [0, 1])


def test_improve_rule() -> None:
    base_p, ys = _fixture(n=300, seed=9)
    # Кандидат знает исход чуть лучше — ДИ разницы целиком ниже нуля
    better = [
        min(0.97, p + 0.12) if y else max(0.03, p - 0.12) for p, y in zip(base_p, ys, strict=True)
    ]
    good = compare(_run(base_p, ys), _run(better, ys), rule="improve", bootstrap=2000)
    assert good.passed and good.verdict == "better"
    assert good.log_loss.estimate is not None and good.log_loss.estimate.high < 0
    # Та же версия — в пределах шума, не включается
    same = compare(_run(base_p, ys), _run(base_p, ys), rule="improve", bootstrap=2000)
    assert not same.passed and same.verdict == "noise"
    # Хуже — ДИ целиком выше нуля
    worse = [
        max(0.03, p - 0.12) if y else min(0.97, p + 0.12) for p, y in zip(base_p, ys, strict=True)
    ]
    bad = compare(_run(base_p, ys), _run(worse, ys), rule="improve", bootstrap=2000)
    assert not bad.passed and bad.verdict == "worse"
    # Лучше, но ошибок формата больше — не проходит
    broken = compare(_run(base_p, ys), _run(better, ys, fmt=2), rule="improve", bootstrap=2000)
    assert not broken.passed and broken.format_errors == (0, 2, False)


def test_non_inferior_rule() -> None:
    base_p, ys = _fixture(n=300, seed=21)
    tiny = [min(0.99, max(0.01, p + 0.005)) for p in base_p]
    cheaper = compare(
        _run(base_p, ys, cost=0.02, tokens=9000),
        _run(tiny, ys, cost=0.014, tokens=6200),
        rule="non_inferior",
        bootstrap=2000,
    )
    assert cheaper.passed and cheaper.verdict == "not_worse"
    assert cheaper.log_loss.margin == eval_compare.LOG_LOSS_MARGIN
    assert cheaper.log_loss.estimate is not None
    assert cheaper.log_loss.estimate.high <= eval_compare.LOG_LOSS_MARGIN
    assert cheaper.cost[2] == pytest.approx(0.014 / 0.02 - 1)
    assert cheaper.tokens[3] is True
    # Не дешевле — правило экономии не выполнено, хотя качество не хуже
    same_cost = compare(_run(base_p, ys), _run(tiny, ys), rule="non_inferior", bootstrap=2000)
    assert not same_cost.passed and same_cost.cost[3] is False
    # Дешевле, но заметно хуже — верхняя граница ДИ выше допуска
    worse = [
        max(0.02, p - 0.2) if y else min(0.98, p + 0.2) for p, y in zip(base_p, ys, strict=True)
    ]
    bad = compare(_run(base_p, ys), _run(worse, ys, cost=0.01), rule="non_inferior", bootstrap=2000)
    assert not bad.passed and bad.verdict == "failed" and bad.log_loss.ok is False
    with pytest.raises(ValueError):
        compare(_run(base_p, ys), _run(tiny, ys), rule="other")


def test_agreement_against_noise_threshold() -> None:
    base_p, ys = _fixture(n=60)
    n = len(ys)
    decisions_a = [frozenset({"ML:1"}) for _ in range(n)]
    decisions_noise = [frozenset({"ML:1"}) if i % 10 else frozenset() for i in range(n)]
    decisions_b = [frozenset({"ML:1"}) if i % 2 else frozenset() for i in range(n)]
    base = _run(base_p, ys, decisions=decisions_a)
    noise = _run([p + 0.01 for p in base_p], ys, decisions=decisions_noise)
    cand = _run([p + 0.05 for p in base_p], ys, decisions=decisions_b)
    result = compare(base, cand, rule="non_inferior", noise=noise, bootstrap=500)
    agreement = result.agreement
    assert agreement["value"] == pytest.approx(0.5)
    assert agreement["noise_value"] == pytest.approx(0.9)
    assert agreement["mean_abs_dp"] == pytest.approx(0.05)
    assert agreement["noise_abs_dp"] == pytest.approx(0.01)
    # Расхождение 50% против шума 10%: больше 1,5 × шума
    assert agreement["ok"] is False
    no_noise = compare(base, cand, rule="non_inferior", bootstrap=500)
    assert no_noise.agreement["ok"] is None
    assert noise_level(base, base) == 0.0
    assert noise_level(base, _run([], [])) is None


def test_ece_difference_interval() -> None:
    base_p, ys = _fixture(n=200, seed=4)
    days = [index // 4 for index in range(len(ys))]
    same = block_bootstrap_ece_diff(base_p, base_p, ys, days, n=300, seed=2)
    assert same.value == 0.0 and same.low == 0.0 and same.high == 0.0
    shifted = [min(0.99, p + 0.15) for p in base_p]
    worse = block_bootstrap_ece_diff(base_p, shifted, ys, days, n=300, seed=2)
    assert worse.value > 0.05 and worse.low > 0
