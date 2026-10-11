"""Бэктест базовой модели (Эло) против рынка без маржи (PLAN.md, этап 2;
LLM_LEARNING.md, разделы 3 и 4).

    python -m app.ml.backtest [--report PATH|-] [--test-years 2024,2025] [--no-save]

Конвейер:
1. Матчи с результатом и кэфы archive (tennis-data.co.uk) из БД; Эло в памяти по всей
   истории — вероятности ДО каждого матча (EloEngine.run).
2. Стороны. В архивах игрок 1 — победитель, поэтому для метрик и подгонки игрок 1/2
   назначается по хешу id матча (четность sha256), иначе исход «всегда 1».
3. Вес покрытия w подбирается по лог-лоссу на tune_years, калибровка Платта (логистическая
   регрессия по logit p, метод Ньютона) — на calib_years. test_years открываются один раз.
4. На тесте — Эло сырой, Эло после калибровки и рынок (кэфы эталона без маржи,
   степенной метод) на одних и тех же событиях; бутстрэп-интервалы разницы потерь.
   Эталон события — первый букмекер из ref_bookmakers (pinnacle → betfair_ex → avg) с
   кэфами обеих сторон; состав эталона по годам — в отчете и в eval_runs.metrics.
5. Приманка: исходы заменены монеткой ДО Эло, весь конвейер заново. Лог-лосс на тесте не
   должен быть лучше 0,693 − 0,005, иначе признаки видят исход своего матча.
6. ROI по правилам стратегии (Стратегия-ставок.md, шаги 4–5; решение Р21): экспресс в
   день, одиночные ставки «для сравнения» и вариант с убранным правилом 7 (ставка без
   перевеса) — тоже для сравнения. Ставка — 1 единица, суммы шага 5 не моделируются.

Вычисления — numpy, детерминированно: seed из настроек бэктеста задает и монетку
приманки, и бутстрэп.
"""

import argparse
import asyncio
import hashlib
import math
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, date, datetime
from decimal import Decimal
from itertools import pairwise
from pathlib import Path
from typing import Any, Self

import numpy as np
import numpy.typing as npt
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.db.models import EvalRun, IngestionRun, Match, OddsSnapshot, Tournament
from app.db.session import create_engine, create_sessionmaker
from app.ml.elo import (
    MODEL_ID,
    RESULT_STATUSES,
    EloEngine,
    EloMatch,
    EloParams,
    PreMatch,
    load_history,
    sort_history,
    upsert_model,
)
from app.ml.market import REFERENCE_ORDER, devig_power_matrix, reference_odds
from app.ml.metrics import (
    COIN_LOG_LOSS,
    CalibrationBin,
    Estimate,
    FloatArray,
    RoiEstimate,
    bootstrap_diff_ci,
    bootstrap_mean_ci,
    brier_losses,
    calibration_table,
    clip_probabilities,
    ece,
    log_loss,
    log_losses,
    roi_with_ci,
)
from app.ml.report import bookmaker_name, reference_warning, render_markdown, summary_lines

MARKET = "ML"
ODDS_KIND = "archive"
# Меньше событий для калибровки — калибровка не применяется (предупреждение в отчете)
MIN_CALIBRATION_EVENTS = 50
# Вторая проверка приманки (Платт на ее же тестовых событиях) — от стольких событий:
# подгонка двух параметров улучшает лог-лосс примерно на 1/n, а в 99% случаев не больше
# 4,6/n, то есть меньше запаса decoy_margin = 0,005
DECOY_REFIT_MIN = 1000
# Источники загрузок, свежесть которых показывает отчет
FRESHNESS_SOURCES = ("sackmann", "tennis_data")
# Лучшая цена среди букмекеров: у одного букмекера ее не получить, ROI по ней завышен и
# годится только как верхняя граница
UPPER_BOUND_BOOKMAKERS = frozenset({"max"})

# Кэфы одного матча у букмекера: (кэф игрока 1, кэф игрока 2)
OddsPair = tuple[Decimal | None, Decimal | None]
OddsBook = Mapping[int, Mapping[str, OddsPair]]


class BacktestError(Exception):
    """Бэктест невозможен (нет данных, неверные годы). Текст — из локали."""


# --- настройки ---


@dataclass(frozen=True)
class StrategyRules:
    """Правила отбора событий (Стратегия-ставок.md, шаг 4). Кэфы — Decimal: граница
    1.80 × 1.80 = 3.24 в плавающей точке дала бы 3.2400000000000003 и ставку бы отсекла."""

    min_p: float = 0.65
    min_odds: Decimal = Decimal("1.13")
    max_odds: Decimal = Decimal("1.80")
    triple_min_p: float = 0.70
    triple_max_odds: Decimal = Decimal("1.60")
    double_total: tuple[Decimal, Decimal] = (Decimal("1.28"), Decimal("3.24"))
    triple_total: tuple[Decimal, Decimal] = (Decimal("1.44"), Decimal("4.10"))


