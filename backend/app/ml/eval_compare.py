"""Сравнение двух версий инструкций анализа на одних событиях замороженного набора
(этап 5, Т10, Т11; LLM_LEARNING.md, 3.4; TOKEN_ECONOMY.md, 2.4). Только расчет, без базы.

A — база (активная версия), B — кандидат. На каждом событии, где обе версии дали
пригодный ответ, dᵢ = loss_B − loss_A; 95% ДИ среднего d — парный блочный бутстрэп по
дням (B = 10 000, seed в отчете). Правила:

- improve (версия должна улучшить прогноз): ДИ разницы лог-лосса целиком ниже нуля;
- non_inferior (версия ради экономии): верхняя граница ДИ лог-лосса ≤ +0,01, Brier ≤
  +0,005, ECE ≤ +0,02 (2 п.п.), стоимость события по логам ниже.

В обоих правилах ошибок формата, остановок по max_tokens и отказов — каждого не больше,
чем у базы (TOKEN_ECONOMY.md, 2.4 п. 4): два отказа вместо двух ошибок формата — не
«столько же». Совпадение решений с базой — не больше 1,5 × шума
  (расхождения двух прогонов базы): по правилу это повод посмотреть на события, а не
  отказ, поэтому в решение не входит, но показывается.

Решение кода (passed) версию не включает: включает только администратор.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.ml.metrics import (
    BOOTSTRAP_SAMPLES,
    Estimate,
    block_bootstrap_diff_ci,
    block_bootstrap_ece_diff,
    brier_losses,
    ece,
    log_losses,
)

LOG_LOSS_MARGIN = 0.01
BRIER_MARGIN = 0.005
ECE_MARGIN = 0.02
AGREEMENT_FACTOR = 1.5
SEED = 2026
ECE_BOOTSTRAP = 2_000
# ECE версий — по 10 корзинам (TOKEN_ECONOMY.md, 2.4): на 200–300 событиях корзины по
# 5 п.п. почти пусты
ECE_BIN = 0.1
RULES = ("improve", "non_inferior")


@dataclass(frozen=True)
class EventResult:
    """Ответ версии на событие: день матча (блок бутстрэпа), исход для p1 досье, p_claude
    победы p1 и решения по ставкам (исходы с p_final не ниже порога стратегии)."""

    day: date
    y: int
    p: float
    decisions: frozenset[str]


@dataclass(frozen=True)
class RunResult:
    """Итог прогона для сравнения: пригодные ответы по матчам, ошибки формата, остановки
    по max_tokens и отказы (каждое — отдельно), стоимость и токены на событие по логам
    (None — не считали)."""

    events: Mapping[int, EventResult]
    format_errors: int
    cost_per_event: float | None
    tokens_per_event: float | None
    max_tokens: int = 0
    refusals: int = 0


@dataclass(frozen=True)
class Diff:
    a: float | None
    b: float | None
    estimate: Estimate | None
    margin: float | None
    ok: bool | None

    def to_json(self) -> dict[str, Any]:
        est = self.estimate
        return {
            "a": self.a,
            "b": self.b,
            "diff": est.value if est is not None else None,
            "low": est.low if est is not None else None,
            "high": est.high if est is not None else None,
            "margin": self.margin,
            "ok": self.ok,
        }


@dataclass(frozen=True)
class Comparison:
    rule: str
    n: int
    log_loss: Diff
    brier: Diff
    ece: Diff
    format_errors: tuple[int, int, bool]
    max_tokens: tuple[int, int, bool]
    refusals: tuple[int, int, bool]
    cost: tuple[float | None, float | None, float | None, bool | None]
    tokens: tuple[float | None, float | None, float | None, bool | None]
    agreement: dict[str, float | bool | None]
    passed: bool
    verdict: str
    seed: int
    bootstrap: int

    def to_json(self) -> dict[str, Any]:
        def change(raw: tuple[float | None, float | None, float | None, bool | None]) -> Any:
            return {"a": raw[0], "b": raw[1], "change": raw[2], "ok": raw[3]}

        return {
            "rule": self.rule,
            "n": self.n,
            "log_loss": self.log_loss.to_json(),
            "brier": self.brier.to_json(),
            "ece": self.ece.to_json(),
            "format_errors": _count(self.format_errors),
            "max_tokens": _count(self.max_tokens),
            "refusals": _count(self.refusals),
            "cost_per_event": change(self.cost),
            "tokens_per_event": change(self.tokens),
            "agreement": dict(self.agreement),
            "passed": self.passed,
            "verdict": self.verdict,
            "seed": self.seed,
            "bootstrap": self.bootstrap,
        }


def _count(raw: tuple[int, int, bool]) -> dict[str, Any]:
    return {"a": raw[0], "b": raw[1], "ok": raw[2]}


def _mean(values: Sequence[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _change(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or a <= 0:
        return None
    return b / a - 1.0


def _agreement(
    first: Mapping[int, EventResult], second: Mapping[int, EventResult]
) -> tuple[float | None, float | None]:
    """Доля событий с одинаковыми решениями и средняя |Δp| на общих событиях."""
    common = sorted(set(first) & set(second))
    if not common:
        return None, None
    same = sum(1 for key in common if first[key].decisions == second[key].decisions)
    shift = sum(abs(first[key].p - second[key].p) for key in common)
    return same / len(common), shift / len(common)


def compare(
    base: RunResult,
    candidate: RunResult,
    *,
    rule: str,
    noise: RunResult | None = None,
    bootstrap: int = BOOTSTRAP_SAMPLES,
    seed: int = SEED,
) -> Comparison:
    """Сравнение кандидата с базой по правилу rule (improve или non_inferior)."""
    if rule not in RULES:
        raise ValueError(rule)
    keys = sorted(set(base.events) & set(candidate.events))
    days = [base.events[key].day.isoformat() for key in keys]
    y = [base.events[key].y for key in keys]
    p_a = [base.events[key].p for key in keys]
    p_b = [candidate.events[key].p for key in keys]
    loss_diff = brier_diff = ece_diff = None
    ll_a = ll_b = br_a = br_b = None
    if keys:
        ll_first, ll_second = log_losses(p_a, y), log_losses(p_b, y)
        br_first, br_second = brier_losses(p_a, y), brier_losses(p_b, y)
        ll_a, ll_b = float(ll_first.mean()), float(ll_second.mean())
        br_a, br_b = float(br_first.mean()), float(br_second.mean())
        loss_diff = block_bootstrap_diff_ci(ll_second, ll_first, days, n=bootstrap, seed=seed)
        brier_diff = block_bootstrap_diff_ci(br_second, br_first, days, n=bootstrap, seed=seed)
        ece_diff = block_bootstrap_ece_diff(
            p_a, p_b, y, days, n=min(bootstrap, ECE_BOOTSTRAP), seed=seed, bin_width=ECE_BIN
        )
    fmt_ok = candidate.format_errors <= base.format_errors
    max_ok = candidate.max_tokens <= base.max_tokens
    refusals_ok = candidate.refusals <= base.refusals
    counts_ok = fmt_ok and max_ok and refusals_ok
    cost_change = _change(base.cost_per_event, candidate.cost_per_event)
    tokens_change = _change(base.tokens_per_event, candidate.tokens_per_event)
    cost_ok = cost_change < 0 if cost_change is not None else None
    tokens_ok = tokens_change < 0 if tokens_change is not None else None
    value, shift = _agreement(base.events, candidate.events)
    noise_value = noise_shift = None
    if noise is not None:
        noise_value, noise_shift = _agreement(base.events, noise.events)
    agreement_ok: bool | None = None
    if value is not None and noise_value is not None and shift is not None:
        mismatch, noise_mismatch = 1.0 - value, 1.0 - noise_value
        agreement_ok = mismatch <= AGREEMENT_FACTOR * noise_mismatch + 1e-12 and (
            noise_shift is None or shift <= AGREEMENT_FACTOR * noise_shift + 1e-12
        )
    if rule == "improve":
        ll_ok = loss_diff.high < 0 if loss_diff is not None else False
        brier_ok = ece_ok = None
        passed = bool(keys) and ll_ok and counts_ok
        if passed:
            verdict = "better"
        elif loss_diff is not None and loss_diff.low > 0:
            verdict = "worse"
        else:
            verdict = "noise"
        ll_margin: float | None = 0.0
        brier_margin = ece_margin = None
    else:
        ll_ok = loss_diff.high <= LOG_LOSS_MARGIN if loss_diff is not None else False
        brier_ok = brier_diff.high <= BRIER_MARGIN if brier_diff is not None else False
        ece_ok = ece_diff.high <= ECE_MARGIN if ece_diff is not None else False
        passed = bool(keys) and ll_ok and brier_ok and ece_ok and counts_ok and bool(cost_ok)
        verdict = "not_worse" if passed else "failed"
        ll_margin, brier_margin, ece_margin = LOG_LOSS_MARGIN, BRIER_MARGIN, ECE_MARGIN
    ece_a = ece_b = None
    if ece_diff is not None:
        ece_a, ece_b = ece(p_a, y, bin_width=ECE_BIN), ece(p_b, y, bin_width=ECE_BIN)
    return Comparison(
        rule=rule,
        n=len(keys),
        log_loss=Diff(ll_a, ll_b, loss_diff, ll_margin, ll_ok),
        brier=Diff(br_a, br_b, brier_diff, brier_margin, brier_ok),
        ece=Diff(ece_a, ece_b, ece_diff, ece_margin, ece_ok),
        format_errors=(base.format_errors, candidate.format_errors, fmt_ok),
        max_tokens=(base.max_tokens, candidate.max_tokens, max_ok),
        refusals=(base.refusals, candidate.refusals, refusals_ok),
        cost=(base.cost_per_event, candidate.cost_per_event, cost_change, cost_ok),
        tokens=(base.tokens_per_event, candidate.tokens_per_event, tokens_change, tokens_ok),
        agreement={
            "value": value,
            "mean_abs_dp": shift,
            "noise_value": noise_value,
            "noise_abs_dp": noise_shift,
            "ok": agreement_ok,
        },
        passed=passed,
        verdict=verdict,
        seed=seed,
        bootstrap=bootstrap,
    )


def noise_level(first: RunResult, second: RunResult) -> float | None:
    """Порог шума: насколько разошелся средний лог-лосс двух прогонов одной версии на
    общих событиях (|LL₁ − LL₂|)."""
    keys = sorted(set(first.events) & set(second.events))
    if not keys:
        return None
    y = [first.events[key].y for key in keys]
    one = float(log_losses([first.events[key].p for key in keys], y).mean())
    two = float(log_losses([second.events[key].p for key in keys], y).mean())
    return abs(one - two)
