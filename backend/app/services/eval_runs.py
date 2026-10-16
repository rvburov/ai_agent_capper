"""Прогон версии инструкций анализа на замороженном eval-наборе (этап 5, Т8, Т10, Т11;
TOKEN_ECONOMY.md, 2.4 и 2.6; LLM_LEARNING.md, 3.4).

Событие — матч набора: досье на день матча без новостей и без данных этого дня (строится
при первом прогоне и дальше общее для всех прогонов набора: сравниваемые версии видят
одно и то же), стороны — side_flip по id матча. Запрос — как оценка матча в анализе
(system версии: промпт и блок уроков — своими точками кэша на 1 час, схема и проверки
кода те же), но через Message Batches API (−50%) и с eval_max_tokens (Т8).

Деньги — из бюджета проверок (app/services/check_runs.py). Прогон идет пакетами до
eval_batch_size событий: следующий пакет отправляется после сбора предыдущего, поэтому
худший случай одного пакета (весь вход по цене записи кэша на 1 час, весь max_tokens,
половина цены) должен помещаться в остаток, а не весь прогон. До запуска экран показывает
цену по живым числам и худший случай (plan). Запуск — администратор с кодом 2FA
(деньги); один прогон за раз. Остаток проверяется и строка пакета пишется под
блокировкой бюджета (lock_budget) до commit — два прогона или прогон и быстрая проверка
не займут один остаток (М1/М2 волны 2). Пакет — строка batch_jobs с детерминированными
custom_id до отправки (идемпотентность, m1 волны 2), отправка без повторов SDK.

Ход: pending (пакет ждет отправки) → running (пакет у Anthropic) → сбор (collect_all,
раз в 15 минут) → следующий пакет (advance: задача run_eval после запуска и каждый сбор
пакетов) … → done. Пакет не ушел (pending без пакета у Anthropic) — пакет отправляется
снова, не больше MAX_ATTEMPTS раз; пакет потерян — прогон failed (деньги, скорее всего,
списаны: резерв держится до конца месяца). Не хватает бюджета на следующий пакет —
прогон ждет (waiting = eval.budget, администратору — уведомление один раз), первый пакет
— прогон failed (ничего не потрачено). Истекшие и сбойные запросы пакета повторяются один
раз отдельным пакетом в конце (не больше eval_batch_size запросов: худший случай до запуска
считается вместе с этим пакетом).

Перед отправкой каждого пакета проверяются статус версии (активная или кандидат, иначе
прогон failed с причиной version_closed) и отмена. Отмена (cancel: администратор или
команда терминала eval-cancel; отклонение кандидата и уход версии в архив — тоже): прогон
без пакета у Anthropic (ждет отправки, бюджета или ключа) сразу abandoned, его резерв
снимается; пакет у Anthropic отменяется (не начатые запросы — canceled, за них не платим),
начатые дособираются и оплачиваются, после сбора прогон abandoned без следующих пакетов.

Итог (summary): оценены n из total, ошибки формата, max_tokens, отказы; лог-лосс, Brier и
ECE p_claude против p_base и рынка архива с парным блочным по дням бутстрэпом (seed),
калибровка, токены и стоимость на событие. После прогона кандидата — сравнение с активной
версией (app/ml/eval_compare.py) в eval_comparisons и уведомление администратору. Ни одна
версия не включается сама: кандидат остается кандидатом.
"""

import asyncio
import contextlib
import math
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, cast

import anthropic
import structlog
from anthropic.types.messages.batch_create_params import Request
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.agent import batches
from app.agent.calls import estimate_tokens
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.prompts import SystemPrompt, system_blocks
from app.agent.runs import price_for
from app.agent.schemas import ASSESSMENT_SCHEMA_VERSION, assessment_schema
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    BatchJob,
    EvalComparison,
    EvalRun,
    EvalSet,
    EvalSetItem,
    Lesson,
    ModelPrice,
    StrategyVersion,
    User,
)
from app.ml import eval_compare
from app.ml.metrics import (
    BOOTSTRAP_SAMPLES,
    block_bootstrap_diff_ci,
    brier,
    calibration_table,
    ece,
    log_losses,
)
from app.ml.model_versions import active_model_id
from app.ml.sets import Probs3
from app.ml.strategy import StrategyParams
from app.schemas.learning import (
    AgreementOut,
    CalibrationPointOut,
    CiNumOut,
    ComparisonOut,
    CostChangeOut,
    CountDiffOut,
    EvalBudgetOut,
    EvalMetricsOut,
    EvalPlanOut,
    EvalRunIn,
    EvalRunOut,
    EvalRunsOut,
    MetricDiffOut,
    VersionEvalOut,
)
from app.services import eval_sets, lesson_quick, smoke_eval
from app.services.admin_confirm import TotpConfirm, check_totp
from app.services.ai_access import usd_text
from app.services.audit import write_audit
from app.services.check_runs import EvalBudget, eval_budget, lock_budget
from app.services.claude_key import key_for
from app.services.model_alerts import notify_admins
from app.services.sessions import utcnow
from app.services.strategy_versions import ACTIVE, CANDIDATE, shared_active, system_prompt_of

log = structlog.get_logger(__name__)

KIND = "eval"
RUN_JOB = "run_eval"
# Сколько раз отправлять пакет, который не ушел (ответа на создание нет, пакета нет)
MAX_ATTEMPTS = 3
BATCH_TIMEOUT_S = 120.0
SEED = eval_compare.SEED
CALIBRATION_WIDTH = 0.1
LEARNING_LINK = "/learning"
# Статусы прогона, которые еще идут (один прогон за раз)
OPEN_STATUSES = ("pending", "running")
# Рекомендательная блокировка расчета сравнения пары прогонов (первый ключ)
COMPARE_LOCK = 0x65766331
# Отметки отмены в metrics: сбор пакета не должен их затереть
CANCEL_KEYS = ("cancel_requested", "cancel_sent", "canceled_by", "cancel_at")


# --- набор и события ---


def custom_id(run_id: int, chunk: int, match_id: int) -> str:
    """id запроса пакета: ^[a-zA-Z0-9_-]{1,64}$."""
    return f"er{run_id}-c{chunk}-m{match_id}"


def parse_custom_id(value: str) -> int | None:
    """custom_id → id матча."""
    try:
        return int(value.rsplit("-m", 1)[1])
    except (IndexError, ValueError):
        return None


def chunks_of(match_ids: Sequence[int], size: int) -> list[list[int]]:
    return [list(match_ids[start : start + size]) for start in range(0, len(match_ids), size)]


async def _items(db: AsyncSession, eval_set_id: int) -> list[EvalSetItem]:
    return list(
        await db.scalars(
            select(EvalSetItem)
            .where(EvalSetItem.eval_set_id == eval_set_id)
            .order_by(EvalSetItem.match_id)
        )
    )


# --- цена и план ---


def budget_out(budget: EvalBudget) -> EvalBudgetOut:
    return EvalBudgetOut(
        budget_usd=budget.budget_usd,
        spent_usd=budget.spent_usd,
        reserved_usd=budget.reserved_usd,
        left_usd=budget.left_usd,
        first_month=budget.first_month,
        next_usd=budget.next_usd,
    )


def per_event_worst(price: ModelPrice, config: AgentConfig, prompt: SystemPrompt) -> Decimal:
    """Худший случай одного события до построения досье: вход по оценке настроек (досье и
    промпт) плюс блок уроков версии."""
    extra = estimate_tokens(prompt.lessons) if prompt.lessons else 0
    return batches.request_worst_usd(
        price,
        input_tokens=config.estimate_analysis_input_tokens + extra,
        max_tokens=config.eval_max_tokens,
        cache_1h=True,
    )