@dataclass(frozen=True)
class BacktestConfig:
    """Годы подбора веса покрытия, калибровки и теста; эталон рынка и букмекеры для ROI;
    уровни турниров (только основной тур ATP, решение Р21).

    ref_bookmakers — эталон рынка по порядку: для события берется первый букмекер с
    кэфами обеих сторон. Первый в списке — основной (острая линия); если его доля ниже
    min_primary_share среди всех событий сравнения или в одном тестовом году, где таких
    событий не меньше min_primary_year_events, отчет предупреждает, что сравнение с рынком
    менее строгое."""

    test_years: tuple[int, ...] = (2024, 2025)
    calib_years: tuple[int, ...] = (2022, 2023)
    tune_years: tuple[int, ...] = (2019, 2020, 2021)
    ref_bookmakers: tuple[str, ...] = REFERENCE_ORDER
    min_primary_share: float = 0.9
    min_primary_year_events: int = 100
    bet_bookmakers: tuple[str, ...] = ("avg", "pinnacle", "max")
    seed: int = 20261009
    levels: tuple[str, ...] = ("grand_slam", "masters", "500", "250", "atp", "finals")
    surface_weights: tuple[float, ...] = (0.0, 0.25, 0.5, 0.75, 1.0)
    elo: EloParams = field(default_factory=EloParams)
    rules: StrategyRules = field(default_factory=StrategyRules)
    bootstrap: int = 10_000
    # Разрез (покрытие, уровень) показывается, если в нем не меньше событий
    min_slice: int = 100
    decoy_margin: float = 0.005

    @classmethod
    def for_test_years(cls, years: Iterable[int], **fields: Any) -> Self:
        """Настройки с другими годами теста: калибровка — два года перед тестом, подбор
        веса — три года перед калибровкой."""
        test = tuple(sorted(set(years)))
        first = test[0]
        return cls(
            test_years=test,
            calib_years=(first - 2, first - 1),
            tune_years=(first - 5, first - 4, first - 3),
            **fields,
        )

    @property
    def eval_set(self) -> str:
        return "atp-tour-" + "-".join(str(year) for year in self.test_years)

    def validate(self) -> None:
        """Эталон рынка задан; годы не пересекаются и идут по времени: подбор <
        калибровка < тест."""
        if not self.ref_bookmakers:
            raise BacktestError(t("backtest.errors.no_reference"))
        periods = (self.tune_years, self.calib_years, self.test_years)
        if not all(periods) or any(
            max(earlier) >= min(later) for earlier, later in pairwise(periods)
        ):
            raise BacktestError(
                t(
                    "backtest.errors.periods",
                    tune=_years_text(self.tune_years),
                    calib=_years_text(self.calib_years),
                    test=_years_text(self.test_years),
                )
            )


def _years_text(years: Sequence[int]) -> str:
    return ", ".join(str(year) for year in years) or "-"


# --- стороны и калибровка ---


def side_flip(match_id: int) -> bool:
    """True — сторона A матча (для метрик) — игрок 2. По четности sha256 от id матча:
    стабильно между запусками и не зависит от того, кто выиграл."""
    return hashlib.sha256(str(match_id).encode()).digest()[-1] % 2 == 1


def _logit(p: npt.ArrayLike) -> FloatArray:
    probs = clip_probabilities(p)
    result: FloatArray = np.log(probs) - np.log1p(-probs)
    return result


def _sigmoid(z: FloatArray) -> FloatArray:
    result: FloatArray = np.exp(-np.logaddexp(0.0, -z))
    return result


@dataclass(frozen=True)
class PlattScaling:
    """Калибровка Платта: p' = σ(a + b·logit p). a = 0, b = 1 — без изменений."""

    a: float = 0.0
    b: float = 1.0

    def apply(self, p: npt.ArrayLike) -> FloatArray:
        return _sigmoid(self.a + self.b * _logit(p))


def fit_platt(p: npt.ArrayLike, y: npt.ArrayLike, *, max_iter: int = 100) -> PlattScaling:
    """Логистическая регрессия исхода по logit p методом Ньютона (с дроблением шага,
    если шаг ухудшил правдоподобие). Нужны оба исхода, иначе ValueError."""
    x = _logit(p)
    outcomes = np.asarray(y, dtype=np.float64).reshape(-1)
    if x.size != outcomes.size:
        raise ValueError(t("ml.metrics.shape", n_p=x.size, n_y=outcomes.size))
    if x.size == 0 or outcomes.min() == outcomes.max():
        raise ValueError(t("ml.metrics.one_class"))

    def loss(theta: FloatArray) -> float:
        z = theta[0] + theta[1] * x
        return float((np.logaddexp(0.0, z) - outcomes * z).sum())

    theta = np.array([0.0, 1.0])
    current = loss(theta)
    for _ in range(max_iter):
        q = _sigmoid(theta[0] + theta[1] * x)
        residual = q - outcomes
        gradient = np.array([residual.sum(), (residual * x).sum()])
        weight = q * (1.0 - q)
        hessian = np.array(
            [[weight.sum(), (weight * x).sum()], [(weight * x).sum(), (weight * x * x).sum()]]
        ) + 1e-9 * np.eye(2)
        step = np.linalg.solve(hessian, gradient)
        scale = 1.0
        while scale > 1e-8:
            candidate = theta - scale * step
            value = loss(candidate)
            if value <= current + 1e-12:
                break
            scale /= 2.0
        else:
            # Ни один шаг не улучшил правдоподобие: уже в минимуме
            break
        theta, current = candidate, value
        if float(np.abs(scale * step).max()) < 1e-10:
            break
    return PlattScaling(a=float(theta[0]), b=float(theta[1]))


# --- события ---


@dataclass(frozen=True)
class _Event:
    """Матч для метрик: сторона A — игрок 1 или 2 по хешу id (flip)."""

    match: EloMatch
    pre: PreMatch
    flip: bool

    @property
    def y(self) -> float:
        side = self.match.player2_id if self.flip else self.match.player1_id
        return 1.0 if self.match.winner_id == side else 0.0

    def p(self, weight: float) -> float:
        p1 = self.pre.probability(weight)
        return 1.0 - p1 if self.flip else p1


