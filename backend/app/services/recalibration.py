"""Еженедельная перекалибровка базовой модели (этап 5, В6 Р25, Т12, Т13; LLM_LEARNING.md,
6.1) и проверка по месяцам (walk-forward).

Модель та же — Эло по покрытиям (elo-v1); перекалибровка подбирает заново только
калибровку Платта на свежих матчах. Данные — сыгранные матчи основного тура архива за
WINDOW_DAYS до сегодня: прогноз до матча (рейтинги строго до дня матча с весом покрытия),
сторона — side_flip по id матча (в архиве игрок 1 — победитель). Матчи по дням делятся:
последние HOLDOUT_SHARE дней — отложенная часть, на остальных подбирается калибровка.

Новая версия (ml_models: калибровка с id elo-v1@ДЕНЬ, app/ml/model_versions.py)
включается сама, если на отложенной части она не хуже прежней: верхняя граница 95% ДИ
разницы лог-лосса (новая − прежняя, парный блочный по дням бутстрэп) не выше +0,01 и
Brier — не выше +0,005 (правило TOKEN_ECONOMY.md, 2.4). Иначе версия rejected с причиной.
Администраторам — уведомление в обоих случаях; вернуть прежнюю — одним действием
(rollback). Новые признаки, другой тип модели и предел поправки Claude — только решением
администратора (здесь их нет).

Проверка по месяцам: для каждого из WALK_MONTHS последних месяцев калибровка подбирается
только на матчах до начала месяца, Brier и лог-лосс считаются на матчах месяца; рынок —
кэфы архива tennis-data без маржи (момент снятия не проверен).

Первая перекалибровка переносит калибровку elo-v1 в версию с датой (базовая версия),
чтобы было с чем сравнивать и куда откатываться.

Вместе с калибровкой подбирается поправка модели сетов (params.sets_platt, app/ml/sets.py):
Платт на p(−1.5) по формату на тех же обучающих матчах с полным счетом. Новая пара чисел
формата берется, если на отложенной части Brier форы −1.5 с ней не выше, чем с прежней, и
матчей формата хватает (MIN_SETS_MATCHES для подбора, MIN_HOLDOUT для проверки); иначе
остается прежняя (у версии без своих чисел — SETS_PLATT). Включение версии решает правило
калибровки выше; числа сетов идут вместе с ней.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import structlog
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import Match, MlModel, Prediction, User
from app.ml.backtest import (
    BacktestConfig,
    PlattScaling,
    SetsSample,
    fit_platt,
    fit_sets_platt,
    sets_arrays,
    sets_brier,
    side_flip,
)
from app.ml.elo import MODEL_ID, win_probability
from app.ml.lesson_scope import ratings_select
from app.ml.metrics import (
    BOOTSTRAP_SAMPLES,
    block_bootstrap_diff_ci,
    brier,
    brier_losses,
    calibration_table,
    ece,
    log_loss,
    log_losses,
)
from app.ml.model_versions import CALIBRATION_KIND, SETS_KEY, active_calibration, version_id
from app.ml.sets import (
    BEST_OF,
    SetCount,
    SetsCalibration,
    complete_for,
    set_count_from_score,
    sets_calibration_json,
    sets_calibration_of,
)
from app.schemas.learning import (
    CalibrationPointOut,
    CiNumOut,
    MlModelOut,
    MlRuleOut,
    MlVersionOut,
    RecalibrationOut,
    WalkForwardOut,
)
from app.services.audit import write_audit
from app.services.dossier import calibrated_p1
from app.services.eval_sets import archive_market
from app.services.lesson_check import elo_model, read_only
from app.services.model_alerts import notify_admins
from app.services.sessions import utcnow

log = structlog.get_logger(__name__)

WINDOW_DAYS = 730
HOLDOUT_SHARE = 0.25
MIN_TRAIN = 50
MIN_HOLDOUT = 30
LOG_LOSS_MARGIN = 0.01
BRIER_MARGIN = 0.005
WALK_MONTHS = 6
SEED = 20261019
CALIBRATION_WIDTH = 0.1
LOCK = 0x6D6C7265636C6201
LEARNING_LINK = "/learning"


@dataclass(frozen=True)
class Sample:
    """Матч: день, вероятность модели до калибровки для стороны side_flip, исход этой
    стороны и рынок архива без маржи для нее (None — кэфов нет). best_of и count —
    формат и сеты стороны и соперника (None — счет неполный): для поправки модели сетов."""

    match_id: int
    day: date
    p_raw: float
    y: int
    q: float | None
    best_of: int = 3
    count: SetCount | None = None


async def samples(db: AsyncSession, *, since: date, until: date) -> list[Sample]:
    """Матчи основного тура архива с днем в [since, until) по дням."""
    model, _ = await elo_model(db)
    rows = await read_only(
        db,
        ratings_select(model=model, since=since, until=until, levels=BacktestConfig().levels),
    )
    market = await archive_market(db, [int(row["match_id"]) for row in rows])
    found: list[Sample] = []
    for row in rows:
        match_id = int(row["match_id"])
        flip = side_flip(match_id)
        r1, r2 = float(row["r1"]), float(row["r2"])
        side_player = row["p2"] if flip else row["p1"]
        p_raw = win_probability(r2, r1) if flip else win_probability(r1, r2)
        q1 = market.get(match_id)
        won = row["winner_id"] == side_player
        best_of = int(row["best_of"]) if row["best_of"] in BEST_OF else 3
        count = set_count_from_score(row["score"], winner_is_first=won)
        found.append(
            Sample(
                match_id=match_id,
                day=row["day"],
                p_raw=p_raw,
                y=1 if won else 0,
                q=None if q1 is None else (1.0 - q1 if flip else q1),
                best_of=best_of,
                count=count if complete_for(count, best_of) else None,
            )
        )
    return sorted(found, key=lambda item: (item.day, item.match_id))


def split_holdout(items: Sequence[Sample], share: float = HOLDOUT_SHARE) -> tuple[int, date | None]:
    """Граница отложенной части по дням: (номер первого отложенного матча, его день)."""
    days = sorted({item.day for item in items})
    if not days:
        return len(items), None
    first = days[min(len(days) - 1, int(len(days) * (1.0 - share)))]
    for index, item in enumerate(items):
        if item.day >= first:
            return index, first
    return len(items), None


def _probs(items: Sequence[Sample], platt: PlattScaling | None) -> list[float]:
    return [calibrated_p1(item.p_raw, platt) for item in items]


def _sets_samples(items: Sequence[Sample], platt: PlattScaling | None) -> list[SetsSample]:
    """Матчи с полным счетом для поправки модели сетов: p стороны — после калибровки."""
    return [
        SetsSample(calibrated_p1(item.p_raw, platt), item.best_of, item.count)
        for item in items
        if item.count is not None
    ]


def choose_sets(
    train: Sequence[Sample],
    holdout: Sequence[Sample],
    platt: PlattScaling | None,
    previous: SetsCalibration,
) -> tuple[SetsCalibration, dict[str, Any]]:
    """Поправка модели сетов новой версии по формату (правило — в docstring модуля) и
    числа для metrics.sets: подбор, Brier форы −1.5 на отложенной части с новой и прежней
    парой, что взято."""
    fitted = fit_sets_platt(_sets_samples(train, platt))
    test = _sets_samples(holdout, platt)
    chosen = dict(previous)
    report: dict[str, Any] = {}
    for best_of in BEST_OF:
        n_holdout = sets_arrays(test, best_of)[0].size // 2
        new = fitted.get(best_of)
        prev_brier = sets_brier(test, best_of, previous) if n_holdout else None
        new_brier = (
            sets_brier(test, best_of, {**previous, best_of: new})
            if new is not None and n_holdout
            else None
        )
        taken = (
            new is not None
            and new_brier is not None
            and prev_brier is not None
            and n_holdout >= MIN_HOLDOUT
            and new_brier <= prev_brier
        )
        if taken and new is not None:
            chosen[best_of] = new
        report[str(best_of)] = {
            "fitted": new.to_json() if new is not None else None,
            "n_holdout": n_holdout,
            "brier": new_brier,
            "prev_brier": prev_brier,
            "taken": taken,
        }
    return chosen, report


def _fit(items: Sequence[Sample]) -> PlattScaling | None:
    y = [item.y for item in items]
    if len(items) < MIN_TRAIN or min(y) == max(y):
        return None
    return fit_platt([item.p_raw for item in items], y)


def _months_back(today: date, count: int) -> list[date]:
    first = today.replace(day=1)
    months = []
    for _ in range(count):
        first = (first - timedelta(days=1)).replace(day=1)
        months.append(first)
    return sorted(months)


def _next_month(day: date) -> date:
    return (day.replace(day=28) + timedelta(days=4)).replace(day=1)


def walk_forward(items: Sequence[Sample], *, today: date) -> list[dict[str, Any]]:
    """Проверка по месяцам: калибровка — на матчах за WINDOW_DAYS до месяца, метрики — на
    матчах месяца (модель и рынок архива)."""
    found: list[dict[str, Any]] = []
    for month in _months_back(today, WALK_MONTHS):
        end = _next_month(month)
        train = [item for item in items if month - timedelta(days=WINDOW_DAYS) <= item.day < month]
        test = [item for item in items if month <= item.day < end]
        if not test:
            continue
        platt = _fit(train)
        p = _probs(test, platt)
        y = [item.y for item in test]
        with_market = [item for item in test if item.q is not None]
        found.append(
            {
                "month": month.isoformat(),
                "n": len(test),
                "model_brier": brier(p, y),
                "model_log_loss": log_loss(p, y),
                "market_n": len(with_market),
                "market_brier": brier(
                    [float(item.q or 0) for item in with_market], [item.y for item in with_market]
                )
                if with_market
                else None,
            }
        )
    return found


def _ci(estimate: Any) -> dict[str, Any]:
    return {"value": estimate.value, "low": estimate.low, "high": estimate.high, "n": estimate.n}


def _platt_of(params: dict[str, Any] | None) -> PlattScaling | None:
    raw = (params or {}).get("platt")
    if not isinstance(raw, dict):
        return None
    try:
        return PlattScaling(a=float(raw["a"]), b=float(raw["b"]))
    except (KeyError, TypeError, ValueError):
        return None


async def _free_id(db: AsyncSession, day: date) -> str:
    number = 1
    while await db.get(MlModel, version_id(day.isoformat(), number)) is not None:
        number += 1
    return version_id(day.isoformat(), number)


async def ensure_baseline(db: AsyncSession) -> MlModel | None:
    """Активная версия калибровки; нет — калибровка elo-v1 переносится в версию с датой
    (дата последних данных модели). Нет elo-v1 — None. flush."""
    found = await active_calibration(db)
    if found is not None:
        return found
    base = await db.get(MlModel, MODEL_ID)
    if base is None:
        return None
    day = base.train_to or (base.created_at.date() if base.created_at else utcnow().date())
    platt = _platt_of(base.params)
    version = MlModel(
        id=await _free_id(db, day),
        kind=CALIBRATION_KIND,
        train_from=base.train_from,
        train_to=base.train_to,
        feature_set=base.feature_set,
        params={"base": MODEL_ID, "platt": {"a": platt.a, "b": platt.b} if platt else None},
        metrics={**(base.metrics or {}), "source": "elo-v1"},
        status="active",
        activated_at=utcnow(),
    )
    db.add(version)
    await db.flush()
    return version


async def recalibrate(
    db: AsyncSession, *, actor_id: int | None = None, today: date | None = None
) -> RecalibrationOut:
    """Перекалибровка и решение по правилу В6 (в docstring модуля). Одна за раз
    (рекомендательная блокировка). commit."""
    day = today or utcnow().date()
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK})
    current = await ensure_baseline(db)
    if current is None:
        await db.commit()
        return RecalibrationOut(decision="skipped", reason="ml.no_model", version=None)
    data = await samples(db, since=day - timedelta(days=WINDOW_DAYS + 31 * WALK_MONTHS), until=day)
    window = [item for item in data if item.day >= day - timedelta(days=WINDOW_DAYS)]
    cut, holdout_from = split_holdout(window)
    train, holdout = window[:cut], window[cut:]
    new_platt = _fit(train)
    if new_platt is None or len(holdout) < MIN_HOLDOUT:
        await db.commit()
        return RecalibrationOut(decision="skipped", reason="ml.too_few", version=None)
    old_platt = _platt_of(current.params)
    sets, sets_report = choose_sets(
        train, holdout, new_platt, sets_calibration_of((current.params or {}).get(SETS_KEY))
    )
    y = [item.y for item in holdout]
    days = [item.day.isoformat() for item in holdout]
    p_new, p_old = _probs(holdout, new_platt), _probs(holdout, old_platt)
    ll_new, ll_old = log_losses(p_new, y), log_losses(p_old, y)
    br_new, br_old = brier_losses(p_new, y), brier_losses(p_old, y)
    diff_ll = block_bootstrap_diff_ci(ll_new, ll_old, days, n=BOOTSTRAP_SAMPLES, seed=SEED)
    diff_br = block_bootstrap_diff_ci(br_new, br_old, days, n=BOOTSTRAP_SAMPLES, seed=SEED)
    passed = diff_ll.high <= LOG_LOSS_MARGIN and diff_br.high <= BRIER_MARGIN
    reason = None if passed else ("log_loss" if diff_ll.high > LOG_LOSS_MARGIN else "brier")
    table = calibration_table(p_new, y, bin_width=CALIBRATION_WIDTH)
    moment = utcnow()
    version = MlModel(
        id=await _free_id(db, day),
        kind=CALIBRATION_KIND,
        train_from=train[0].day,
        train_to=train[-1].day,
        feature_set=current.feature_set,
        params={
            "base": MODEL_ID,
            "platt": {"a": new_platt.a, "b": new_platt.b},
            SETS_KEY: sets_calibration_json(sets),
        },
        metrics={
            "n_train": len(train),
            "n_holdout": len(holdout),
            "holdout_from": holdout_from.isoformat() if holdout_from else None,
            "brier": float(br_new.mean()),
            "log_loss": float(ll_new.mean()),
            "ece": ece(p_new, y),
            "prev_brier": float(br_old.mean()),
            "prev_log_loss": float(ll_old.mean()),
            "diff_log_loss": _ci(diff_ll),
            "diff_brier": _ci(diff_br),
            "calibration": [
                {
                    "low": row.low,
                    "high": row.high,
                    "n": row.n,
                    "p": row.mean_p,
                    "actual": row.rate,
                    "ci_low": row.ci_low,
                    "ci_high": row.ci_high,
                }
                for row in table
            ],
            "walk_forward": walk_forward(data, today=day),
            "sets": sets_report,
            "seed": SEED,
            "rule": {"log_loss_margin": LOG_LOSS_MARGIN, "brier_margin": BRIER_MARGIN},
            "reason": reason,
            "started_by": actor_id,
            # Сама — по расписанию воркера; по кнопке администратора — ручная
            "auto": actor_id is None,
        },
        status="rejected",
        parent_id=current.id,
    )
    if passed:
        current.status = "archived"
        await db.flush()
        version.status = "active"
        version.activated_at = moment
        version.activated_by = actor_id
    db.add(version)
    await db.flush()
    await write_audit(
        db,
        action="model_on",
        actor_id=actor_id,
        details={
            "model": version.id,
            "step": "recalibrate",
            "activated": passed,
            "previous": current.id,
        },
        ip=None,
    )
    await notify_admins(
        db,
        variant="model_recalibrated" if passed else "model_rejected",
        link=LEARNING_LINK,
        model=version.id,
        brier=f"{float(br_new.mean()):.4f}".replace(".", ","),
        prev=f"{float(br_old.mean()):.4f}".replace(".", ","),
    )
    await db.commit()
    log.info("ml.recalibrated", model=version.id, activated=passed, reason=reason)
    return RecalibrationOut(
        decision="activated" if passed else "rejected",
        reason=None if passed else f"ml.worse_{reason}",
        version=version_out(version, active_id=version.id if passed else current.id),
    )


async def rollback(db: AsyncSession, admin: User, model_id: str, *, ip: str | None) -> MlModelOut:
    """Вернуть версию калибровки, которая уже была активной: она снова активна, нынешняя
    — в архив. Журнал model_on. commit."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK})
    target = await db.get(MlModel, model_id, with_for_update=True, populate_existing=True)
    if target is None or target.kind != CALIBRATION_KIND:
        raise AppError(404, "ml.not_found")
    if target.status != "archived" or target.activated_at is None:
        raise AppError(409, "ml.cannot_rollback")
    current = await active_calibration(db)
    if current is not None:
        current.status = "archived"
        await db.flush()
    target.status = "active"
    target.activated_at = utcnow()
    target.activated_by = admin.id
    await db.flush()
    await write_audit(
        db,
        action="model_on",
        actor_id=admin.id,
        details={
            "model": target.id,
            "step": "rollback",
            "previous": current.id if current is not None else None,
        },
        ip=ip,
    )
    await db.commit()
    return await model_out(db)


