"""Поддельный Claude API для прогонов без ключа: тесты конвейера, локальный запуск,
Playwright волны 3.

Отвечает по смыслу запроса, а не по очереди (вызовы анализа идут параллельно):
- разбор (схема с unknown_lines) — свой разбор текста формата бота регулярными
  выражениями: банк, букмекер, «A vs B, турнир, покрытие, раунд», кэфы П1/П2 и форы;
- новости (инструмент record_news) — блок поиска web_search_tool_result с двумя
  адресами и вызов record_news с фактами по этим адресам; у web_search без
  allowed_callers (фильтрация поиска кодом) — в форме такого ответа: блок выполнения
  кода, пара server_tool_use и web_search_tool_result с полем caller и контейнер;
  запись кэша после результата поиска — только если в запросе есть точка cache_control;
- анализ (схема с p1_win) — потоком SSE: p_base досье со сдвигом +0,02 к игроку 1,
  факторы со ссылками elo и form; первый вызов с этими инструментами и system пишет
  кэш, следующие читают;
- разбор матча (схема с verdict, этап 5) — по фактам: разбираемая сторона (subject)
  выиграла — fine без гипотезы, нет — model_error и гипотеза postmortem_hypothesis
  (условие из словаря: фаворит на покрытии матча, модель завышает);
- GET /v1/models и /v1/models/{id} — для проверки ключа; у модели есть capabilities
  (веб-поиск у всех, programmatic tool calling — у всех, кроме claude-haiku-4-5);
- Message Batches: POST /v1/messages/batches, GET /v1/messages/batches (список, новые
  первыми: поиск пакета, созданного до сбоя воркера), GET …/batches/{id} (пакет
  в работе первые batch_polls опросов, потом ended и results_url), GET …/{id}/results —
  JSONL: каждый запрос пакета отвечается как обычный (без потока, service_tier batch);
  ответ с ошибкой HTTP — результат errored с тем же типом ошибки. Неизвестный пакет —
  404 not_found_error; batches[id]["expired"] = True — прошло 29 дней (пакет виден,
  results_url нет, результаты — 404). id пакета — msgbatch_fake‹N› в тестах,
  msgbatch_fake‹метка процесса›_‹N› у сервера; /_fake/reset номера не сбрасывает.

Сбои включаются переключателем: FakeClaude.fail(step, error, times) в тестах,
POST /_fake/fail {"step": "analysis", "error": "overloaded", "times": 1} у сервера или
переменная окружения FAKE_CLAUDE_FAIL=analysis:overloaded[,news:search_error]. step —
parse, news, analysis или any; error — overloaded (529), rate_limited (429),
key_rejected (401), server (500), refusal, max_tokens, bad_json, bad_checks (ответ не
проходит проверку кода), search_error (ошибка поиска unavailable), no_record
(новости без record_news); у разбора (step postmortem) bad_checks — вывод против исхода,
bad_scope — условие гипотезы не из словаря. Пакеты: step batch — error expired или
canceled (результат запроса пакета такого вида), step batch_create — ошибка из списка
выше при отправке.

Этап 6: в том же сервере — поддельный сервис push (tests/fake_push.py: /push/<id> и
/_fake/push*), ответы сервера — с CORS «*».

Запуск сервера:
    cd backend && .venv/bin/uvicorn tests.fake_claude:app --port 8099
    CAPPER_ANTHROPIC_BASE_URL=http://127.0.0.1:8099 (API и воркер)
"""

import hashlib
import json
import os
import re
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx2
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from tests import fake_push

MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5")
STEPS = ("parse", "news", "analysis", "postmortem")
ERRORS = {
    "overloaded": (529, "overloaded_error"),
    "rate_limited": (429, "rate_limit_error"),
    "key_rejected": (401, "authentication_error"),
    "server": (500, "api_error"),
    "bad_request": (400, "invalid_request_error"),
}
SHIFT = 0.02
# Фильтрация поиска кодом: кто вызвал поиск и контейнер выполнения кода в ответе
CODE_CALLER = "code_execution_20260120"
FAKE_CONTAINER = {"id": "container_fake", "expires_at": "2026-12-31T00:00:00Z"}
# Модели без programmatic tool calling: фильтрация поиска кодом им недоступна
NO_CODE_CALLERS = frozenset({"claude-haiku-4-5"})