def _events(matches: Sequence[EloMatch], pre: Sequence[PreMatch]) -> list[_Event]:
    return [
        _Event(match=match, pre=state, flip=side_flip(match.match_id))
        for match, state in zip(matches, pre, strict=True)
    ]


def _scored(event: _Event, config: BacktestConfig, years: Sequence[int]) -> bool:
    """Событие для метрик: сыгран до конца, уровень основного тура, год из списка."""
    match = event.match
    return match.status == "finished" and match.level in config.levels and match.day.year in years


def _arrays(events: Sequence[_Event], weight: float) -> tuple[FloatArray, FloatArray]:
    p = np.array([event.p(weight) for event in events], dtype=np.float64)
    y = np.array([event.y for event in events], dtype=np.float64)
    return p, y


@dataclass(frozen=True)
class _Fit:
    """Подобранный вес покрытия и калибровка."""

    weight: float
    tuning: dict[float, float]
    tune_events: int
    platt: PlattScaling
    calib_events: int


def _fit(events: Sequence[_Event], config: BacktestConfig, warnings: list[str]) -> _Fit:
    tune = [event for event in events if _scored(event, config, config.tune_years)]
    tuning: dict[float, float] = {}
    weight = config.elo.surface_weight
    if tune:
        y = np.array([event.y for event in tune])
        for candidate in config.surface_weights:
            tuning[candidate] = log_loss([event.p(candidate) for event in tune], y)
        weight = min(tuning, key=lambda w: (tuning[w], config.surface_weights.index(w)))
    else:
        warnings.append(
            t("backtest.warnings.no_tune", years=_years_text(config.tune_years), weight=weight)
        )
    calib = [event for event in events if _scored(event, config, config.calib_years)]
    platt = PlattScaling()
    p, y = _arrays(calib, weight)
    if len(calib) >= MIN_CALIBRATION_EVENTS and y.min() != y.max():
        platt = fit_platt(p, y)
    else:
        warnings.append(
            t(
                "backtest.warnings.no_calibration",
                years=_years_text(config.calib_years),
                n=len(calib),
                min=MIN_CALIBRATION_EVENTS,
            )
        )
    return _Fit(weight, tuning, len(tune), platt, len(calib))


# --- результат ---


@dataclass(frozen=True)
class ScoreSummary:
    """Метрики одного прогноза на наборе событий: средние потери с бутстрэп-ДИ и ECE."""

    n: int
    log_loss: Estimate
    brier: Estimate
    ece: float


@dataclass(frozen=True)
class MarketGap:
    """Разница потерь модель − рынок на одних событиях (больше 0 — модель хуже) и
    Brier skill score к рынку (больше 0 — модель лучше)."""

    log_loss: Estimate
    brier: Estimate
    skill: float | None


@dataclass(frozen=True)
class SliceResult:
    """Разрез по покрытию или уровню турнира: откалиброванная модель против рынка."""

    kind: str
    value: str
    n: int
    model_log_loss: float
    market_log_loss: float
    gap: Estimate
    model_brier: float
    market_brier: float


@dataclass(frozen=True)
class DecoyResult:
    """Приманка: лог-лосс конвейера на исходах-монетке и порог ln 2 − decoy_margin.

    log_loss — с калибровкой Платта, подогнанной на годах калибровки (как у главных
    чисел). Утечка только в тестовых годах ее не видна: на годах калибровки исходы —
    монетка без утечки, Платт сжимает все прогнозы к 0,5. Поэтому вторая проверка,
    refit_log_loss, — Платт, подогнанный на самих тестовых событиях приманки (2
    параметра на тысячи событий: выигрыш от подгонки около 1/n, меньше запаса). Она
    считается, только если событий не меньше DECOY_REFIT_MIN (иначе None). Приманка
    пройдена, если обе величины не лучше порога."""

    log_loss: float
    threshold: float
    passed: bool
    n: int
    refit_log_loss: float | None = None
    refit_min: int = DECOY_REFIT_MIN


@dataclass(frozen=True)
class Outcome:
    """Исход матча для ставки: вероятность модели, кэф букмекера и сбылся ли он."""

    match_id: int
    day: date | None
    selection: int
    p: float
    odds: Decimal
    won: bool

    @property
    def edge(self) -> float:
        """Перевес p·кэф: больше 1 — ставка с валуем."""
        return self.p * float(self.odds)


@dataclass(frozen=True)
class BetResult:
    """Итог ставок одного вида у одного букмекера. kind: parlay — экспрессы; legs —
    одиночные на исходах этих экспрессов (каждая нога — своя ставка в 1 единицу; разница
    ROI с экспрессом — сколько съедает экспресс, решение Р21); single — одиночные на всех
    кандидатах. rule7 — вариант с правилом 7 (без требования перевеса, убрано решением
    Р21, показано для сравнения). upper_bound — кэфы «максимум по рынку»
    (UPPER_BOUND_BOOKMAKERS): ROI только верхняя граница."""

    bookmaker: str
    kind: str
    rule7: bool
    wins: int
    avg_odds: float | None
    roi: RoiEstimate
    legs: dict[int, int] = field(default_factory=dict)
    upper_bound: bool = False

    @property
    def bets(self) -> int:
        return self.roi.bets

    @property
    def win_rate(self) -> float | None:
        return self.wins / self.bets if self.bets else None


@dataclass(frozen=True)
class Period:
    years: tuple[int, ...]
    events: int


@dataclass(frozen=True)
class SourceFreshness:
    """Свежесть источника: последняя успешная загрузка и самый поздний день матча."""

    source: str
    last_ok_run: datetime | None
    last_day: date | None


