"""Подмена Claude API в тестах: ответы и ошибки через httpx2.MockTransport, без сети.

    @pytest.fixture
    def claude() -> Iterator[ClaudeMock]:
        yield from installed_mock()

    claude.add(text_message('{"p1_win": 0.6}'))     # обычный ответ
    claude.add(api_error(529, "overloaded_error"))   # ошибка API
    claude.add(httpx2.ConnectError("drop"))          # обрыв сети до ответа
    claude.add(stream_broken(httpx2.ReadTimeout("x")))  # обрыв потока после ответа 200
    ... вызов кода, который ходит в Claude через app.agent.client.client_for ...
    claude.bodies[0]["model"]                        # тело первого запроса

Запрос с "stream": true получает тот же ответ событиями SSE (message_start … message_stop),
как отдает API: messages.stream(...).get_final_message() собирает его обратно.
Ответы синтетические: поля как в API, тексты — свои.
"""

import json
from collections.abc import AsyncIterator, Callable, Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import anthropic
import httpx2
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.client import set_http_client_for_tests
from app.db.models import ModelPrice

KEY = "sk-ant-api03-" + "Kq7" * 14
OTHER_KEY = "sk-ant-api03-" + "Zx9" * 14

Reply = httpx2.Response | dict[str, Any] | Exception | Callable[[httpx2.Request], httpx2.Response]


def usage(**fields: Any) -> dict[str, Any]:
    """usage со всеми полями API; поля можно переопределить."""
    data: dict[str, Any] = {
        "input_tokens": 1000,
        "output_tokens": 300,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0},
        "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
        "output_tokens_details": {"thinking_tokens": 100},
        "service_tier": "standard",
    }
    data.update(fields)
    return data


def message(
    content: list[dict[str, Any]],
    *,
    stop_reason: str = "end_turn",
    model: str = "claude-opus-5-5",
    stop_details: dict[str, Any] | None = None,
    **usage_fields: Any,
) -> dict[str, Any]:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "stop_details": stop_details,
        "usage": usage(**usage_fields),
    }


def text_message(text: str, **fields: Any) -> dict[str, Any]:
    """Ответ с пустым блоком размышлений (как у моделей 5.5) и текстом."""
    blocks = [
        {"type": "thinking", "thinking": "", "signature": "sig"},
        {"type": "text", "text": text},
    ]
    return message(blocks, **fields)


def refusal_message(category: str | None = "cyber", **fields: Any) -> dict[str, Any]:
    details = {"type": "refusal", "category": category, "explanation": None}
    return message([], stop_reason="refusal", stop_details=details, **fields)


def api_error(
    status: int, kind: str, *, request_id: str = "req_err", message: str = "synthetic error"
) -> httpx2.Response:
    return httpx2.Response(
        status,
        json={"type": "error", "error": {"type": kind, "message": message}},
        headers={"request-id": request_id},
    )


def _sse(events: list[tuple[str, dict[str, Any]]]) -> str:
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)