# Гипотеза разбора по умолчанию: «{surface}» заменяется покрытием матча из фактов
DEFAULT_HYPOTHESIS: dict[str, Any] = {
    "text": "Фаворит на этом покрытии выигрывает реже, чем дает модель",
    "direction": "lower",
    "conditions": [
        {"feature": "role", "op": "eq", "values": ["favorite"], "value": None},
        {"feature": "surface", "op": "in", "values": ["{surface}"], "value": None},
    ],
}

_SURFACES = {
    "хард": "hard",
    "hard": "hard",
    "грунт": "clay",
    "clay": "clay",
    "трава": "grass",
    "grass": "grass",
    "хардкорт": "hard",
}
_ROUNDS = {
    "1/64": "R128",
    "1/32": "R64",
    "1/16": "R32",
    "1/8": "R16",
    "1/4": "QF",
    "1/2": "SF",
    "финал": "F",
    "полуфинал": "SF",
    "четвертьфинал": "QF",
}
_EVENT = re.compile(
    r"^\s*(?P<p1>[^,]+?)\s+(?:vs|—|-|–)\s+(?P<p2>[^,]+?)\s*(?:,(?P<rest>.*))?$", re.IGNORECASE
)
_ODD = r"(\d+[.,]\d+)"
_BANK = re.compile(r"банк[^:]*:\s*([\d\s.,]+)\s*(₽|руб|р\b|\$|€|usd|eur|rub)?", re.IGNORECASE)
_BOOKMAKER = re.compile(r"^\s*букмекер\s*:\s*(.+)$", re.IGNORECASE)


def _num(text: str) -> float:
    return float(text.replace(",", "."))


def _odds_in(line: str, label: str) -> float | None:
    found = re.search(re.escape(label) + r"\s*=\s*" + _ODD, line)
    return _num(found.group(1)) if found else None


def parse_text(text: str) -> dict[str, Any]:
    """Разбор текста формата бота (ответ по схеме ParsedInput)."""
    bank: dict[str, Any] = {"amount": None, "currency": None}
    bookmaker: str | None = None
    events: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.lower().rstrip(":") == "события":
            continue
        bank_match = _BANK.search(stripped)
        if bank_match:
            digits = re.sub(r"[\s]", "", bank_match.group(1)).replace(",", ".")
            try:
                bank["amount"] = float(digits)
            except ValueError:
                bank["amount"] = None
            sign = (bank_match.group(2) or "").lower()
            bank["currency"] = {
                "₽": "RUB",
                "руб": "RUB",
                "р": "RUB",
                "rub": "RUB",
                "$": "USD",
                "usd": "USD",
                "€": "EUR",
                "eur": "EUR",
            }.get(sign)
            continue
        book = _BOOKMAKER.match(stripped)
        if book:
            bookmaker = book.group(1).strip()
            continue
        if "кэф" in stripped.lower() and events:
            odds = events[-1]["odds"]
            odds["ml1"] = _odds_in(stripped, "П1") or odds["ml1"]
            odds["ml2"] = _odds_in(stripped, "П2") or odds["ml2"]
            continue
        if "фора" in stripped.lower() and events:
            odds = events[-1]["odds"]
            odds["h1_minus"] = _odds_in(stripped, "П1(-1.5)")
            odds["h1_plus"] = _odds_in(stripped, "П1(+1.5)")
            odds["h2_minus"] = _odds_in(stripped, "П2(-1.5)")
            odds["h2_plus"] = _odds_in(stripped, "П2(+1.5)")
            continue
        event = _EVENT.match(stripped)
        if event and " vs " in f" {stripped.lower()} ":
            parts = [
                part.strip() for part in (event.group("rest") or "").split(",") if part.strip()
            ]
            surface = next((_SURFACES[p.lower()] for p in parts if p.lower() in _SURFACES), None)
            round_code = next((_ROUNDS[p.lower()] for p in parts if p.lower() in _ROUNDS), None)
            tournament = next(
                (p for p in parts if p.lower() not in _SURFACES and p.lower() not in _ROUNDS),
                None,
            )
            events.append(
                {
                    "line_no": number,
                    "player1": {"raw": event.group("p1").strip(), "latin": None},
                    "player2": {"raw": event.group("p2").strip(), "latin": None},
                    "tournament": tournament,
                    "surface": surface,
                    "round": round_code,
                    "odds": {
                        key: None
                        for key in ("ml1", "ml2", "h1_minus", "h1_plus", "h2_minus", "h2_plus")
                    },
                    "bookmaker": None,
                }
            )
            continue
        unknown.append({"line_no": number, "text": stripped})
    return {"bank": bank, "bookmaker": bookmaker, "events": events, "unknown_lines": unknown}


