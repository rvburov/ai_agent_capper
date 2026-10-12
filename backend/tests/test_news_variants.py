"""Варианты шага новостей для сравнения на живом ключе: значения по умолчанию, форма
запроса (прямой поиск и фильтрация кодом, с точкой кэша и без, Sonnet и Haiku 5.5) и
разбор ответов с фильтрацией: блок выполнения кода, пары server_tool_use и
web_search_tool_result с полем caller, контейнер (форма — по живой документации
web-search-tool и programmatic-tool-calling и типам SDK 1.12.1)."""

from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest

from app.agent.config import AgentConfig
from app.agent.news import NewsOutcome, NewsTarget, fetch_news
from tests.claude_mock import ClaudeMock, installed_mock, message
from tests.test_agent_steps import Hooks, _client

TODAY = date(2026, 10, 11)
URL1 = "https://www.atptour.com/en/news/sinner-1"
URL2 = "https://www.atptour.com/en/news/rune-2"
URL3 = "https://www.tennis.com/news/sinner-shanghai"
CODE = "code_execution_20260120"
CONTAINER = {"id": "container_011", "expires_at": "2026-10-11T12:30:00Z"}
TARGETS = [
    NewsTarget(position=1, player_id=101, name="Jannik Sinner"),
    NewsTarget(position=2, player_id=202, name="Holger Rune"),
]
DYNAMIC = AgentConfig(news_dynamic_filtering=True)


@pytest.fixture
def claude() -> Iterator[ClaudeMock]:
    yield from installed_mock()


def _caller(tool_id: str = "srvtoolu_code1") -> dict[str, Any]:
    return {"type": CODE, "tool_id": tool_id}


def _code_call(tool_id: str = "srvtoolu_code1") -> dict[str, Any]:
    return {
        "type": "server_tool_use",
        "id": tool_id,
        "name": "code_execution",
        "input": {"code": "rows = await web_search({'query': 'Sinner injury'})"},
    }


def _code_result(tool_id: str = "srvtoolu_code1", error: str | None = None) -> dict[str, Any]:
    content: dict[str, Any] = (
        {"type": "code_execution_tool_result_error", "error_code": error}
        if error is not None
        else {
            "type": "encrypted_code_execution_result",
            "content": [],
            "encrypted_stdout": "enc",
            "return_code": 0,
            "stderr": "",
        }
    )
    return {"type": "code_execution_tool_result", "tool_use_id": tool_id, "content": content}


def _nested_search(
    search_id: str,
    urls: list[str] | None,
    *,
    error: str | None = None,
    code: str = "srvtoolu_code1",
) -> list[dict[str, Any]]:
    """Поиск, вызванный кодом: server_tool_use и результат с caller."""
    result: Any = (
        {"type": "web_search_tool_result_error", "error_code": error}
        if error is not None
        else [
            {"type": "web_search_result", "url": url, "title": "t", "encrypted_content": "e"}
            for url in urls or []
        ]
    )
    return [
        {
            "type": "server_tool_use",
            "id": search_id,
            "name": "web_search",
            "input": {"query": "q"},
            "caller": _caller(code),
        },
        {
            "type": "web_search_tool_result",
            "tool_use_id": search_id,
            "content": result,
            "caller": _caller(code),
        },
    ]


def _item(url: str, day: str = "2026-10-09") -> dict[str, Any]:
    return {
        "kind": "injury",
        "summary": "Снялся с турнира из-за травмы спины",
        "published_at": day,
        "source_url": url,
        "source_name": "ATP",
        "result": None,
    }


def _record(players: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "tool_use",
        "id": "toolu_1",
        "name": "record_news",
        "input": {"players": players},
        "caller": {"type": "direct"},
    }


def _dynamic_message(content: list[dict[str, Any]], **fields: Any) -> dict[str, Any]:
    msg = message(content, model="claude-sonnet-5-5", **fields)
    msg["container"] = CONTAINER
    return msg


