"""Пакеты Message Batches API: общий механизм для разборов ставок, проверок (eval) и тени
(PLAN.md, раздел 6; TOKEN_ECONOMY.md, раздел 4; правила — SP/s3 «Claude API», раздел 4).

Batch дешевле вдвое на все токены (и кэш), поиск — без скидки; ответ — обычно в течение
часа, до суток; через 24 часа необработанные запросы получают expired; результаты хранятся
29 дней. Пакет может слегка превысить лимит трат workspace, поэтому худший случай пакета
держится в резерве бюджета до сбора результатов (reserved_usd):

- pending — строка создана, пакет еще не отправлен (или ответ на создание не дошел): в
  резерве PENDING_STALE после создания; дальше reap_pending ищет пакет у Anthropic (список
  пакетов, созданных после строки, с тем же числом запросов, custom_id сверяются по
  результатам) и привязывает его к строке (submitted), а не нашел — ставит failed;
- submitted — пока результаты можно забрать: 29 дней после отправки, а в месяце
  отправки — до конца месяца;
- lost (пакета или результатов у Anthropic нет) и abandoned — до конца месяца отправки:
  деньги, скорее всего, списаны, а сколько — неизвестно.

Идемпотентность (у Batch API нет ключа идемпотентности): строка batch_jobs с
детерминированными custom_id пишется до отправки; create_batch — без повторов SDK
(max_retries=0: повтор после тайм-аута создал бы второй оплаченный пакет); ответ на создание
не дошел (тайм-аут, обрыв, 5xx) — пакет ищется по списку, строка остается pending, пока
reap_pending его не найдет или не убедится, что его нет.

Здесь две части. Вызовы API: create_batch, retrieve (404 — BatchLost, а не «ключ
отозван»), cancel_batch (отмена: не начатые запросы — canceled), wait_batch,
iter_results (каждый результат — BatchItem: успех с ответом, ошибка по
result.error.error.type, истекший или отмененный), record_item — строка agent_runs
(batch = true, request_id «<batch_id>/<custom_id>», цена со скидкой Batch). Строки
batch_jobs: open_job (pending, до отправки — резерв виден другим), send_job, collect_job
(под FOR UPDATE: повторный или одновременный сбор не пишет agent_runs второй раз).
smoke-eval хранит состояние пакета в eval_runs.metrics и пользуется только вызовами API.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Collection, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import ROUND_UP, Decimal
from typing import Any, cast

import anthropic
from anthropic.types import Message
from anthropic.types.messages import MessageBatch
from anthropic.types.messages.batch_create_params import Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.errors import ClaudeStepError, claude_errors
from app.agent.runs import MTOK, Usage, long_factor, record_run, usage_from
from app.db.models import AgentRun, BatchJob, ModelPrice
from app.services.admin_users import month_start
from app.services.sessions import utcnow

# Опрос пакета в команде терминала: большинство пакетов готово за час
POLL_SECONDS = 60.0
# Результаты хранятся 29 дней после создания пакета
RESULTS_DAYS = 29
# Строка pending старше — пакет не ушел (сбой между записью и отправкой)
PENDING_STALE = timedelta(hours=1)
USD_STEP = Decimal("0.0001")
# Почему пакет потерян
BATCH_NOT_FOUND = "batch_not_found"
RESULTS_EXPIRED = "results_expired"
# Состояния batch_jobs (db/models/learning.py, BATCH_STATUSES)
PENDING = "pending"
SUBMITTED = "submitted"
COLLECTED = "collected"
FAILED = "failed"
LOST = "lost"
ABANDONED = "abandoned"
# Итог одного запроса пакета (BatchItem.kind)
SUCCEEDED = "succeeded"
ERRORED = "errored"
EXPIRED = "expired"
CANCELED = "canceled"
# Ошибки запроса пакета, после которых его стоит отправить еще раз (сбой у Anthropic)
RETRYABLE_ERRORS = frozenset({"overloaded_error", "api_error", "rate_limit_error", "timeout_error"})


class BatchLost(Exception):
    """Пакета или его результатов у Anthropic нет (reason — BATCH_NOT_FOUND или
    RESULTS_EXPIRED): другой workspace, удален или прошло 29 дней."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


# --- вызовы API ---


async def create_batch(
    client: anthropic.AsyncAnthropic, requests: Sequence[Request]
) -> MessageBatch:
    """Отправка пакета, один запрос без повторов SDK. Сбой — ClaudeStepError; пакет мог
    быть создан, если сбой неоднозначный (unsure_created)."""
    with claude_errors():
        return await client.with_options(max_retries=0).messages.batches.create(
            requests=list(requests)
        )


