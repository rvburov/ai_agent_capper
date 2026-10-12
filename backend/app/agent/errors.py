"""Сбои шагов Claude: исключения SDK, отказ, обрезанный ответ и ответ не по схеме —
в один вид ошибки с кодом.

Код — ключ локали без префикса errors. (как у AppError): анализ останавливается со статусом
failed и error_code = код, пользователь видит текст из ru.json, а не текст ответа
Anthropic. detail — короткая метка для agent_runs.error и лога: «529:overloaded_error»,
«refusal:cyber», «max_tokens», «connection», «incomplete». Заголовки запроса (в них ключ)
в detail не попадают. Текст ошибки Anthropic хранится только у отказа «наш запрос
неверен» (400 invalid_request_error, код ai.bad_request): без него такую ошибку не
найти. Он идет в журнал вызовов и в вывод agent-smoke, но не участнику; строки вида
sk-ant-… в нем маскируются.
"""

import json
import re
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import anthropic
import httpx2
from anthropic.types import Message
from pydantic import BaseModel, ValidationError

from app.core.i18n import t

# Сбои вызова (ключи errors.ai.*)
CALL_ERROR_CODES = (
    "ai.key_rejected",
    "ai.billing",
    "ai.rate_limited",
    "ai.overloaded",
    "ai.unavailable",
    "ai.timeout",
    "ai.bad_request",
    "ai.refusal",
    "ai.max_tokens",
    "ai.bad_output",
)
# Ключ не найден или не расшифровывается (app/services/claude_key.py)
NO_KEY = "ai.no_key"
# Ошибки, после которых ключ надо проверить: пишется user_secrets.last_error и уведомление
KEY_FAILURE_CODES = frozenset({"ai.key_rejected", "ai.billing"})

# 401 и 403 — ключ неверный или отозван; 404 — модель недоступна организации этого ключа
_KEY_REJECTED = (
    anthropic.AuthenticationError,
    anthropic.PermissionDeniedError,
    anthropic.NotFoundError,
)
# Тип ошибки в теле ответа (в том числе в событии error внутри потока, где статус 200)
_BY_ERROR_TYPE = {
    "authentication_error": "ai.key_rejected",
    "permission_error": "ai.key_rejected",
    "not_found_error": "ai.key_rejected",
    "billing_error": "ai.billing",
    "rate_limit_error": "ai.rate_limited",
    "overloaded_error": "ai.overloaded",
    "api_error": "ai.unavailable",
    "timeout_error": "ai.timeout",
    "invalid_request_error": "ai.bad_request",
}
# Нет денег на счете и лимит трат организации API присылает как 400 invalid_request_error;
# отличить их от нашей ошибки запроса можно только по тексту (в журнал текст не пишется)
_BILLING_MARKERS = ("credit balance", "usage limit", "spend limit")
# stop_reason законченного ответа. None — поток закрылся без message_delta: ответ не
# дописан, а usage знает только вход
_COMPLETE_STOPS = frozenset({"end_turn", "tool_use", "pause_turn", "stop_sequence"})
_DETAIL_LENGTH = 64
# Текст ошибки Anthropic в журнале: коротко и без ключей
_API_MESSAGE_LENGTH = 300
_KEY_TEXT = re.compile(r"sk-ant-[A-Za-z0-9_\-]*")


class ClaudeStepError(Exception):
    """Сбой шага Claude. code — ключ локали без errors., params — параметры текста,
    detail — метка для agent_runs.error, request_id — id запроса Anthropic."""

    def __init__(
        self,
        code: str,
        *,
        detail: str | None = None,
        request_id: str | None = None,
        api_message: str | None = None,
        **params: Any,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail or code
        self.request_id = request_id
        self.api_message = api_message
        self.params = params

    @property
    def journal_detail(self) -> str:
        """Метка для agent_runs.error: detail и, если есть, текст отказа Anthropic."""
        if self.api_message:
            return f"{self.detail} | {self.api_message}"
        return self.detail

    @property
    def message(self) -> str:
        return t(f"errors.{self.code}", **self.params)

    @property
    def is_key_failure(self) -> bool:
        return self.code in KEY_FAILURE_CODES


def _status_detail(exc: anthropic.APIStatusError) -> str:
    return f"{exc.status_code}:{exc.type or 'error'}"


def _error_text(exc: anthropic.APIStatusError) -> str | None:
    body = exc.body
    error = body.get("error") if isinstance(body, dict) else None
    text = error.get("message") if isinstance(error, dict) else None
    return text if isinstance(text, str) else None


def api_message(exc: anthropic.APIStatusError) -> str | None:
    """Текст отказа Anthropic для журнала: одна строка, без ключей, не длиннее 300."""
    text = _error_text(exc)
    if not text:
        return None
    cleaned = " ".join(_KEY_TEXT.sub("sk-ant-***", text).split())
    return cleaned[:_API_MESSAGE_LENGTH] or None


def _is_billing(exc: anthropic.APIStatusError) -> bool:
    """400 invalid_request_error о деньгах: «credit balance is too low», «reached your
    specified API usage limits»."""
    text = _error_text(exc)
    if text is None:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in _BILLING_MARKERS)