@dataclass(frozen=True)
class Freshness:
    last_day: date | None
    sources: tuple[SourceFreshness, ...] = ()


@dataclass(frozen=True)
class ReferenceMix:
    """Состав эталона рынка на тестовых событиях: год → букмекер → событий, оцененных по
    его кэфам (букмекеры в порядке order, нули тоже). Первый в order — основной эталон.

    Год, где событий сравнения не меньше min_year_events, а доля основного эталона ниже
    min_share, делает сравнение нестрогим, даже если общая доля выше порога: иначе год
    почти без Pinnacle (как 2026-й) прятался бы за полными годами. Год с меньшим числом
    событий на итог почти не влияет и отдельно не проверяется."""

    order: tuple[str, ...]
    by_year: dict[int, dict[str, int]]
    min_share: float
    min_year_events: int = 100

    @property
    def primary(self) -> str:
        return self.order[0]

    def counts_for(self, years: Iterable[int]) -> dict[str, int]:
        """Событий по каждому букмекеру за выбранные тестовые годы."""
        chosen = [self.by_year.get(year, {}) for year in years]
        return {
            bookmaker: sum(year.get(bookmaker, 0) for year in chosen) for bookmaker in self.order
        }

    @property
    def counts(self) -> dict[str, int]:
        """Событий по каждому букмекеру за все тестовые годы."""
        return self.counts_for(self.by_year)

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def year_total(self, year: int) -> int:
        """Событий сравнения (с эталоном) в году."""
        return sum(self.by_year.get(year, {}).values())

    def year_share(self, year: int) -> float | None:
        """Доля основного эталона среди событий года с эталоном."""
        total = self.year_total(year)
        return self.by_year[year].get(self.primary, 0) / total if total else None

    @property
    def primary_share(self) -> float | None:
        """Доля основного эталона среди всех событий сравнения; None — сравнения нет."""
        return self.counts[self.primary] / self.total if self.total else None

    @property
    def weak_years(self) -> tuple[int, ...]:
        """Тестовые годы, где событий сравнения не меньше min_year_events, а доля
        основного эталона ниже min_share."""
        return tuple(
            year
            for year in self.by_year
            if self.year_total(year) >= self.min_year_events
            and (share := self.year_share(year)) is not None
            and share < self.min_share
        )

    @property
    def overall_strict(self) -> bool:
        """Общая доля основного эталона не ниже min_share (или сравнения нет вовсе —
        тогда предупреждает no_market)."""
        share = self.primary_share
        return share is None or share >= self.min_share

    @property
    def strict(self) -> bool:
        """Сравнение с рынком строгое: основного эталона не меньше min_share и в целом,
        и в каждом тестовом году, где событий сравнения не меньше min_year_events."""
        return self.overall_strict and not self.weak_years

    def as_dict(self) -> dict[str, Any]:
        """Состав для eval_runs.metrics."""
        return {
            "order": list(self.order),
            "primary": self.primary,
            "min_primary_share": self.min_share,
            "min_year_events": self.min_year_events,
            "primary_share": self.primary_share,
            "strict": self.strict,
            "weak_years": list(self.weak_years),
            "counts": self.counts,
            "by_year": self.by_year,
            "primary_share_by_year": {year: self.year_share(year) for year in self.by_year},
        }


@dataclass(frozen=True)
class DataSummary:
    """Что было в данных: матчи в расчете Эло, пропуски, события по периодам, доля
    тестовых событий с кэфами эталона (по годам: год → (с кэфами, всего)) и состав
    эталона (reference)."""

    matches: int
    skipped: dict[str, int]
    first_day: date | None
    last_day: date | None
    tune: Period
    calib: Period
    test: Period
    test_with_market: int
    market_by_year: dict[int, tuple[int, int]]
    bet_events: int
    reference: ReferenceMix

    @property
    def market_share(self) -> float | None:
        return self.test_with_market / self.test.events if self.test.events else None


@dataclass
class BacktestResult:
    """Все числа бэктеста. Сравнение с рынком (raw, calibrated, market, gaps,
    calibration, slices) — на тестовых событиях с кэфами эталона; model_all_* — на всех
    тестовых событиях. Нет кэфов — сравнения нет (None)."""

    config: BacktestConfig
    created_at: datetime
    data: DataSummary
    freshness: Freshness | None
    surface_weight: float
    tuning: dict[float, float]
    platt: PlattScaling
    model_all_raw: ScoreSummary
    model_all: ScoreSummary
    raw: ScoreSummary | None
    calibrated: ScoreSummary | None
    market: ScoreSummary | None
    raw_gap: MarketGap | None
    calibrated_gap: MarketGap | None
    calibration: list[CalibrationBin]
    market_calibration: list[CalibrationBin]
    slices: list[SliceResult]
    decoy: DecoyResult
    bets: list[BetResult]
    warnings: list[str]
    eval_run_id: int | None = None

    @property
    def n_events(self) -> int:
        """События, на которых посчитаны главные числа."""
        return self.calibrated.n if self.calibrated is not None else self.model_all.n

    def metrics(self) -> dict[str, Any]:
        """Все числа для eval_runs.metrics (JSONB)."""
        data = asdict(self)
        data.pop("config")
        data.pop("eval_run_id")
        data["n_events"] = self.n_events
        data["market_share"] = self.data.market_share
        data["data"]["reference"] = self.data.reference.as_dict()
        data["config"] = {
            **asdict(self.config),
            "eval_set": self.config.eval_set,
        }
        jsonable: dict[str, Any] = _jsonable(data)
        return jsonable


