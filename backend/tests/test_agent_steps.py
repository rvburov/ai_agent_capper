"""Шаги Claude без базы (app/agent/{parse,news,analysis,calls}.py): тело запроса, разбор
ответа, продолжения pause_turn, просьба вызвать record_news, сверка адресов новостей,
итерации анализа, учет неудачных вызовов и оборванного потока."""

import asyncio
import base64
import json
import time
from collections.abc import AsyncIterator, Iterator
from datetime import date
from typing import Any

import httpx2
import pytest
from pydantic import ValidationError

from app.agent.analysis import assess_match, check_assessment
from app.agent.calls import CallInfo
from app.agent.client import client_for, set_http_client_for_tests
from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError, error_from_exception
from app.agent.news import NewsTarget, fetch_news
from app.agent.parse import parse_text
from app.agent.prompts import ANALYSIS_PROMPT, load_prompt
from app.agent.schemas import Factor, Flags, MatchAssessmentOut
from app.core.config import Settings
from app.ml.sets import Probs3
from tests.claude_mock import (
    KEY,
    ClaudeMock,
    api_error,
    installed_mock,
    message,
    stream_body,
    stream_broken,
    text_message,
)
from tests.support import SettingsOverride

CONFIG = AgentConfig()
TODAY = date(2026, 10, 11)
P_BASE = Probs3(0.7, 0.45, 0.12)
REFS = {"elo", "form", "news:5"}


class Hooks:
    """StepHooks для тестов: что спросили до вызова и что записали после."""

    def __init__(self, *, refuse: ClaudeStepError | None = None, grant: int | None = None) -> None:
        self.before: list[dict[str, Any]] = []
        self.after: list[CallInfo] = []
        self.refuse = refuse
        self.grant = grant

    async def before_call(
        self,
        *,
        kind: str,
        model: str,
        input_tokens: int,
        max_tokens: int,
        min_tokens: int,
        searches: int,
    ) -> int | None:
        self.before.append(
            {
                "kind": kind,
                "model": model,
                "input_tokens": input_tokens,
                "max_tokens": max_tokens,
                "min_tokens": min_tokens,
                "searches": searches,
            }
        )
        if self.refuse is not None:
            raise self.refuse
        return self.grant

    async def after_call(self, info: CallInfo) -> int | None:
        self.after.append(info)
        return len(self.after)


@pytest.fixture
def claude() -> Iterator[ClaudeMock]:
    yield from installed_mock()


def _client() -> Any:
    return client_for(KEY, timeout=30.0)


# --- разбор ---

PARSED = {
    "bank": {"amount": 48000, "currency": "RUB"},
    "bookmaker": "Fonbet",
    "events": [
        {
            "line_no": 5,
            "player1": {"raw": "Синнер", "latin": "Jannik Sinner"},
            "player2": {"raw": "Руне", "latin": "Holger Rune"},
            "tournament": "Shanghai",
            "surface": "hard",
            "round": None,
            "odds": {
                "ml1": 1.17,
                "ml2": 5.1,
                "h1_minus": 1.62,
                "h1_plus": None,
                "h2_minus": None,
                "h2_plus": 2.3,
            },
            "bookmaker": None,
        }
    ],
    "unknown_lines": [],
}


async def test_parse_request_and_answer(claude: ClaudeMock) -> None:
    claude.add(text_message(json.dumps(PARSED), model="claude-haiku-5-5"))
    hooks = Hooks()
    parsed = await parse_text(_client(), "Синнер vs Руне", CONFIG, hooks)
    assert parsed.events[0].player1.latin == "Jannik Sinner"
    body = claude.bodies[0]
    assert body["model"] == "claude-haiku-5-5"
    assert body["output_config"]["effort"] == "low"
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert "tools" not in body and "temperature" not in body and "thinking" not in body
    assert body["messages"] == [{"role": "user", "content": "Синнер vs Руне"}]
    assert claude.keys == [KEY]
    assert [info.kind for info in hooks.after] == ["parse"]
    assert hooks.after[0].error is None and hooks.after[0].usage.input_tokens == 1000
    assert hooks.after[0].prompt_version == "parse_input.v1"
    assert hooks.after[0].schema_version == "p1"


async def test_parse_answer_not_by_schema_is_recorded(claude: ClaudeMock) -> None:
    claude.add(text_message('{"bank": 1'))
    hooks = Hooks()
    with pytest.raises(ClaudeStepError) as caught:
        await parse_text(_client(), "текст", CONFIG, hooks)
    assert caught.value.code == "ai.bad_output"
    assert [info.error for info in hooks.after] == ["schema"]