def unsure_created(exc: ClaudeStepError) -> bool:
    """Ответа на создание нет (тайм-аут, обрыв, 5xx, кроме перегрузки 529): пакет мог
    появиться у Anthropic. Отказ 4xx и 529 — запрос не принят."""
    if exc.code == "ai.timeout":
        return True
    status = exc.params.get("status")
    return exc.code == "ai.unavailable" and (status is None or int(status) >= 500)


# Сколько страниц списка пакетов смотреть при поиске (по 100, новые первыми)
FIND_PAGES = 5
# Часы клиента и Anthropic расходятся: пакет ищется с запасом до создания строки
FIND_SKEW = timedelta(minutes=5)


async def _custom_ids(client: anthropic.AsyncAnthropic, batch_id: str) -> set[str] | None:
    """custom_id законченного пакета по результатам; пакет в работе — None."""
    found = await retrieve(client, batch_id)
    if found.processing_status != "ended" or found.results_url is None:
        return None
    return {item.custom_id async for item in iter_results(client, batch_id)}


async def find_batch(
    db: AsyncSession, client: anthropic.AsyncAnthropic, job: BatchJob
) -> MessageBatch | None:
    """Пакет строки job, созданный у Anthropic, хотя ответ на создание не дошел: создан не
    раньше строки (с запасом FIND_SKEW), с тем же числом запросов, не привязан к другой
    строке. Законченный сверяется по custom_id (params.custom_ids); в работе — берется,
    только если такой кандидат один. Не нашли — None."""
    expected = {str(value) for value in (job.params or {}).get("custom_ids") or []}
    since = job.created_at - FIND_SKEW
    taken = set(await db.scalars(select(BatchJob.batch_id).where(BatchJob.batch_id.is_not(None))))
    candidates: list[MessageBatch] = []
    after: str | None = None
    with claude_errors():
        for _ in range(FIND_PAGES):
            page = (
                await client.messages.batches.list(limit=100, after_id=after)
                if after is not None
                else await client.messages.batches.list(limit=100)
            )
            items = list(page.data)
            for batch in items:
                counts = batch.request_counts
                total = (
                    counts.processing
                    + counts.succeeded
                    + counts.errored
                    + counts.canceled
                    + counts.expired
                )
                if batch.created_at >= since and total == job.requests and batch.id not in taken:
                    candidates.append(batch)
            if not items or items[-1].created_at < since or not page.has_more:
                break
            after = items[-1].id
    unverified: list[MessageBatch] = []
    for batch in candidates:
        try:
            ids = await _custom_ids(client, batch.id)
        except BatchLost:
            continue
        if ids is None:
            unverified.append(batch)
        elif expected and ids == expected:
            return batch
    if len(unverified) == 1 and len(candidates) == 1:
        return unverified[0]
    return None


async def retrieve(client: anthropic.AsyncAnthropic, batch_id: str) -> MessageBatch:
    """Пакет по id. 404 — BatchLost, а не «ключ отозван»: claude_errors считает 404
    недоступной моделью, а здесь это пакет другого workspace или удаленный."""
    with claude_errors():
        try:
            return await client.messages.batches.retrieve(batch_id)
        except anthropic.NotFoundError:
            raise BatchLost(BATCH_NOT_FOUND) from None


async def cancel_batch(client: anthropic.AsyncAnthropic, batch_id: str) -> MessageBatch:
    """Отмена пакета у Anthropic: запросы, которые еще не начаты, получают canceled (за них
    не платим), начатые доделываются и оплачиваются; результаты собираются как обычно.
    404 — BatchLost."""
    with claude_errors():
        try:
            return await client.messages.batches.cancel(batch_id)
        except anthropic.NotFoundError:
            raise BatchLost(BATCH_NOT_FOUND) from None


async def wait_batch(
    client: anthropic.AsyncAnthropic,
    batch_id: str,
    *,
    on_poll: Callable[[MessageBatch], None] | None = None,
    poll_seconds: float | None = None,
) -> MessageBatch:
    """Опрос пакета раз в poll_seconds (по умолчанию POLL_SECONDS), пока он не закончен.
    Только для команд терминала: воркер не ждет, а собирает раз в 15 минут."""
    while True:
        batch = await retrieve(client, batch_id)
        if batch.processing_status == "ended":
            return batch
        if on_poll is not None:
            on_poll(batch)
        await asyncio.sleep(POLL_SECONDS if poll_seconds is None else poll_seconds)