async def _shared_version(db: AsyncSession, version_id: int) -> StrategyVersion:
    found = await db.get(StrategyVersion, version_id, populate_existing=True)
    if found is None or found.user_id is not None:
        raise AppError(404, "strategy.not_found")
    return found


async def running_run(db: AsyncSession) -> EvalRun | None:
    found: EvalRun | None = await db.scalar(
        select(EvalRun)
        .where(EvalRun.metrics["kind"].astext == KIND, EvalRun.status.in_(OPEN_STATUSES))
        .order_by(EvalRun.id)
        .limit(1)
    )
    return found


async def _done_runs(db: AsyncSession, version_id: int, eval_set_id: int) -> list[EvalRun]:
    return list(
        await db.scalars(
            select(EvalRun)
            .where(
                EvalRun.strategy_version_id == version_id,
                EvalRun.eval_set_id == eval_set_id,
                EvalRun.status == "done",
                EvalRun.metrics["kind"].astext == KIND,
            )
            .order_by(EvalRun.id)
        )
    )


async def plan(db: AsyncSession, version_id: int, *, now: datetime | None = None) -> EvalPlanOut:
    """Прогон версии до запуска: события, пакеты, цена, худший случай и бюджет."""
    moment = now or utcnow()
    config = await load_agent_config(db)
    version = await _shared_version(db, version_id)
    prompt = system_prompt_of(version)
    eval_set = await eval_sets.latest_set(db)
    budget = await eval_budget(db, moment)
    events = eval_set.n_events if eval_set is not None else 0
    batch = config.eval_batch_size
    try:
        price: ModelPrice | None = await price_for(db, config.analysis_model)
    except ClaudeStepError:
        price = None
    one_worst = per_event_worst(price, config, prompt) if price is not None else Decimal(0)
    # Пакет повтора истекших и сбойных запросов — не больше eval_batch_size (retry_cap)
    retry = retry_cap(events, batch)
    worst = batches.round_usd(one_worst * (events + retry))
    worst_chunk = batches.round_usd(one_worst * min(batch, events))
    estimate = Decimal(0)
    live: Decimal | None = None
    if price is not None:
        live = await lesson_quick.live_request_usd(db, config.analysis_model)
        one = (
            live
            if live is not None
            else batches.request_estimate_usd(
                price,
                input_tokens=config.estimate_analysis_input_tokens,
                output_tokens=config.estimate_analysis_output_tokens,
            )
        )
        estimate = batches.round_usd(one * events)
    running = await running_run(db)
    done = await _done_runs(db, version.id, eval_set.id) if eval_set is not None else []
    reason: str | None = None
    overlap = await lesson_overlap(db, version, eval_set) if eval_set is not None else None
    if eval_set is None:
        reason = "eval.no_set"
    elif version.status not in (ACTIVE, CANDIDATE):
        reason = "eval.version_closed"
    elif set_seen(eval_set, config.analysis_model):
        reason = "eval.set_model_seen"
    elif overlap is not None:
        reason = "eval.lesson_overlap"
    elif running is not None:
        reason = "eval.run_in_progress"
    elif price is None:
        reason = "ai.no_price"
    elif not await lesson_quick._has_admin_key(db):
        reason = "ai.no_admin_key"
    elif worst_chunk > budget.left_usd:
        reason = "eval.budget"
    return EvalPlanOut(
        version_id=version.id,
        version_code=version.code,
        eval_set=eval_sets.set_out(eval_set) if eval_set is not None else None,
        repeat_no=len(done) + 1,
        events=events,
        chunks=math.ceil(events / batch) if events else 0,
        batch_size=batch,
        model=config.analysis_model,
        max_tokens=config.eval_max_tokens,
        estimate_usd=estimate,
        estimate_source="live" if live is not None else "settings",
        worst_usd=worst,
        worst_chunk_usd=worst_chunk,
        per_event_worst_usd=batches.round_usd(one_worst),
        budget=budget_out(budget),
        can_run=reason is None,
        reason=reason,
        running_run_id=running.id if running is not None else None,
        retry_events=retry,
        set_model=(eval_set.rules or {}).get("model") if eval_set is not None else None,
        set_seen_since=eval_sets.since_floor(config.analysis_model),
        overlap_lesson=overlap,
    )


def retry_cap(events: int, batch: int) -> int:
    """Сколько запросов уходит в пакет повтора: не больше одного пакета."""
    return min(batch, events)


def set_seen(eval_set: Any, model: str) -> bool:
    """Набор мог попасть в обучение модели анализа (m3 волны 3): первый день набора раньше
    среза знаний этой модели. Модель сменили на более новую — прогоны на этом наборе уже
    нечестны, нужен новый набор."""
    since = eval_set.since
    return since is None or since < eval_sets.since_floor(model)


async def lesson_overlap(db: AsyncSession, version: StrategyVersion, eval_set: Any) -> str | None:
    """Урок кандидата (которого нет в активной версии), проверенный на архиве до заморозки
    набора: его поправка подбиралась и на матчах набора (M1 волны 3). → код урока или
    None. Такой урок нужно перепроверить (lessons-check --recheck): новая проверка
    исключает матчи замороженных наборов."""
    if version.status != CANDIDATE or not version.lessons or eval_set.frozen_at is None:
        return None
    active = await shared_active(db)
    added = sorted(set(version.lessons) - set(active.lessons or [] if active else []))
    if not added:
        return None
    rows = await db.execute(
        select(Lesson.code, Lesson.kind, Lesson.validated_at).where(
            Lesson.user_id.is_(None), Lesson.code.in_(added)
        )
    )
    for code, kind, validated_at in rows:
        if kind == "numeric" and validated_at is not None and validated_at < eval_set.frozen_at:
            return str(code)
    return None


# --- запуск ---


Enqueue = Callable[[int], Any]


async def enqueue_run(eval_run_id: int) -> None:
    """Задача воркера run_eval: отправить очередной пакет прогона."""
    from app.workers.queue import create_queue_pool

    pool = await create_queue_pool(retries=1)
    try:
        await pool.enqueue_job(RUN_JOB, eval_run_id, _job_id=f"{RUN_JOB}:{eval_run_id}:0")
    finally:
        await pool.aclose()