async def test_failed_call_is_recorded_with_request_id(claude: ClaudeMock) -> None:
    claude.add(api_error(529, "overloaded_error", request_id="req_529"))
    hooks = Hooks()
    with pytest.raises(ClaudeStepError) as caught:
        await parse_text(_client(), "текст", CONFIG, hooks)
    assert caught.value.code == "ai.overloaded"
    info = hooks.after[0]
    assert info.error == "529:overloaded_error" and info.request_id == "req_529"
    assert info.usage.total_tokens == 0


async def test_refused_before_call_sends_nothing(claude: ClaudeMock) -> None:
    hooks = Hooks(refuse=ClaudeStepError("ai.analysis_cap", cap="1,00"))
    with pytest.raises(ClaudeStepError) as caught:
        await parse_text(_client(), "текст", CONFIG, hooks)
    assert caught.value.code == "ai.analysis_cap"
    assert claude.requests == [] and hooks.after == []


# --- новости ---

URL1 = "https://www.atptour.com/en/news/sinner-1"
URL2 = "https://www.atptour.com/en/news/rune-2"


def _search(urls: list[str]) -> list[dict[str, Any]]:
    return [
        {"type": "server_tool_use", "id": "srv1", "name": "web_search", "input": {"query": "q"}},
        {
            "type": "web_search_tool_result",
            "tool_use_id": "srv1",
            "content": [
                {"type": "web_search_result", "url": url, "title": "t", "encrypted_content": "e"}
                for url in urls
            ],
        },
    ]


def _record(players: list[dict[str, Any]]) -> dict[str, Any]:
    return {"type": "tool_use", "id": "tu1", "name": "record_news", "input": {"players": players}}


def _item(
    url: str, *, kind: str = "injury", day: str = "2026-10-09", **extra: Any
) -> dict[str, Any]:
    return {
        "kind": kind,
        "summary": "Снялся с турнира из-за травмы спины",
        "published_at": day,
        "source_url": url,
        "source_name": "ATP",
        "result": None,
        **extra,
    }


TARGETS = [
    NewsTarget(position=1, player_id=101, name="Jannik Sinner"),
    NewsTarget(position=2, player_id=202, name="Holger Rune"),
]


async def _news(hooks: Hooks) -> Any:
    return await fetch_news(
        _client(),
        targets=TARGETS,
        match_label="Jannik Sinner vs Holger Rune, Shanghai",
        today=TODAY,
        config=CONFIG,
        hooks=hooks,
        max_uses=3,
    )


async def test_news_pause_turn_and_url_check(claude: ClaudeMock) -> None:
    paused = message(_search([URL1]), stop_reason="pause_turn", model="claude-sonnet-5-5")
    result = {
        "kind": "result",
        "summary": "Обыграл Медведева в полуфинале",
        "published_at": "2026-10-10",
        "source_url": URL2,
        "source_name": "ATP",
        "result": {
            "opponent": "Daniil Medvedev",
            "score": "6-4 6-3",
            "tournament": "Shanghai",
            "date": "2026-10-10",
            "won": True,
        },
    }
    final = message(
        [
            *_search([URL2]),
            _record(
                [
                    {
                        "player": 1,
                        "items": [
                            _item(URL1),
                            _item("https://evil.example/fake"),
                            _item(URL1, day="2026-08-01"),
                        ],
                    },
                    {"player": 2, "items": [result]},
                ]
            ),
        ],
        stop_reason="tool_use",
        model="claude-sonnet-5-5",
    )
    claude.add(paused, final)
    hooks = Hooks()
    outcome = await _news(hooks)
    # Продолжение: тот же разговор, ответ ассистента как есть, те же инструменты
    first, second = claude.bodies
    assert second["tools"] == first["tools"]
    assert [item["role"] for item in second["messages"]] == ["user", "assistant"]
    assert "2026-10-11" in first["messages"][0]["content"]
    # Адрес не из поиска и старая новость отброшены
    assert [(fact.player_id, fact.source_url) for fact in outcome.facts] == [
        (101, URL1),
        (202, URL2),
    ]
    assert outcome.dropped == 2
    assert outcome.facts[1].details == {
        "opponent": "Daniil Medvedev",
        "score": "6-4 6-3",
        "tournament": "Shanghai",
        "date": "2026-10-10",
        "won": True,
    }
    assert len(hooks.after) == 2 and all(info.kind == "news" for info in hooks.after)
    assert hooks.before[0]["searches"] == 3
    assert outcome.searched is True


