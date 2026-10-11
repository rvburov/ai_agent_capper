"""Один вызов Claude в шаге: проверка лимитов до вызова, тайм-аут, разбор сбоев и учет.

Шаги (parse, news, analysis) не знают о базе: до вызова они спрашивают у сервиса
разрешение (StepHooks.before_call — потолок анализа и лимиты по худшему случаю), после
вызова отдают ему CallInfo (StepHooks.after_call — строка agent_runs). Учет пишется и
на неудачный вызов: с кодом ошибки, request_id и usage, если ответ успел прийти (у
оборванного потока — то, что было в message_start). Так же — когда задачу сняли посреди
вызова (тайм-аут, отмена, остановка воркера): вход уже оплачен, а отмена не теряется.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol, cast

import anthropic
import httpx2
import structlog
from anthropic.types import Message, MessageParam

from app.agent.errors import ClaudeStepError, claude_errors, stop_error
from app.agent.runs import Usage, usage_from

log = structlog.get_logger(__name__)

# Грубая оценка числа токенов по тексту для худшего случая: русский текст и JSON дают
# 2–4 символа на токен, берем 2 — оценка сверху
CHARS_PER_TOKEN = 2


def estimate_tokens(*texts: str) -> int:
    """Оценка токенов входа сверху (для проверки лимитов до вызова)."""
    return sum(len(text) for text in texts) // CHARS_PER_TOKEN + 1


@dataclass(frozen=True)
class CallInfo:
    """Итог одного вызова API для agent_runs."""

    kind: str
    model: str
    effort: str | None
    prompt_version: str | None
    schema_version: str | None
    usage: Usage
    duration_ms: int
    stop_reason: str | None
    error: str | None
    request_id: str | None


class StepHooks(Protocol):
    """Связь шага с сервисом: разрешение на вызов и учет."""

    async def before_call(
        self, *, kind: str, model: str, input_tokens: int, max_tokens: int, searches: int
    ) -> None:
        """Перед вызовом: худший случай укладывается в лимиты, иначе ClaudeStepError."""
        ...

    async def after_call(self, info: CallInfo) -> int | None:
        """После вызова (и неудачного): строка agent_runs, ее id."""
        ...


@dataclass(frozen=True)
class CallSpec:
    """Что за вызов: для учета и проверки до вызова."""

    kind: str
    model: str
    effort: str
    prompt_version: str
    schema_version: str
    input_tokens: int
    max_tokens: int
    searches: int = 0


@dataclass(frozen=True)
class CallResult[T]:
    """Ответ, то, что из него прочитал шаг (read), id строки agent_runs и usage."""

    message: Message
    value: T
    agent_run_id: int | None
    usage: Usage


def plain(message: Message) -> tuple[Message, str | None]:
    """read для вызова, ответ которого шаг разбирает сам (новости)."""
    return message, None


@dataclass
class CallTrace:
    """Что известно о вызове до его конца: id запроса (из заголовков ответа) и usage из
    message_start. Заполняет send, читает call, если ответ так и не пришел целиком."""

    request_id: str | None = None
    usage: Usage | None = None


Send = Callable[[CallTrace], Awaitable[Message]]


def _request_id(message: Message) -> str | None:
    value = getattr(message, "_request_id", None)
    return value if isinstance(value, str) else None


async def call[T](
    hooks: StepHooks,
    spec: CallSpec,
    send: Send,
    *,
    timeout_s: float,
    read: Callable[[Message], tuple[T, str | None]],
) -> CallResult[T]:
    """Вызов с проверкой до него и учетом после. Сбой — ClaudeStepError (после записи
    учета). Ответ с отказом, обрезанный или незаконченный — тоже ClaudeStepError.
    read разбирает ответ до записи учета: его ClaudeStepError (ответ не по схеме) и
    метка (второе значение, например «checks» — ответ не прошел проверки кода) попадают
    в agent_runs.error."""
    await hooks.before_call(
        kind=spec.kind,
        model=spec.model,
        input_tokens=spec.input_tokens,
        max_tokens=spec.max_tokens,
        searches=spec.searches,
    )
    started = time.monotonic()

    def info(
        usage: Usage, stop_reason: str | None, error: str | None, request_id: str | None
    ) -> CallInfo:
        return CallInfo(
            kind=spec.kind,
            model=spec.model,
            effort=spec.effort,
            prompt_version=spec.prompt_version,
            schema_version=spec.schema_version,
            usage=usage,
            duration_ms=int((time.monotonic() - started) * 1000),
            stop_reason=stop_reason,
            error=error,
            request_id=request_id,
        )

    trace = CallTrace()
    try:
        with claude_errors():
            async with asyncio.timeout(timeout_s):
                message = await send(trace)
    except ClaudeStepError as exc:
        await hooks.after_call(
            info(trace.usage or Usage(), None, exc.detail, exc.request_id or trace.request_id)
        )
        raise
    except BaseException as exc:
        # Задачу сняли посреди вызова (отмена, предел arq) или сбой вне SDK: вызов мог быть
        # оплачен, поэтому учет пишется и тут, а исключение (и отмена) идет дальше
        detail = "cancelled" if isinstance(exc, asyncio.CancelledError) else "internal"
        await _record_anyway(hooks, info(trace.usage or Usage(), None, detail, trace.request_id))
        raise
    usage = usage_from(message)
    failure = stop_error(message)
    value: T | None = None
    note: str | None = None
    if failure is None:
        try:
            value, note = read(message)
        except ClaudeStepError as exc:
            failure = exc
    run_id = await hooks.after_call(
        info(
            usage,
            message.stop_reason,
            failure.detail if failure is not None else note,
            _request_id(message),
        )
    )
    if failure is not None:
        raise failure
    return CallResult(message=message, value=cast(T, value), agent_run_id=run_id, usage=usage)


async def _record_anyway(hooks: StepHooks, info: CallInfo) -> None:
    """Учет вызова, прерванного отменой: запись не отменяется вместе с задачей, а ее сбой
    не подменяет исходное исключение."""
    try:
        await asyncio.shield(hooks.after_call(info))
    except BaseException:
        log.warning("agent.call_record_failed", kind=info.kind, error=info.error)


async def create(client: anthropic.AsyncAnthropic, trace: CallTrace, **params: Any) -> Message:
    """messages.create без потока (разбор, новости: max_tokens небольшой)."""
    message: Message = await client.messages.create(**params)
    return message


# Сбои разбора испорченного потока внутри SDK (порядок событий, индексы блоков, JSON)
_STREAM_PARSE_ERRORS = (RuntimeError, TypeError, IndexError, KeyError, AssertionError, ValueError)


async def stream(client: anthropic.AsyncAnthropic, trace: CallTrace, **params: Any) -> Message:
    """messages.stream + get_final_message (анализ: большой max_tokens требует поток).
    Обрыв потока, тайм-аут и отмена после message_start оставляют в trace usage входа
    (вход уже оплачен) и id запроса."""
    async with client.messages.stream(**params) as running:
        # Собранное из потока сообщение не знает id запроса: он в заголовках ответа
        trace.request_id = running.request_id
        try:
            message: Message = await running.get_final_message()
        except BaseException as exc:
            trace.usage = _snapshot_usage(running)
            if isinstance(exc, _STREAM_PARSE_ERRORS) and not isinstance(
                exc, anthropic.AnthropicError | httpx2.HTTPError
            ):
                raise ClaudeStepError(
                    "ai.unavailable", detail="stream_parse", request_id=trace.request_id
                ) from exc
            raise
        message._request_id = running.request_id
        return message


def _snapshot_usage(running: Any) -> Usage | None:
    try:
        snapshot = running.current_message_snapshot
    except AssertionError:
        return None
    try:
        return usage_from(snapshot)
    except (AttributeError, TypeError):
        return None


def assistant_turn(message: Message) -> MessageParam:
    """Ответ модели как ход разговора для продолжения (pause_turn, повтор анализа):
    блоки возвращаются без изменений, вместе с пустыми блоками размышлений."""
    return message.to_param()