def ended_with_results(batch: MessageBatch) -> bool:
    """Пакет закончен. Закончен, а результатов нет (прошло 29 дней) — BatchLost."""
    if batch.processing_status != "ended":
        return False
    if batch.results_url is None:
        raise BatchLost(RESULTS_EXPIRED)
    return True


@dataclass(frozen=True)
class BatchItem:
    """Результат одного запроса пакета. kind — SUCCEEDED, ERRORED, EXPIRED, CANCELED;
    message — ответ (у успеха; отказ тоже здесь: stop_reason == "refusal"); usage — его
    токены с пометкой batch (у остальных — нули: не оплачиваются); error_type — тип ошибки
    запроса (invalid_request_error — чинить запрос); detail — метка для agent_runs.error."""

    custom_id: str
    kind: str
    message: Message | None
    usage: Usage
    stop_reason: str | None
    error_type: str | None
    detail: str | None

    @property
    def retryable(self) -> bool:
        """Запрос не выполнен не по нашей вине: истек, отменен или сбой у Anthropic."""
        if self.kind in (EXPIRED, CANCELED):
            return True
        return self.kind == ERRORED and self.error_type in RETRYABLE_ERRORS


def batch_item(raw: Any) -> BatchItem:
    """BatchItem из строки результатов SDK (MessageBatchIndividualResponse)."""
    result = raw.result
    custom_id = str(raw.custom_id)
    if result.type == "succeeded":
        message = cast(Message, result.message)
        return BatchItem(
            custom_id=custom_id,
            kind=SUCCEEDED,
            message=message,
            usage=replace(usage_from(message), batch=True),
            stop_reason=message.stop_reason,
            error_type=None,
            detail=None,
        )
    if result.type == "errored":
        # В SDK 1.12.1 тип лежит глубже, чем в документации: result.error.error.type
        error_type = str(result.error.error.type)
        return BatchItem(
            custom_id, ERRORED, None, Usage(batch=True), None, error_type, f"batch:{error_type}"
        )
    kind = EXPIRED if result.type == "expired" else CANCELED
    return BatchItem(custom_id, kind, None, Usage(batch=True), None, None, f"batch:{kind}")


async def iter_results(client: anthropic.AsyncAnthropic, batch_id: str) -> AsyncIterator[BatchItem]:
    """Результаты законченного пакета по одному. Результатов нет (404) — BatchLost."""
    with claude_errors():
        try:
            results = await client.messages.batches.results(batch_id)
        except anthropic.NotFoundError:
            raise BatchLost(BATCH_NOT_FOUND) from None
        async for raw in results:
            yield batch_item(raw)


def request_id(batch_id: str, custom_id: str) -> str:
    """id вызова пакета в agent_runs: у Batch своего request-id нет."""
    return f"{batch_id}/{custom_id}"


@dataclass(frozen=True)
class RunMeta:
    """Что пишется в agent_runs у каждого результата пакета."""

    kind: str
    model: str
    effort: str | None
    prompt_version: str | None
    schema_version: str | None
    key_source: str = "admin"
    user_id: int | None = None
    eval_run_id: int | None = None

    def to_params(self, **extra: Any) -> dict[str, Any]:
        return {
            "model": self.model,
            "effort": self.effort,
            "prompt_version": self.prompt_version,
            "schema_version": self.schema_version,
            **extra,
        }

    @classmethod
    def from_params(cls, kind: str, params: dict[str, Any], **extra: Any) -> "RunMeta":
        return cls(
            kind=kind,
            model=str(params.get("model") or ""),
            effort=params.get("effort"),
            prompt_version=params.get("prompt_version"),
            schema_version=params.get("schema_version"),
            **extra,
        )


async def record_item(
    db: AsyncSession, item: BatchItem, *, batch_id: str, meta: RunMeta, step: int
) -> AgentRun:
    """Строка agent_runs результата пакета: токены со скидкой Batch (ошибки, истекшие и
    отмененные запросы — нулевые, они не оплачиваются). flush; commit — за вызывающим."""
    return await record_run(
        db,
        user_id=meta.user_id,
        key_source=meta.key_source,
        analysis_id=None,
        kind=meta.kind,
        step=step,
        model=meta.model,
        effort=meta.effort,
        prompt_version=meta.prompt_version,
        schema_version=meta.schema_version,
        usage=item.usage,
        duration_ms=None,
        stop_reason=item.stop_reason,
        error=item.detail,
        request_id=request_id(batch_id, item.custom_id),
        eval_run_id=meta.eval_run_id,
    )