def _search_error(code: str) -> dict[str, Any]:
    return {
        "type": "web_search_tool_result",
        "tool_use_id": "srv1",
        "content": {"type": "web_search_tool_result_error", "error_code": code},
    }


async def test_news_search_error_code(claude: ClaudeMock) -> None:
    claude.add(
        message(
            [
                _search_error("unavailable"),
                _record([{"player": 1, "items": []}, {"player": 2, "items": []}]),
            ],
            stop_reason="tool_use",
        )
    )
    outcome = await _news(Hooks())
    assert outcome.search_errors == ("unavailable",) and outcome.facts == []
    # Ни один поиск не удался: новости не проверены (сервис не отметит игроков)
    assert outcome.searched is False


async def test_max_uses_exceeded_is_not_a_search_failure(claude: ClaudeMock) -> None:
    """Модель попробовала четвертый поиск при max_uses = 3: API отвечает блоком
    max_uses_exceeded. Разрешенные поиски прошли — это не сбой поиска, и участник не
    видит «часть поисков не удалась». Сколько поисков разрешено, модель видит в
    сообщении."""
    claude.add(
        message(
            [
                *_search([URL1]),
                *_search([URL2]),
                *_search([URL1]),
                _search_error("max_uses_exceeded"),
                _record([{"player": 1, "items": [_item(URL1)]}, {"player": 2, "items": []}]),
            ],
            stop_reason="tool_use",
            model="claude-sonnet-5-5",
        )
    )
    outcome = await _news(Hooks())
    assert outcome.search_errors == () and outcome.limited == 1
    assert outcome.searched is True and len(outcome.facts) == 1
    text = claude.bodies[0]["messages"][0]["content"]
    assert "Поисков у тебя не больше 3 на весь запрос" in text


async def test_news_without_record_asks_once(claude: ClaudeMock) -> None:
    plain = message([{"type": "text", "text": "Ничего не нашел"}])
    claude.add(plain, plain)
    hooks = Hooks()
    with pytest.raises(ClaudeStepError) as caught:
        await _news(hooks)
    assert caught.value.detail == "news_not_recorded"
    assert len(claude.requests) == 2
    assert claude.bodies[1]["messages"][-1]["role"] == "user"


async def test_news_pause_turn_limit(claude: ClaudeMock) -> None:
    paused = message(_search([URL1]), stop_reason="pause_turn")
    claude.add(*[paused] * (CONFIG.news_max_pause_continuations + 1))
    with pytest.raises(ClaudeStepError) as caught:
        await _news(Hooks())
    assert caught.value.detail == "pause_limit"
    assert len(claude.requests) == CONFIG.news_max_pause_continuations + 1


# --- анализ ---


def _assessment(**fields: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "p1_win": 0.72,
        "p1_cover": 0.46,
        "p2_cover": 0.11,
        "confidence": "medium",
        "factors": [{"player": 1, "effect": "plus", "text": "Эло выше", "ref": "elo"}],
        "flags": {"p1": [], "p2": []},
        "explanation": "Близко к модели",
        "divergence_note": "",
    }
    data.update(fields)
    return data


def _out(**fields: Any) -> MatchAssessmentOut:
    return MatchAssessmentOut.model_validate(_assessment(**fields))


def test_divergence_is_measured_from_p_base_shown_in_dossier() -> None:
    """Модель видит p_base в досье с 3 знаками (0,6996 → 0,7) и по правилу промпта не
    обязана пояснять ответ 0,78 (ровно 8 п.п.). Раньше код сравнивал с неокругленным
    p_base, требовал пояснение («|0.780 - p_base 0.700| > 0.08») и платил за лишний вызов
    Opus с сообщением, которое противоречит само себе."""
    p_base = Probs3(0.6996, 0.4404, 0.1196)
    exact = _out(p1_win=0.78, p1_cover=0.44, p2_cover=0.12)
    assert check_assessment(exact, p_base=p_base, refs=REFS, highlight=0.08) == []
    beyond = _out(p1_win=0.781, p1_cover=0.44, p2_cover=0.12)
    [problem] = check_assessment(beyond, p_base=p_base, refs=REFS, highlight=0.08)
    assert "|0.781 - p_base 0.700| > 0.08" in problem


