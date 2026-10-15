"""Права на каждый адрес /api/admin/*: без сеанса 401, участник 403, администратор
проходит проверку прав. Список адресов берется из схемы OpenAPI приложения, поэтому
новый маршрут администратора попадает в тест сам. Плюс Р14: в ответах о пользователях
нет ставок, банка и стратегии."""

import re
from typing import Any

import pytest
from fastapi.routing import APIRoute
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes import admin as admin_routes
from app.api.routes import admin_ai as admin_ai_routes
from app.api.routes import admin_messages as admin_messages_routes
from app.api.routes import admin_settings as admin_settings_routes
from app.db.models import User
from app.main import create_app
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.support import ClientFactory, LoginFn, UserFactory

_SCHEMA = create_app().openapi()
ADMIN_ROUTES = sorted(
    (method.upper(), path)
    for path, operations in _SCHEMA["paths"].items()
    if path.startswith("/api/admin")
    for method in operations
)
_WITH_BODY = {"POST", "PUT", "PATCH", "DELETE"}
# Несуществующий id: администратор получит 404 или 422, но не 401/403
_MISSING_ID = "999999"


def _url(path: str) -> str:
    return re.sub(r"\{[^}]+\}", _MISSING_ID, path)


def test_every_admin_router_route_is_in_schema() -> None:
    """Маршрут, скрытый из схемы, не попал бы в параметризованный тест прав."""
    in_schema = set(ADMIN_ROUTES)
    for route in [
        *admin_routes.router.routes,
        *admin_ai_routes.router.routes,
        *admin_settings_routes.router.routes,
        *admin_messages_routes.router.routes,
    ]:
        assert isinstance(route, APIRoute)
        for method in route.methods or set():
            assert (method, "/api" + route.path) in in_schema
    assert len(ADMIN_ROUTES) >= 28


@pytest.mark.parametrize(("method", "path"), ADMIN_ROUTES, ids=lambda v: str(v))
async def test_admin_route_permissions(
    method: str,
    path: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    url = _url(path)
    body: dict[str, Any] | None = {} if method in _WITH_BODY else None

    anonymous = await make_client()
    response = await anonymous.request(method, url, json=body)
    assert response.status_code == 401
    assert error_code(response) == "auth.not_authenticated"

    member = await signed_in(make_client, make_user, login)
    response = await member.client.request(method, url, json=body)
    assert response.status_code == 403
    assert error_code(response) == "common.forbidden"

    admin = await admin_signed_in(make_client, make_user, login)
    response = await admin.client.request(method, url, json=body)
    assert response.status_code not in (401, 403), response.text


async def test_demoted_admin_loses_access(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    assert (await admin.client.get("/api/admin/users")).status_code == 200
    await db.execute(update(User).where(User.id == admin.id).values(role="member"))
    await db.commit()
    assert (await admin.client.get("/api/admin/users")).status_code == 403


# --- Р14: ни ставок, ни банка, ни стратегии ---

_PRIVATE_WORDS = ("bet", "bank", "stake", "ledger", "strateg", "profit", "roi", "lesson", "predict")


def _schema_properties(node: Any, seen: set[str]) -> set[str]:
    """Все имена полей в схеме ответа, с переходом по $ref."""
    names: set[str] = set()
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            name = ref.rsplit("/", 1)[-1]
            if name not in seen:
                seen.add(name)
                names |= _schema_properties(_SCHEMA["components"]["schemas"][name], seen)
        for key, value in node.get("properties", {}).items():
            names.add(key)
            names |= _schema_properties(value, seen)
        for key in ("items", "anyOf", "oneOf", "allOf", "additionalProperties"):
            if key in node:
                names |= _schema_properties(node[key], seen)
    elif isinstance(node, list):
        for item in node:
            names |= _schema_properties(item, seen)
    return names


def test_admin_user_responses_have_no_private_fields() -> None:
    checked = 0
    for path, operations in _SCHEMA["paths"].items():
        # Участники, их расход на ИИ (лимиты, режим ключа, разбивки) и активность
        if not path.startswith(("/api/admin/users", "/api/admin/ai", "/api/admin/activity")):
            continue
        for operation in operations.values():
            for code, response in operation["responses"].items():
                if not code.startswith("2") or "content" not in response:
                    continue
                schema = response["content"]["application/json"]["schema"]
                fields = _schema_properties(schema, set())
                assert fields, path
                leaked = {f for f in fields if any(word in f.lower() for word in _PRIVATE_WORDS)}
                assert not leaked, (path, leaked)
                checked += 1
    assert checked >= 14


def test_admin_breakdowns_have_no_analysis_or_input() -> None:
    """Р14: разбивки расхода и активность — только деньги, число анализов и входов: без
    анализов, текстов ввода, игроков, адресов и устройств."""
    words = ("analysis_id", "input_text", "player", "match", "ip", "user_agent", "device")
    for path in ("/api/admin/ai/usage", "/api/admin/activity"):
        schema = _SCHEMA["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]
        fields = _schema_properties(schema["schema"], set())
        assert {"display_name", "user_id"} <= fields, path
        assert not {field for field in fields if field in words or field.startswith("player")}


async def test_admin_user_payload_keys(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    expected = {
        "id",
        "display_name",
        "email",
        "role",
        "status",
        "ai_mode",
        "totp_enabled",
        "created_at",
        "last_login_at",
        "ai_spent_month_usd",
        "analyses_month",
        "limit",
        # доля месячного лимита — тот же расход на ИИ (Р14)
        "limit_share",
    }
    rows = (await admin.client.get("/api/admin/users")).json()
    assert {tuple(sorted(row)) for row in rows} == {tuple(sorted(expected))}
    detail = (await admin.client.get(f"/api/admin/users/{member.id}")).json()
    assert set(detail) == expected | {"active_sessions", "recent_logins"}
