"""Проверка ключа Claude API администратора легким запросом списка моделей
(ответы Anthropic подменены через транспорт httpx2)."""

from collections.abc import Callable

import anthropic
import httpx2
import pytest

from app.services.admin_key import KeyCheck, check_anthropic_key, looks_like_key

KEY = "sk-ant-api03-" + "x" * 40


def _client(
    handler: Callable[[httpx2.Request], httpx2.Response],
) -> anthropic.DefaultAsyncHttpxClient:
    return anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(handler))


def _error(status: int, kind: str) -> httpx2.Response:
    return httpx2.Response(
        status, json={"type": "error", "error": {"type": kind, "message": "nope"}}
    )


async def test_key_accepted() -> None:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(
            200, json={"data": [], "has_more": False, "first_id": None, "last_id": None}
        )

    assert await check_anthropic_key(KEY, http_client=_client(handler)) == KeyCheck("ok")
    [request] = seen
    assert request.url.path == "/v1/models"
    assert request.url.params["limit"] == "1"
    assert request.headers["x-api-key"] == KEY


@pytest.mark.parametrize(
    ("status", "kind", "expected"),
    [
        (401, "authentication_error", KeyCheck("rejected", 401)),
        (403, "permission_error", KeyCheck("rejected", 403)),
        (400, "invalid_request_error", KeyCheck("error", 400)),
    ],
)
async def test_key_rejected_or_failed(status: int, kind: str, expected: KeyCheck) -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return _error(status, kind)

    assert await check_anthropic_key(KEY, http_client=_client(handler)) == expected


async def test_network_failure_is_unavailable() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("no route", request=request)

    result = await check_anthropic_key(KEY, http_client=_client(handler))
    assert result == KeyCheck("unavailable")


def test_key_format() -> None:
    assert looks_like_key(KEY)
    for bad in (
        "",
        "sk-ant-short",
        "sk-proj-" + "x" * 40,
        KEY + " ",
        "sk-ant-api03-ключ" + "x" * 20,
    ):
        assert not looks_like_key(bad)
