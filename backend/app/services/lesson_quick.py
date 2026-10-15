"""Быстрая проверка урока перед включением в анализ (этап 5, В4 Р25; макет learning.js,
окно «Урок в анализ»).

Оценка матча Opus 5.5 через Batch на quick_check_events сыгранных матчах после даты
среза знаний модели (замороженный набор eval_sets, иначе первые матчи после среза, как
smoke-eval): досье на день матча без новостей, в system — промпт анализа активной версии
администратора и блок с этим уроком (prompts/lessons_block.v1.md). Без урока — готовые
ответы прошлых прогонов (smoke-eval) на тех же досье, тем же промптом, моделью и effort;
где их нет, в пакет идет и запрос без урока.

Деньги — из бюджета проверок (app/services/check_runs.py): до запуска экран показывает
цену по живым числам (средняя цена ответа прошлых проверок, иначе оценка настроек) и
худший случай (весь вход по цене записи кэша на 1 час и eval_max_tokens выхода, половина
цены — Batch); запуск — только если худший случай помещается в остаток. Запуск идет под
блокировкой бюджета проверок и урока (check_runs.lock_budget, затем FOR UPDATE урока):
проверка «уже идет», остаток и строка eval_runs с резервом худшего случая — одним шагом,
две проверки одного урока или двух уроков не займут один остаток (М2, М3). При отправке
худший случай считается заново по настоящим досье, тоже под блокировкой бюджета.

Сбой задачи воркера до отправки — прогон failed (повтор задачи ничего не делает:
прогон уже не pending); задача потерялась или воркер перезапущен — уборщик reap_stuck
(сбор пакетов раз в 15 минут) ставит failed прогону без пакета старше
check_runs.PENDING_RESERVE (М4).

Итог: разница лог-лосса p_claude с уроком и без на одних событиях (с − без) и парный
бутстрэп-ДИ с seed; ошибки формата, max_tokens и отказы. Не хуже (passed): все события
оценены, ошибок формата и отказов нет, верхняя граница ДИ разницы не выше MARGIN (+0,01,
правило TOKEN_ECONOMY.md, 2.4). Решение «включить» — за администратором
(app/services/lessons.py, enable).
"""

from collections.abc import Awaitable, Callable, Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Any, cast

import anthropic
from anthropic.types.messages.batch_create_params import Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import batches
from app.agent.calls import estimate_tokens
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.prompts import LESSON_LINE, LESSON_SHIFT, LESSONS_BLOCK, load_prompt, load_prompt_id
from app.agent.runs import price_for
from app.agent.schemas import ASSESSMENT_SCHEMA_VERSION, assessment_schema
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    AppSettings,
    BatchJob,
    EvalRun,
    EvalSet,
    EvalSetItem,
    Lesson,
    Match,
    ModelPrice,
    Prediction,
    StrategyVersion,
    Tournament,
    User,
)
from app.ml.metrics import Estimate, bootstrap_diff_ci, log_losses
from app.ml.sets import MARKET_ML
from app.schemas.lessons import QuickCheckOut
from app.services import lessons as lessons_service
from app.services import smoke_eval
from app.services.ai_access import usd_text
from app.services.app_settings import SETTINGS_ROW_ID
from app.services.audit import write_audit
from app.services.check_runs import PENDING_RESERVE, eval_budget, lock_budget
from app.services.claude_key import key_for
from app.services.notifications import notify
from app.services.sessions import utcnow
from app.services.strategy_versions import ensure_active, params_of, prompt_version_of

KIND = "quick"
QUICK_JOB = "run_quick_check"
# Допуск «не хуже» по лог-лоссу (TOKEN_ECONOMY.md, 2.4)
MARGIN = 0.01
SEED = 20261016
MIN_EVENTS = 10
# Живая цена: средняя цена ответа последних проверок этой модели
LIVE_RUNS = 200
BATCH_TIMEOUT_S = 120.0
# Ветка запроса: с уроком и без
WITH = "l"
WITHOUT = "b"


# --- блок уроков ---


def _shift_text(value: float) -> str:
    return f"{value * 100:+.1f}".replace(".", ",").replace("-", "−")