async def start(
    db: AsyncSession,
    admin: User,
    body: EvalRunIn,
    *,
    confirm: TotpConfirm | None,
    ip: str | None,
    enqueue: Enqueue | None = None,
    terminal: bool = False,
) -> EvalRun:
    """Запуск прогона: код 2FA (тратит бюджет проверок), затем под блокировкой бюджета —
    план (можно ли), строка eval_runs (pending) с резервом худшего случая первого пакета,
    журнал eval_run. Нельзя — 409 с причиной плана. Очередь недоступна — прогон уйдет со
    следующим сбором пакетов (через 15 минут). terminal — команда терминала: код не
    спрашивается (доступ к серверу уже подтверждает владельца). commit."""
    if not terminal:
        await check_totp(db, admin, confirm, action="eval_run")
    moment = utcnow()
    config = await load_agent_config(db)
    await lock_budget(db)
    found = await plan(db, body.version_id, now=moment)
    if not found.can_run:
        raise AppError(
            409,
            found.reason or "eval.run_in_progress",
            since=found.set_seen_since.isoformat(),
            lesson=found.overlap_lesson or "",
        )
    version = await _shared_version(db, body.version_id)
    eval_set = await eval_sets.latest_set(db)
    assert eval_set is not None
    items = await _items(db, eval_set.id)
    ids = [item.match_id for item in items]
    prompt = system_prompt_of(version)
    run = EvalRun(
        version_kind="strategy",
        strategy_version_id=version.id,
        eval_set=eval_set.code,
        eval_set_id=eval_set.id,
        split="test",
        n_events=len(ids),
        repeat_no=found.repeat_no,
        status="pending",
        max_tokens=config.eval_max_tokens,
        metrics={},
    )
    db.add(run)
    await db.flush()
    run.metrics = {
        "kind": KIND,
        "status": "pending",
        "admin_id": admin.id,
        "version_code": version.code,
        "chunks": chunks_of(ids, config.eval_batch_size),
        "batch_size": config.eval_batch_size,
        "chunk": 0,
        "attempts": 0,
        "jobs": [],
        "events": {},
        "retry": [],
        "retried": False,
        "model": config.analysis_model,
        "effort": config.analysis_effort,
        "prompt_version": prompt.version_id,
        "schema_version": ASSESSMENT_SCHEMA_VERSION,
        "estimate_usd": str(found.estimate_usd),
        "worst_total_usd": str(found.worst_usd),
        # Резерв до отправки первого пакета (check_runs.eval_budget, pending)
        "worst_usd": str(found.worst_chunk_usd),
        "started_at": moment.isoformat(),
        "pending_since": moment.isoformat(),
    }
    await write_audit(
        db,
        action="eval_run",
        actor_id=admin.id,
        details={
            "kind": KIND,
            "code": version.code,
            "set": eval_set.code,
            "events": len(ids),
            "repeat_no": found.repeat_no,
            "worst_usd": str(found.worst_usd),
        },
        ip=ip,
    )
    await db.commit()
    try:
        await (enqueue or enqueue_run)(run.id)
    except Exception:
        log.warning("eval_run.enqueue_failed", eval_run_id=run.id)
    return run


# --- отправка пакета ---


ClientFactory = Callable[[str], anthropic.AsyncAnthropic]


def _client(key: str) -> anthropic.AsyncAnthropic:
    return client_for(key, timeout=BATCH_TIMEOUT_S)


def eval_request(
    custom: str, event: smoke_eval.SmokeEvent, prompt: SystemPrompt, config: AgentConfig
) -> Request:
    """Запрос пакета: system версии (промпт и уроки — точками кэша на 1 час), досье,
    дата матча, схема оценки и eval_max_tokens (Т8)."""
    return cast(
        Request,
        {
            "custom_id": custom,
            "params": {
                "model": config.analysis_model,
                "max_tokens": config.eval_max_tokens,
                "system": system_blocks(prompt, ttl="1h"),
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": event.dossier_text},
                            {"type": "text", "text": smoke_eval.request_text(event)},
                        ],
                    }
                ],
                "output_config": {
                    "effort": config.analysis_effort,
                    "format": {"type": "json_schema", "schema": assessment_schema()},
                },
            },
        },
    )


def _set_metrics(run: EvalRun, **fields: Any) -> dict[str, Any]:
    metrics = {**(run.metrics or {}), **fields}
    run.metrics = metrics
    return metrics


async def _fail(db: AsyncSession, run: EvalRun, error: str) -> str:
    run.status = "failed"
    _set_metrics(run, status="failed", error=error, finished_at=utcnow().isoformat())
    await db.commit()
    return "failed"


def _abandoned(run: EvalRun) -> None:
    """Прогон отменен: abandoned без следующих пакетов. metrics.status — canceled (не
    abandoned smoke-eval: резерв без пакета не держится, пакет у Anthropic держит свой)."""
    run.status = "abandoned"
    _set_metrics(
        run, status="canceled", error="canceled", waiting=None, finished_at=utcnow().isoformat()
    )


async def _abandon(db: AsyncSession, run: EvalRun) -> str:
    _abandoned(run)
    await db.commit()
    return "abandoned"


async def _wait(db: AsyncSession, run: EvalRun, reason: str) -> str:
    """Пакет не отправлен, прогон ждет следующей попытки (сбор пакетов, 15 минут). Не
    хватает бюджета — администратору уведомление один раз."""
    metrics = _set_metrics(run, waiting=reason)
    if reason == "eval.budget" and not metrics.get("budget_notified"):
        _set_metrics(run, budget_notified=True)
        await notify_admins(
            db,
            variant="eval_budget",
            link=LEARNING_LINK,
            code=str(metrics.get("version_code") or ""),
            left=str(len(metrics.get("chunks") or []) - int(metrics.get("chunk") or 0)),
        )
    await db.commit()
    return "pending"


async def advance(
    db: AsyncSession, eval_run_id: int, *, client_factory: ClientFactory | None = None
) -> str:
    """Отправка очередного пакета прогона в pending (задача run_eval и сбор пакетов).
    Прогон под FOR UPDATE SKIP LOCKED: две задачи не отправят один пакет. → статус."""
    run = await db.scalar(
        select(EvalRun)
        .where(EvalRun.id == eval_run_id)
        .with_for_update(skip_locked=True)
        .execution_options(populate_existing=True)
    )
    if run is None or run.status != "pending" or (run.metrics or {}).get("kind") != KIND:
        status = run.status if run is not None else "busy"
        await db.rollback()
        return status or "missing"
    try:
        return await _send_chunk(db, run, client_factory=client_factory)
    except Exception:
        await db.rollback()
        run = await db.get_one(EvalRun, eval_run_id, populate_existing=True, with_for_update=True)
        attempts = int((run.metrics or {}).get("attempts") or 0) + 1
        if run.status == "pending":
            _set_metrics(run, attempts=attempts, waiting="error")
            if attempts >= MAX_ATTEMPTS:
                return await _fail(db, run, "error")
        await db.commit()
        raise


