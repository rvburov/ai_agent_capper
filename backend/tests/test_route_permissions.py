"""Права на всех маршрутах приложения (приемка этапа 4, «Готово, когда»): список маршрутов
берется из самого приложения обходом роутеров, а не из схемы и не руками.

- каждый маршрут приложения есть в OpenAPI (по схеме строятся тесты прав и типы фронтенда);
- каждый адрес с id вне /api/admin проверен в test_foreign_objects.py (чужой объект или
  общие данные без чужих ставок);
- каждый /api/admin/* — в test_admin_permissions.py (401 без входа, 403 участнику);
- без сеанса закрыто все, кроме входа, регистрации, сброса пароля и проверки здоровья:
  401 auth.not_authenticated; открытые адреса без сеанса этим кодом не отвечают.
"""

import re
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.routing import APIRoute

from app.main import create_app
from tests.helpers_admin import error_code
from tests.support import ClientFactory
from tests.test_admin_permissions import ADMIN_ROUTES
from tests.test_foreign_objects import (
    FOREIGN_CASES,
    LESSON_ROUTES,
    SHARED_ROUTES,
    STRATEGY_ROUTES,
)

_APP = create_app()


def _walk(routes: Any, prefix: str = "") -> Iterator[tuple[str, APIRoute]]:
    """Маршруты со всех вложенных роутеров с полным путем (префиксы включений)."""
    for route in routes:
        if isinstance(route, APIRoute):
            yield prefix + route.path, route
        elif hasattr(route, "original_router"):
            yield from _walk(route.original_router.routes, prefix + route.include_context.prefix)


APP_ROUTES = sorted(
    {
        (method, path)
        for path, route in _walk(_APP.routes)
        for method in (route.methods or set()) - {"HEAD"}
    }
)

# Открыты без сеанса: вход и 2FA при входе, регистрация по приглашению, сброс пароля,
# выход (стирает cookie и без сеанса), CSRF-токен, проверка здоровья. GET /api/settings
# (валюта программы) — только с сеансом
PUBLIC_ROUTES = {
    ("GET", "/api/health"),
    ("GET", "/api/auth/csrf"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/2fa"),
    ("POST", "/api/auth/2fa/setup"),
    ("POST", "/api/auth/2fa/setup/confirm"),
    ("POST", "/api/auth/logout"),
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/reset"),
}


def test_route_walk_finds_everything() -> None:
    assert len(APP_ROUTES) >= 110
    assert ("GET", "/api/me/export/summary") in APP_ROUTES
    assert ("PUT", "/api/admin/settings") in APP_ROUTES


def test_every_app_route_is_in_openapi() -> None:
    schema = _APP.openapi()
    in_schema = {
        (method.upper(), path)
        for path, operations in schema["paths"].items()
        for method in operations
    }
    assert set(APP_ROUTES) == in_schema


def test_every_id_route_has_foreign_check() -> None:
    with_id = {
        (method, path)
        for method, path in APP_ROUTES
        if "{" in path and not path.startswith("/api/admin")
    }
    assert with_id == set(FOREIGN_CASES) | SHARED_ROUTES | LESSON_ROUTES | STRATEGY_ROUTES


def test_every_admin_route_has_permission_check() -> None:
    admin = {(method, path) for method, path in APP_ROUTES if path.startswith("/api/admin")}
    assert admin == set(ADMIN_ROUTES)


def test_public_routes_exist() -> None:
    assert set(APP_ROUTES) >= PUBLIC_ROUTES


PRIVATE_ROUTES = [route for route in APP_ROUTES if route not in PUBLIC_ROUTES]


@pytest.mark.parametrize(("method", "path"), PRIVATE_ROUTES, ids=lambda v: str(v))
async def test_private_route_needs_session(
    method: str, path: str, make_client: ClientFactory
) -> None:
    client = await make_client()
    url = re.sub(r"\{[^}]+\}", "1", path)
    body: dict[str, Any] | None = {} if method in {"POST", "PUT", "PATCH", "DELETE"} else None
    response = await client.request(method, url, json=body)
    assert response.status_code == 401, response.text
    assert error_code(response) == "auth.not_authenticated"


@pytest.mark.parametrize(("method", "path"), sorted(PUBLIC_ROUTES), ids=lambda v: str(v))
async def test_public_route_open_without_session(
    method: str, path: str, make_client: ClientFactory
) -> None:
    """Список открытых адресов не прячет закрытый: без сеанса ответ — не «войдите»."""
    client = await make_client()
    body: dict[str, Any] | None = {} if method in {"POST", "PUT", "PATCH", "DELETE"} else None
    response = await client.request(method, path, json=body)
    assert response.status_code < 500, response.text
    if response.status_code == 401:
        assert error_code(response) != "auth.not_authenticated", response.text