def _jsonable(value: Any) -> Any:
    """Значение для JSONB: даты — ISO, Decimal — float, ключи — строки, не числа
    (NaN, бесконечность) — None."""
    if isinstance(value, bool) or value is None or isinstance(value, str | int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(item) for item in value]
    return str(value)


# --- ставки по правилам стратегии ---


def _qualifies(outcome: Outcome, rules: StrategyRules, require_value: bool) -> bool:
    return (
        outcome.p >= rules.min_p
        and rules.min_odds <= outcome.odds <= rules.max_odds
        and (outcome.edge > 1.0 or not require_value)
    )


def _by_edge(outcome: Outcome) -> tuple[float, int, int]:
    return (-outcome.edge, outcome.match_id, outcome.selection)


def candidates(
    outcomes: Iterable[Outcome], rules: StrategyRules, *, require_value: bool = True
) -> list[Outcome]:
    """Подходящие исходы (p ≥ 0,65, кэф 1.13–1.80, перевес p·кэф > 1, если он требуется),
    не больше одного из матча (с наибольшим перевесом), по убыванию перевеса."""
    best: dict[int, Outcome] = {}
    for outcome in outcomes:
        if not _qualifies(outcome, rules, require_value):
            continue
        current = best.get(outcome.match_id)
        if current is None or _by_edge(outcome) < _by_edge(current):
            best[outcome.match_id] = outcome
    return sorted(best.values(), key=_by_edge)


def _total(legs: Sequence[Outcome]) -> Decimal:
    total = Decimal(1)
    for leg in legs:
        total *= leg.odds
    return total


def pick_parlay(
    outcomes: Iterable[Outcome], rules: StrategyRules, *, require_value: bool = True
) -> tuple[Outcome, ...] | None:
    """Экспресс дня по шагу 4 стратегии: меньше 2 кандидатов — ставки нет; три лучших
    по перевесу кандидата с p ≥ 0,70 и кэфом ≤ 1.60 с итогом 1.44–4.10 — экспресс из 3;
    иначе два лучших по перевесу с итогом 1.28–3.24 — экспресс из 2; иначе ставки нет."""
    pool = candidates(outcomes, rules, require_value=require_value)
    if len(pool) < 2:
        return None
    strong = [o for o in pool if o.p >= rules.triple_min_p and o.odds <= rules.triple_max_odds]
    if len(strong) >= 3:
        low, high = rules.triple_total
        if low <= _total(strong[:3]) <= high:
            return tuple(strong[:3])
    low, high = rules.double_total
    if low <= _total(pool[:2]) <= high:
        return tuple(pool[:2])
    return None


def _bet_result(
    bookmaker: str,
    kind: str,
    rule7: bool,
    bets: Sequence[Sequence[Outcome]],
    config: BacktestConfig,
) -> BetResult:
    totals = [_total(legs) for legs in bets]
    won = [all(leg.won for leg in legs) for legs in bets]
    returns = [float(total) if ok else 0.0 for total, ok in zip(totals, won, strict=True)]
    legs: dict[int, int] = defaultdict(int)
    for item in bets:
        legs[len(item)] += 1
    return BetResult(
        bookmaker=bookmaker,
        kind=kind,
        rule7=rule7,
        wins=sum(won),
        avg_odds=float(sum(totals) / len(totals)) if totals else None,
        roi=roi_with_ci([1.0] * len(bets), returns, n=config.bootstrap, seed=config.seed),
        legs=dict(sorted(legs.items())) if kind == "parlay" else {},
        upper_bound=bookmaker in UPPER_BOUND_BOOKMAKERS,
    )


def _outcomes(
    events: Sequence[_Event], p1: Sequence[float], odds: OddsBook, bookmaker: str
) -> list[Outcome]:
    result: list[Outcome] = []
    for event, prob1 in zip(events, p1, strict=True):
        pair = (odds.get(event.match.match_id) or {}).get(bookmaker)
        if pair is None:
            continue
        for selection, value in enumerate(pair, start=1):
            if value is None or value <= 1:
                continue
            player = event.match.player1_id if selection == 1 else event.match.player2_id
            result.append(
                Outcome(
                    match_id=event.match.match_id,
                    day=event.match.match_date,
                    selection=selection,
                    p=prob1 if selection == 1 else 1.0 - prob1,
                    odds=value,
                    won=event.match.winner_id == player,
                )
            )
    return result


def _bets(
    events: Sequence[_Event], p1: Sequence[float], odds: OddsBook, config: BacktestConfig
) -> list[BetResult]:
    results: list[BetResult] = []
    for bookmaker in config.bet_bookmakers:
        outcomes = _outcomes(events, p1, odds, bookmaker)
        by_day: dict[date, list[Outcome]] = defaultdict(list)
        for outcome in outcomes:
            if outcome.day is not None:
                by_day[outcome.day].append(outcome)
        for rule7 in (False, True):
            singles = [
                (outcome,)
                for outcome in candidates(outcomes, config.rules, require_value=not rule7)
            ]
            parlays = [
                legs
                for day in sorted(by_day)
                if (legs := pick_parlay(by_day[day], config.rules, require_value=not rule7))
            ]
            # Те же исходы, что вошли в экспрессы, отдельными ставками (Р21)
            leg_bets = [(leg,) for parlay in parlays for leg in parlay]
            results.append(_bet_result(bookmaker, "parlay", rule7, parlays, config))
            results.append(_bet_result(bookmaker, "legs", rule7, leg_bets, config))
            results.append(_bet_result(bookmaker, "single", rule7, singles, config))
    return results


# --- расчет ---