def stream_body(msg: dict[str, Any]) -> str:
    """Ответ событиями потока: блоки text и thinking, usage в message_start и message_delta."""
    start = {**msg, "content": [], "stop_reason": None}
    events: list[tuple[str, dict[str, Any]]] = [
        ("message_start", {"type": "message_start", "message": start})
    ]
    for index, block in enumerate(msg["content"]):
        if block["type"] == "text":
            empty: dict[str, Any] = {"type": "text", "text": ""}
            delta: dict[str, Any] = {"type": "text_delta", "text": block["text"]}
        elif block["type"] == "thinking":
            empty = {"type": "thinking", "thinking": "", "signature": ""}
            delta = {"type": "signature_delta", "signature": block.get("signature", "sig")}
        else:
            raise ValueError(block["type"])
        events += [
            (
                "content_block_start",
                {"type": "content_block_start", "index": index, "content_block": empty},
            ),
            (
                "content_block_delta",
                {"type": "content_block_delta", "index": index, "delta": delta},
            ),
            ("content_block_stop", {"type": "content_block_stop", "index": index}),
        ]
    events += [
        (
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": msg["stop_reason"], "stop_sequence": None},
                "usage": {"output_tokens": msg["usage"]["output_tokens"]},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    return _sse(events)


def stream_truncated(msg: dict[str, Any]) -> str:
    """Поток, который сервер закрыл до message_delta: блоки есть, stop_reason нет."""
    full = stream_body(msg)
    return full[: full.index("event: message_delta")]


class _BrokenBody(httpx2.AsyncByteStream):
    """Тело ответа 200: начало потока, затем исключение при чтении (обрыв, зависание)."""

    def __init__(self, head: bytes, exc: Exception) -> None:
        self._head = head
        self._exc = exc

    async def __aiter__(self) -> AsyncIterator[bytes]:
        yield self._head
        raise self._exc

    async def aclose(self) -> None:
        return None


def stream_broken(exc: Exception) -> Callable[[httpx2.Request], httpx2.Response]:
    """Ответ для ClaudeMock.add: 200 и message_start, потом чтение тела бросает exc
    (httpx2.ReadTimeout, RemoteProtocolError и т. п.) — SDK такое не оборачивает."""
    start = message([])
    start["stop_reason"] = None
    head = _sse([("message_start", {"type": "message_start", "message": start})]).encode()

    def reply(request: httpx2.Request) -> httpx2.Response:
        headers = {"content-type": "text/event-stream", "request-id": "req_broken"}
        return httpx2.Response(200, headers=headers, stream=_BrokenBody(head, exc))

    return reply


def stream_error(kind: str) -> str:
    """Поток, который оборвался событием error после ответа 200."""
    start = message([])
    start["stop_reason"] = None
    return _sse(
        [
            ("message_start", {"type": "message_start", "message": start}),
            ("error", {"type": "error", "error": {"type": kind, "message": "synthetic"}}),
        ]
    )


class ClaudeMock:
    """Очередь ответов Claude API и записанные запросы."""

    def __init__(self) -> None:
        self.requests: list[httpx2.Request] = []
        self._replies: list[Reply] = []

    def add(self, *replies: Reply) -> "ClaudeMock":
        self._replies.extend(replies)
        return self

    @property
    def bodies(self) -> list[dict[str, Any]]:
        return [json.loads(r.content) if r.content else {} for r in self.requests]

    @property
    def keys(self) -> list[str]:
        """x-api-key каждого запроса (тест проверяет, чей ключ ушел)."""
        return [r.headers.get("x-api-key", "") for r in self.requests]

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if not self._replies:
            raise AssertionError(f"лишний запрос к Claude: {request.method} {request.url.path}")
        reply = self._replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if callable(reply) and not isinstance(reply, httpx2.Response):
            return reply(request)
        if isinstance(reply, httpx2.Response):
            return reply
        body = json.loads(request.content) if request.content else {}
        headers = {"request-id": "req_test"}
        if body.get("stream"):
            headers["content-type"] = "text/event-stream"
            return httpx2.Response(200, text=stream_body(reply), headers=headers)
        return httpx2.Response(200, json=reply, headers=headers)

    def http_client(self) -> anthropic.DefaultAsyncHttpxClient:
        return anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(self.handler))

    @property
    def pending(self) -> int:
        return len(self._replies)


def installed_mock() -> Iterator[ClaudeMock]:
    """Для фикстуры: все клиенты app.agent.client идут в ClaudeMock (без повторов SDK)."""
    mock = ClaudeMock()
    set_http_client_for_tests(mock.http_client())
    try:
        yield mock
    finally:
        set_http_client_for_tests(None)


def models_list() -> dict[str, Any]:
    return {"data": [], "has_more": False, "first_id": None, "last_id": None}


def model_info(model: str) -> dict[str, Any]:
    return {
        "type": "model",
        "id": model,
        "display_name": model,
        "created_at": "2026-09-01T00:00:00Z",
        "lifecycle": "active",
    }


# Цены моделей, как их вставляет миграция 0003 (тесты чистят таблицы перед каждым тестом)
PRICES_FROM = datetime(2026, 10, 1, tzinfo=UTC)
PRICES: dict[str, tuple[str, str, str, str, str, str, int | None, str | None]] = {
    # input, output, cache_read, cache_write_5m, cache_write_1h, search, порог, множитель
    "claude-opus-5-5": ("4", "20", "0.20", "5", "8", "0.01", None, None),
    "claude-sonnet-5-5": ("2", "10", "0.10", "2.50", "4", "0.01", None, None),
    "claude-haiku-5-5": ("0.10", "0.50", "0.01", "0.125", "0.20", "0.01", 100000, "5"),
    "claude-haiku-4-5": ("1", "5", "0.10", "1.25", "2", "0.01", None, None),
}


def price_row(model: str, valid_from: datetime = PRICES_FROM) -> ModelPrice:
    inp, out, read, w5, w1, search, threshold, mult = PRICES[model]
    return ModelPrice(
        model=model,
        valid_from=valid_from,
        input=Decimal(inp),
        output=Decimal(out),
        cache_read=Decimal(read),
        cache_write_5m=Decimal(w5),
        cache_write_1h=Decimal(w1),
        search_price=Decimal(search),
        long_input_threshold=threshold,
        long_multiplier=Decimal(mult) if mult is not None else None,
    )


async def seed_prices(db: AsyncSession, *models: str) -> None:
    """Цены моделей в базу (по умолчанию — все четыре) и commit."""
    for model in models or tuple(PRICES):
        db.add(price_row(model))
    await db.commit()