# --- цена ---


def request_worst_usd(
    price: ModelPrice, *, input_tokens: int, max_tokens: int, cache_1h: bool = False
) -> Decimal:
    """Худший случай одного запроса пакета: весь вход по самой дорогой цене входа (запись
    кэша на 1 час, если в запросе точка кэша с ttl 1h, иначе на 5 минут), весь
    max_tokens выхода, надбавка за длинный вход (вторая ступень цены модели, как у
    обычного вызова), половина цены (скидка Batch на все токены)."""
    per_input = max(price.input, price.cache_write_1h if cache_1h else price.cache_write_5m)
    tokens = (input_tokens * per_input + max_tokens * price.output) / MTOK
    return tokens * long_factor(price, input_tokens) / 2


def request_estimate_usd(price: ModelPrice, *, input_tokens: int, output_tokens: int) -> Decimal:
    """Оценка одного запроса пакета: вход по цене обычного входа, выход по оценке, с
    надбавкой за длинный вход."""
    tokens = (input_tokens * price.input + output_tokens * price.output) / MTOK
    return tokens * long_factor(price, input_tokens) / 2


def round_usd(value: Decimal) -> Decimal:
    return value.quantize(USD_STEP, rounding=ROUND_UP)


# --- строки batch_jobs ---


async def reserved_usd(
    db: AsyncSession, kinds: Collection[str], now: datetime | None = None
) -> Decimal:
    """Резерв худшего случая незабранных пакетов этих видов (окна — в docstring модуля)."""
    moment = now or utcnow()
    month = month_start(moment)
    collectable_since = min(month, moment - timedelta(days=RESULTS_DAYS))
    sent = func.coalesce(BatchJob.submitted_at, BatchJob.created_at)
    total = await db.scalar(
        select(func.sum(BatchJob.worst_usd)).where(
            BatchJob.kind.in_(list(kinds)),
            or_(
                (BatchJob.status == PENDING) & (BatchJob.created_at >= moment - PENDING_STALE),
                (BatchJob.status == SUBMITTED) & (sent >= collectable_since),
                BatchJob.status.in_((LOST, ABANDONED)) & (sent >= month),
            ),
        )
    )
    return Decimal(total or 0)


async def open_job(
    db: AsyncSession,
    *,
    kind: str,
    requests: int,
    worst_usd: Decimal,
    params: dict[str, Any],
    custom_ids: Sequence[str] = (),
) -> BatchJob:
    """Строка пакета до отправки (pending): ее резерв уже виден другим; custom_ids — по ним
    reap_pending узнает пакет, если ответ на создание не дошел. flush; commit — за
    вызывающим, до отправки."""
    job = BatchJob(
        kind=kind,
        status=PENDING,
        requests=requests,
        worst_usd=round_usd(worst_usd),
        params={**params, "custom_ids": list(custom_ids)} if custom_ids else params,
    )
    db.add(job)
    await db.flush()
    return job


async def send_job(
    db: AsyncSession,
    client: anthropic.AsyncAnthropic,
    job: BatchJob,
    requests: Sequence[Request],
) -> str:
    """Отправка пакета строки job: id пакета, submitted (commit). Отказ — failed с кодом
    (commit) и ClaudeStepError: ничего не потрачено, резерв снят. Ответа нет (тайм-аут,
    обрыв, 5xx) — пакет ищется по списку: нашелся — submitted, иначе строка остается
    pending с резервом (reap_pending поищет еще раз) и ClaudeStepError."""
    try:
        batch = await create_batch(client, requests)
    except ClaudeStepError as exc:
        found: MessageBatch | None = None
        if unsure_created(exc):
            try:
                found = await find_batch(db, client, job)
            except ClaudeStepError:
                found = None
            if found is None:
                job.error = exc.journal_detail[:500]
                await db.commit()
                raise
        if found is None:
            job.status = FAILED
            job.error = exc.journal_detail[:500]
            job.ended_at = utcnow()
            await db.commit()
            raise
        batch = found
    job.batch_id = batch.id
    job.status = SUBMITTED
    job.submitted_at = batch.created_at
    job.error = None
    await db.commit()
    return batch.id


