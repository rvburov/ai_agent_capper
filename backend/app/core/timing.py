"""Время ответа API в лог (основа p95 этапа 4, PLAN.md: «p95 API < 200 мс»).

Чистый ASGI-middleware, как остальные (app/core/middleware.py): потоковые ответы (SSE хода
анализа, CSV) не буферизуются. На каждый HTTP-запрос — одна запись http.request: метод,
шаблон маршрута (/api/bets/{bet_id}, а не адрес с номером: так запросы группируются, и в
лог не попадают id), статус, ms — до последнего байта ответа, ttfb_ms — до заголовков.
Фоновые задачи маршрута (прогрев аналитики после расчета ставки) идут после последнего
байта и в ms не входят: участник их не ждет. Запрос мимо маршрутов (404 без маршрута) —
route = null.

observe(callback) — та же запись в функцию (замер p95, app/admin/perf_measure.py): она
получает запись при любом уровне логов.
"""

import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any
from weakref import WeakKeyDictionary

import structlog
from fastapi.routing import iter_route_contexts
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = structlog.get_logger(__name__)

EVENT = "http.request"
# Приложение → {id маршрута → полный шаблон}: маршрут подключенного роутера знает только
# свой путь (/bets/{bet_id}), а префикс /api — у подключения
_TEMPLATES: "WeakKeyDictionary[Any, dict[int, str]]" = WeakKeyDictionary()
_OBSERVERS: list[Callable[[dict[str, Any]], None]] = []


@contextmanager
def observe(callback: Callable[[dict[str, Any]], None]) -> Iterator[None]:
    """Пока открыт контекст, callback получает каждую запись http.request (словарь полей)."""
    _OBSERVERS.append(callback)
    try:
        yield
    finally:
        _OBSERVERS.remove(callback)


def _templates(app: Any) -> dict[int, str]:
    found = _TEMPLATES.get(app)
    if found is None:
        found = {
            id(context.original_route): str(context.path_format)
            for context in iter_route_contexts(getattr(app, "routes", []))
            if context.path_format
        }
        _TEMPLATES[app] = found
    return found


def route_template(scope: Scope) -> str | None:
    """Полный шаблон маршрута, который обработал запрос; None — маршрута нет."""
    route: Any = scope.get("route")
    if route is None:
        return None
    app = scope.get("app")
    if app is not None:
        template = _templates(app).get(id(route))
        if template:
            return template
    path = getattr(route, "path_format", None) or getattr(route, "path", None)
    return str(path) if path else None


class TimingMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        status = 500
        first_byte: float | None = None
        last_byte: float | None = None

        async def timed_send(message: Message) -> None:
            nonlocal status, first_byte, last_byte
            if message["type"] == "http.response.start":
                status = int(message["status"])
                first_byte = time.perf_counter()
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body"):
                last_byte = time.perf_counter()

        try:
            await self.app(scope, receive, timed_send)
        finally:
            finished = last_byte or time.perf_counter()
            record = {
                "method": scope["method"],
                "route": route_template(scope),
                "status": status,
                "ms": round((finished - started) * 1000, 1),
                "ttfb_ms": round(((first_byte or finished) - started) * 1000, 1),
            }
            for callback in tuple(_OBSERVERS):
                callback(record)
            log.info(EVENT, **record)