# --- ответы ---


def usage(**fields: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "input_tokens": 1200,
        "output_tokens": 400,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0},
        "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
        "output_tokens_details": {"thinking_tokens": 150},
        "service_tier": "standard",
    }
    data.update(fields)
    return data


def message(
    content: list[dict[str, Any]],
    *,
    model: str,
    stop_reason: str | None = "end_turn",
    stop_details: dict[str, Any] | None = None,
    **usage_fields: Any,
) -> dict[str, Any]:
    return {
        "id": "msg_fake",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "stop_details": stop_details,
        "usage": usage(**usage_fields),
    }


def _sse(events: list[tuple[str, dict[str, Any]]]) -> str:
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events)


def stream_body(msg: dict[str, Any]) -> str:
    """Сообщение событиями потока (message_start … message_stop)."""
    start = {**msg, "content": [], "stop_reason": None}
    events: list[tuple[str, dict[str, Any]]] = [
        ("message_start", {"type": "message_start", "message": start})
    ]
    for index, block in enumerate(msg["content"]):
        if block["type"] == "text":
            empty: dict[str, Any] = {"type": "text", "text": ""}
            delta: dict[str, Any] = {"type": "text_delta", "text": block["text"]}
        else:
            empty = {"type": "thinking", "thinking": "", "signature": ""}
            delta = {"type": "signature_delta", "signature": block.get("signature", "sig")}
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
                "delta": {
                    "stop_reason": msg["stop_reason"],
                    "stop_sequence": None,
                    "stop_details": msg.get("stop_details"),
                },
                "usage": {"output_tokens": msg["usage"]["output_tokens"]},
            },
        ),
        ("message_stop", {"type": "message_stop"}),
    ]
    return _sse(events)


def _thinking() -> dict[str, Any]:
    return {"type": "thinking", "thinking": "", "signature": "sig"}


def step_of(body: dict[str, Any]) -> str:
    """Шаг по смыслу запроса: инструмент record_news — новости, схема с p1_win — анализ,
    схема с unknown_lines — разбор."""
    tools = body.get("tools") or []
    if any(tool.get("name") == "record_news" for tool in tools):
        return "news"
    schema = ((body.get("output_config") or {}).get("format") or {}).get("schema") or {}
    properties = schema.get("properties") or {}
    if "p1_win" in properties:
        return "analysis"
    if "verdict" in properties:
        return "postmortem"
    return "parse"


def _dynamic_search(body: dict[str, Any]) -> bool:
    """У web_search_20260209 без allowed_callers поиск вызывает код (фильтрация)."""
    tools = body.get("tools") or []
    search = next((tool for tool in tools if tool.get("name") == "web_search"), None)
    return search is not None and "allowed_callers" not in search


def _has_cache_control(body: dict[str, Any]) -> bool:
    """Есть ли в запросе хоть одна точка cache_control (system, инструменты, сообщения)."""
    return '"cache_control"' in json.dumps(
        [body.get("system"), body.get("tools"), body.get("messages")]
    )