def _score(p: FloatArray, y: FloatArray, config: BacktestConfig) -> ScoreSummary:
    return ScoreSummary(
        n=int(p.size),
        log_loss=bootstrap_mean_ci(log_losses(p, y), n=config.bootstrap, seed=config.seed),
        brier=bootstrap_mean_ci(brier_losses(p, y), n=config.bootstrap, seed=config.seed),
        ece=ece(p, y),
    )


def _gap(model: FloatArray, market: FloatArray, y: FloatArray, config: BacktestConfig) -> MarketGap:
    model_brier = brier_losses(model, y)
    market_brier = brier_losses(market, y)
    reference = float(market_brier.mean())
    return MarketGap(
        log_loss=bootstrap_diff_ci(
            log_losses(model, y), log_losses(market, y), n=config.bootstrap, seed=config.seed
        ),
        brier=bootstrap_diff_ci(model_brier, market_brier, n=config.bootstrap, seed=config.seed),
        skill=1.0 - float(model_brier.mean()) / reference if reference > 0 else None,
    )


def _slices(
    events: Sequence[_Event],
    model: FloatArray,
    market: FloatArray,
    y: FloatArray,
    config: BacktestConfig,
) -> list[SliceResult]:
    result: list[SliceResult] = []
    keys: list[tuple[str, Callable[[EloMatch], str]]] = [
        ("surface", lambda match: match.surface or "unknown"),
        ("level", lambda match: match.level or "unknown"),
    ]
    for kind, key in keys:
        groups: dict[str, list[int]] = defaultdict(list)
        for position, event in enumerate(events):
            groups[key(event.match)].append(position)
        for value in sorted(groups):
            index = np.array(groups[value])
            if index.size < config.min_slice:
                continue
            model_ll = log_losses(model[index], y[index])
            market_ll = log_losses(market[index], y[index])
            result.append(
                SliceResult(
                    kind=kind,
                    value=value,
                    n=int(index.size),
                    model_log_loss=float(model_ll.mean()),
                    market_log_loss=float(market_ll.mean()),
                    gap=bootstrap_diff_ci(
                        model_ll, market_ll, n=config.bootstrap, seed=config.seed
                    ),
                    model_brier=float(brier_losses(model[index], y[index]).mean()),
                    market_brier=float(brier_losses(market[index], y[index]).mean()),
                )
            )
    return result


def _decoy(matches: Sequence[EloMatch], config: BacktestConfig, test_ids: set[int]) -> DecoyResult:
    """Приманка: победитель каждого матча назначен монеткой (seed) ДО Эло, затем весь
    конвейер заново — подбор веса, калибровка, тест на тех же событиях."""
    coins = np.random.default_rng(config.seed).random(len(matches)) < 0.5
    fake = [
        replace(match, winner_id=match.player1_id if coin else match.player2_id)
        for match, coin in zip(matches, coins, strict=True)
    ]
    events = _events(fake, EloEngine(config.elo).run(fake))
    fit = _fit(events, config, [])
    test = [event for event in events if event.match.match_id in test_ids]
    threshold = COIN_LOG_LOSS - config.decoy_margin
    if not test:
        return DecoyResult(log_loss=COIN_LOG_LOSS, threshold=threshold, passed=True, n=0)
    p, y = _arrays(test, fit.weight)
    value = log_loss(fit.platt.apply(p), y)
    refit: float | None = None
    if len(test) >= DECOY_REFIT_MIN and y.min() != y.max():
        refit = log_loss(fit_platt(p, y).apply(p), y)
    passed = value >= threshold and (refit is None or refit >= threshold)
    return DecoyResult(
        log_loss=value, threshold=threshold, passed=passed, n=len(test), refit_log_loss=refit
    )