def lesson_line(lesson: Lesson) -> str:
    line = load_prompt(*LESSON_LINE).format(code=lesson.code, text=lesson.text).strip()
    if lesson.kind == "numeric" and lesson.effect_shrunk is not None:
        shift = load_prompt(*LESSON_SHIFT).format(shift=_shift_text(lesson.effect_shrunk))
        line = f"{line} {shift.strip()}"
    return line


def lessons_block(lessons: Sequence[Lesson]) -> str:
    """Блок уроков для system анализа (prompts/lessons_block.v1.md)."""
    lines = "\n".join(lesson_line(lesson) for lesson in lessons)
    return load_prompt(*LESSONS_BLOCK).format(lessons=lines).strip()


def lesson_prompt_version(base_version: str, lesson: Lesson) -> str:
    """Версия промпта с уроком для agent_runs (до 64 символов)."""
    block = load_prompt(*LESSONS_BLOCK).version_id
    return f"{base_version}+{block}:{lesson.code}"[:64]


# --- матчи и готовые ответы без урока ---


async def _frozen_matches(db: AsyncSession, count: int) -> list[int]:
    """Матчи последнего замороженного набора (волна 3), по порядку событий."""
    found = await db.scalar(
        select(EvalSet.id)
        .where(EvalSet.frozen_at.is_not(None))
        .order_by(EvalSet.frozen_at.desc())
        .limit(1)
    )
    if found is None:
        return []
    return list(
        await db.scalars(
            select(EvalSetItem.match_id)
            .where(EvalSetItem.eval_set_id == found)
            .order_by(EvalSetItem.id)
            .limit(count)
        )
    )


async def _matches_by_ids(db: AsyncSession, ids: Sequence[int]) -> list[smoke_eval.SmokeMatch]:
    if not ids:
        return []
    day = func.coalesce(Match.match_date, Tournament.start_date)
    rows = await db.execute(
        select(Match, day, Tournament.surface, Tournament.best_of)
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.id.in_(list(ids)), Match.winner_id.is_not(None), day.is_not(None))
    )
    found = {
        match.id: smoke_eval.SmokeMatch(
            match=match,
            day=match_day,
            surface=surface or "hard",
            best_of=match.best_of or tour_best_of or 3,
        )
        for match, match_day, surface, tour_best_of in rows
    }
    return [found[match_id] for match_id in ids if match_id in found]


async def pick_matches(
    db: AsyncSession, config: AgentConfig, *, today: date
) -> list[smoke_eval.SmokeMatch]:
    count = config.quick_check_events
    frozen = await _frozen_matches(db, count)
    if frozen:
        return await _matches_by_ids(db, frozen)
    since = smoke_eval.safe_since(config.analysis_model)
    return await smoke_eval.pick_matches(db, since=since, count=count, today=today)


async def baselines(
    db: AsyncSession,
    match_ids: Sequence[int],
    *,
    prompt_version: str,
    config: AgentConfig,
) -> dict[tuple[int, int | None], dict[int, float]]:
    """Готовые ответы без урока: (матч, досье) → сторона → p_claude победы (рынок ML)
    прогонов проверок тем же промптом, моделью и effort. Последний ответ — главнее."""
    if not match_ids:
        return {}
    rows = await db.execute(
        select(
            Prediction.match_id, Prediction.dossier_id, Prediction.selection, Prediction.p_claude
        )
        .where(
            Prediction.is_eval.is_(True),
            Prediction.market == MARKET_ML,
            Prediction.match_id.in_(list(match_ids)),
            Prediction.prompt_version == prompt_version,
            Prediction.llm_model == config.analysis_model,
            Prediction.effort == config.analysis_effort,
            Prediction.p_claude.is_not(None),
        )
        .order_by(Prediction.id)
    )
    found: dict[tuple[int, int | None], dict[int, float]] = {}
    for match_id, dossier_id, selection, p_claude in rows:
        if p_claude is not None:
            found.setdefault((match_id, dossier_id), {})[selection] = float(p_claude)
    return found


def _reused(found: dict[tuple[int, int | None], dict[int, float]]) -> set[int]:
    return {match_id for match_id, _ in found}


# --- цена ---