async def _news(config: AgentConfig, hooks: Hooks | None = None) -> NewsOutcome:
    return await fetch_news(
        _client(),
        targets=TARGETS,
        match_label="Jannik Sinner vs Holger Rune, Shanghai",
        today=TODAY,
        config=config,
        hooks=hooks or Hooks(),
        max_uses=config.news_max_uses,
    )


# --- значения по умолчанию ---


def test_news_defaults_from_live_check() -> None:
    """Один поиск на игрока (запрос на матч — два игрока), не больше 6 поисков на анализ,
    оценка — по живой проверке 12 октября: 37 тыс. входа, 1,5 тыс. выхода, 2 поиска.
    Варианты для сравнения выключены: прямой поиск и точка кэша, как раньше."""
    config = AgentConfig()
    assert (config.news_max_uses, config.news_max_searches_per_analysis) == (2, 6)
    assert (
        config.estimate_news_input_tokens,
        config.estimate_news_output_tokens,
        config.estimate_news_searches,
    ) == (37000, 1500, 2)
    assert config.news_dynamic_filtering is False and config.news_prompt_cache is True


# --- форма запроса ---


def _empty_record() -> dict[str, Any]:
    return message(
        [_record([{"player": 1, "items": []}, {"player": 2, "items": []}])],
        stop_reason="tool_use",
        model="claude-sonnet-5-5",
    )


async def test_direct_search_request(claude: ClaudeMock) -> None:
    claude.add(_empty_record())
    await _news(AgentConfig())
    [body] = claude.bodies
    search, record = body["tools"]
    assert search == {
        "type": "web_search_20260209",
        "name": "web_search",
        "max_uses": 2,
        "allowed_callers": ["direct"],
        "allowed_domains": list(AgentConfig().news_domains),
    }
    assert record["name"] == "record_news" and record["strict"] is True
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "container" not in body
    assert "Поисков у тебя не больше 2 на весь запрос" in body["messages"][0]["content"]


async def test_dynamic_filtering_request_has_no_allowed_callers(claude: ClaudeMock) -> None:
    """Фильтрация кодом: allowed_callers не задается (по умолчанию у _20260209 —
    code_execution_20260120), свой code_execution в tools не добавляется."""
    claude.add(_empty_record())
    await _news(DYNAMIC)
    [body] = claude.bodies
    assert [tool["name"] for tool in body["tools"]] == ["web_search", "record_news"]
    search = body["tools"][0]
    assert search["type"] == "web_search_20260209" and "allowed_callers" not in search
    assert search["max_uses"] == 2


async def test_without_prompt_cache_request_has_no_cache_control(claude: ClaudeMock) -> None:
    """Без точки кэша в запросе нет ни одного cache_control: тогда сервер не ставит и
    автоматическую точку после результатов поиска."""
    claude.add(_empty_record())
    await _news(AgentConfig(news_prompt_cache=False))
    [body] = claude.bodies
    assert body["system"] == [{"type": "text", "text": body["system"][0]["text"]}]
    assert "cache_control" not in str(body)


async def test_haiku_request_shape(claude: ClaudeMock) -> None:
    """Новости на Haiku 5.5: та же версия поиска (web_search_20260209), effort из
    настроек, без thinking и параметров выборки."""
    claude.add(_empty_record())
    hooks = Hooks()
    await _news(AgentConfig(news_model="claude-haiku-5-5"), hooks)
    [body] = claude.bodies
    assert body["model"] == "claude-haiku-5-5"
    assert body["tools"][0]["type"] == "web_search_20260209"
    assert body["output_config"] == {"effort": "low"}
    for name in ("thinking", "temperature", "top_p", "top_k", "tool_choice"):
        assert name not in body
    assert hooks.before[0]["model"] == "claude-haiku-5-5"
    assert hooks.after[0].model == "claude-haiku-5-5"


# --- ответы с фильтрацией кодом ---