def evaluate(
    matches: Sequence[EloMatch],
    odds: OddsBook,
    config: BacktestConfig | None = None,
    *,
    skipped: Mapping[str, int] | None = None,
    freshness: Freshness | None = None,
) -> BacktestResult:
    """Весь бэктест в памяти, без БД: matches — сыгранные матчи (порядок любой), odds —
    кэфы archive: id матча → букмекер → (кэф игрока 1, кэф игрока 2)."""
    config = config or BacktestConfig()
    config.validate()
    ordered = sort_history(matches)
    events = _events(ordered, EloEngine(config.elo).run(ordered))
    warnings: list[str] = []
    fit = _fit(events, config, warnings)

    test = [event for event in events if _scored(event, config, config.test_years)]
    if not test:
        raise BacktestError(
            t("backtest.errors.no_test_events", years=_years_text(config.test_years))
        )
    raw_all, y_all = _arrays(test, fit.weight)
    cal_all = fit.platt.apply(raw_all)

    # Эталон события — первый букмекер по порядку с кэфами обеих сторон
    references = [
        (index, found)
        for index, event in enumerate(test)
        if (found := reference_odds(odds.get(event.match.match_id) or {}, config.ref_bookmakers))
        is not None
    ]
    with_market = [index for index, _ in references]
    market_by_year: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    reference_by_year: dict[int, dict[str, int]] = {}
    for event in test:
        year = event.match.day.year
        market_by_year[year][1] += 1
        reference_by_year.setdefault(year, dict.fromkeys(config.ref_bookmakers, 0))
    for index, (bookmaker, _) in references:
        year = test[index].match.day.year
        market_by_year[year][0] += 1
        reference_by_year[year][bookmaker] += 1
    reference = ReferenceMix(
        order=tuple(dict.fromkeys(config.ref_bookmakers)),
        by_year=dict(sorted(reference_by_year.items())),
        min_share=config.min_primary_share,
        min_year_events=config.min_primary_year_events,
    )

    raw = calibrated = market = None
    raw_gap = calibrated_gap = None
    calibration: list[CalibrationBin] = calibration_table(cal_all, y_all)
    market_calibration: list[CalibrationBin] = []
    slices: list[SliceResult] = []
    headline_ids = {event.match.match_id for event in test}
    if with_market:
        compared = [test[index] for index in with_market]
        rows = np.array(with_market)
        q1 = devig_power_matrix(
            [[float(odds1), float(odds2)] for _, (_, (odds1, odds2)) in references]
        )[:, 0]
        flips = np.array([event.flip for event in compared])
        q = np.where(flips, 1.0 - q1, q1)
        y = y_all[rows]
        raw = _score(raw_all[rows], y, config)
        calibrated = _score(cal_all[rows], y, config)
        market = _score(q, y, config)
        raw_gap = _gap(raw_all[rows], q, y, config)
        calibrated_gap = _gap(cal_all[rows], q, y, config)
        calibration = calibration_table(cal_all[rows], y)
        market_calibration = calibration_table(q, y)
        slices = _slices(compared, cal_all[rows], q, y, config)
        headline_ids = {event.match.match_id for event in compared}
        if not reference.strict:
            warnings.append(reference_warning(reference))
    else:
        warnings.append(
            t(
                "backtest.warnings.no_market",
                bookmakers=", ".join(map(bookmaker_name, reference.order)),
                years=_years_text(config.test_years),
            )
        )

    # ROI: сыгранные и с отказом (результат как есть), уровни основного тура
    bet_events = [
        event
        for event in events
        if event.match.status in RESULT_STATUSES
        and event.match.level in config.levels
        and event.match.day.year in config.test_years
    ]
    bet_raw, _ = _arrays(bet_events, fit.weight)
    bet_cal = fit.platt.apply(bet_raw)
    # Калибровка — для стороны A; вероятность игрока 1 — из нее, сумма сторон равна 1
    p1 = [
        1.0 - float(value) if event.flip else float(value)
        for event, value in zip(bet_events, bet_cal, strict=True)
    ]
    bets = _bets(bet_events, p1, odds, config)

    data = DataSummary(
        matches=len(ordered),
        skipped=dict(sorted((skipped or {}).items())),
        first_day=ordered[0].day if ordered else None,
        last_day=ordered[-1].day if ordered else None,
        tune=Period(config.tune_years, fit.tune_events),
        calib=Period(config.calib_years, fit.calib_events),
        test=Period(config.test_years, len(test)),
        test_with_market=len(with_market),
        market_by_year={year: (pair[0], pair[1]) for year, pair in sorted(market_by_year.items())},
        bet_events=len(bet_events),
        reference=reference,
    )
    return BacktestResult(
        config=config,
        created_at=datetime.now(UTC),
        data=data,
        freshness=freshness,
        surface_weight=fit.weight,
        tuning=fit.tuning,
        platt=fit.platt,
        model_all_raw=_score(raw_all, y_all, config),
        model_all=_score(cal_all, y_all, config),
        raw=raw,
        calibrated=calibrated,
        market=market,
        raw_gap=raw_gap,
        calibrated_gap=calibrated_gap,
        calibration=calibration,
        market_calibration=market_calibration,
        slices=slices,
        decoy=_decoy(ordered, config, headline_ids),
        bets=bets,
        warnings=warnings,
    )


# --- БД ---


async def load_archive_odds(
    db: AsyncSession, *, years: Sequence[int], bookmakers: Iterable[str]
) -> dict[int, dict[str, OddsPair]]:
    """Кэфы archive на победу в матче (ML) у матчей тестовых лет."""
    day = func.coalesce(Match.match_date, Tournament.start_date)
    rows = await db.execute(
        select(
            OddsSnapshot.match_id, OddsSnapshot.selection, OddsSnapshot.bookmaker, OddsSnapshot.odds
        )
        .join(Match, Match.id == OddsSnapshot.match_id)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(
            OddsSnapshot.kind == ODDS_KIND,
            OddsSnapshot.market == MARKET,
            OddsSnapshot.bookmaker.in_(tuple(bookmakers)),
            day >= date(min(years), 1, 1),
            day <= date(max(years), 12, 31),
        )
    )
    found: dict[int, dict[str, list[Decimal | None]]] = defaultdict(dict)
    for match_id, selection, bookmaker, value in rows:
        pair = found[match_id].setdefault(bookmaker, [None, None])
        pair[selection - 1] = value
    return {
        match_id: {bookmaker: (pair[0], pair[1]) for bookmaker, pair in books.items()}
        for match_id, books in found.items()
    }


async def load_freshness(db: AsyncSession) -> Freshness:
    """Самый поздний день матча с результатом и свежесть загрузок архивов.

    Последний матч Сакманна — среди матчей source = sackmann. Последний матч tennis-data —
    самая поздняя дата матча (match_date) у матчей архивов, а не по Match.source: дату
    ставит только tennis-data, а найденный им матч Сакманна остается source = sackmann.
    """
    day = func.coalesce(Match.match_date, Tournament.start_date)
    played = (
        select(func.max(day))
        .select_from(Match)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.status.in_(RESULT_STATUSES))
    )
    last_days = {
        "sackmann": played.where(Match.source == "sackmann"),
        "tennis_data": played.where(
            Match.match_date.is_not(None), Match.source.in_(("sackmann", "tennis_data"))
        ),
    }
    sources: list[SourceFreshness] = []
    for source in FRESHNESS_SOURCES:
        last_run = await db.scalar(
            select(func.max(IngestionRun.finished_at)).where(
                IngestionRun.source == source, IngestionRun.status == "ok"
            )
        )
        sources.append(SourceFreshness(source, last_run, await db.scalar(last_days[source])))
    return Freshness(last_day=await db.scalar(played), sources=tuple(sources))