async def live_request_usd(db: AsyncSession, model: str) -> Decimal | None:
    """Средняя цена ответа последних проверок этой модели (живые числа)."""
    recent = (
        select(AgentRun.cost_usd)
        .where(
            AgentRun.kind == "eval",
            AgentRun.batch.is_(True),
            AgentRun.model == model,
            AgentRun.cost_usd > 0,
        )
        .order_by(AgentRun.id.desc())
        .limit(LIVE_RUNS)
        .subquery()
    )
    value = await db.scalar(select(func.avg(recent.c.cost_usd)))
    return Decimal(value) if value is not None else None


def worst_per_request(price: ModelPrice, config: AgentConfig, input_tokens: int) -> Decimal:
    return batches.request_worst_usd(
        price, input_tokens=input_tokens, max_tokens=config.eval_max_tokens, cache_1h=True
    )


# --- до запуска ---


async def _has_admin_key(db: AsyncSession) -> bool:
    key = await db.scalar(
        select(AppSettings.anthropic_key_enc).where(AppSettings.id == SETTINGS_ROW_ID)
    )
    return key is not None


async def preview(
    db: AsyncSession, lesson_id: int, *, now: datetime | None = None
) -> QuickCheckOut:
    """Цена и худший случай быстрой проверки до запуска и можно ли ее запустить."""
    moment = now or utcnow()
    config = await load_agent_config(db)
    lesson = await lessons_service.shared_lesson(db, lesson_id)
    running = await lessons_service.running_quick(db, lesson.id)
    budget = await eval_budget(db, moment)
    reason: str | None = None
    try:
        price: ModelPrice | None = await price_for(db, config.analysis_model)
    except ClaudeStepError:
        price = None
    matches = await pick_matches(db, config, today=moment.date())
    base_version = await _base_prompt_version(db)
    found = await baselines(
        db, [item.match.id for item in matches], prompt_version=base_version, config=config
    )
    reused = len(_reused(found) & {item.match.id for item in matches})
    requests = len(matches) * 2 - reused
    estimate = worst = Decimal(0)
    if price is not None:
        live = await live_request_usd(db, config.analysis_model)
        one = (
            live
            if live is not None
            else batches.request_estimate_usd(
                price,
                input_tokens=config.estimate_analysis_input_tokens,
                output_tokens=config.estimate_analysis_output_tokens,
            )
        )
        estimate = batches.round_usd(one * requests)
        worst = batches.round_usd(
            worst_per_request(price, config, config.estimate_analysis_input_tokens) * requests
        )
    active = await lessons_service.active_count(db)
    if lesson.status not in lessons_service.CHECKED_STATUSES:
        reason = "lesson.not_ready"
    elif lesson.in_prompt:
        reason = "lesson.already_on"
    elif running is not None:
        reason = "lesson.quick_check_running"
    elif price is None:
        reason = "ai.no_price"
    elif not await _has_admin_key(db):
        reason = "ai.no_admin_key"
    elif len(matches) < MIN_EVENTS:
        reason = "lesson.quick_check_no_matches"
    elif worst > budget.left_usd:
        reason = "lesson.quick_check_budget"
    return QuickCheckOut(
        lesson_id=lesson.id,
        events=len(matches),
        requests=requests,
        baseline_reused=reused,
        model=config.analysis_model,
        estimate_usd=estimate,
        worst_usd=worst,
        budget_usd=budget.budget_usd,
        spent_usd=budget.spent_usd,
        reserved_usd=budget.reserved_usd,
        left_usd=budget.left_usd,
        active=active,
        max_active=config.lessons_max_active,
        can_run=reason is None,
        reason=reason,
        eval_run_id=running.id if running is not None else None,
        status=running.status if running is not None else None,  # type: ignore[arg-type]
    )


async def _base_prompt_version(db: AsyncSession, admin_id: int | None = None) -> str:
    """Промпт анализа активной версии администратора (как у smoke-eval)."""
    if admin_id is None:
        admin_id = await db.scalar(
            select(User.id)
            .where(User.role == "admin", User.status == "active")
            .order_by(User.id)
            .limit(1)
        )
    version = None
    if admin_id is not None:
        version = await db.scalar(
            select(StrategyVersion).where(
                StrategyVersion.user_id == admin_id, StrategyVersion.status == "active"
            )
        )
    return prompt_version_of(version)


Enqueue = Callable[[int], Awaitable[None]]