async def test_dynamic_response_urls_errors_and_limit(claude: ClaudeMock) -> None:
    """Адреса для сверки — из всех результатов поиска, вызванных кодом (с caller);
    ошибка поиска и max_uses_exceeded внутри кода считаются так же, как без фильтрации;
    ошибка выполнения кода идет в code_errors, а не в ошибки поиска."""
    content = [
        {"type": "thinking", "thinking": "", "signature": "sig"},
        _code_call("srvtoolu_code1"),
        *_nested_search("srvtoolu_s1", [URL1, URL3]),
        *_nested_search("srvtoolu_s2", None, error="unavailable"),
        _code_result("srvtoolu_code1"),
        _code_call("srvtoolu_code2"),
        *_nested_search("srvtoolu_s3", [URL2], code="srvtoolu_code2"),
        *_nested_search("srvtoolu_s4", None, error="max_uses_exceeded", code="srvtoolu_code2"),
        _code_result("srvtoolu_code2", error="execution_time_exceeded"),
        _record(
            [
                {"player": 1, "items": [_item(URL1), _item(URL3), _item("https://x.example/a")]},
                {"player": 2, "items": [_item(URL2)]},
            ]
        ),
    ]
    claude.add(
        _dynamic_message(
            content,
            stop_reason="tool_use",
            server_tool_use={"web_search_requests": 2, "web_fetch_requests": 0},
        )
    )
    outcome = await _news(DYNAMIC)
    assert [(fact.player_id, fact.source_url) for fact in outcome.facts] == [
        (101, URL1),
        (101, URL3),
        (202, URL2),
    ]
    assert outcome.dropped == 1
    assert outcome.search_errors == ("unavailable",) and outcome.limited == 1
    assert outcome.code_errors == ("execution_time_exceeded",)
    assert outcome.searched is True and outcome.searches == 2


async def test_dynamic_pause_turn_continues_in_same_container(claude: ClaudeMock) -> None:
    """pause_turn с фильтрацией: ответ ассистента возвращается как есть (с блоками кода и
    caller), те же tools, и запрос продолжает тот же контейнер."""
    paused = _dynamic_message(
        [_code_call(), *_nested_search("srvtoolu_s1", [URL1])],
        stop_reason="pause_turn",
    )
    final = _dynamic_message(
        [
            _code_result(),
            _record([{"player": 1, "items": [_item(URL1)]}, {"player": 2, "items": []}]),
        ],
        stop_reason="tool_use",
    )
    claude.add(paused, final)
    hooks = Hooks()
    outcome = await _news(DYNAMIC, hooks)
    first, second = claude.bodies
    assert "container" not in first and second["container"] == CONTAINER["id"]
    assert second["tools"] == first["tools"]
    assert [item["role"] for item in second["messages"]] == ["user", "assistant"]
    returned = second["messages"][1]["content"]
    assert [block["type"] for block in returned] == [
        "server_tool_use",
        "server_tool_use",
        "web_search_tool_result",
    ]
    assert returned[1]["caller"] == _caller() and returned[2]["caller"] == _caller()
    assert [fact.source_url for fact in outcome.facts] == [URL1]
    assert len(hooks.after) == 2


async def test_dynamic_only_failed_searches_is_not_searched(claude: ClaudeMock) -> None:
    """Все поиски внутри кода с ошибкой: новости не проверены, как и без фильтрации."""
    claude.add(
        _dynamic_message(
            [
                _code_call(),
                *_nested_search("srvtoolu_s1", None, error="too_many_requests"),
                _code_result(),
                _record([{"player": 1, "items": []}, {"player": 2, "items": []}]),
            ],
            stop_reason="tool_use",
        )
    )
    outcome = await _news(DYNAMIC)
    assert outcome.searched is False and outcome.search_errors == ("too_many_requests",)


async def test_retry_after_missing_record_keeps_container(claude: ClaudeMock) -> None:
    """Модель закончила без record_news: просьба вызвать его — тот же разговор и тот же
    контейнер."""
    plain = _dynamic_message(
        [_code_call(), *_nested_search("srvtoolu_s1", [URL1]), _code_result()],
        stop_reason="end_turn",
    )
    claude.add(
        plain,
        _dynamic_message(
            [_record([{"player": 1, "items": [_item(URL1)]}, {"player": 2, "items": []}])],
            stop_reason="tool_use",
        ),
    )
    outcome = await _news(DYNAMIC)
    second = claude.bodies[1]
    assert second["container"] == CONTAINER["id"]
    assert [item["role"] for item in second["messages"]] == ["user", "assistant", "user"]
    assert [fact.source_url for fact in outcome.facts] == [URL1]


