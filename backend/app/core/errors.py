"""Ошибки API в одном формате: {"error": {"code": "...", "message": "...", ...}}.

Код ошибки — ключ локали без префикса errors.: AppError(401, "auth.invalid_credentials")
берет текст из errors.auth.invalid_credentials. Дополнительные параметры (например
retry_after) попадают и в текст, и в тело ответа. Фронтенд показывает message.
"""

from collections.abc import Mapping
from typing import Any

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.headers import security_headers
from app.core.i18n import t

log = structlog.get_logger(__name__)


class AppError(Exception):
    """Ошибка, которую видит пользователь. Бросается из сервисов и зависимостей."""

    def __init__(
        self,
        status_code: int,
        code: str,
        *,
        headers: dict[str, str] | None = None,
        **params: Any,
    ) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.headers = headers
        self.params = params

    @property
    def message(self) -> str:
        return t(f"errors.{self.code}", **self.params)


def error_body(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, **extra}}


def error_response(
    status_code: int,
    code: str,
    *,
    headers: Mapping[str, str] | None = None,
    **params: Any,
) -> JSONResponse:
    """Ответ с ошибкой по ключу локали. Нужен там, где исключение бросить нельзя (middleware)."""
    message = t(f"errors.{code}", **params)
    return JSONResponse(error_body(code, message, **params), status_code, headers=headers)


async def _app_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)
    headers = dict(exc.headers or {})
    retry_after = exc.params.get("retry_after")
    if isinstance(retry_after, int) and "Retry-After" not in headers:
        headers["Retry-After"] = str(retry_after)
    return JSONResponse(
        error_body(exc.code, exc.message, **exc.params),
        exc.status_code,
        headers=headers or None,
    )


async def _validation_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    # Значения полей не возвращаем: среди них бывают пароли
    fields = [
        {"loc": list(err.get("loc", ())), "code": err.get("type", "")} for err in exc.errors()
    ]
    return JSONResponse(
        error_body("validation", t("errors.common.validation"), fields=fields),
        422,
    )


_HTTP_CODES = {
    401: "auth.not_authenticated",
    403: "common.forbidden",
    404: "common.not_found",
    405: "common.method_not_allowed",
}


async def _http_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    code = _HTTP_CODES.get(exc.status_code, "common.http_error")
    return error_response(exc.status_code, code, headers=exc.headers)


async def _unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
    log.exception("request.unhandled_error", path=request.url.path)
    # Этот ответ идет мимо SecurityHeadersMiddleware (ServerErrorMiddleware снаружи)
    return error_response(500, "common.internal", headers=security_headers(request.url.path))


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_error_handler)
    app.add_exception_handler(Exception, _unhandled_handler)