async def enqueue_quick(eval_run_id: int) -> None:
    """Задача воркера run_quick_check (одна на прогон)."""
    from app.workers.queue import create_queue_pool

    pool = await create_queue_pool(retries=1)
    try:
        await pool.enqueue_job(QUICK_JOB, eval_run_id, _job_id=f"{QUICK_JOB}:{eval_run_id}")
    finally:
        await pool.aclose()


def _quick_state(run: EvalRun, **fields: Any) -> dict[str, Any]:
    metrics = run.metrics or {}
    return {
        "eval_run_id": run.id,
        "status": run.status,
        "started_at": metrics.get("started_at"),
        "finished_at": metrics.get("finished_at"),
        "events": run.n_events,
        "requests": int(metrics.get("requests") or 0),
        "worst_usd": str(metrics.get("worst_usd") or "0"),
        "cost_usd": str(run.cost_usd or 0),
        "margin": MARGIN,
        **fields,
    }


async def start(
    db: AsyncSession,
    admin: User,
    lesson_id: int,
    *,
    ip: str | None,
    enqueue: Enqueue | None = None,
) -> QuickCheckOut:
    """Запуск быстрой проверки: строка eval_runs (pending), задача воркера; журнал
    eval_run. Нельзя запустить — 409 с причиной. Очередь недоступна — 503, прогон failed."""
    moment = utcnow()
    config = await load_agent_config(db)
    # Порядок блокировок: бюджет (app_settings), затем урок — как у резерва анализа
    await lock_budget(db)
    lesson = await lessons_service.shared_lesson(db, lesson_id, lock=True)
    plan = await preview(db, lesson_id, now=moment)
    if not plan.can_run:
        raise AppError(409, plan.reason or "lesson.not_ready")
    version = await ensure_active(db, admin.id)
    matches = await pick_matches(db, config, today=moment.date())
    split = smoke_eval.split_for(
        min((item.day for item in matches), default=moment.date()), config.analysis_model
    )
    run = EvalRun(
        version_kind="strategy",
        strategy_version_id=version.id,
        eval_set=f"{KIND}:{lesson.code}:{len(matches)}"[:64],
        split=split,
        n_events=len(matches),
        status="pending",
        max_tokens=config.eval_max_tokens,
        metrics={},
    )
    db.add(run)
    await db.flush()
    run.metrics = {
        "kind": KIND,
        "status": "pending",
        "lesson_id": lesson.id,
        "lesson_code": lesson.code,
        "admin_id": admin.id,
        "match_ids": [item.match.id for item in matches],
        "requests": plan.requests,
        "estimate_usd": str(plan.estimate_usd),
        "worst_usd": str(plan.worst_usd),
        "started_at": moment.isoformat(),
    }
    lesson.metrics = {**(lesson.metrics or {}), "quick": _quick_state(run)}
    await write_audit(
        db,
        action="eval_run",
        actor_id=admin.id,
        details={
            "kind": KIND,
            "code": lesson.code,
            "events": len(matches),
            "worst_usd": str(plan.worst_usd),
        },
        ip=ip,
    )
    await db.commit()
    try:
        await (enqueue or enqueue_quick)(run.id)
    except Exception as exc:
        await _fail(db, run.id, "queue_unavailable")
        raise AppError(503, "lesson.queue_unavailable") from exc
    return await preview(db, lesson_id)


# --- воркер: досье, запросы, отправка ---


async def _lesson_of(db: AsyncSession, run: EvalRun) -> Lesson | None:
    lesson_id = (run.metrics or {}).get("lesson_id")
    if lesson_id is None:
        return None
    return await db.get(Lesson, int(lesson_id), populate_existing=True)


async def _fail(db: AsyncSession, run_id: int, error: str, *, unsent: bool = False) -> None:
    """Прогон failed (commit). unsent — только если пакет еще не ушел (pending или running
    без строки пакета): ушедший пакет закончит сбор или уборка batch_jobs."""
    run = await db.get(EvalRun, run_id, with_for_update=True, populate_existing=True)
    if run is None or (
        unsent and (run.status not in ("pending", "running") or run.batch_job_id is not None)
    ):
        await db.rollback()
        return
    run.status = "failed"
    run.metrics = {
        **(run.metrics or {}),
        "status": "failed",
        "error": error,
        "finished_at": utcnow().isoformat(),
    }
    lesson = await _lesson_of(db, run)
    if lesson is not None:
        lesson.metrics = {
            **(lesson.metrics or {}),
            "quick": _quick_state(run, error=error, passed=False),
        }
    await db.commit()