def error_from_exception(exc: BaseException) -> ClaudeStepError:
    """Исключение вызова Claude → ClaudeStepError. Порядок проверок — от частных классов
    к общим: OverloadedError не подкласс InternalServerError, APITimeoutError — подкласс
    APIConnectionError. Ошибка внутри потока приходит со статусом 200: ее разбираем по
    типу ошибки в теле."""
    if isinstance(exc, ClaudeStepError):
        return exc
    if isinstance(exc, anthropic.APIStatusError):
        detail, request_id = _status_detail(exc), exc.request_id
        if isinstance(exc, _KEY_REJECTED):
            code = "ai.key_rejected"
        elif isinstance(exc, anthropic.RateLimitError):
            code = "ai.rate_limited"
        elif isinstance(exc, anthropic.OverloadedError):
            code = "ai.overloaded"
        elif isinstance(exc, anthropic.InternalServerError):
            code = "ai.unavailable"
        elif exc.type == "invalid_request_error" and _is_billing(exc):
            code = "ai.billing"
        elif exc.type is not None and exc.type in _BY_ERROR_TYPE:
            # Сюда же billing_error (402 и ошибка внутри потока)
            code = _BY_ERROR_TYPE[exc.type]
        elif exc.status_code == 402:
            code = "ai.billing"
        elif exc.status_code >= 500 or exc.status_code < 400:
            code = "ai.unavailable"
        else:
            code = "ai.bad_request"
        message = api_message(exc) if code == "ai.bad_request" else None
        return ClaudeStepError(
            code,
            detail=detail,
            request_id=request_id,
            api_message=message,
            status=exc.status_code,
        )
    # Сеть SDK оборачивает в APIConnectionError только до ответа. Обрыв и зависание
    # потока после ответа 200 приходят исключением httpx2 при чтении тела
    if isinstance(exc, anthropic.APITimeoutError | TimeoutError | httpx2.TimeoutException):
        return ClaudeStepError("ai.timeout", detail="timeout")
    if isinstance(exc, anthropic.APIConnectionError | httpx2.HTTPError):
        return ClaudeStepError("ai.unavailable", detail="connection")
    if isinstance(exc, anthropic.APIResponseValidationError):
        return ClaudeStepError("ai.bad_output", detail="response_validation")
    if isinstance(exc, ValidationError):
        return ClaudeStepError("ai.bad_output", detail="schema")
    if isinstance(exc, json.JSONDecodeError):
        # Испорченное событие потока SSE (обрыв посреди данных): сбой связи, а не наш запрос
        return ClaudeStepError("ai.unavailable", detail="stream_decode")
    if isinstance(exc, ValueError):
        # Защита SDK от долгого запроса без потока: ошибка нашего запроса
        return ClaudeStepError("ai.bad_request", detail="client")
    return ClaudeStepError("ai.unavailable", detail=type(exc).__name__)


@contextmanager
def claude_errors() -> Iterator[None]:
    """Блок вызова Claude: любое исключение SDK, обрыв потока (httpx2), тайм-аут шага
    (asyncio.timeout) и ошибка проверки схемы становятся ClaudeStepError."""
    try:
        yield
    except ClaudeStepError:
        raise
    except (
        anthropic.AnthropicError,
        httpx2.HTTPError,
        TimeoutError,
        ValidationError,
        ValueError,
    ) as exc:
        raise error_from_exception(exc) from exc


def stop_error(message: Message) -> ClaudeStepError | None:
    """Ответ пришел (HTTP 200), но им нельзя пользоваться: отказ, обрезан по max_tokens или
    по окну контекста, поток закрылся до конца ответа. Проверяется первым, до разбора
    content."""
    request_id = getattr(message, "_request_id", None)
    if message.stop_reason == "refusal":
        category = message.stop_details.category if message.stop_details else None
        return ClaudeStepError(
            "ai.refusal", detail=f"refusal:{category or 'none'}", request_id=request_id
        )
    if message.stop_reason in ("max_tokens", "model_context_window_exceeded"):
        return ClaudeStepError("ai.max_tokens", detail=message.stop_reason, request_id=request_id)
    if message.stop_reason is None:
        return ClaudeStepError("ai.unavailable", detail="incomplete", request_id=request_id)
    if message.stop_reason not in _COMPLETE_STOPS:
        detail = f"stop:{message.stop_reason}"[:_DETAIL_LENGTH]
        return ClaudeStepError("ai.bad_output", detail=detail, request_id=request_id)
    return None


def output_text(message: Message) -> str:
    """Текст ответа (первый блок text; блоки thinking пропускаются). Нет текста —
    ai.bad_output."""
    error = stop_error(message)
    if error is not None:
        raise error
    for block in message.content:
        if block.type == "text":
            return block.text
    raise ClaudeStepError(
        "ai.bad_output", detail="no_text", request_id=getattr(message, "_request_id", None)
    )


def parse_output[T: BaseModel](message: Message, schema: type[T]) -> T:
    """Ответ по схеме (output_config.format): сначала stop_reason, потом JSON и Pydantic.
    Диапазоны, длины и ссылки на факты проверяет вызывающий код после этого."""
    text = output_text(message)
    try:
        return schema.model_validate_json(text)
    except ValidationError:
        raise ClaudeStepError(
            "ai.bad_output", detail="schema", request_id=getattr(message, "_request_id", None)
        ) from None