async def _send_chunk(
    db: AsyncSession, run: EvalRun, *, client_factory: ClientFactory | None
) -> str:
    metrics = dict(run.metrics or {})
    config = await load_agent_config(db)
    chunk = int(metrics.get("chunk") or 0)
    chunks: list[list[int]] = [list(map(int, ids)) for ids in metrics.get("chunks") or []]
    if chunk >= len(chunks):
        return await _finish_run(db, run)
    if metrics.get("cancel_requested"):
        return await _abandon(db, run)
    version = await db.get(StrategyVersion, run.strategy_version_id, populate_existing=True)
    if version is None or version.status not in (ACTIVE, CANDIDATE):
        # Кандидата отклонили или версия ушла в архив: следующие пакеты не тратят бюджет
        return await _fail(db, run, "version_closed")
    prompt = system_prompt_of(version)
    if prompt.version_id != metrics.get("prompt_version"):
        # Версия поменялась после запуска (снимок уроков не меняется, но промпт удалили)
        return await _fail(db, run, "version_changed")
    try:
        price = await price_for(db, str(metrics.get("model") or config.analysis_model))
    except ClaudeStepError as exc:
        return await _wait(db, run, exc.code)
    eval_set = await db.get(EvalSet, run.eval_set_id or 0)
    if eval_set is None:
        return await _fail(db, run, "set_missing")
    ids = set(chunks[chunk])
    items = [item for item in await _items(db, eval_set.id) if item.match_id in ids]
    events = await eval_sets.prepare_events(db, eval_set, items)
    stored = dict(metrics.get("events") or {})
    requests: list[Request] = []
    worst = Decimal(0)
    for event in events:
        row = event.to_json(run.id)
        row.pop("custom_id", None)
        stored[str(event.match_id)] = {**stored.get(str(event.match_id), {}), **row}
        requests.append(
            eval_request(custom_id(run.id, chunk, event.match_id), event, prompt, config)
        )
        worst += batches.request_worst_usd(
            price,
            input_tokens=estimate_tokens(
                prompt.text, event.dossier_text, smoke_eval.request_text(event)
            ),
            max_tokens=config.eval_max_tokens,
            cache_1h=True,
        )
    if not requests:
        _set_metrics(run, chunk=chunk + 1, events=stored)
        await db.commit()
        return "pending"
    worst = batches.round_usd(worst)
    # Остаток и строка пакета — под блокировкой бюджета до commit (М2 волны 2): свой
    # резерв до отправки не считается, вместо него встает худший случай пакета
    await lock_budget(db)
    budget = await eval_budget(db, exclude_run_id=run.id)
    if worst > budget.left_usd:
        if chunk == 0 and not metrics.get("jobs"):
            return await _fail(db, run, "budget")
        return await _wait(db, run, "eval.budget")
    try:
        key = await key_for(db, key_source="admin", user_id=0)
    except ClaudeStepError as exc:
        return await _wait(db, run, exc.code)
    meta = batches.RunMeta(
        kind="eval",
        model=str(metrics.get("model") or config.analysis_model),
        effort=metrics.get("effort") or config.analysis_effort,
        prompt_version=prompt.version_id,
        schema_version=ASSESSMENT_SCHEMA_VERSION,
        eval_run_id=run.id,
    )
    job = await batches.open_job(
        db,
        kind="eval",
        requests=len(requests),
        worst_usd=worst,
        params=meta.to_params(eval_run_id=run.id, eval_kind=KIND, chunk=chunk),
        custom_ids=[str(request["custom_id"]) for request in requests],
    )
    run.batch_job_id = job.id
    run.status = "running"
    _set_metrics(
        run,
        status="running",
        waiting=None,
        events=stored,
        jobs=[*(metrics.get("jobs") or []), job.id],
        worst_usd=str(worst),
        sent_at=utcnow().isoformat(),
    )
    await db.commit()
    client = (client_factory or _client)(key)
    try:
        await batches.send_job(db, client, job, requests)
    except ClaudeStepError:
        if job.status == batches.FAILED:
            await back_to_pending(db, job.id, "not_sent")
            return "pending"
        # Ответа на создание нет, пакет не нашелся: строка pending, решит reap_pending
        return "running"
    return "running"


