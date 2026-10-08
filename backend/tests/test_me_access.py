"""Права на /api/me/* и /api/settings: без сеанса — 401 на каждом адресе; участник
не видит и не меняет чужие сеансы, уведомления и доверенные устройства."""

import re

import httpx2
import pytest
from fastapi.routing import APIRoute
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes import me as me_routes
from app.api.routes import settings as settings_routes
from app.db.models import AppSettings, Notification, TrustedDevice
from app.services.notifications import notify
from tests.helpers_auth import full_login
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory


def _routes() -> list[tuple[str, str]]:
    """Все маршруты личного кабинета и настроек: новый маршрут попадает в проверку сам."""
    found: list[tuple[str, str]] = []
    for router in (me_routes.router, settings_routes.router):
        for route in router.routes:
            assert isinstance(route, APIRoute)
            path = "/api" + re.sub(r"\{[^}]+\}", "1", route.path)
            found.extend((method, path) for method in sorted(route.methods or ()))
    return found


def test_route_list_is_complete() -> None:
    routes = _routes()
    assert ("GET", "/api/me") in routes
    assert ("DELETE", "/api/me/sessions/1") in routes
    assert ("GET", "/api/settings") in routes
    assert len(routes) >= 13


@pytest.mark.parametrize(("method", "path"), _routes())
async def test_without_session_is_401(client: httpx2.AsyncClient, method: str, path: str) -> None:
    body: dict[str, object] | None = {} if method in {"POST", "PUT", "PATCH"} else None
    response = await client.request(method, path, json=body)
    assert response.status_code == 401, response.text
    assert response.json()["error"]["code"] == "auth.not_authenticated"


async def test_me_returns_own_profile(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn
) -> None:
    member = await make_user(display_name="Иван", tz="Europe/Berlin")
    await login(client, member)
    body = (await client.get("/api/me")).json()
    assert body == {
        "id": member.id,
        "email": member.email,
        "display_name": "Иван",
        "role": "member",
        "status": "active",
        "ai_mode": "shared",
        "tz": "Europe/Berlin",
        "totp_enabled": True,
        "created_at": body["created_at"],
    }


async def test_public_settings_currency(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await login(client, await make_user())
    assert (await client.get("/api/settings")).json() == {"currency": "RUB"}
    await db.execute(update(AppSettings).where(AppSettings.id == 1).values(currency="EUR"))
    await db.commit()
    assert (await client.get("/api/settings")).json() == {"currency": "EUR"}


async def test_member_sees_only_own_notifications(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    alice_user = await make_user()
    bob_user = await make_user()
    await notify(db, user_id=alice_user.id, kind="new_device", device="Chrome", ip="10.0.0.1")
    bob_note = await notify(
        db, user_id=bob_user.id, kind="new_device", device="Safari", ip="1.2.3.4"
    )
    await db.commit()
    alice = await login(await make_client(), alice_user)

    listed = (await alice.get("/api/me/notifications")).json()
    assert len(listed["items"]) == 1 and listed["unread"] == 1
    assert "Chrome" in listed["items"][0]["body"]

    response = await alice.post(f"/api/me/notifications/{bob_note.id}/read")
    assert response.status_code == 404
    assert (await alice.post("/api/me/notifications/read-all")).status_code == 204
    read_at = await db.execute(select(Notification.read_at).where(Notification.id == bob_note.id))
    assert read_at.scalar_one() is None


async def test_member_cannot_touch_other_trusted_devices(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    bob_user = await make_user()
    bob_browser = await make_client("10.0.0.2")
    await full_login(bob_browser, bob_user, await totp_code(bob_user), remember_device=True)
    bob_device = (await db.execute(select(TrustedDevice.id))).scalar_one()

    alice = await login(await make_client("10.0.0.1"), await make_user())
    assert (await alice.get("/api/me/trusted-devices")).json() == []
    response = await alice.delete(f"/api/me/trusted-devices/{bob_device}")
    assert response.status_code == 404
    revoked = await db.execute(
        select(TrustedDevice.revoked_at).where(TrustedDevice.id == bob_device)
    )
    assert revoked.scalar_one() is None
    assert len((await bob_browser.get("/api/me/trusted-devices")).json()) == 1


async def test_member_cannot_see_other_login_events(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, totp_code: TotpCodeFn
) -> None:
    bob_user = await make_user()
    await full_login(await make_client("10.0.0.2"), bob_user, await totp_code(bob_user))
    alice = await login(await make_client("10.0.0.1"), await make_user())
    assert (await alice.get("/api/me/login-events")).json() == []


@pytest.mark.parametrize("row_id", ["0", "9223372036854775808", "99999999999999999999"])
async def test_out_of_range_ids_are_422(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, row_id: str
) -> None:
    await login(client, await make_user())
    # Число вне BIGINT не доходит до базы (там была бы ошибка 500)
    for method, path in (
        ("DELETE", f"/api/me/sessions/{row_id}"),
        ("DELETE", f"/api/me/trusted-devices/{row_id}"),
        ("POST", f"/api/me/notifications/{row_id}/read"),
    ):
        response = await client.request(method, path)
        assert response.status_code == 422, (path, response.text)
        assert response.json()["error"]["code"] == "validation"
    # Наибольший BIGINT — обычный «не найдено»
    largest = await client.delete("/api/me/sessions/9223372036854775807")
    assert largest.status_code == 404