def test_check_assessment_rules() -> None:
    assert check_assessment(_out(), p_base=P_BASE, refs=REFS, highlight=0.08) == []
    problems = check_assessment(
        _out(p1_cover=0.8, p2_cover=0.4), p_base=P_BASE, refs=REFS, highlight=0.08
    )
    assert any("p1_cover" in item for item in problems)
    assert any("p2_cover" in item for item in problems)
    far = check_assessment(_out(p1_win=0.8), p_base=P_BASE, refs=REFS, highlight=0.08)
    assert any("divergence_note" in item for item in far)
    noted = _out(p1_win=0.8, divergence_note="Соперник снялся с прошлого турнира")
    assert check_assessment(noted, p_base=P_BASE, refs=REFS, highlight=0.08) == []
    # Ровно 8 п.п. не подсвечивается (как apply_claude)
    edge = _out(p1_win=0.78)
    assert check_assessment(edge, p_base=P_BASE, refs=REFS, highlight=0.08) == []
    bad_ref = _out(factors=[Factor(player=2, effect="minus", text="x", ref="news:9")])
    assert any(
        "news:9" in item
        for item in check_assessment(bad_ref, p_base=P_BASE, refs=REFS, highlight=0.08)
    )
    long_text = _out(explanation="а" * 301, flags=Flags(p1=["injury"], p2=[]))
    assert any(
        "explanation" in item
        for item in check_assessment(long_text, p_base=P_BASE, refs=REFS, highlight=0.08)
    )
    outside = _out(p1_win=1.2)
    assert check_assessment(outside, p_base=P_BASE, refs=REFS, highlight=0.08) == [
        "p1_win = 1.2 is outside 0..1"
    ]


async def _assess(hooks: Hooks, config: AgentConfig = CONFIG) -> Any:
    return await assess_match(
        _client(),
        prompt=load_prompt(*ANALYSIS_PROMPT),
        dossier_text='{"v":"d1"}',
        today=TODAY,
        p_base=P_BASE,
        refs=REFS,
        highlight=0.08,
        config=config,
        hooks=hooks,
    )


class _SlowBody(httpx2.AsyncByteStream):
    """Тело потока по частям с паузой между ними (медленный ответ, зависший поток)."""

    def __init__(self, parts: list[tuple[float, bytes]], read: asyncio.Event | None) -> None:
        self._parts = parts
        self._read = read

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for pause, chunk in self._parts:
            await asyncio.sleep(pause)
            yield chunk
            # SDK прочитал часть и ждет следующую
            if self._read is not None:
                self._read.set()

    async def aclose(self) -> None:
        return None


def _slow(parts: list[tuple[float, bytes]], read: asyncio.Event | None = None) -> Any:
    def reply(request: httpx2.Request) -> httpx2.Response:
        headers = {"content-type": "text/event-stream", "request-id": "req_slow"}
        return httpx2.Response(200, headers=headers, stream=_SlowBody(parts, read))

    return reply


def _stalled(read: asyncio.Event | None = None) -> Any:
    """message_start (вход 1000 токенов уже оплачен), затем тишина."""
    start = message([])
    start["stop_reason"] = None
    head = f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': start})}"
    return _slow([(0.0, (head + "\n\n").encode()), (30.0, b"")], read)


async def test_assessment_request_and_retry(claude: ClaudeMock) -> None:
    wrong = _assessment(factors=[{"player": 1, "effect": "plus", "text": "x", "ref": "h2h"}])
    claude.add(text_message(json.dumps(wrong)), text_message(json.dumps(_assessment())))
    hooks = Hooks()
    outcome = await _assess(hooks)
    assert outcome.calls == 2 and outcome.assessment.p1_win == 0.72
    first, second = claude.bodies
    assert first["stream"] is True and first["model"] == "claude-opus-5-5"
    assert first["output_config"]["effort"] == "medium"
    assert first["system"][-1]["cache_control"] == {"type": "ephemeral"}
    assert first["messages"][0]["content"][0]["text"] == '{"v":"d1"}'
    assert "2026-10-11" in first["messages"][0]["content"][1]["text"]
    assert [item["role"] for item in second["messages"]] == ["user", "assistant", "user"]
    assert "h2h" in second["messages"][2]["content"]
    # Ответ ассистента возвращается как есть, с пустым блоком размышлений
    assert second["messages"][1]["content"][0]["type"] == "thinking"
    assert [info.error for info in hooks.after] == ["checks", None]
    # Вход второй итерации — весь разговор: вход и выход первой плюс сообщение с ошибками
    first_usage = hooks.after[0].usage
    assert hooks.before[1]["input_tokens"] > first_usage.prompt_tokens + first_usage.output_tokens