# --- для экранов ---


def _ci_out(raw: Any) -> CiNumOut | None:
    return CiNumOut(**raw) if isinstance(raw, dict) else None


def is_auto(model: MlModel) -> bool:
    """Версия включена (или посчитана) сама — по расписанию, без администратора: не
    перекалибровка по кнопке и не возврат."""
    metrics = model.metrics or {}
    return (
        model.activated_by is None
        and metrics.get("started_by") is None
        and metrics.get("auto") is not False
    )


def version_out(model: MlModel, *, active_id: str | None) -> MlVersionOut:
    metrics = model.metrics or {}
    platt = _platt_of(model.params)
    return MlVersionOut(
        id=model.id,
        status=model.status,  # type: ignore[arg-type]
        created_at=model.created_at,
        activated_at=model.activated_at,
        auto=is_auto(model),
        parent_id=model.parent_id,
        train_from=model.train_from,
        train_to=model.train_to,
        n_train=int(metrics.get("n_train") or 0),
        n_holdout=int(metrics.get("n_holdout") or metrics.get("n_events") or 0),
        brier=metrics.get("brier"),
        log_loss=metrics.get("log_loss"),
        ece=metrics.get("ece"),
        prev_brier=metrics.get("prev_brier"),
        prev_log_loss=metrics.get("prev_log_loss"),
        diff_log_loss=_ci_out(metrics.get("diff_log_loss")),
        diff_brier=_ci_out(metrics.get("diff_brier")),
        platt_a=platt.a if platt else None,
        platt_b=platt.b if platt else None,
        reason=metrics.get("reason"),
        can_rollback=model.status == "archived"
        and model.activated_at is not None
        and model.id != active_id,
    )


