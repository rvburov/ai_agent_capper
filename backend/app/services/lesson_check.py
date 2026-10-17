"""Проверка урока кодом, бесплатно (этап 5, п. 8; LLM_LEARNING.md, 1.1 и раздел 5).

Случаи условия урока (app/ml/lesson_scope.py) берутся запросом только для чтения: точка
сохранения той же сессии в режиме READ ONLY (запись в нем база отвергает) с пределом
времени. SQL собирает код
из словаря, значения условия — параметры запроса.

Свои случаи — ноги рассчитанных ставок приложения под условием (считаются матчи). Проверка
на истории начинается с lesson_min_cases своих случаев (решает app/services/lessons.py).

История — сыгранные матчи архива за HISTORY_YEARS лет до сегодня, кроме матчей
замороженных eval-наборов (на них сравниваются версии инструкций). Вероятность случая —
прогноз базовой модели до матча (out-of-sample по времени: рейтинги Эло из player_ratings
строго до дня матча, вес покрытия и калибровка Платта — из ml_models, как в досье),
для фор — модель сетов. Случаи по дням делятся на историю и отложенную часть (последние
HOLDOUT_SHARE).

На истории:
- остаток y − p и его 95% ДИ (бутстрэп с seed) — смещение модели в условии (effect);
- поправка с усадкой shift = effect · n / (n + k), n — случаев истории архива (n_shrink;
  свои случаи в формулу не входят: основание проверки одно для всех и не выдает, сколько
  ставок у других участников), k — lesson_shrink_k (effect_shrunk);
- лог-лосс без урока и с поправкой и парный бутстрэп-ДИ выигрыша
  (без − с; больше нуля — урок помогает).
На отложенной части — выигрыш лог-лосса от той же поправки (holdout_effect, ДИ).

Решение: ready — смещение в сторону урока и его ДИ не задевает ноль, ДИ выигрыша на
истории выше нуля и выигрыш на отложенной части больше нуля; rejected — иначе;
insufficient — случаев на истории или в отложенной части меньше MIN_HISTORY или
MIN_HOLDOUT (урок остается гипотезой). Бутстрэп детерминирован (seed в отчете).
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

import numpy as np
from sqlalchemy import RowMapping, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql import Select

from app.db.models import BetLeg, EvalSet, EvalSetItem
from app.ml.backtest import PlattScaling
from app.ml.elo import EloParams, win_probability
from app.ml.lesson_scope import EloModel, Scope, cases_select
from app.ml.metrics import (
    BOOTSTRAP_SAMPLES,
    Estimate,
    bootstrap_diff_ci,
    bootstrap_mean_ci,
    clip_probabilities,
    log_losses,
)
from app.ml.model_versions import SETS_KEY
from app.ml.sets import (
    MARKET_MINUS,
    MARKET_ML,
    MARKET_PLUS,
    SETS_PLATT,
    SetsCalibration,
    base_probs,
    leg_result,
    set_count_from_score,
    sets_calibration_of,
)
from app.services.dossier import calibrated_p1, model_params

METHOD = "elo_prematch"
HISTORY_YEARS = 8
HOLDOUT_SHARE = 0.25
MIN_HISTORY = 200
MIN_HOLDOUT = 50
SEED = 20261015
# Предел запроса случаев: признаки — подзапросы на каждую сторону матча
STATEMENT_TIMEOUT_MS = 120_000
Status = Literal["ready", "rejected", "insufficient"]


# --- запросы только для чтения ---


async def read_only(db: AsyncSession, stmt: Select[*tuple[Any, ...]]) -> list[RowMapping]:
    """Запрос в точке сохранения той же сессии, переведенной в READ ONLY с пределом времени:
    база сама отвергнет любую запись. Второе соединение пула не берется: вызывающий может
    держать блокировку, и ожидание соединения под ней исчерпало бы пул (замечание M6
    волны 2). После запроса точка сохранения откатывается: режим и предел снимаются."""
    nested = await db.begin_nested()
    try:
        await db.execute(text("SET LOCAL transaction_read_only = on"))
        await db.execute(text(f"SET LOCAL statement_timeout = {int(STATEMENT_TIMEOUT_MS)}"))
        rows = list((await db.execute(stmt)).mappings().all())
    finally:
        await nested.rollback()
    return rows


async def elo_model(db: AsyncSession) -> tuple[EloModel, PlattScaling | None]:
    """Вес покрытия, начальный рейтинг и калибровка базовой модели (как в досье)."""
    return elo_model_of(await model_params(db))


def elo_model_of(params: dict[str, Any]) -> tuple[EloModel, PlattScaling | None]:
    """То же по готовым параметрам (снимок модели, закрепленный за набором)."""
    weight = float(params.get("surface_weight", EloParams.surface_weight))
    initial = float(params.get("initial", EloParams.initial))
    platt: PlattScaling | None = None
    raw = params.get("platt")
    if isinstance(raw, dict):
        try:
            platt = PlattScaling(a=float(raw["a"]), b=float(raw["b"]))
        except (KeyError, TypeError, ValueError):
            platt = None
    return EloModel(weight=weight, initial=initial), platt


# --- случаи ---


@dataclass(frozen=True)
class Case:
    """Случай истории: исход (рынок, сторона) матча, прогноз модели до матча и исход."""

    match_id: int
    day: date
    p: float
    y: int


def selection_prob(
    p_side: float, best_of: int, market: str, calibration: SetsCalibration = SETS_PLATT
) -> float:
    """Вероятность исхода стороны по ее вероятности победы в матче (модель сетов с
    поправкой p(−1.5) по формату, как в досье)."""
    probs = base_probs(p_side, best_of if best_of in (3, 5) else 3, calibration)
    if market == MARKET_ML:
        return probs.p1_win
    if market == MARKET_MINUS:
        return probs.p1_cover
    if market == MARKET_PLUS:
        return 1.0 - probs.p2_cover
    raise ValueError(market)


def selection_outcome(row: RowMapping, market: str) -> int | None:
    """Исход стороны: 1 — сыграл. Форы — по счету архива; неполный счет — None."""
    won = row["winner_id"] == row["pid"]
    if market == MARKET_ML:
        return int(won)
    best_of = row["best_of"] if row["best_of"] in (3, 5) else 3
    count = set_count_from_score(row["score"], winner_is_first=won)
    result = leg_result(market, 1, count, best_of)
    if result is None:
        return None
    return int(result == "win")


def archive_cases(
    rows: Sequence[RowMapping],
    scope: Scope,
    platt: PlattScaling | None,
    calibration: SetsCalibration = SETS_PLATT,
) -> list[Case]:
    found: list[Case] = []
    for row in rows:
        p_raw = win_probability(float(row["r_side"]), float(row["r_opp"]))
        p_side = calibrated_p1(p_raw, platt)
        for market in scope.markets():
            y = selection_outcome(row, market)
            if y is None:
                continue
            p = selection_prob(p_side, int(row["best_of"] or 3), market, calibration)
            found.append(Case(int(row["match_id"]), row["day"], p, y))
    return found


async def frozen_match_ids(db: AsyncSession) -> set[int]:
    """Матчи всех замороженных eval-наборов: на них сравниваются версии инструкций."""
    return set(
        await db.scalars(
            select(EvalSetItem.match_id)
            .join(EvalSet, EvalSet.id == EvalSetItem.eval_set_id)
            .where(EvalSet.frozen_at.is_not(None))
        )
    )


async def history_cases(db: AsyncSession, scope: Scope, *, today: date) -> list[Case]:
    """Случаи истории урока без матчей замороженных наборов (M1 волны 3): поправка урока
    подбирается и отбирается не на тех матчах, на которых потом сравнивается кандидат
    инструкций с этим уроком, — исходы набора не протекают в инструкции."""
    params = await model_params(db)
    model, platt = elo_model_of(params)
    calibration = sets_calibration_of(params.get(SETS_KEY))
    since = today - timedelta(days=365 * HISTORY_YEARS)
    rows = await read_only(db, cases_select(scope, model=model, since=since, until=today))
    frozen = await frozen_match_ids(db)
    kept = [row for row in rows if int(row["match_id"]) not in frozen]
    return archive_cases(kept, scope, platt, calibration)


@dataclass(frozen=True)
class OwnCases:
    """Свои случаи: матчи под условием (n), ноги, ставки и прогнозы-источники, средний
    остаток y − p итоговой вероятности по ногам с прогнозом."""

    n: int
    leg_ids: tuple[int, ...] = ()
    bet_ids: tuple[int, ...] = ()
    prediction_ids: tuple[int, ...] = ()
    residual: float | None = None
    legs: int = 0


async def own_cases(db: AsyncSession, scope: Scope) -> OwnCases:
    model, _ = await elo_model(db)
    rows = await read_only(db, cases_select(scope, model=model, own=True))
    if not rows:
        return OwnCases(0)
    leg_ids = sorted({int(row["leg_id"]) for row in rows})
    links = (
        await db.execute(
            select(BetLeg.id, BetLeg.bet_id, BetLeg.prediction_id).where(BetLeg.id.in_(leg_ids))
        )
    ).all()
    residuals = [
        (1.0 if row["leg_result"] == "win" else 0.0) - float(row["p_own"])
        for row in rows
        if row["p_own"] is not None
    ]
    return OwnCases(
        n=len({int(row["match_id"]) for row in rows}),
        leg_ids=tuple(leg_ids),
        bet_ids=tuple(sorted({bet_id for _, bet_id, _ in links})),
        prediction_ids=tuple(sorted({pid for _, _, pid in links if pid is not None})),
        residual=float(np.mean(residuals)) if residuals else None,
        legs=len(rows),
    )


async def leg_features(db: AsyncSession, leg_ids: Sequence[int]) -> dict[int, dict[str, Any]]:
    """Признаки словаря у своих ног (факты разбора): нога → признак → значение."""
    if not leg_ids:
        return {}
    model, _ = await elo_model(db)
    rows = await read_only(db, cases_select(None, model=model, own=True, leg_ids=leg_ids))
    return {int(row["leg_id"]): _feature_row(row) for row in rows}


def _feature_row(row: RowMapping) -> dict[str, Any]:
    odds = row["odds"]
    return {
        "market": row["market"] or MARKET_ML,
        "surface": row["surface"],
        "round": row["round"] or None,
        "best_of": int(row["best_of"]) if row["best_of"] else None,
        "role": row["role"],
        "elo_gap": round(float(row["elo_gap"])) if row["elo_gap"] is not None else None,
        "odds": float(odds) if odds is not None else None,
        "sets_48h": row["sets_48h"],
        "opp_sets_48h": row["opp_sets_48h"],
        "rest_days": row["rest_days"],
        "h2h_matches": row["h2h_matches"],
        "h2h_wins": row["h2h_wins"],
    }


@dataclass(frozen=True)
class MatchSide:
    """Сторона матча для общего разбора: признаки словаря (рынок ML) и вероятность победы
    по базовой модели до матча (рейтинги Эло строго до дня матча, калибровка — как в
    досье)."""

    features: dict[str, Any]
    p_base: float


async def match_sides(
    db: AsyncSession, match_ids: Sequence[int]
) -> dict[tuple[int, int], MatchSide]:
    """Признаки и p_base обеих сторон матчей: (матч, сторона) → MatchSide. Только архив и
    данные до матча, без ставок и прогнозов участников. p_base стороны 2 — 1 − p_base
    стороны 1 (калибровка Платта — к игроку 1, как в досье)."""
    if not match_ids:
        return {}
    model, platt = await elo_model(db)
    rows = await read_only(db, cases_select(None, model=model, match_ids=match_ids))
    first: dict[int, float] = {}
    for row in rows:
        if int(row["side"]) == 1:
            p_raw = win_probability(float(row["r_side"]), float(row["r_opp"]))
            first[int(row["match_id"])] = calibrated_p1(p_raw, platt)
    found: dict[tuple[int, int], MatchSide] = {}
    for row in rows:
        match_id, side = int(row["match_id"]), int(row["side"])
        if match_id not in first:
            continue
        p1 = first[match_id]
        found[(match_id, side)] = MatchSide(
            features=_feature_row(row), p_base=p1 if side == 1 else 1.0 - p1
        )
    return found


# --- статистика ---


def shrink(effect: float, n: int, k: int) -> float:
    """Поправка с усадкой к нулю: effect · n / (n + k)."""
    return effect * n / (n + k) if n + k > 0 else 0.0


def _estimate(value: Estimate | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {"value": value.value, "low": value.low, "high": value.high, "n": value.n}


@dataclass(frozen=True)
class HistoryCheck:
    """Итог проверки на истории (что пишется в lessons и lessons.metrics.history)."""

    status: Status
    reason: str | None
    n_hist: int
    n_history: int = 0
    n_holdout: int = 0
    n_shrink: int = 0
    holdout_since: date | None = None
    bias: Estimate | None = None
    shift: float | None = None
    log_loss_without: float | None = None
    log_loss_with: float | None = None
    gain: Estimate | None = None
    holdout_gain: Estimate | None = None
    seed: int = SEED
    samples: int = BOOTSTRAP_SAMPLES
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "method": METHOD,
            "status": self.status,
            "reason": self.reason,
            "n_hist": self.n_hist,
            "n_history": self.n_history,
            "n_holdout": self.n_holdout,
            "n_shrink": self.n_shrink,
            "holdout_since": self.holdout_since.isoformat() if self.holdout_since else None,
            "bias": _estimate(self.bias),
            "shift": self.shift,
            "log_loss_without": self.log_loss_without,
            "log_loss_with": self.log_loss_with,
            "gain": _estimate(self.gain),
            "holdout_gain": _estimate(self.holdout_gain),
            "seed": self.seed,
            "samples": self.samples,
            **self.extra,
        }


def _shifted(p: Any, shift: float) -> Any:
    """Вероятности с поправкой урока, обрезанные в [0, 1] (и от краев — для лог-лосса)."""
    return clip_probabilities(np.clip(p + shift, 0.0, 1.0))


def evaluate(
    cases: Sequence[Case],
    scope: Scope,
    *,
    shrink_k: int,
    seed: int = SEED,
    samples: int = BOOTSTRAP_SAMPLES,
) -> HistoryCheck:
    """Проверка на истории и отложенной части (правила — в docstring модуля)."""
    ordered = sorted(cases, key=lambda item: (item.day, item.match_id))
    total = len(ordered)
    if total == 0:
        return HistoryCheck("insufficient", "no_history", 0, seed=seed, samples=samples)
    cut = int(total * (1.0 - HOLDOUT_SHARE))
    holdout_since = ordered[min(cut, total - 1)].day
    history = [item for item in ordered if item.day < holdout_since]
    holdout = [item for item in ordered if item.day >= holdout_since]
    if len(history) < MIN_HISTORY or len(holdout) < MIN_HOLDOUT:
        return HistoryCheck(
            "insufficient",
            "few_history",
            total,
            n_history=len(history),
            n_holdout=len(holdout),
            holdout_since=holdout_since,
            seed=seed,
            samples=samples,
        )
    p_h = np.array([item.p for item in history])
    y_h = np.array([item.y for item in history], dtype=np.float64)
    bias = bootstrap_mean_ci(y_h - p_h, n=samples, seed=seed)
    shift = shrink(bias.value, len(history), shrink_k)
    without_h = log_losses(p_h, y_h)
    with_h = log_losses(_shifted(p_h, shift), y_h)
    gain = bootstrap_diff_ci(without_h, with_h, n=samples, seed=seed)
    p_o = np.array([item.p for item in holdout])
    y_o = np.array([item.y for item in holdout], dtype=np.float64)
    holdout_gain = bootstrap_diff_ci(
        log_losses(p_o, y_o), log_losses(_shifted(p_o, shift), y_o), n=samples, seed=seed
    )
    sign = scope.sign()
    status: Status = "ready"
    reason: str | None = None
    if bias.value * sign <= 0:
        status, reason = "rejected", "direction"
    elif (sign < 0 and bias.high >= 0) or (sign > 0 and bias.low <= 0):
        status, reason = "rejected", "no_bias"
    elif gain.low <= 0:
        status, reason = "rejected", "no_gain"
    elif holdout_gain.value <= 0:
        status, reason = "rejected", "holdout"
    return HistoryCheck(
        status,
        reason,
        total,
        n_history=len(history),
        n_holdout=len(holdout),
        n_shrink=len(history),
        holdout_since=holdout_since,
        bias=bias,
        shift=shift,
        log_loss_without=float(without_h.mean()),
        log_loss_with=float(with_h.mean()),
        gain=gain,
        holdout_gain=holdout_gain,
        seed=seed,
        samples=samples,
    )


async def check_history(
    db: AsyncSession, scope: Scope, *, today: date, shrink_k: int
) -> HistoryCheck:
    """Проверка урока на архиве (запрос только для чтения и evaluate)."""
    cases = await history_cases(db, scope, today=today)
    return evaluate(cases, scope, shrink_k=shrink_k)
