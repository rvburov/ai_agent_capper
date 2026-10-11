"""Сбои вызова Claude: исключения SDK, отказ, обрезанный ответ и ответ не по схеме
становятся ClaudeStepError с кодом из ru.json (ответы Anthropic подменены через httpx2)."""

import asyncio
from collections.abc import Iterator

import anthropic
import httpx2
import pytest
from anthropic.types import Message
from pydantic import BaseModel

from app.agent.client import BASE_URL, client_for, close_client, set_http_client_for_tests
from app.agent.errors import (
    CALL_ERROR_CODES,
    ClaudeStepError,
    claude_errors,
    error_from_exception,
    output_text,
    parse_output,
    stop_error,
)
from app.core.i18n import has_key
from tests.claude_mock import (
    KEY,
    ClaudeMock,
    api_error,
    installed_mock,
    message,
    refusal_message,
    stream_broken,
    stream_error,
    stream_truncated,
    text_message,
)


class Verdict(BaseModel):
    p1_win: float
    explanation: str


@pytest.fixture
def claude() -> Iterator[ClaudeMock]:
    yield from installed_mock()


async def _call() -> Message:
    with claude_errors():
        return await client_for(KEY, timeout=5.0).messages.create(
            model="claude-haiku-5-5",
            max_tokens=1024,
            messages=[{"role": "user", "content": "Синнер — Алькарас"}],
        )


async def _stream() -> Message:
    with claude_errors():
        async with client_for(KEY, timeout=5.0).messages.stream(
            model="claude-opus-5-5",
            max_tokens=16000,
            messages=[{"role": "user", "content": "досье"}],
            output_config={"effort": "medium"},
        ) as stream:
            return await stream.get_final_message()


def _no_secrets(exc: ClaudeStepError) -> None:
    for text in (str(exc), repr(exc), exc.message, exc.detail, str(exc.__cause__)):
        assert KEY not in text
        assert "synthetic" not in exc.message


def test_every_code_has_text() -> None:
    for code in (*CALL_ERROR_CODES, "ai.no_key", "ai.no_price"):
        assert has_key(f"errors.{code}"), code


@pytest.mark.parametrize(
    ("status", "kind", "code"),
    [
        (401, "authentication_error", "ai.key_rejected"),
        (403, "permission_error", "ai.key_rejected"),
        (404, "not_found_error", "ai.key_rejected"),
        (400, "invalid_request_error", "ai.bad_request"),
        (400, "billing_error", "ai.billing"),
        (402, "billing_error", "ai.billing"),
        (413, "request_too_large", "ai.bad_request"),
        (429, "rate_limit_error", "ai.rate_limited"),
        (529, "overloaded_error", "ai.overloaded"),
        (500, "api_error", "ai.unavailable"),
        (503, "api_error", "ai.unavailable"),
        (504, "timeout_error", "ai.unavailable"),
    ],
)
async def test_status_errors(claude: ClaudeMock, status: int, kind: str, code: str) -> None:
    claude.add(api_error(status, kind, request_id="req_77"))
    with pytest.raises(ClaudeStepError) as caught:
        await _call()
    exc = caught.value
    assert exc.code == code
    assert exc.detail == f"{status}:{kind}"
    assert exc.request_id == "req_77"
    assert exc.params == {"status": status}
    assert exc.is_key_failure == (code in ("ai.key_rejected", "ai.billing"))
    _no_secrets(exc)


async def test_timeout_and_connection_drop(claude: ClaudeMock) -> None:
    claude.add(httpx2.ReadTimeout("slow"), httpx2.RemoteProtocolError("peer closed"))
    with pytest.raises(ClaudeStepError) as timeout:
        await _call()
    assert (timeout.value.code, timeout.value.detail) == ("ai.timeout", "timeout")
    with pytest.raises(ClaudeStepError) as dropped:
        await _call()
    assert (dropped.value.code, dropped.value.detail) == ("ai.unavailable", "connection")