async def lock_job(db: AsyncSession, job_id: int) -> BatchJob | None:
    found: BatchJob | None = await db.scalar(
        select(BatchJob)
        .where(BatchJob.id == job_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return found


async def mark_lost(db: AsyncSession, job_id: int, reason: str) -> None:
    """Пакета или результатов нет: lost с причиной (commit). Худший случай держится в
    резерве до конца месяца отправки."""
    job = await lock_job(db, job_id)
    if job is not None and job.status == SUBMITTED:
        job.status = LOST
        job.error = reason
        job.ended_at = utcnow()
    await db.commit()


async def reap_pending(
    db: AsyncSession,
    now: datetime | None = None,
    *,
    client: anthropic.AsyncAnthropic | None = None,
) -> tuple[list[int], list[int]]:
    """Строки pending старше PENDING_STALE: пакет, созданный у Anthropic до сбоя воркера
    (find_batch), привязывается к строке (submitted, соберется как обычно); не нашелся —
    failed (not_sent). Без клиента (нет ключа) или при сбое поиска строка ждет следующего
    прохода (резерв уже снят: прошло PENDING_STALE, а пакет без ключа не уйдет). commit.
    → (id failed, id привязанных)."""
    moment = now or utcnow()
    jobs = list(
        await db.scalars(
            select(BatchJob)
            .where(BatchJob.status == PENDING, BatchJob.created_at < moment - PENDING_STALE)
            .with_for_update(skip_locked=True)
        )
    )
    failed: list[int] = []
    attached: list[int] = []
    for job in jobs:
        if client is None:
            continue
        try:
            found = await find_batch(db, client, job)
        except ClaudeStepError:
            continue
        if found is not None:
            job.batch_id = found.id
            job.status = SUBMITTED
            job.submitted_at = found.created_at
            job.error = None
            attached.append(job.id)
            continue
        job.status = FAILED
        job.error = "not_sent"
        job.ended_at = moment
        failed.append(job.id)
    await db.commit()
    return failed, attached


async def recorded_ids(db: AsyncSession, batch_id: str) -> set[str]:
    """request_id результатов пакета, уже записанных в agent_runs."""
    rows = await db.scalars(
        select(AgentRun.request_id).where(
            AgentRun.request_id.startswith(f"{batch_id}/", autoescape=True)
        )
    )
    return {value for value in rows if value}


# Обработчик результата: строка agent_runs уже записана (flush), обработчик пишет свое
ItemHandler = Callable[[AsyncSession, BatchItem, AgentRun], Awaitable[None]]


@dataclass(frozen=True)
class Collected:
    """Итог сбора: состояние пакета (submitted — еще в работе), сколько результатов
    записано в этот раз."""

    status: str
    items: int


async def collect_job(
    db: AsyncSession,
    client: anthropic.AsyncAnthropic,
    job_id: int,
    *,
    meta: RunMeta,
    handle: ItemHandler,
    finish: Callable[[AsyncSession, BatchJob], Awaitable[None]] | None = None,
) -> Collected:
    """Сбор законченного пакета: строка agent_runs на каждый результат и обработчик
    handle, затем collected и стоимость (commit). Строка пакета под FOR UPDATE:
    одновременный сбор ждет, повторный ничего не пишет. Результаты, уже записанные в
    agent_runs (сбор прервался на середине), пропускаются; finish — итог после всех
    результатов, в той же транзакции. Пакет в работе — ничего не меняется. Пакета или
    результатов нет — lost (commit) и BatchLost."""
    job = await lock_job(db, job_id)
    if job is None or job.status != SUBMITTED or job.batch_id is None:
        await db.commit()
        return Collected(job.status if job is not None else FAILED, 0)
    batch_id = job.batch_id
    try:
        found = await retrieve(client, batch_id)
        if not ended_with_results(found):
            await db.commit()
            return Collected(SUBMITTED, 0)
        seen = await recorded_ids(db, batch_id)
        step = len(seen)
        written = 0
        async for item in iter_results(client, batch_id):
            if request_id(batch_id, item.custom_id) in seen:
                continue
            step += 1
            run = await record_item(db, item, batch_id=batch_id, meta=meta, step=step)
            await handle(db, item, run)
            written += 1
    except BatchLost as exc:
        await db.rollback()
        await mark_lost(db, job_id, exc.reason)
        raise
    total = await db.scalar(
        select(func.sum(AgentRun.cost_usd)).where(
            AgentRun.request_id.startswith(f"{batch_id}/", autoescape=True)
        )
    )
    job.cost_usd = Decimal(total or 0)
    if finish is not None:
        await finish(db, job)
    job.status = COLLECTED
    job.ended_at = utcnow()
    await db.commit()
    return Collected(COLLECTED, written)
