"""Middleware: защита от CSRF и заголовки ответов. Чистый ASGI, без BaseHTTPMiddleware,
чтобы не ломать потоковые ответы (SSE прогресса анализа).

CSRF — схема double submit: изменяющий запрос (POST, PUT, PATCH, DELETE) должен нести
заголовок X-CSRF-Token, равный cookie csrf. Чужой сайт cookie прочитать не может и
заголовок не подставит. Дополнительно, если браузер прислал Origin, он должен совпасть
с public_origin. GET, HEAD, OPTIONS и /api/health не проверяются.
"""

import hmac

from starlette.datastructures import MutableHeaders
from starlette.requests import HTTPConnection
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import get_settings
from app.core.cookies import CSRF_HEADER, cookie_name
from app.core.errors import error_response
from app.core.headers import security_headers

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
CSRF_EXEMPT_PATHS = frozenset({"/api/health"})


class CsrfMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return
        if scope["path"] in CSRF_EXEMPT_PATHS:
            await self.app(scope, receive, send)
            return
        if not _csrf_ok(HTTPConnection(scope)):
            await error_response(403, "common.csrf")(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _csrf_ok(conn: HTTPConnection) -> bool:
    settings = get_settings()
    origin = conn.headers.get("origin")
    if origin is not None and origin.rstrip("/") != settings.public_origin_normalized:
        return False
    cookie = conn.cookies.get(cookie_name("csrf", settings), "")
    header = conn.headers.get(CSRF_HEADER, "")
    if not cookie or not header:
        return False
    return hmac.compare_digest(cookie.encode(), header.encode())


class SecurityHeadersMiddleware:
    """Заголовки для ответов API (app.core.headers). Ответ 500 получает их в errors.py."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        extra = security_headers(scope["path"])

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                # Заголовок, заданный маршрутом, не меняется
                for name, value in extra.items():
                    headers.setdefault(name, value)
            await send(message)

        await self.app(scope, receive, send_with_headers)