async def back_to_pending(db: AsyncSession, job_id: int, reason: str) -> None:
    """Пакет прогона не ушел: прогон снова ждет отправки этого пакета (не больше
    MAX_ATTEMPTS раз, потом failed). commit."""
    run = await db.scalar(
        select(EvalRun)
        .where(EvalRun.batch_job_id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None or run.status != "running":
        await db.commit()
        return
    if (run.metrics or {}).get("cancel_requested"):
        await _abandon(db, run)
        return
    attempts = int((run.metrics or {}).get("attempts") or 0) + 1
    run.status = "pending"
    _set_metrics(
        run, status="pending", attempts=attempts, waiting=reason, pending_since=utcnow().isoformat()
    )
    if attempts >= MAX_ATTEMPTS:
        await _fail(db, run, reason)
        return
    await db.commit()


async def mark_lost(db: AsyncSession, job: BatchJob, reason: str) -> None:
    """Пакет прогона не ушел (not_sent) — отправить снова; потерян — прогон failed."""
    if reason == "not_sent":
        await back_to_pending(db, job.id, reason)
        return
    run = await db.scalar(select(EvalRun).where(EvalRun.batch_job_id == job.id).with_for_update())
    if run is None or run.status not in OPEN_STATUSES:
        await db.commit()
        return
    await _fail(db, run, reason)


async def advance_all(
    db: AsyncSession, *, client_factory: ClientFactory | None = None
) -> list[tuple[int, str]]:
    """Все прогоны, ждущие отправки пакета (сбор пакетов раз в 15 минут); сначала —
    отмена у Anthropic пакетов отмененных прогонов, если она еще не дошла."""
    try:
        await send_cancels(db, client_factory=client_factory)
    except Exception:
        await db.rollback()
        log.exception("eval_run.send_cancels_failed")
    ids = list(
        await db.scalars(
            select(EvalRun.id).where(
                EvalRun.metrics["kind"].astext == KIND, EvalRun.status == "pending"
            )
        )
    )
    await db.commit()
    done: list[tuple[int, str]] = []
    for run_id in ids:
        try:
            done.append((run_id, await advance(db, run_id, client_factory=client_factory)))
        except Exception:
            log.exception("eval_run.advance_failed", eval_run_id=run_id)
    return done


# --- отмена ---


def request_cancel(run: EvalRun, *, actor_id: int | None) -> str:
    """Отметить отмену открытого прогона (строка под FOR UPDATE у вызывающего): без
    пакета у Anthropic — abandoned сразу (резерв до отправки снимается); с пакетом — отмена
    у Anthropic (send_cancel), после сбора — abandoned. flush/commit — за вызывающим.
    → новый статус прогона."""
    _set_metrics(run, cancel_requested=True, canceled_by=actor_id, cancel_at=utcnow().isoformat())
    if run.status == "pending":
        _abandoned(run)
        return "abandoned"
    _set_metrics(run, waiting="eval.canceling")
    return str(run.status)


async def close_version_runs(db: AsyncSession, version_id: int, *, actor_id: int | None) -> None:
    """Версия больше не активна и не кандидат (отклонена, ушла в архив): ее открытые
    прогоны отменяются (их пакеты у Anthropic отменит следующий сбор пакетов, send_cancels).
    flush; commit — за вызывающим."""
    runs = list(
        await db.scalars(
            select(EvalRun)
            .where(
                EvalRun.strategy_version_id == version_id,
                EvalRun.metrics["kind"].astext == KIND,
                EvalRun.status.in_(OPEN_STATUSES),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    )
    for run in runs:
        request_cancel(run, actor_id=actor_id)
    await db.flush()


async def cancel(
    db: AsyncSession,
    actor: User | None,
    eval_run_id: int,
    *,
    ip: str | None,
    client_factory: ClientFactory | None = None,
) -> EvalRun:
    """«Остановить прогон» (администратор или команда терминала eval-cancel; денег не
    тратит, 2FA не нужна): прогон ждет отправки, бюджета или ключа — abandoned сразу;
    пакет у Anthropic — отменяется там (не начатые запросы бесплатно), начатые
    дособираются. Нет такого прогона — 404 eval.run_not_found; уже закончен — 409
    eval.run_closed. Журнал eval_run (step cancel). commit."""
    run = await db.scalar(
        select(EvalRun)
        .where(EvalRun.id == eval_run_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None or run.version_kind != "strategy":
        raise AppError(404, "eval.run_not_found")
    if (run.metrics or {}).get("kind") != KIND or run.status not in OPEN_STATUSES:
        raise AppError(409, "eval.run_closed")
    status = request_cancel(run, actor_id=actor.id if actor is not None else None)
    await write_audit(
        db,
        action="eval_run",
        actor_id=actor.id if actor is not None else None,
        details={
            "kind": KIND,
            "step": "cancel",
            "run": run.id,
            "code": (run.metrics or {}).get("version_code"),
            "status": status,
        },
        ip=ip,
    )
    await db.commit()
    if status == "running":
        try:
            await send_cancel(db, run.id, client_factory=client_factory)
        except Exception:
            # Отмена у Anthropic дойдет со следующим сбором пакетов (send_cancels)
            await db.rollback()
            log.warning("eval_run.cancel_send_failed", eval_run_id=run.id, exc_info=True)
    found = await db.get(EvalRun, run.id, populate_existing=True)
    assert found is not None
    return found


async def send_cancel(
    db: AsyncSession, eval_run_id: int, *, client_factory: ClientFactory | None = None
) -> bool:
    """Отмена пакета отмененного прогона у Anthropic (один раз). Пакет еще не дошел до
    Anthropic (строка pending) — ничего: его привяжет или закроет reap_pending, а сбор или
    back_to_pending закончит прогон. → отмена отправлена. commit."""
    run = await db.get(EvalRun, eval_run_id, populate_existing=True)
    metrics = (run.metrics or {}) if run is not None else {}
    if (
        run is None
        or run.status != "running"
        or not metrics.get("cancel_requested")
        or metrics.get("cancel_sent")
        or run.batch_job_id is None
    ):
        await db.commit()
        return False
    job = await db.get(BatchJob, run.batch_job_id)
    if job is None or job.status != batches.SUBMITTED or job.batch_id is None:
        await db.commit()
        return False
    batch_id = job.batch_id
    key = await key_for(db, key_source="admin", user_id=0)
    await db.commit()
    client = (client_factory or _client)(key)
    # Пакета у Anthropic нет (BatchLost): сбор пометит его lost, прогон — failed
    with contextlib.suppress(batches.BatchLost):
        await batches.cancel_batch(client, batch_id)
    run = await db.get_one(EvalRun, eval_run_id, populate_existing=True, with_for_update=True)
    _set_metrics(run, cancel_sent=True)
    await db.commit()
    return True


async def send_cancels(
    db: AsyncSession, *, client_factory: ClientFactory | None = None
) -> list[int]:
    """Отмена у Anthropic для всех отмененных прогонов, где она еще не дошла (сбор пакетов
    раз в 15 минут). → id прогонов, по которым отмена отправлена."""
    ids = list(
        await db.scalars(
            select(EvalRun.id).where(
                EvalRun.metrics["kind"].astext == KIND,
                EvalRun.status == "running",
                EvalRun.metrics["cancel_requested"].astext == "true",
                EvalRun.metrics["cancel_sent"].astext.is_distinct_from("true"),
            )
        )
    )
    await db.commit()
    sent: list[int] = []
    for run_id in ids:
        try:
            if await send_cancel(db, run_id, client_factory=client_factory):
                sent.append(run_id)
        except ClaudeStepError as exc:
            await db.rollback()
            log.warning("eval_run.cancel_send_failed", eval_run_id=run_id, code=exc.code)
    return sent


# --- сбор ---


def decisions(final: Probs3, flip: bool, params: StrategyParams) -> list[str]:
    """Решения по ставкам версии на событии: исходы (в порядке игроков матча) с
    итоговой вероятностью не ниже порога стратегии (min_p, у форы −1.5 — cover_min_p)."""
    picked: list[str] = []
    for (market, selection), value in final.markets().items():
        limit = params.cover_min_p if market == "HCP_-1.5" else params.min_p
        if value + 1e-12 >= limit:
            side = 3 - selection if flip else selection
            picked.append(f"{market}:{side}")
    return sorted(picked)


_ITEM_OUTCOMES = {
    batches.ERRORED: smoke_eval.ERRORED,
    batches.EXPIRED: smoke_eval.EXPIRED,
    batches.CANCELED: smoke_eval.CANCELED,
}


async def collect(
    db: AsyncSession, client: anthropic.AsyncAnthropic, job: BatchJob
) -> batches.Collected:
    """Сбор пакета прогона: agent_runs (бюджет проверок), прогнозы проверки (predictions
    is_eval по 6 исходам), ответы событий; затем следующий пакет (pending) или итог.
    Повторный сбор ничего не пишет второй раз (batches.collect_job). commit."""
    run = await db.scalar(select(EvalRun).where(EvalRun.batch_job_id == job.id))
    meta = batches.RunMeta.from_params(
        "eval", job.params or {}, eval_run_id=run.id if run is not None else None
    )
    if run is None:
        return await batches.collect_job(db, client, job.id, meta=meta, handle=_ignore)
    metrics = dict(run.metrics or {})
    events = {str(key): dict(value) for key, value in (metrics.get("events") or {}).items()}
    retry: list[int] = [int(value) for value in metrics.get("retry") or []]
    params = StrategyParams()
    version = await db.get(StrategyVersion, run.strategy_version_id)
    ml_model = await active_model_id(db)

    async def handle(session: AsyncSession, item: batches.BatchItem, agent_run: AgentRun) -> None:
        match_id = parse_custom_id(item.custom_id)
        event = events.get(str(match_id)) if match_id is not None else None
        if event is None:
            return
        if item.message is not None:
            judged = smoke_eval.judge(item.message, event, params.claude_highlight)
        else:
            judged = smoke_eval.Judged(
                _ITEM_OUTCOMES.get(item.kind, smoke_eval.ERRORED), item.detail, None
            )
        agent_run.error = judged.detail
        if item.retryable and not metrics.get("retried") and match_id is not None:
            retry.append(match_id)
        event["outcome"] = judged.outcome
        if judged.assessment is None:
            return
        rows, final = smoke_eval._predictions(
            run,
            event,
            judged.assessment,
            version=version,
            ml_model=ml_model,
            model=meta.model,
            agent_run_id=agent_run.id,
        )
        session.add_all(rows)
        p_claude = min(1.0, max(0.0, float(judged.assessment.p1_win)))
        event["p_claude"] = p_claude
        event["p_final"] = final.p1_win
        event["decisions"] = decisions(final, bool(event.get("flip")), params)

    async def finish(session: AsyncSession, collected: BatchJob) -> None:
        # Отмену могли попросить, пока пакет собирался: свежая строка под блокировкой
        fresh = await session.scalar(
            select(EvalRun.metrics).where(EvalRun.id == run.id).with_for_update()
        )
        canceled = bool((fresh or {}).get("cancel_requested"))
        chunk = int(metrics.get("chunk") or 0) + 1
        chunks = list(metrics.get("chunks") or [])
        retried = bool(metrics.get("retried"))
        if chunk >= len(chunks) and retry and not retried and not canceled:
            batch = int(metrics.get("batch_size") or (len(chunks[0]) if chunks else 1))
            chunks.append(sorted(set(retry))[: retry_cap(len(set(retry)), batch)])
            retried = True
        moment = utcnow().isoformat()
        run.metrics = {
            **metrics,
            **{key: (fresh or {}).get(key) for key in CANCEL_KEYS if key in (fresh or {})},
            "events": events,
            "chunk": chunk,
            "chunks": chunks,
            "retry": [] if retried else retry,
            "retried": retried,
            "attempts": 0,
        }
        # Потрачено растет с каждым собранным пакетом; у остановленного прогона — сколько
        # фактически ушло (итог прогона пересчитает то же в _summarize)
        run.cost_usd = (await _run_costs(session, run.id))[0]
        if canceled:
            _abandoned(run)
            return
        if chunk < len(chunks):
            run.status = "pending"
            run.metrics = {**run.metrics, "status": "pending", "pending_since": moment}
            return
        await _summarize(session, run)

    return await batches.collect_job(db, client, job.id, meta=meta, handle=handle, finish=finish)


async def _ignore(session: AsyncSession, item: batches.BatchItem, agent_run: AgentRun) -> None:
    return None


async def _finish_run(db: AsyncSession, run: EvalRun) -> str:
    await _summarize(db, run)
    await db.commit()
    return "done"


# --- итог ---


def _usable(event: dict[str, Any]) -> bool:
    return event.get("outcome") in smoke_eval.USABLE and event.get("p_claude") is not None


async def _run_costs(db: AsyncSession, run_id: int) -> tuple[Decimal, int, int]:
    """Стоимость прогона, запросов и токенов (вход, кэш, выход) по agent_runs."""
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(AgentRun.cost_usd), 0),
                func.count(),
                func.coalesce(
                    func.sum(
                        AgentRun.input_tokens
                        + AgentRun.cache_write_tokens
                        + AgentRun.cache_read_tokens
                        + AgentRun.output_tokens
                    ),
                    0,
                ),
            ).where(AgentRun.eval_run_id == run_id)
        )
    ).one()
    return Decimal(row[0]), int(row[1]), int(row[2])


def summary_of(
    events: Sequence[dict[str, Any]],
    *,
    market: dict[int, float],
    cost_usd: Decimal,
    requests: int,
    tokens: int,
    bootstrap: int = BOOTSTRAP_SAMPLES,
) -> dict[str, Any]:
    """Итог прогона по событиям (чистая функция): счетчики, метрики p_claude против p_base
    и рынка (q для p1 досье: у перевернутого — 1 − q игрока 1 матча), калибровка."""
    counts = {outcome: 0 for outcome in smoke_eval.OUTCOMES}
    for event in events:
        outcome = str(event.get("outcome") or smoke_eval.ERRORED)
        counts[outcome] = counts.get(outcome, 0) + 1
    usable = [event for event in events if _usable(event)]
    total = len(events)
    result: dict[str, Any] = {
        "n": len(usable),
        "total": total,
        "unrated": total - len(usable),
        "format_errors": counts.get(smoke_eval.FORMAT, 0),
        "max_tokens": counts.get(smoke_eval.MAX_TOKENS, 0),
        "refusals": counts.get(smoke_eval.REFUSAL, 0),
        "counts": counts,
        "cost_usd": str(cost_usd),
        "tokens_per_event": tokens / requests if requests else None,
        "cost_per_event_usd": str(cost_usd / requests) if requests else None,
        "seed": SEED,
        "bootstrap": bootstrap,
    }
    if not usable:
        return {**result, "calibration": [], "market_n": 0}
    y = [int(event["y"]) for event in usable]
    days = [str(event["day"]) for event in usable]
    p = [float(event["p_claude"]) for event in usable]
    p_final = [float(event.get("p_final") or event["p_claude"]) for event in usable]
    p_base = [float(event["p_base"]["p1_win"]) for event in usable]
    claude_ll, base_ll = log_losses(p, y), log_losses(p_base, y)
    vs_base = block_bootstrap_diff_ci(claude_ll, base_ll, days, n=bootstrap, seed=SEED)
    rows = [
        (index, market[int(event["match_id"])])
        for index, event in enumerate(usable)
        if int(event["match_id"]) in market
    ]
    market_part: dict[str, Any] = {"market_n": len(rows)}
    if rows:
        q = [(1.0 - value) if usable[index].get("flip") else value for index, value in rows]
        y_m = [y[index] for index, _ in rows]
        ll_m = log_losses(q, y_m)
        ll_c = log_losses([p[index] for index, _ in rows], y_m)
        vs_market = block_bootstrap_diff_ci(
            ll_c, ll_m, [days[index] for index, _ in rows], n=bootstrap, seed=SEED
        )
        market_part |= {
            "log_loss_market": float(ll_m.mean()),
            "brier_market": brier(q, y_m),
            "vs_market": _ci_json(vs_market),
        }
    table = calibration_table(p, y, bin_width=CALIBRATION_WIDTH)
    return {
        **result,
        **market_part,
        "log_loss": float(claude_ll.mean()),
        "brier": brier(p, y),
        "ece": ece(p, y, bin_width=eval_compare.ECE_BIN),
        "log_loss_final": float(log_losses(p_final, y).mean()),
        "log_loss_base": float(base_ll.mean()),
        "brier_base": brier(p_base, y),
        "vs_base": _ci_json(vs_base),
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
    }


def _ci_json(estimate: Any) -> dict[str, Any]:
    return {
        "value": estimate.value,
        "low": estimate.low,
        "high": estimate.high,
        "n": estimate.n,
    }


async def _summarize(db: AsyncSession, run: EvalRun) -> None:
    """Итог прогона, сравнения кандидатов с активной версией, уведомление. flush."""
    metrics = dict(run.metrics or {})
    events = list((metrics.get("events") or {}).values())
    for event in events:
        event.setdefault("outcome", smoke_eval.ERRORED)
    cost, requests, tokens = await _run_costs(db, run.id)
    market = await eval_sets.archive_market(db, [int(event["match_id"]) for event in events])
    summary = summary_of(events, market=market, cost_usd=cost, requests=requests, tokens=tokens)
    moment = utcnow()
    run.status = "done"
    run.cost_usd = cost
    run.metrics = {
        **metrics,
        "events": {str(event["match_id"]): event for event in events},
        "status": "done",
        "summary": summary,
        "finished_at": moment.isoformat(),
        "waiting": None,
    }
    await db.flush()
    comparisons = await refresh_comparisons(db, run.eval_set_id)
    version = await db.get(StrategyVersion, run.strategy_version_id)
    mine = next(
        (
            item
            for item in comparisons
            if run.id in (item.candidate_run_id, item.baseline_run_id)
            and version is not None
            and version.status == CANDIDATE
        ),
        None,
    )
    variant = "eval_done"
    if mine is not None:
        variant = "candidate_passed" if mine.passed else "candidate_failed"
    await notify_admins(
        db,
        variant=variant,
        link=LEARNING_LINK,
        code=version.code if version is not None else "",
        events=str(summary["n"]),
        cost=usd_text(cost),
    )


# --- сравнение ---


def run_result(run: EvalRun) -> eval_compare.RunResult:
    """Итог прогона для сравнения: пригодные ответы по матчам."""
    metrics = run.metrics or {}
    summary = metrics.get("summary") or {}
    events: dict[int, eval_compare.EventResult] = {}
    for raw in (metrics.get("events") or {}).values():
        if not _usable(raw):
            continue
        events[int(raw["match_id"])] = eval_compare.EventResult(
            day=date.fromisoformat(str(raw["day"])),
            y=int(raw["y"]),
            p=float(raw["p_claude"]),
            decisions=frozenset(raw.get("decisions") or ()),
        )
    cost = summary.get("cost_per_event_usd")
    return eval_compare.RunResult(
        events=events,
        format_errors=int(summary.get("format_errors") or 0),
        max_tokens=int(summary.get("max_tokens") or 0),
        refusals=int(summary.get("refusals") or 0),
        cost_per_event=float(cost) if cost is not None else None,
        tokens_per_event=summary.get("tokens_per_event"),
    )


def rule_for(version: StrategyVersion) -> str:
    return "non_inferior" if version.goal == "saving" else "improve"


async def refresh_comparisons(db: AsyncSession, eval_set_id: int | None) -> list[EvalComparison]:
    """Сравнения кандидатов общей линии с активной версией на этом наборе по последним
    законченным прогонам (повтор базы — порог шума); новая строка eval_comparisons, если
    такой пары прогонов еще нет. flush."""
    if eval_set_id is None:
        return []
    active = await shared_active(db)
    if active is None:
        return []
    base_runs = await _done_runs(db, active.id, eval_set_id)
    if not base_runs:
        return []
    baseline = base_runs[-1]
    noise = base_runs[-2] if len(base_runs) > 1 else None
    candidates = list(
        await db.scalars(
            select(StrategyVersion).where(
                StrategyVersion.user_id.is_(None), StrategyVersion.status == CANDIDATE
            )
        )
    )
    made: list[EvalComparison] = []
    for candidate in candidates:
        runs = await _done_runs(db, candidate.id, eval_set_id)
        if not runs:
            continue
        latest = runs[-1]
        found = await db.scalar(
            select(EvalComparison).where(
                EvalComparison.candidate_run_id == latest.id,
                EvalComparison.baseline_run_id == baseline.id,
                EvalComparison.noise_run_id.is_(None)
                if noise is None
                else EvalComparison.noise_run_id == noise.id,
            )
        )
        if found is not None:
            made.append(found)
            continue
        comparison = await _compare(baseline, latest, rule_for(candidate), noise)
        row = EvalComparison(
            candidate_run_id=latest.id,
            baseline_run_id=baseline.id,
            noise_run_id=noise.id if noise is not None else None,
            rule=comparison.rule,
            metrics=comparison.to_json(),
            passed=comparison.passed,
        )
        db.add(row)
        await db.flush()
        candidate.metrics = {
            **(candidate.metrics or {}),
            "comparison_id": row.id,
            "passed": comparison.passed,
        }
        made.append(row)
    return made


def comparison_out(
    raw: dict[str, Any],
    *,
    row_id: int | None,
    created_at: datetime | None,
    candidate_run: EvalRun,
    baseline_run: EvalRun,
    noise_run_id: int | None,
    candidate: StrategyVersion,
    baseline: StrategyVersion,
) -> ComparisonOut:
    def diff(key: str) -> MetricDiffOut:
        return MetricDiffOut(**(raw.get(key) or {}))

    def change(key: str) -> CostChangeOut:
        return CostChangeOut(**(raw.get(key) or {"a": None, "b": None, "change": None, "ok": None}))

    fmt = raw.get("format_errors") or {"a": 0, "b": 0, "ok": True}
    zero = {"a": 0, "b": 0, "ok": True}
    return ComparisonOut(
        id=row_id,
        candidate_run_id=candidate_run.id,
        baseline_run_id=baseline_run.id,
        noise_run_id=noise_run_id,
        candidate_version_id=candidate.id,
        candidate_code=candidate.code,
        baseline_version_id=baseline.id,
        baseline_code=baseline.code,
        rule=raw["rule"],
        n=int(raw.get("n") or 0),
        log_loss=diff("log_loss"),
        brier=diff("brier"),
        ece=diff("ece"),
        format_errors=CountDiffOut(**fmt),
        max_tokens=CountDiffOut(**(raw.get("max_tokens") or zero)),
        refusals=CountDiffOut(**(raw.get("refusals") or zero)),
        cost_per_event=change("cost_per_event"),
        tokens_per_event=change("tokens_per_event"),
        agreement=AgreementOut(**(raw.get("agreement") or {})),
        passed=bool(raw.get("passed")),
        verdict=raw.get("verdict") or "failed",
        seed=int(raw.get("seed") or SEED),
        bootstrap=int(raw.get("bootstrap") or BOOTSTRAP_SAMPLES),
        created_at=created_at,
    )


async def _compare(
    baseline: EvalRun, candidate: EvalRun, rule: str, noise: EvalRun | None
) -> eval_compare.Comparison:
    """Сравнение прогонов (бутстрэп 10 000 и ECE — около 0,5 с CPU) — в отдельном потоке,
    чтобы не держать цикл событий API (m6 волны 3)."""
    return await asyncio.to_thread(
        eval_compare.compare,
        run_result(baseline),
        run_result(candidate),
        rule=rule,
        noise=run_result(noise) if noise is not None else None,
    )


async def compare_versions(
    db: AsyncSession, candidate: StrategyVersion, baseline: StrategyVersion
) -> ComparisonOut | None:
    """Сравнение двух версий общей линии на последнем наборе: последние законченные
    прогоны, повтор базы — порог шума. Итоги прогонов не меняются, поэтому сравнение пары
    прогонов считается один раз и хранится в eval_comparisons (кэш, m6 волны 3; при
    завершении прогона его считает refresh_comparisons); одновременные запросы одной пары
    ждут друг друга под рекомендательной блокировкой пары. Прогона нет — None. commit,
    если сравнение посчитано сейчас."""
    eval_set = await eval_sets.latest_set(db)
    if eval_set is None:
        return None
    base_runs = await _done_runs(db, baseline.id, eval_set.id)
    runs = await _done_runs(db, candidate.id, eval_set.id)
    if not base_runs or not runs:
        return None
    baseline_run, candidate_run = base_runs[-1], runs[-1]
    noise = base_runs[-2] if len(base_runs) > 1 else None
    rule = rule_for(candidate)
    stored = await _stored_comparison(db, candidate_run, baseline_run, noise, rule)
    if stored is None:
        await db.execute(
            text("SELECT pg_advisory_xact_lock(:a, :b)"),
            {"a": COMPARE_LOCK, "b": (candidate_run.id * 1_000_003 + baseline_run.id) % 2**31},
        )
        stored = await _stored_comparison(db, candidate_run, baseline_run, noise, rule)
        if stored is None:
            comparison = await _compare(baseline_run, candidate_run, rule, noise)
            stored = EvalComparison(
                candidate_run_id=candidate_run.id,
                baseline_run_id=baseline_run.id,
                noise_run_id=noise.id if noise is not None else None,
                rule=comparison.rule,
                metrics=comparison.to_json(),
                passed=comparison.passed,
            )
            db.add(stored)
            await db.flush()
        await db.commit()
        await db.refresh(stored)
    return comparison_out(
        stored.metrics,
        row_id=stored.id,
        created_at=stored.created_at,
        candidate_run=candidate_run,
        baseline_run=baseline_run,
        noise_run_id=noise.id if noise is not None else None,
        candidate=candidate,
        baseline=baseline,
    )


async def latest_comparison(
    db: AsyncSession, candidate: StrategyVersion, baseline: StrategyVersion
) -> ComparisonOut | None:
    """Последнее уже посчитанное сравнение candidate с baseline на последнем замороженном
    наборе — том же, что у version_eval: метрики сторон и сравнение не расходятся после
    новой заморозки. Только чтение: «ИИ и расходы» бутстрэп не считает (его считает
    завершение прогона и экран версий). Нет — None."""
    eval_set = await eval_sets.latest_set(db)
    if eval_set is None:
        return None
    cand, base = aliased(EvalRun), aliased(EvalRun)
    found = (
        await db.execute(
            select(EvalComparison, cand, base)
            .join(cand, cand.id == EvalComparison.candidate_run_id)
            .join(base, base.id == EvalComparison.baseline_run_id)
            .where(
                cand.strategy_version_id == candidate.id,
                base.strategy_version_id == baseline.id,
                cand.eval_set_id == eval_set.id,
                base.eval_set_id == eval_set.id,
            )
            .order_by(EvalComparison.id.desc())
            .limit(1)
        )
    ).first()
    if found is None:
        return None
    stored, candidate_run, baseline_run = found
    return comparison_out(
        stored.metrics,
        row_id=stored.id,
        created_at=stored.created_at,
        candidate_run=candidate_run,
        baseline_run=baseline_run,
        noise_run_id=stored.noise_run_id,
        candidate=candidate,
        baseline=baseline,
    )


async def _stored_comparison(
    db: AsyncSession,
    candidate_run: EvalRun,
    baseline_run: EvalRun,
    noise: EvalRun | None,
    rule: str,
) -> EvalComparison | None:
    found: EvalComparison | None = await db.scalar(
        select(EvalComparison)
        .where(
            EvalComparison.candidate_run_id == candidate_run.id,
            EvalComparison.baseline_run_id == baseline_run.id,
            EvalComparison.noise_run_id.is_(None)
            if noise is None
            else EvalComparison.noise_run_id == noise.id,
            EvalComparison.rule == rule,
        )
        .order_by(EvalComparison.id.desc())
        .limit(1)
    )
    return found


# --- для экранов ---


def _ci(raw: Any) -> CiNumOut | None:
    return CiNumOut(**raw) if isinstance(raw, dict) else None


def metrics_out(summary: dict[str, Any]) -> EvalMetricsOut:
    cost = summary.get("cost_per_event_usd")
    return EvalMetricsOut(
        n=int(summary.get("n") or 0),
        total=int(summary.get("total") or 0),
        unrated=int(summary.get("unrated") or 0),
        format_errors=int(summary.get("format_errors") or 0),
        max_tokens=int(summary.get("max_tokens") or 0),
        refusals=int(summary.get("refusals") or 0),
        log_loss=summary.get("log_loss"),
        brier=summary.get("brier"),
        ece=summary.get("ece"),
        log_loss_final=summary.get("log_loss_final"),
        log_loss_base=summary.get("log_loss_base"),
        brier_base=summary.get("brier_base"),
        market_n=int(summary.get("market_n") or 0),
        log_loss_market=summary.get("log_loss_market"),
        brier_market=summary.get("brier_market"),
        vs_base=_ci(summary.get("vs_base")),
        vs_market=_ci(summary.get("vs_market")),
        tokens_per_event=summary.get("tokens_per_event"),
        cost_per_event_usd=Decimal(str(cost)) if cost is not None else None,
        calibration=[CalibrationPointOut(**row) for row in summary.get("calibration") or []],
    )


def _kind(run: EvalRun) -> str:
    kind = str((run.metrics or {}).get("kind") or "smoke")
    return kind if kind in ("eval", "quick", "smoke") else "smoke"


def _status(run: EvalRun) -> str:
    if run.status in ("pending", "running", "done", "failed", "abandoned"):
        return str(run.status)
    state = str((run.metrics or {}).get("status") or "")
    return {
        "ended": "done",
        "submitted": "running",
        "creating": "pending",
        "lost": "failed",
        "abandoned": "abandoned",
        "failed": "failed",
    }.get(state, "running")


def _when(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        value = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _usd(raw: Any) -> Decimal | None:
    try:
        return Decimal(str(raw)) if raw is not None else None
    except ArithmeticError:
        return None


def run_out(run: EvalRun, version_code: str | None) -> EvalRunOut:
    metrics = run.metrics or {}
    kind = _kind(run)
    chunks = metrics.get("chunks") or []
    summary = metrics.get("summary") if kind == KIND else None
    done = run.status == "done"
    return EvalRunOut(
        id=run.id,
        kind=kind,  # type: ignore[arg-type]
        version_id=run.strategy_version_id,
        version_code=version_code,
        eval_set_code=run.eval_set,
        repeat_no=run.repeat_no,
        status=_status(run),  # type: ignore[arg-type]
        events=run.n_events,
        chunks_done=len(chunks) if done else int(metrics.get("chunk") or 0),
        chunks_total=len(chunks) if kind == KIND else 1,
        created_at=run.created_at,
        finished_at=_when(metrics.get("finished_at")),
        cost_usd=run.cost_usd or Decimal(0),
        worst_usd=_usd(metrics.get("worst_total_usd") or metrics.get("worst_usd")) or Decimal(0),
        estimate_usd=_usd(metrics.get("estimate_usd")),
        model=metrics.get("model"),
        error=metrics.get("error"),
        waiting=metrics.get("waiting"),
        metrics=metrics_out(summary) if isinstance(summary, dict) else None,
        seed=int(summary["seed"]) if isinstance(summary, dict) and "seed" in summary else None,
        bootstrap=int(summary["bootstrap"])
        if isinstance(summary, dict) and "bootstrap" in summary
        else None,
    )


async def _codes(db: AsyncSession, runs: Sequence[EvalRun]) -> dict[int, str]:
    ids = {run.strategy_version_id for run in runs if run.strategy_version_id is not None}
    if not ids:
        return {}
    rows = await db.execute(
        select(StrategyVersion.id, StrategyVersion.code, StrategyVersion.user_id).where(
            StrategyVersion.id.in_(ids)
        )
    )
    # Версия участника (прогоны этапа 3 на версии администратора) — без кода: Р14
    return {row_id: code for row_id, code, user_id in rows if user_id is None}


async def list_runs(db: AsyncSession, *, limit: int = 100) -> EvalRunsOut:
    """Прогоны проверок (новые первыми) и бюджет проверок."""
    runs = list(
        await db.scalars(
            select(EvalRun)
            .where(EvalRun.version_kind == "strategy")
            .order_by(EvalRun.created_at.desc(), EvalRun.id.desc())
            .limit(limit)
        )
    )
    codes = await _codes(db, runs)
    items = [run_out(run, codes.get(run.strategy_version_id or 0)) for run in runs]
    return EvalRunsOut(items=items, budget=budget_out(await eval_budget(db)))


async def run_detail(db: AsyncSession, run_id: int) -> EvalRunOut:
    run = await db.get(EvalRun, run_id)
    if run is None or run.version_kind != "strategy":
        raise AppError(404, "eval.run_not_found")
    codes = await _codes(db, [run])
    return run_out(run, codes.get(run.strategy_version_id or 0))


async def version_eval(db: AsyncSession, version: StrategyVersion) -> VersionEvalOut | None:
    """Версия на последнем наборе: прогоны, метрики последнего, порог шума."""
    eval_set = await eval_sets.latest_set(db)
    if eval_set is None:
        return None
    runs = await _done_runs(db, version.id, eval_set.id)
    if not runs:
        return None
    latest = runs[-1]
    summary = (latest.metrics or {}).get("summary") or {}
    noise = (
        eval_compare.noise_level(run_result(runs[-2]), run_result(latest))
        if len(runs) > 1
        else None
    )
    cost = summary.get("cost_per_event_usd")
    return VersionEvalOut(
        eval_set_code=eval_set.code,
        runs=len(runs),
        run_ids=[run.id for run in runs],
        n=int(summary.get("n") or 0),
        log_loss=summary.get("log_loss"),
        brier=summary.get("brier"),
        ece=summary.get("ece"),
        format_errors=int(summary.get("format_errors") or 0),
        max_tokens=int(summary.get("max_tokens") or 0),
        refusals=int(summary.get("refusals") or 0),
        to_market=_ci(summary.get("vs_market")),
        noise=noise,
        tokens_per_event=summary.get("tokens_per_event"),
        cost_per_event_usd=Decimal(str(cost)) if cost is not None else None,
    )