async def events_with_outcome(db: AsyncSession) -> int:
    """Событий с исходами для поправки Claude числом: матчи прогнозов анализов (не
    проверок) с победителем."""
    count = await db.scalar(
        select(func.count(func.distinct(Prediction.match_id)))
        .join(Match, Match.id == Prediction.match_id)
        .where(Prediction.is_eval.is_(False), Match.winner_id.is_not(None))
    )
    return int(count or 0)


def next_monday(day: date) -> date:
    return day + timedelta(days=(7 - day.weekday()) % 7 or 7)


async def model_out(db: AsyncSession, *, today: date | None = None) -> MlModelOut:
    """«Базовая модель»: версии калибровки, проверка по месяцам и калибровка (из
    последней посчитанной версии), события для поправки Claude."""
    from app.agent.config import load_agent_config

    config = await load_agent_config(db)
    day = today or utcnow().date()
    rows = list(
        await db.scalars(
            select(MlModel)
            .where(MlModel.kind == CALIBRATION_KIND)
            .order_by(MlModel.created_at.desc(), MlModel.id.desc())
        )
    )
    active = next((row for row in rows if row.status == "active"), None)
    active_id = active.id if active is not None else None
    computed = next((row for row in rows if (row.metrics or {}).get("walk_forward")), None)
    source = active if active is not None and (active.metrics or {}).get("calibration") else None
    source = source or computed
    metrics = (source.metrics or {}) if source is not None else {}
    return MlModelOut(
        active=version_out(active, active_id=active_id) if active is not None else None,
        versions=[version_out(row, active_id=active_id) for row in rows],
        walk_forward=[
            WalkForwardOut(
                month=date.fromisoformat(item["month"]),
                n=int(item["n"]),
                model_brier=item.get("model_brier"),
                model_log_loss=item.get("model_log_loss"),
                market_n=int(item.get("market_n") or 0),
                market_brier=item.get("market_brier"),
            )
            for item in (computed.metrics or {}).get("walk_forward") or []
        ]
        if computed is not None
        else [],
        calibration=[CalibrationPointOut(**row) for row in metrics.get("calibration") or []],
        events_with_outcome=await events_with_outcome(db),
        claude_min_events=config.claude_min_events,
        rule=MlRuleOut(
            log_loss_margin=LOG_LOSS_MARGIN, brier_margin=BRIER_MARGIN, holdout_share=HOLDOUT_SHARE
        ),
        next_run=next_monday(day),
    )