def _news_iterations(cache: dict[str, Any]) -> list[dict[str, Any]]:
    """usage.iterations ответа новостей: первая итерация (system и запрос, вызов поиска)
    пишет или читает кэш, вторая (после результата поиска) — вход без кэша. Сумма
    итераций равна usage ответа (вход 8000, выход 500)."""
    return [
        {
            "type": "message",
            "input_tokens": 300,
            "output_tokens": 150,
            "cache_creation_input_tokens": cache.get("cache_creation_input_tokens", 0),
            "cache_read_input_tokens": cache.get("cache_read_input_tokens", 0),
        },
        {
            "type": "message",
            "input_tokens": 7700,
            "output_tokens": 350,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
    ]


def _user_text(body: dict[str, Any]) -> str:
    content = body["messages"][0]["content"]
    if isinstance(content, str):
        return content
    return "\n".join(block.get("text", "") for block in content if block.get("type") == "text")


def _dossier(body: dict[str, Any]) -> dict[str, Any]:
    content = body["messages"][0]["content"]
    first = content[0]["text"] if isinstance(content, list) else content
    try:
        data = json.loads(first)
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


@dataclass
class _Switch:
    step: str
    error: str
    times: int


@dataclass
class FakeClaude:
    """Состояние сервера: записанные запросы, кэш промптов, переключатели сбоев."""

    requests: list[dict[str, Any]] = field(default_factory=list)
    keys: list[str] = field(default_factory=list)
    switches: list[_Switch] = field(default_factory=list)
    cached: set[str] = field(default_factory=set)
    lock: threading.Lock = field(default_factory=threading.Lock)
    shift: float = SHIFT
    # Пакеты Message Batches: id → запросы, сколько опросов еще «в работе», результаты
    batches: dict[str, dict[str, Any]] = field(default_factory=dict)
    batch_polls: int = 0
    # Номер следующего пакета и метка процесса в id: /_fake/reset их не сбрасывает, id
    # пакетов не повторяются (batch_jobs.batch_id уникален, пакеты в базе стенда остаются)
    batch_seq: int = 0
    batch_tag: str = ""
    # Пакеты, которые отменили (POST …/cancel)
    canceled: list[str] = field(default_factory=list)
    # Гипотеза разбора проигравшей стороны (None — без гипотезы)
    postmortem_hypothesis: dict[str, Any] | None = field(
        default_factory=lambda: dict(DEFAULT_HYPOTHESIS)
    )

    def fail(self, step: str, error: str, times: int = 1) -> "FakeClaude":
        with self.lock:
            self.switches.append(_Switch(step, error, times))
        return self

    def calls(self, step: str) -> list[dict[str, Any]]:
        return [body for body in self.requests if step_of(body) == step]

    def _take(self, step: str) -> str | None:
        with self.lock:
            for switch in self.switches:
                if switch.times > 0 and switch.step in (step, "any"):
                    switch.times -= 1
                    return switch.error
        return None

    def _take_exact(self, step: str) -> str | None:
        """Сбой только этого шага (без any): пакет — не шаг анализа."""
        with self.lock:
            for switch in self.switches:
                if switch.times > 0 and switch.step == step:
                    switch.times -= 1
                    return switch.error
        return None

    def _cache(self, body: dict[str, Any]) -> dict[str, Any]:
        system = json.dumps(body.get("system"), sort_keys=True, ensure_ascii=False)
        # Префикс кэша — инструменты, потом system: другие инструменты (например, поиск
        # без allowed_callers) кэш того же system не читают, как у настоящего API
        tools = json.dumps(body.get("tools"), sort_keys=True, ensure_ascii=False)
        key = hashlib.sha256((body.get("model", "") + tools + system).encode()).hexdigest()
        with self.lock:
            seen = key in self.cached
            self.cached.add(key)
        size = max(600, len(system) // 3)
        if seen:
            return {"cache_read_input_tokens": size}
        return {
            "cache_creation_input_tokens": size,
            "cache_creation": {"ephemeral_5m_input_tokens": size, "ephemeral_1h_input_tokens": 0},
        }

    # --- ответы по шагам ---

    def reply(self, body: dict[str, Any], key: str) -> tuple[int, Any, str]:
        """(статус, тело, content-type) ответа на POST /v1/messages."""
        with self.lock:
            self.requests.append(body)
            self.keys.append(key)
        step = step_of(body)
        model = str(body.get("model", "claude"))
        error = self._take(step)
        if error in ERRORS:
            status, kind = ERRORS[error]
            return status, {"type": "error", "error": {"type": kind, "message": "fake"}}, "json"
        if error == "refusal":
            msg = message(
                [],
                model=model,
                stop_reason="refusal",
                stop_details={"type": "refusal", "category": "cyber", "explanation": None},
            )
        elif step == "parse":
            msg = self._parse(body, model, error)
        elif step == "news":
            msg = self._news(body, model, error)
        elif step == "postmortem":
            msg = self._postmortem(body, model, error)
        else:
            msg = self._analysis(body, model, error)
        if body.get("stream"):
            return 200, stream_body(msg), "sse"
        return 200, msg, "json"

    def _parse(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        text = json.dumps(parse_text(_user_text(body)), ensure_ascii=False)
        if error == "bad_json":
            text = text[: len(text) // 2]
        stop = "max_tokens" if error == "max_tokens" else "end_turn"
        return message(
            [_thinking(), {"type": "text", "text": text}],
            model=model,
            stop_reason=stop,
            input_tokens=900,
            output_tokens=350,
        )

    def _news(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        text = _user_text(body)
        today = re.search(r"(\d{4}-\d{2}-\d{2})", text)
        day = today.group(1) if today else "2026-10-01"
        players = re.findall(r"^(\d)\. (.+)$", text, re.MULTILINE)
        dynamic = _dynamic_search(body)
        # Фильтрация поиска кодом: поиск вызывает код, у пары блоков поиска есть caller
        caller = {"caller": {"type": CODE_CALLER, "tool_id": "srvtoolu_code"}} if dynamic else {}
        content: list[dict[str, Any]] = [_thinking()]
        if dynamic:
            content.append(
                {
                    "type": "server_tool_use",
                    "id": "srvtoolu_code",
                    "name": "code_execution",
                    "input": {"code": "results = await web_search({'query': 'tennis news'})"},
                }
            )
        content.append(
            {
                "type": "server_tool_use",
                "id": "srvtoolu_fake",
                "name": "web_search",
                "input": {"query": "tennis news"},
                **caller,
            }
        )
        urls: list[str] = []
        if error == "search_error":
            content.append(
                {
                    "type": "web_search_tool_result",
                    "tool_use_id": "srvtoolu_fake",
                    "content": {
                        "type": "web_search_tool_result_error",
                        "error_code": "unavailable",
                    },
                    **caller,
                }
            )
        else:
            for number, name in players:
                slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
                urls.append(f"https://www.atptour.com/en/news/{slug}-{number}")
            content.append(
                {
                    "type": "web_search_tool_result",
                    "tool_use_id": "srvtoolu_fake",
                    "content": [
                        {
                            "type": "web_search_result",
                            "url": url,
                            "title": "News",
                            "encrypted_content": "enc",
                            "page_age": day,
                        }
                        for url in urls
                    ],
                    **caller,
                }
            )
        if dynamic:
            content.append(
                {
                    "type": "code_execution_tool_result",
                    "tool_use_id": "srvtoolu_code",
                    "content": {
                        "type": "encrypted_code_execution_result",
                        "content": [],
                        "encrypted_stdout": "enc",
                        "return_code": 0,
                        "stderr": "",
                    },
                }
            )
        extra: dict[str, Any] = {"container": FAKE_CONTAINER} if dynamic else {}
        if error == "no_record":
            content.append({"type": "text", "text": "Ничего важного не нашел."})
            return {
                **message(
                    content,
                    model=model,
                    stop_reason="end_turn",
                    server_tool_use={"web_search_requests": 1, "web_fetch_requests": 0},
                    input_tokens=8000,
                    output_tokens=500,
                ),
                **extra,
            }
        items = []
        for (number, name), url in zip(players, urls, strict=False):
            items.append(
                {
                    "player": int(number),
                    "items": [
                        {
                            "kind": "other",
                            "summary": f"{name}: тренируется в обычном режиме, жалоб нет",
                            "published_at": day,
                            "source_url": url,
                            "source_name": "ATP Tour",
                            "result": None,
                        }
                    ],
                }
            )
        if not items:
            items = [{"player": int(number), "items": []} for number, _ in players]
        content.append(
            {
                "type": "tool_use",
                "id": "toolu_fake",
                "name": "record_news",
                "input": {"players": items},
            }
        )
        # Без точки cache_control сервер не пишет в кэш и результаты поиска
        cache = self._cache(body) if _has_cache_control(body) else {}
        return {
            **message(
                content,
                model=model,
                stop_reason="tool_use",
                server_tool_use={"web_search_requests": 1, "web_fetch_requests": 0},
                input_tokens=8000,
                output_tokens=500,
                iterations=_news_iterations(cache),
                **cache,
            ),
            **extra,
        }

    def _analysis(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        dossier = _dossier(body)
        base = dossier.get("p_base") or {}
        p1 = float(base.get("p1_win", 0.6))
        c1 = float(base.get("p1_cover", 0.35))
        c2 = float(base.get("p2_cover", 0.2))
        p1_win = min(0.99, p1 + self.shift)
        p1_cover = min(p1_win, c1 + self.shift / 2)
        p2_cover = min(1.0 - p1_win, max(0.0, c2 - self.shift / 2))
        refs = list((dossier.get("refs") or {"elo": ""}).keys())
        factors = [
            {
                "player": 1,
                "effect": "plus",
                "text": "Эло на покрытии выше соперника",
                "ref": "elo" if "elo" in refs else refs[0],
            },
        ]
        if "form" in refs:
            factors.append(
                {"player": 2, "effect": "minus", "text": "Форма за 10 матчей хуже", "ref": "form"}
            )
        answer = {
            "p1_win": round(p1_win, 4),
            "p1_cover": round(p1_cover, 4),
            "p2_cover": round(p2_cover, 4),
            "confidence": "medium",
            "factors": factors,
            "flags": {"p1": [], "p2": []},
            "explanation": "Оценка близка к базовой модели: преимущество в Эло на покрытии.",
            "divergence_note": "",
        }
        if error == "bad_checks":
            answer["factors"] = [dict(factors[0], ref="news:999999")]
        text = json.dumps(answer, ensure_ascii=False)
        if error == "bad_json":
            text = text[: len(text) // 2]
        stop = "max_tokens" if error == "max_tokens" else "end_turn"
        return message(
            [_thinking(), {"type": "text", "text": text}],
            model=model,
            stop_reason=stop,
            input_tokens=2500,
            output_tokens=900,
            **self._cache(body),
        )

    def _postmortem(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        facts = _dossier(body)
        subject = facts.get("subject") or {}
        won = bool(subject.get("won"))
        surface = ((facts.get("match") or {}).get("surface")) or "hard"
        hypothesis: dict[str, Any] | None = None
        if not won and self.postmortem_hypothesis is not None:
            hypothesis = json.loads(
                json.dumps(self.postmortem_hypothesis).replace('"{surface}"', json.dumps(surface))
            )
            if error == "bad_scope":
                hypothesis["conditions"] = [
                    {"feature": "surface", "op": "in", "values": ["mud"], "value": None}
                ]
        verdict = "fine" if won else "model_error"
        if error == "bad_checks":
            verdict = "luck" if won else "fine"
        answer = {
            "verdict": verdict,
            "what": "Матч сыгран: модель давала " + str((facts.get("model") or {}).get("p_base")),
            "why": "Фаворит устал после длинного матча накануне, модель это не учла.",
            "hypothesis": hypothesis,
        }
        text = json.dumps(answer, ensure_ascii=False)
        if error == "bad_json":
            text = text[: len(text) // 2]
        stop = "max_tokens" if error == "max_tokens" else "end_turn"
        return message(
            [_thinking(), {"type": "text", "text": text}],
            model=model,
            stop_reason=stop,
            input_tokens=3000,
            output_tokens=600,
        )

    # --- Message Batches ---

    def _batch_create(self, raw: bytes) -> tuple[int, Any, str]:
        error = self._take_exact("batch_create")
        if error in ERRORS:
            status, kind = ERRORS[error]
            return status, {"type": "error", "error": {"type": kind, "message": "fake"}}, "json"
        requests = list(json.loads(raw or b"{}").get("requests") or [])
        now = datetime.now(UTC)
        with self.lock:
            self.batch_seq += 1
            batch_id = f"msgbatch_fake{self.batch_tag}{self.batch_seq}"
            self.batches[batch_id] = {
                "requests": requests,
                "polls_left": self.batch_polls,
                "created_at": now,
                "results": None,
            }
        return 200, self._batch_view(batch_id, ""), "json"

    def _batch_list(self, query: str) -> tuple[int, Any, str]:
        """GET /v1/messages/batches: новые первыми (как у Anthropic), limit и after_id."""
        params = dict(item.split("=", 1) for item in query.split("&") if "=" in item)
        ids = sorted(self.batches, key=lambda key: self.batches[key]["created_at"], reverse=True)
        if params.get("after_id") in ids:
            ids = ids[ids.index(params["after_id"]) + 1 :]
        limit = int(params.get("limit") or 20)
        page = ids[:limit]
        return (
            200,
            {
                "data": [self._batch_view(batch_id, "") for batch_id in page],
                "has_more": len(ids) > limit,
                "first_id": page[0] if page else None,
                "last_id": page[-1] if page else None,
            },
            "json",
        )

    def _batch_view(self, batch_id: str, origin: str) -> dict[str, Any]:
        batch = self.batches[batch_id]
        created: datetime = batch["created_at"]
        results: list[dict[str, Any]] | None = batch["results"]
        counts = {"processing": 0, "succeeded": 0, "errored": 0, "canceled": 0, "expired": 0}
        if results is None:
            counts["processing"] = len(batch["requests"])
        else:
            for item in results:
                counts[item["result"]["type"]] += 1
        return {
            "id": batch_id,
            "type": "message_batch",
            "processing_status": "in_progress" if results is None else "ended",
            "request_counts": counts,
            "created_at": created.isoformat(),
            "expires_at": (created + timedelta(hours=24)).isoformat(),
            "ended_at": None if results is None else datetime.now(UTC).isoformat(),
            "archived_at": None,
            "cancel_initiated_at": None,
            # expired — прошло 29 дней: пакет виден, результатов нет
            "results_url": None
            if results is None or batch.get("expired")
            else f"{origin}/v1/messages/batches/{batch_id}/results",
        }

    def _batch_result(self, request: dict[str, Any], key: str) -> dict[str, Any]:
        """Результат одного запроса пакета: тот же ответ, что на POST /v1/messages."""
        custom = request.get("custom_id", "")
        kind = self._take_exact("batch")
        if kind in ("expired", "canceled"):
            return {"custom_id": custom, "result": {"type": kind}}
        params = {**(request.get("params") or {}), "stream": False}
        status, payload, _ = self.reply(params, key)
        if status != 200:
            return {
                "custom_id": custom,
                "result": {
                    "type": "errored",
                    "error": {"type": "error", "error": payload["error"], "request_id": None},
                },
            }
        payload["usage"]["service_tier"] = "batch"
        return {"custom_id": custom, "result": {"type": "succeeded", "message": payload}}

    def _batch_get(self, batch_id: str, key: str, origin: str) -> tuple[int, Any, str]:
        batch = self.batches.get(batch_id)
        if batch is None:
            return (
                404,
                {"type": "error", "error": {"type": "not_found_error", "message": "batch"}},
                "json",
            )
        if batch["results"] is None:
            if batch["polls_left"] > 0:
                batch["polls_left"] -= 1
            else:
                batch["results"] = [self._batch_result(item, key) for item in batch["requests"]]
        return 200, self._batch_view(batch_id, origin), "json"

    def _batch_cancel(self, batch_id: str, origin: str) -> tuple[int, Any, str]:
        """POST /v1/messages/batches/{id}/cancel: еще не готовые запросы — canceled (за них
        не платят), готовый пакет не меняется."""
        batch = self.batches.get(batch_id)
        if batch is None:
            return (
                404,
                {"type": "error", "error": {"type": "not_found_error", "message": "batch"}},
                "json",
            )
        with self.lock:
            self.canceled.append(batch_id)
            if batch["results"] is None:
                batch["results"] = [
                    {"custom_id": item.get("custom_id", ""), "result": {"type": "canceled"}}
                    for item in batch["requests"]
                ]
        return 200, self._batch_view(batch_id, origin), "json"

    def _batch_lines(self, batch_id: str) -> tuple[int, Any, str]:
        batch = self.batches.get(batch_id)
        if batch is None or batch["results"] is None or batch.get("expired"):
            return (
                404,
                {"type": "error", "error": {"type": "not_found_error", "message": "batch"}},
                "json",
            )
        lines = "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in batch["results"])
        return 200, lines, "jsonl"

    # --- транспорт ---

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        """Обработчик для httpx2.MockTransport (тесты)."""
        url = request.url
        origin = f"{url.scheme}://{url.host}" + (f":{url.port}" if url.port else "")
        status, payload, kind = self._route(
            request.method,
            url.path,
            request.content,
            request.headers.get("x-api-key", ""),
            origin=origin,
            query=url.query.decode() if isinstance(url.query, bytes) else str(url.query),
        )
        headers = {"request-id": "req_fake"}
        if kind == "sse":
            headers["content-type"] = "text/event-stream"
            return httpx2.Response(status, text=payload, headers=headers)
        if kind == "jsonl":
            headers["content-type"] = "application/binary"
            return httpx2.Response(status, text=payload, headers=headers)
        return httpx2.Response(status, json=payload, headers=headers)

    def http_client(self) -> Any:
        import anthropic

        return anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(self.handler))

    def _route(
        self, method: str, path: str, raw: bytes, key: str, *, origin: str = "", query: str = ""
    ) -> tuple[int, Any, str]:
        if path.startswith("/v1/messages/batches"):
            parts = path.rstrip("/").split("/")[4:]
            if method == "POST" and not parts:
                return self._batch_create(raw)
            if method == "GET" and not parts:
                return self._batch_list(query)
            if method == "GET" and len(parts) == 1:
                return self._batch_get(parts[0], key, origin)
            if method == "GET" and len(parts) == 2 and parts[1] == "results":
                return self._batch_lines(parts[0])
            if method == "POST" and len(parts) == 2 and parts[1] == "cancel":
                return self._batch_cancel(parts[0], origin)
        if method == "GET" and path.rstrip("/") == "/v1/models":
            return (
                200,
                {
                    "data": [_model(name) for name in MODELS],
                    "has_more": False,
                    "first_id": MODELS[0],
                    "last_id": MODELS[-1],
                },
                "json",
            )
        if method == "GET" and path.startswith("/v1/models/"):
            name = path.rsplit("/", 1)[-1]
            if name not in MODELS:
                return (
                    404,
                    {"type": "error", "error": {"type": "not_found_error", "message": "model"}},
                    "json",
                )
            return 200, _model(name), "json"
        if method == "POST" and path == "/v1/messages":
            return self.reply(json.loads(raw or b"{}"), key)
        return 404, {"type": "error", "error": {"type": "not_found_error", "message": path}}, "json"


def _model(name: str) -> dict[str, Any]:
    """Модель как в GET /v1/models/{id}; из capabilities — только то, что смотрит код:
    веб-поиск и programmatic tool calling (фильтрация поиска кодом)."""
    return {
        "type": "model",
        "id": name,
        "display_name": name,
        "created_at": "2026-09-01T00:00:00Z",
        "capabilities": {
            "server_tools": {
                "supported": True,
                "web_search": {"supported": True},
                "code_execution": {"supported": True},
            },
            "code_execution": {"supported": name not in NO_CODE_CALLERS},
        },
    }


def _from_env(fake: FakeClaude) -> FakeClaude:
    # Сервер стенда: метка процесса в id пакетов — после перезапуска сервера номера
    # начинаются заново, а пакеты прошлых запусков остаются в базе
    fake.batch_tag = f"{uuid.uuid4().hex[:8]}_"
    for part in os.environ.get("FAKE_CLAUDE_FAIL", "").split(","):
        if ":" in part:
            step, error = part.split(":", 1)
            fake.fail(step.strip(), error.strip(), times=10**6)
    return fake


STATE = _from_env(FakeClaude())


def _endpoint(method: str) -> Callable[[Request], Any]:
    async def handle(request: Request) -> Response:
        status, payload, kind = STATE._route(
            method,
            request.url.path,
            await request.body(),
            request.headers.get("x-api-key", ""),
            origin=str(request.base_url).rstrip("/"),
            query=request.url.query,
        )
        headers = {"request-id": "req_fake"}
        if kind == "sse":
            return Response(
                payload, status_code=status, media_type="text/event-stream", headers=headers
            )
        if kind == "jsonl":
            return Response(
                payload, status_code=status, media_type="application/binary", headers=headers
            )
        return JSONResponse(payload, status_code=status, headers=headers)

    return handle


async def _set_fail(request: Request) -> Response:
    data = await request.json()
    STATE.fail(str(data.get("step", "any")), str(data["error"]), int(data.get("times", 1)))
    return JSONResponse({"ok": True})


async def _reset(request: Request) -> Response:
    with STATE.lock:
        STATE.switches.clear()
        STATE.requests.clear()
        STATE.keys.clear()
        STATE.cached.clear()
        STATE.batches.clear()
        STATE.canceled.clear()
    return JSONResponse({"ok": True})


async def _calls(request: Request) -> Response:
    return JSONResponse({step: len(STATE.calls(step)) for step in STEPS})


app = Starlette(
    routes=[
        Route("/v1/messages", _endpoint("POST"), methods=["POST"]),
        Route("/v1/models", _endpoint("GET"), methods=["GET"]),
        Route("/v1/models/{model}", _endpoint("GET"), methods=["GET"]),
        Route("/v1/messages/batches", _endpoint("POST"), methods=["POST"]),
        Route("/v1/messages/batches/{batch}", _endpoint("GET"), methods=["GET"]),
        Route("/v1/messages/batches/{batch}/results", _endpoint("GET"), methods=["GET"]),
        Route("/v1/messages/batches/{batch}/cancel", _endpoint("POST"), methods=["POST"]),
        Route("/_fake/fail", _set_fail, methods=["POST"]),
        Route("/_fake/reset", _reset, methods=["POST"]),
        Route("/_fake/calls", _calls, methods=["GET"]),
        *fake_push.ROUTES,
    ],
    middleware=[
        Middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    ],
)