async def test_broken_stream_records_input_usage(claude: ClaudeMock) -> None:
    claude.add(stream_broken(httpx2.ReadTimeout("stalled")))
    hooks = Hooks()
    with pytest.raises(ClaudeStepError) as caught:
        await _assess(hooks)
    assert caught.value.code == "ai.timeout"
    assert hooks.after[0].usage.input_tokens == 1000
    assert hooks.after[0].error == "timeout"
    # id запроса известен из заголовков ответа и у оборванного потока
    assert hooks.after[0].request_id == "req_broken"


async def test_timeout_keeps_input_usage_and_request_id(claude: ClaudeMock) -> None:
    claude.add(_stalled())
    hooks = Hooks()
    config = CONFIG.model_copy(update={"analysis_step_timeout_s": 0.3})
    with pytest.raises(ClaudeStepError) as caught:
        await _assess(hooks, config)
    # Тайм-аут шага отменяет чтение потока: вход уже оплачен и попадает в учет
    assert caught.value.code == "ai.timeout"
    info = hooks.after[0]
    assert info.error == "timeout" and info.request_id == "req_slow"
    assert info.usage.input_tokens == 1000


async def test_cancelled_call_is_recorded(claude: ClaudeMock) -> None:
    started = asyncio.Event()
    claude.add(_stalled(started))
    hooks = Hooks()
    task = asyncio.create_task(_assess(hooks))
    await asyncio.wait_for(started.wait(), timeout=5)
    task.cancel()
    # Задачу сняли (предел arq, остановка воркера): учет записан, отмена не потеряна
    with pytest.raises(asyncio.CancelledError):
        await task
    info = hooks.after[0]
    assert info.error == "cancelled" and info.request_id == "req_slow"
    assert info.usage.input_tokens == 1000


async def test_step_timeout_covers_all_iterations(claude: ClaudeMock) -> None:
    wrong = _assessment(factors=[{"player": 1, "effect": "plus", "text": "x", "ref": "h2h"}])
    body = stream_body(text_message(json.dumps(wrong))).encode()
    claude.add(*[_slow([(0.3, body)]) for _ in range(3)])
    hooks = Hooks()
    config = CONFIG.model_copy(update={"analysis_step_timeout_s": 0.8})
    started = time.monotonic()
    with pytest.raises(ClaudeStepError) as caught:
        await _assess(hooks, config)
    # Три итерации по 0,3 с не укладываются в предел шага 0,8 с: третья обрывается
    assert caught.value.code == "ai.timeout"
    assert time.monotonic() - started < 1.5
    assert [info.error for info in hooks.after] == ["checks", "checks", "timeout"]


async def test_corrupt_stream_event_is_unavailable(claude: ClaudeMock) -> None:
    start = message([])
    start["stop_reason"] = None
    body = (
        "event: message_start\ndata: "
        + json.dumps({"type": "message_start", "message": start})
        + "\n\nevent: content_block_start\ndata: {not json\n\n"
    )
    claude.add(httpx2.Response(200, text=body, headers={"content-type": "text/event-stream"}))
    hooks = Hooks()
    with pytest.raises(ClaudeStepError) as caught:
        await _assess(hooks)
    assert caught.value.code == "ai.unavailable"
    assert hooks.after[0].usage.input_tokens == 1000


def test_json_decode_error_is_unavailable() -> None:
    try:
        json.loads("{bad")
    except json.JSONDecodeError as exc:
        error = error_from_exception(exc)
    assert error.code == "ai.unavailable" and error.detail == "stream_decode"


# --- адрес API ---


async def test_base_url_from_settings(
    claude: ClaudeMock, override_settings: SettingsOverride
) -> None:
    override_settings(anthropic_base_url="http://127.0.0.1:8099")
    set_http_client_for_tests(claude.http_client())
    assert str(client_for(KEY, timeout=5.0).base_url).startswith("http://127.0.0.1:8099")


def test_prod_needs_https_base_url() -> None:
    master = "1:" + base64.b64encode(b"k" * 32).decode()
    fields: dict[str, Any] = {
        "env": "prod",
        "secret_key": "s" * 40,
        "master_keys": master,
        "public_origin": "https://capper.example",
        "cookie_secure": True,
    }
    assert Settings(**fields).anthropic_base_url == "https://api.anthropic.com"
    with pytest.raises(ValidationError, match="CAPPER_ANTHROPIC_BASE_URL"):
        Settings(**fields, anthropic_base_url="http://127.0.0.1:8099")