@pytest.mark.parametrize(
    ("exc", "code", "detail"),
    [
        (httpx2.ReadTimeout("stall"), "ai.timeout", "timeout"),
        (httpx2.RemoteProtocolError("peer closed"), "ai.unavailable", "connection"),
        (httpx2.ReadError("reset"), "ai.unavailable", "connection"),
    ],
)
async def test_stream_drop_after_200(
    claude: ClaudeMock, exc: Exception, code: str, detail: str
) -> None:
    """Обрыв или зависание потока после ответа 200: SDK отдает исключение httpx2 как есть,
    claude_errors превращает его в код."""
    claude.add(stream_broken(exc))
    with pytest.raises(ClaudeStepError) as caught:
        await _stream()
    assert (caught.value.code, caught.value.detail) == (code, detail)


async def test_stream_closed_before_end(claude: ClaudeMock) -> None:
    """Сервер закрыл поток до message_delta: текст есть, stop_reason нет — ответ не
    дописан, им нельзя пользоваться."""

    def truncated(request: httpx2.Request) -> httpx2.Response:
        body = stream_truncated(text_message('{"p1_win": 0.6, "explanation": "Форма"}'))
        return httpx2.Response(200, text=body, headers={"content-type": "text/event-stream"})

    claude.add(truncated)
    final = await _stream()
    assert final.stop_reason is None
    with pytest.raises(ClaudeStepError) as caught:
        parse_output(final, Verdict)
    assert (caught.value.code, caught.value.detail) == ("ai.unavailable", "incomplete")


def test_unknown_stop_reason_is_bad_output() -> None:
    msg = Message.model_construct(**{**text_message("{}"), "stop_reason": "new_reason"})
    error = stop_error(msg)
    assert error is not None and (error.code, error.detail) == ("ai.bad_output", "stop:new_reason")
    for reason in ("end_turn", "tool_use", "pause_turn", "stop_sequence"):
        done = Message.model_validate({**text_message("{}"), "stop_reason": reason})
        assert stop_error(done) is None


@pytest.mark.parametrize(
    "text",
    [
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing"
        " to upgrade or purchase credits.",
        "You have reached your specified API usage limits. You will regain access on"
        " 2026-11-01 at 00:00 UTC.",
    ],
)
async def test_billing_as_bad_request(claude: ClaudeMock, text: str) -> None:
    """Нет денег и лимит трат организации приходят как 400 invalid_request_error: это
    ai.billing (ключ надо проверить), а не ошибка программы. Текст Anthropic никуда не
    попадает."""
    claude.add(api_error(400, "invalid_request_error", message=text))
    with pytest.raises(ClaudeStepError) as caught:
        await _call()
    exc = caught.value
    assert (exc.code, exc.detail, exc.is_key_failure) == (
        "ai.billing",
        "400:invalid_request_error",
        True,
    )
    assert text not in exc.message and "credit" not in exc.detail


async def test_step_timeout_is_timeout() -> None:
    """Общий предел шага (asyncio.timeout) — тоже ai.timeout."""
    with pytest.raises(ClaudeStepError) as caught, claude_errors():
        async with asyncio.timeout(0.01):
            await asyncio.sleep(1)
    assert caught.value.code == "ai.timeout"


async def test_error_inside_stream(claude: ClaudeMock) -> None:
    """Ошибка после ответа 200 приходит событием error: разбирается по типу ошибки."""

    def overloaded(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            200,
            text=stream_error("overloaded_error"),
            headers={"content-type": "text/event-stream", "request-id": "req_s"},
        )

    claude.add(overloaded)
    with pytest.raises(ClaudeStepError) as caught:
        await _stream()
    assert caught.value.code == "ai.overloaded"
    assert caught.value.detail == "200:overloaded_error"


