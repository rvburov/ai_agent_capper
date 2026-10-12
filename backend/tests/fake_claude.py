"""Поддельный Claude API для прогонов без ключа: тесты конвейера, локальный запуск,
Playwright волны 3.

Отвечает по смыслу запроса, а не по очереди (вызовы анализа идут параллельно):
- разбор (схема с unknown_lines) — свой разбор текста формата бота регулярными
  выражениями: банк, букмекер, «A vs B, турнир, покрытие, раунд», кэфы П1/П2 и форы;
- новости (инструмент record_news) — блок поиска web_search_tool_result с двумя
  адресами и вызов record_news с фактами по этим адресам;
- анализ (схема с p1_win) — потоком SSE: p_base досье со сдвигом +0,02 к игроку 1,
  факторы со ссылками elo и form; первый вызов с этим system пишет кэш, следующие читают;
- GET /v1/models и /v1/models/{id} — для проверки ключа.

Сбои включаются переключателем: FakeClaude.fail(step, error, times) в тестах,
POST /_fake/fail {"step": "analysis", "error": "overloaded", "times": 1} у сервера или
переменная окружения FAKE_CLAUDE_FAIL=analysis:overloaded[,news:search_error]. step —
parse, news, analysis или any; error — overloaded (529), rate_limited (429),
key_rejected (401), server (500), refusal, max_tokens, bad_json, bad_checks (ответ не
проходит проверку кода), search_error (ошибка поиска unavailable), no_record
(новости без record_news).

Запуск сервера:
    cd backend && .venv/bin/uvicorn tests.fake_claude:app --port 8099
    CAPPER_ANTHROPIC_BASE_URL=http://127.0.0.1:8099 (API и воркер)
"""

import hashlib
import json
import os
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx2
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

MODELS = ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5")
STEPS = ("parse", "news", "analysis")
ERRORS = {
    "overloaded": (529, "overloaded_error"),
    "rate_limited": (429, "rate_limit_error"),
    "key_rejected": (401, "authentication_error"),
    "server": (500, "api_error"),
    "bad_request": (400, "invalid_request_error"),
}
SHIFT = 0.02

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
    return "parse"


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

    def _cache(self, body: dict[str, Any]) -> dict[str, Any]:
        system = json.dumps(body.get("system"), sort_keys=True, ensure_ascii=False)
        key = hashlib.sha256((body.get("model", "") + system).encode()).hexdigest()
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
        content: list[dict[str, Any]] = [
            _thinking(),
            {
                "type": "server_tool_use",
                "id": "srvtoolu_fake",
                "name": "web_search",
                "input": {"query": "tennis news"},
            },
        ]
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
                }
            )
        if error == "no_record":
            content.append({"type": "text", "text": "Ничего важного не нашел."})
            return message(
                content,
                model=model,
                stop_reason="end_turn",
                server_tool_use={"web_search_requests": 1, "web_fetch_requests": 0},
                input_tokens=8000,
                output_tokens=500,
            )
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
        return message(
            content,
            model=model,
            stop_reason="tool_use",
            server_tool_use={"web_search_requests": 1, "web_fetch_requests": 0},
            input_tokens=8000,
            output_tokens=500,
            **self._cache(body),
        )

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

    # --- транспорт ---

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        """Обработчик для httpx2.MockTransport (тесты)."""
        status, payload, kind = self._route(
            request.method, request.url.path, request.content, request.headers.get("x-api-key", "")
        )
        headers = {"request-id": "req_fake"}
        if kind == "sse":
            headers["content-type"] = "text/event-stream"
            return httpx2.Response(status, text=payload, headers=headers)
        return httpx2.Response(status, json=payload, headers=headers)

    def http_client(self) -> Any:
        import anthropic

        return anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(self.handler))

    def _route(self, method: str, path: str, raw: bytes, key: str) -> tuple[int, Any, str]:
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
    return {"type": "model", "id": name, "display_name": name, "created_at": "2026-09-01T00:00:00Z"}


def _from_env(fake: FakeClaude) -> FakeClaude:
    for part in os.environ.get("FAKE_CLAUDE_FAIL", "").split(","):
        if ":" in part:
            step, error = part.split(":", 1)
            fake.fail(step.strip(), error.strip(), times=10**6)
    return fake


STATE = _from_env(FakeClaude())


def _endpoint(method: str) -> Callable[[Request], Any]:
    async def handle(request: Request) -> Response:
        status, payload, kind = STATE._route(
            method, request.url.path, await request.body(), request.headers.get("x-api-key", "")
        )
        headers = {"request-id": "req_fake"}
        if kind == "sse":
            return Response(
                payload, status_code=status, media_type="text/event-stream", headers=headers
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
    return JSONResponse({"ok": True})


async def _calls(request: Request) -> Response:
    return JSONResponse({step: len(STATE.calls(step)) for step in STEPS})


app = Starlette(
    routes=[
        Route("/v1/messages", _endpoint("POST"), methods=["POST"]),
        Route("/v1/models", _endpoint("GET"), methods=["GET"]),
        Route("/v1/models/{model}", _endpoint("GET"), methods=["GET"]),
        Route("/_fake/fail", _set_fail, methods=["POST"]),
        Route("/_fake/reset", _reset, methods=["POST"]),
        Route("/_fake/calls", _calls, methods=["GET"]),
    ]
)