async def save_result(db: AsyncSession, result: BacktestResult) -> int:
    """ml_models elo-v1 (вес покрытия и калибровка Платта в params, кратко метрики) и
    новая строка eval_runs со всеми числами. Коммит — за вызывающим."""
    config = result.config
    headline = result.calibrated or result.model_all
    await upsert_model(
        db,
        params={
            **config.elo.as_dict(),
            "surface_weight": result.surface_weight,
            "carpet_as": "hard",
            "platt": {"a": result.platt.a, "b": result.platt.b},
            "tune_years": list(config.tune_years),
            "calib_years": list(config.calib_years),
        },
        metrics=_jsonable(
            {
                "eval_set": config.eval_set,
                "n_events": result.n_events,
                "log_loss": headline.log_loss.value,
                "brier": headline.brier.value,
                "ece": headline.ece,
                "log_loss_market": result.market.log_loss.value if result.market else None,
                "brier_market": result.market.brier.value if result.market else None,
                "decoy_passed": result.decoy.passed,
            }
        ),
        train_from=result.data.first_day,
        train_to=result.data.last_day,
    )
    run = EvalRun(
        version_kind="ml_model",
        ml_model_id=MODEL_ID,
        eval_set=config.eval_set,
        split="test",
        n_events=result.n_events,
        metrics=result.metrics(),
        cost_usd=Decimal(0),
    )
    db.add(run)
    await db.flush()
    return run.id


async def run_backtest(
    config: BacktestConfig | None = None,
    *,
    save: bool = True,
    db_factory: Callable[[], AsyncSession] | None = None,
) -> BacktestResult:
    """Бэктест на данных из БД. save — записать ml_models elo-v1 и eval_runs.
    db_factory — фабрика сеансов; без нее открывается свой движок по настройкам."""
    config = config or BacktestConfig()
    config.validate()
    if db_factory is None:
        db_engine = create_engine()
        try:
            return await run_backtest(config, save=save, db_factory=create_sessionmaker(db_engine))
        finally:
            await db_engine.dispose()
    async with db_factory() as db:
        history = await load_history(db)
        odds = await load_archive_odds(
            db,
            years=config.test_years,
            bookmakers={*config.ref_bookmakers, *config.bet_bookmakers},
        )
        freshness = await load_freshness(db)
    # Счет занимает секунды (бутстрэп): в отдельном потоке он не держит цикл событий
    result = await asyncio.to_thread(
        evaluate,
        history.matches,
        odds,
        config,
        skipped=dict(history.skipped),
        freshness=freshness,
    )
    if save:
        async with db_factory() as db:
            result.eval_run_id = await save_result(db, result)
            await db.commit()
    return result


# --- команда терминала ---


def parse_years(value: str) -> tuple[int, ...]:
    """«2024,2025» или «2024-2025» → (2024, 2025)."""
    years: set[int] = set()
    try:
        for part in value.split(","):
            part = part.strip()
            if not part:
                continue
            first, sep, last = part.partition("-")
            low = int(first)
            high = int(last) if sep else low
            if low > high:
                raise ValueError(value)
            years.update(range(low, high + 1))
    except ValueError:
        years = set()
    if not years or min(years) < 1968 or max(years) > 2100:
        raise ValueError(t("backtest.errors.years", value=value))
    return tuple(sorted(years))


def _years_arg(value: str) -> tuple[int, ...]:
    try:
        return parse_years(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.ml.backtest", description=t("backtest.cli.description")
    )
    parser.add_argument(
        "--report", metavar=t("backtest.cli.metavar_path"), help=t("backtest.cli.help_report")
    )
    parser.add_argument(
        "--test-years",
        type=_years_arg,
        metavar=t("backtest.cli.metavar_years"),
        help=t("backtest.cli.help_test_years"),
    )
    parser.add_argument("--no-save", action="store_true", help=t("backtest.cli.help_no_save"))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Код возврата: 0 — отчет готов, 1 — ошибка."""
    args = build_parser().parse_args(argv)
    try:
        config = (
            BacktestConfig.for_test_years(args.test_years) if args.test_years else BacktestConfig()
        )
        result = asyncio.run(run_backtest(config, save=not args.no_save))
    except BacktestError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except (DBAPIError, OSError):
        # DBAPIError — общий класс ошибок драйвера: нет связи, неверный пароль, нет базы
        # или таблиц. Текст исключения не печатаем: в нем бывает адрес базы с паролем
        print(t("backtest.errors.db_unavailable"), file=sys.stderr)
        return 1
    markdown = render_markdown(result)
    lines = summary_lines(result)
    if args.report == "-":
        # stdout занят отчетом (его сохраняют перенаправлением, deploy/local.sh backtest),
        # короткий вывод — в stderr, на экран
        print(markdown, flush=True)
        if result.eval_run_id is not None:
            lines.append(t("backtest.cli.eval_run", id=result.eval_run_id))
        print("\n".join(lines), file=sys.stderr, flush=True)
        return 0
    if args.report:
        path = Path(args.report)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(markdown, encoding="utf-8")
        except OSError:
            print(t("backtest.errors.report_write", path=path), file=sys.stderr)
            return 1
        lines.append(t("backtest.cli.saved", path=path))
    if result.eval_run_id is not None:
        lines.append(t("backtest.cli.eval_run", id=result.eval_run_id))
    print("\n".join(lines), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