async def test_stream_ok_and_request_shape(
    claude: ClaudeMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Поток собирается в Message; запрос уходит на api.anthropic.com с ключом из
    client_for, даже если в окружении другой адрес и ключ."""
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://attacker.invalid")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-from-env-" + "x" * 20)
    claude.add(text_message('{"p1_win": 0.62, "explanation": "Форма лучше"}', output_tokens=900))
    final = await _stream()
    verdict = parse_output(final, Verdict)
    assert verdict == Verdict(p1_win=0.62, explanation="Форма лучше")
    [request] = claude.requests
    assert f"{request.url.scheme}://{request.url.host}" == BASE_URL
    assert request.headers["x-api-key"] == KEY
    body = claude.bodies[0]
    assert body["stream"] is True and body["model"] == "claude-opus-5-5"
    assert body["output_config"] == {"effort": "medium"}
    assert "temperature" not in body and "thinking" not in body
    assert final.usage.output_tokens == 900


def test_client_needs_key() -> None:
    for empty in ("", "unset"):
        with pytest.raises(ValueError):
            client_for(empty, timeout=5.0)


async def test_refusal_max_tokens_and_bad_output(claude: ClaudeMock) -> None:
    claude.add(
        refusal_message("reasoning_extraction"),
        text_message('{"p1_win": 0.6, "expl', stop_reason="max_tokens"),
        text_message('{"p1_win": "много"}'),
        message([{"type": "thinking", "thinking": "", "signature": "s"}]),
        message([], stop_reason="model_context_window_exceeded"),
    )
    refusal = await _call()
    error = stop_error(refusal)
    assert error is not None
    assert (error.code, error.detail) == ("ai.refusal", "refusal:reasoning_extraction")
    with pytest.raises(ClaudeStepError) as cut:
        parse_output(await _call(), Verdict)
    assert (cut.value.code, cut.value.detail) == ("ai.max_tokens", "max_tokens")
    with pytest.raises(ClaudeStepError) as bad:
        parse_output(await _call(), Verdict)
    assert (bad.value.code, bad.value.detail) == ("ai.bad_output", "schema")
    with pytest.raises(ClaudeStepError) as empty:
        output_text(await _call())
    assert (empty.value.code, empty.value.detail) == ("ai.bad_output", "no_text")
    with pytest.raises(ClaudeStepError) as window:
        output_text(await _call())
    assert window.value.code == "ai.max_tokens"
    assert window.value.detail == "model_context_window_exceeded"


def test_refusal_without_category() -> None:
    msg = Message.model_validate(refusal_message(None))
    error = stop_error(msg)
    assert error is not None and error.detail == "refusal:none"
    assert stop_error(Message.model_validate(text_message("{}"))) is None


def test_other_exceptions() -> None:
    assert error_from_exception(ValueError("Streaming is required")).code == "ai.bad_request"
    assert error_from_exception(RuntimeError("boom")).code == "ai.unavailable"
    same = ClaudeStepError("ai.refusal")
    assert error_from_exception(same) is same
    request = httpx2.Request("POST", f"{BASE_URL}/v1/messages")
    timeout = anthropic.APITimeoutError(request=request)
    assert error_from_exception(timeout).code == "ai.timeout"


async def test_long_request_without_stream_is_our_error(claude: ClaudeMock) -> None:
    """SDK не дает отправить долгий запрос без потока (max_tokens больше 21 333 при
    стандартном таймауте): это ошибка программы, а не сбой Claude."""
    with pytest.raises(ClaudeStepError) as caught, claude_errors():
        await anthropic.AsyncAnthropic(
            api_key=KEY, base_url=BASE_URL, http_client=claude.http_client()
        ).messages.create(
            model="claude-opus-5-5",
            max_tokens=64000,
            messages=[{"role": "user", "content": "x"}],
        )
    assert caught.value.code == "ai.bad_request"
    assert claude.requests == []


async def test_client_pool_per_loop_and_close() -> None:
    """У каждого цикла событий свой пул: команда терминала в своем asyncio.run не трогает
    пул API, а close_client закрывает только пул своего цикла."""
    set_http_client_for_tests(None)
    try:
        base = client_for(KEY, timeout=5.0)._client
        assert client_for(KEY, timeout=5.0)._client is base

        async def command() -> tuple[object, bool]:
            other = client_for(KEY, timeout=5.0)._client
            await close_client()
            return other, other.is_closed

        other, closed = await asyncio.to_thread(asyncio.run, command())
        assert other is not base and closed
        assert not base.is_closed
        await close_client()
        assert base.is_closed
        # После закрытия цикл получает новый пул
        assert client_for(KEY, timeout=5.0)._client is not base
        await close_client()
    finally:
        set_http_client_for_tests(None)


async def test_close_keeps_test_http_client(claude: ClaudeMock) -> None:
    claude.add(text_message("{}"), text_message("{}"))
    await _call()
    await close_client()
    await _call()
    assert len(claude.requests) == 2