def custom_id(run_id: int, match_id: int, arm: str) -> str:
    return f"qc{run_id}-m{match_id}-{arm}"


def parse_custom_id(value: str) -> tuple[int, str] | None:
    """custom_id → (матч, ветка)."""
    try:
        _, match_part, arm = value.split("-")
        return int(match_part.removeprefix("m")), arm
    except ValueError:
        return None


def quick_request(
    custom: str, event: smoke_eval.SmokeEvent, system: str, config: AgentConfig
) -> Request:
    """Запрос как у оценки матча в пакете smoke-eval, но с system проверки и
    eval_max_tokens (Т8)."""
    return cast(
        Request,
        {
            "custom_id": custom,
            "params": {
                "model": config.analysis_model,
                "max_tokens": config.eval_max_tokens,
                "system": [
                    {
                        "type": "text",
                        "text": system,
                        "cache_control": {"type": "ephemeral", "ttl": "1h"},
                    }
                ],
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


ClientFactory = Callable[[str], anthropic.AsyncAnthropic]


def _client(key: str) -> anthropic.AsyncAnthropic:
    return client_for(key, timeout=BATCH_TIMEOUT_S)


async def reap_stuck(db: AsyncSession, now: datetime | None = None) -> list[int]:
    """Быстрые проверки без пакета (pending или running без batch_jobs) старше
    PENDING_RESERVE — failed с ошибкой not_sent: задача воркера упала, потерялась или
    воркер перезапущен. Прогон, который сейчас готовит задача (строка под блокировкой),
    не трогается. commit. → id прогонов."""
    moment = now or utcnow()
    ids = list(
        await db.scalars(
            select(EvalRun.id)
            .where(
                EvalRun.metrics["kind"].astext == KIND,
                EvalRun.status.in_(("pending", "running")),
                EvalRun.batch_job_id.is_(None),
                EvalRun.created_at < moment - PENDING_RESERVE,
            )
            .with_for_update(skip_locked=True)
        )
    )
    await db.commit()
    for run_id in ids:
        await _fail(db, run_id, "not_sent", unsent=True)
    return ids


async def prepare_and_submit(
    db: AsyncSession, eval_run_id: int, *, client_factory: ClientFactory | None = None
) -> str:
    """Задача воркера: досье матчей, запросы с уроком и без, худший случай по настоящим
    досье, проверка бюджета проверок, строка batch_jobs и отправка. → статус прогона.
    Исключение до отправки — прогон failed и исключение дальше (повтор задачи ничего не
    сделает: прогон уже не pending)."""
    try:
        return await _prepare_and_submit(db, eval_run_id, client_factory=client_factory)
    except Exception:
        await db.rollback()
        await _fail(db, eval_run_id, "error", unsent=True)
        raise


async def _prepare_and_submit(
    db: AsyncSession, eval_run_id: int, *, client_factory: ClientFactory | None
) -> str:
    run = await db.get(EvalRun, eval_run_id, with_for_update=True, populate_existing=True)
    if run is None or run.status != "pending":
        status = (run.status if run is not None else None) or "missing"
        await db.rollback()
        return status
    metrics = dict(run.metrics or {})
    lesson = await _lesson_of(db, run)
    if lesson is None:
        await db.rollback()
        await _fail(db, eval_run_id, "lesson_missing")
        return "failed"
    config = await load_agent_config(db)
    version = await db.get(StrategyVersion, run.strategy_version_id)
    base = load_prompt_id(prompt_version_of(version))
    with_prompt = f"{base.text.rstrip()}\n\n{lessons_block([lesson])}\n"
    try:
        price = await price_for(db, config.analysis_model)
    except ClaudeStepError as exc:
        await db.rollback()
        await _fail(db, eval_run_id, exc.code)
        return "failed"
    matches = await _matches_by_ids(db, [int(value) for value in metrics.get("match_ids") or []])
    events = await smoke_eval.prepare_events(db, matches)
    found = await baselines(
        db, [event.match_id for event in events], prompt_version=base.version_id, config=config
    )
    requests: list[Request] = []
    stored: list[dict[str, Any]] = []
    worst = Decimal(0)
    for event in events:
        row = event.to_json(run.id)
        row.pop("custom_id", None)
        side = 2 if event.flip else 1
        reuse = found.get((event.match_id, event.dossier_id), {}).get(side)
        requests.append(
            quick_request(custom_id(run.id, event.match_id, WITH), event, with_prompt, config)
        )
        worst += worst_per_request(
            price,
            config,
            estimate_tokens(with_prompt, event.dossier_text, smoke_eval.request_text(event)),
        )
        if reuse is None:
            requests.append(
                quick_request(custom_id(run.id, event.match_id, WITHOUT), event, base.text, config)
            )
            worst += worst_per_request(
                price,
                config,
                estimate_tokens(base.text, event.dossier_text, smoke_eval.request_text(event)),
            )
        else:
            row["base_p"] = reuse
            row["base_reused"] = True
        stored.append(row)
    worst = batches.round_usd(worst)
    # Остаток и строка пакета — под блокировкой бюджета до commit (М2); свой резерв до
    # отправки не считается: вместо него встает худший случай пакета
    await lock_budget(db)
    budget = await eval_budget(db, exclude_run_id=run.id)
    if worst > budget.left_usd:
        await db.commit()
        await _fail(db, eval_run_id, "budget")
        return "failed"
    try:
        key = await key_for(db, key_source="admin", user_id=0)
    except ClaudeStepError as exc:
        await db.commit()
        await _fail(db, eval_run_id, exc.code)
        return "failed"
    meta = batches.RunMeta(
        kind="eval",
        model=config.analysis_model,
        effort=config.analysis_effort,
        prompt_version=lesson_prompt_version(base.version_id, lesson),
        schema_version=ASSESSMENT_SCHEMA_VERSION,
        eval_run_id=run.id,
    )
    job = await batches.open_job(
        db,
        kind="eval",
        requests=len(requests),
        worst_usd=worst,
        params=meta.to_params(base_prompt_version=base.version_id, eval_run_id=run.id),
        custom_ids=[str(request["custom_id"]) for request in requests],
    )
    run.batch_job_id = job.id
    run.status = "running"
    run.metrics = {
        **metrics,
        "status": "running",
        "events": stored,
        "requests": len(requests),
        "worst_usd": str(worst),
        "model": config.analysis_model,
        "effort": config.analysis_effort,
        "prompt_version": meta.prompt_version,
        "base_prompt_version": base.version_id,
    }
    lesson.metrics = {**(lesson.metrics or {}), "quick": _quick_state(run)}
    await db.commit()
    client = (client_factory or _client)(key)
    try:
        await batches.send_job(db, client, job, requests)
    except ClaudeStepError as exc:
        if job.status == batches.FAILED:
            await _fail(db, eval_run_id, exc.code)
            return "failed"
        # Ответа на создание нет, пакет не нашелся: строка pending, решит reap_pending
        return "running"
    return "running"


# --- сбор и итог ---


def summarize(events: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Итог по событиям: с уроком (l_outcome, l_p) и без (b_outcome, b_p или base_p)."""
    format_errors = sum(
        1
        for event in events
        if event.get("l_outcome") in (smoke_eval.FORMAT, smoke_eval.MAX_TOKENS)
    )
    refusals = sum(1 for event in events if event.get("l_outcome") == smoke_eval.REFUSAL)
    pairs = [
        event
        for event in events
        if event.get("l_outcome") in smoke_eval.USABLE
        and event.get("l_p") is not None
        and (event.get("base_p") is not None or event.get("b_p") is not None)
    ]
    diff: Estimate | None = None
    with_loss = without_loss = None
    if pairs:
        y = [int(event["y"]) for event in pairs]
        with_values = log_losses([float(event["l_p"]) for event in pairs], y)
        without_values = log_losses(
            [
                float(event["base_p"] if event.get("base_p") is not None else event["b_p"])
                for event in pairs
            ],
            y,
        )
        diff = bootstrap_diff_ci(with_values, without_values, seed=SEED)
        with_loss, without_loss = float(with_values.mean()), float(without_values.mean())
    unrated = len(events) - len(pairs)
    passed = (
        bool(events)
        and unrated == 0
        and format_errors == 0
        and refusals == 0
        and diff is not None
        and diff.high <= MARGIN
    )
    return {
        "n": len(pairs),
        "total": len(events),
        "unrated": unrated,
        "format_errors": format_errors,
        "refusals": refusals,
        "log_loss_with": with_loss,
        "log_loss_without": without_loss,
        "diff": None
        if diff is None
        else {"value": diff.value, "low": diff.low, "high": diff.high, "n": diff.n},
        "margin": MARGIN,
        "seed": SEED,
        "passed": passed,
    }


async def collect(
    db: AsyncSession, client: anthropic.AsyncAnthropic, job: BatchJob
) -> batches.Collected:
    """Сбор пакета быстрой проверки: agent_runs (бюджет проверок), ответы по событиям,
    итог в eval_runs и в уроке, уведомление администратору, который запускал. commit."""
    run = await db.scalar(select(EvalRun).where(EvalRun.batch_job_id == job.id))
    if run is None:
        meta = batches.RunMeta.from_params("eval", job.params or {})
        return await batches.collect_job(db, client, job.id, meta=meta, handle=_ignore)
    metrics = dict(run.metrics or {})
    events = {int(event["match_id"]): dict(event) for event in metrics.get("events") or []}
    version = await db.get(StrategyVersion, run.strategy_version_id)
    highlight = params_of(version).claude_highlight
    base_version = str(metrics.get("base_prompt_version") or "")

    async def handle(session: AsyncSession, item: batches.BatchItem, agent_run: AgentRun) -> None:
        parsed = parse_custom_id(item.custom_id)
        event = events.get(parsed[0]) if parsed is not None else None
        if parsed is None or event is None:
            return
        arm = parsed[1]
        if arm == WITHOUT:
            agent_run.prompt_version = base_version or agent_run.prompt_version
        if item.message is not None:
            judged = smoke_eval.judge(item.message, event, highlight)
        else:
            outcome = {
                batches.EXPIRED: smoke_eval.EXPIRED,
                batches.CANCELED: smoke_eval.CANCELED,
            }.get(item.kind, smoke_eval.ERRORED)
            judged = smoke_eval.Judged(outcome, item.detail, None)
        agent_run.error = judged.detail
        event[f"{arm}_outcome"] = judged.outcome
        if judged.assessment is not None:
            event[f"{arm}_p"] = min(1.0, max(0.0, float(judged.assessment.p1_win)))

    async def finish(session: AsyncSession, collected: BatchJob) -> None:
        summary = summarize(list(events.values()))
        moment = utcnow()
        run.status = "done"
        run.cost_usd = collected.cost_usd
        run.metrics = {
            **metrics,
            "status": "done",
            "events": list(events.values()),
            "summary": summary,
            "finished_at": moment.isoformat(),
        }
        lesson = await _lesson_of(session, run)
        if lesson is None:
            return
        lesson.metrics = {
            **(lesson.metrics or {}),
            "quick": _quick_state(
                run,
                passed=summary["passed"],
                diff=summary["diff"],
                format_errors=summary["format_errors"],
                refusals=summary["refusals"],
                unrated=summary["unrated"],
            ),
        }
        admin_id = metrics.get("admin_id")
        if admin_id is not None:
            await notify(
                session,
                user_id=int(admin_id),
                kind="learning",
                variant="quick_passed" if summary["passed"] else "quick_failed",
                link=lessons_service.LEARNING_LINK,
                code=lesson.code,
                events=summary["total"],
                cost=usd_text(collected.cost_usd),
            )

    meta = batches.RunMeta.from_params("eval", job.params or {}, eval_run_id=run.id)
    return await batches.collect_job(db, client, job.id, meta=meta, handle=handle, finish=finish)


async def _ignore(session: AsyncSession, item: batches.BatchItem, agent_run: AgentRun) -> None:
    return None


async def mark_lost(db: AsyncSession, job: BatchJob, reason: str) -> None:
    """Пакет быстрой проверки потерян: прогон failed (худший случай — в резерве до конца
    месяца отправки, app/agent/batches.py)."""
    run_id = await db.scalar(select(EvalRun.id).where(EvalRun.batch_job_id == job.id))
    if run_id is not None:
        await _fail(db, run_id, reason)