async def test_dynamic_failed_filter_code_counts_as_code_error(claude: ClaudeMock) -> None:
    """Упавший код фильтрации (ненулевой return_code, Traceback в stderr; так же по
    документации выглядит превышение 90 с на ячейку — detection_timeout) идет в
    code_errors, хотя error_code у результата нет. Удачный код (return_code 0) — не сбой."""
    failed = {
        "type": "code_execution_tool_result",
        "tool_use_id": "srvtoolu_code2",
        "content": {
            "type": "encrypted_code_execution_result",
            "content": [],
            "encrypted_stdout": "",
            "return_code": 1,
            "stderr": "Traceback (most recent call last): ... KeyError: 'url'",
        },
    }
    bash_failed = {
        "type": "bash_code_execution_tool_result",
        "tool_use_id": "srvtoolu_bash1",
        "content": {
            "type": "bash_code_execution_result",
            "content": [],
            "stdout": "",
            "stderr": "detection_timeout",
            "return_code": 137,
        },
    }
    claude.add(
        _dynamic_message(
            [
                _code_call("srvtoolu_code1"),
                *_nested_search("srvtoolu_s1", [URL1]),
                _code_result("srvtoolu_code1"),
                _code_call("srvtoolu_code2"),
                *_nested_search("srvtoolu_s2", [URL2], code="srvtoolu_code2"),
                failed,
                bash_failed,
                _record([{"player": 1, "items": [_item(URL1)]}, {"player": 2, "items": []}]),
            ],
            stop_reason="tool_use",
            server_tool_use={"web_search_requests": 2, "web_fetch_requests": 0},
        )
    )
    outcome = await _news(DYNAMIC)
    assert outcome.code_errors == ("return_code:1", "return_code:137")
    assert outcome.search_errors == () and outcome.searched is True
    assert [fact.source_url for fact in outcome.facts] == [URL1]


async def test_usage_iterations_kept_per_call(claude: ClaudeMock) -> None:
    """usage.iterations ответа (итерации серверного цикла: вход, запись и чтение кэша
    каждой) попадает в учет вызова и в итог шага: по ним видна форма разговора."""
    reply = message(
        [
            {"type": "server_tool_use", "id": "srvtoolu_s1", "name": "web_search", "input": {}},
            {
                "type": "web_search_tool_result",
                "tool_use_id": "srvtoolu_s1",
                "content": [
                    {
                        "type": "web_search_result",
                        "url": URL1,
                        "title": "t",
                        "encrypted_content": "e",
                    }
                ],
            },
            _record([{"player": 1, "items": [_item(URL1)]}, {"player": 2, "items": []}]),
        ],
        model="claude-sonnet-5-5",
        stop_reason="tool_use",
        input_tokens=262,
        output_tokens=1076,
        cache_creation_input_tokens=32444,
        cache_read_input_tokens=4498,
    )
    reply["usage"]["iterations"] = [
        {
            "type": "message",
            "input_tokens": 262,
            "output_tokens": 300,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 4498,
        },
        {
            "type": "message",
            "input_tokens": 0,
            "output_tokens": 776,
            "cache_read_input_tokens": 4498,
            "cache_creation_input_tokens": 27946,
        },
    ]
    claude.add(reply)
    hooks = Hooks()
    outcome = await _news(AgentConfig(), hooks)
    shape = [
        (item.type, item.input_tokens, item.cache_write_tokens, item.cache_read_tokens)
        for item in hooks.after[0].usage.iterations
    ]
    assert shape == [("message", 262, 4498, 0), ("message", 0, 27946, 4498)]
    assert outcome.usage.iterations == hooks.after[0].usage.iterations
