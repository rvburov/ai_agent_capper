from datetime import timedelta

import httpx2
import pytest
from fastapi import FastAPI, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cookies import cookie_name
from app.core.deps import AdminUser, ClientIp, CurrentSession, CurrentUser, client_ip
from app.db.models import User, UserSession
from app.services import sessions as sessions_service
from tests.support import COOKIE_DOMAIN, ClientFactory, LoginFn, UserFactory


@pytest.fixture
def deps_app(app: FastAPI) -> FastAPI:
    @app.get("/api/test/whoami")
    async def whoami(user: CurrentUser, session: CurrentSession) -> dict[str, int | str]:
        return {"id": user.id, "role": user.role, "session_id": session.id}

    @app.get("/api/test/admin-only")
    async def admin_only(user: AdminUser) -> dict[str, int]:
        return {"id": user.id}

    @app.get("/api/test/ip")
    async def ip(value: ClientIp) -> dict[str, str]:
        return {"ip": value}

    return app


async def test_without_session_is_401(deps_app: FastAPI, client: httpx2.AsyncClient) -> None:
    response = await client.get("/api/test/whoami")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth.not_authenticated"
    client.cookies.set(cookie_name("session"), "garbage", domain=COOKIE_DOMAIN)
    assert (await client.get("/api/test/whoami")).status_code == 401


async def test_session_cookie_authenticates(
    deps_app: FastAPI, client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn
) -> None:
    member = await make_user()
    await login(client, member)
    response = await client.get("/api/test/whoami")
    assert response.status_code == 200
    assert response.json()["id"] == member.id


async def test_revoked_idle_expired_and_blocked_sessions_are_rejected(
    deps_app: FastAPI,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    member = await make_user()

    async def fresh_session_id() -> tuple[httpx2.AsyncClient, int]:
        c = await login(await make_client(), member)
        body = (await c.get("/api/test/whoami")).json()
        return c, int(body["session_id"])

    revoked, sid = await fresh_session_id()
    await sessions_service.revoke_session(db, sid, user_id=member.id)
    await db.commit()
    assert (await revoked.get("/api/test/whoami")).status_code == 401

    idle, sid = await fresh_session_id()
    now = sessions_service.utcnow()
    await db.execute(
        update(UserSession)
        .where(UserSession.id == sid)
        .values(last_seen_at=now - timedelta(days=14, minutes=1))
    )
    await db.commit()
    assert (await idle.get("/api/test/whoami")).status_code == 401

    expired, sid = await fresh_session_id()
    past = now - timedelta(seconds=1)
    await db.execute(update(UserSession).where(UserSession.id == sid).values(expires_at=past))
    await db.commit()
    assert (await expired.get("/api/test/whoami")).status_code == 401

    blocked, _ = await fresh_session_id()
    await db.execute(update(User).where(User.id == member.id).values(status="blocked"))
    await db.commit()
    assert (await blocked.get("/api/test/whoami")).status_code == 401


async def test_last_seen_updated_at_most_every_5_minutes(
    deps_app: FastAPI,
    client: httpx2.AsyncClient,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    await login(client, member)
    sid = int((await client.get("/api/test/whoami")).json()["session_id"])

    async def last_seen() -> object:
        db.expire_all()
        return (
            await db.execute(select(UserSession.last_seen_at).where(UserSession.id == sid))
        ).scalar_one()

    first = await last_seen()
    await client.get("/api/test/whoami")
    assert await last_seen() == first

    old = sessions_service.utcnow() - timedelta(minutes=6)
    await db.execute(update(UserSession).where(UserSession.id == sid).values(last_seen_at=old))
    await db.commit()
    await client.get("/api/test/whoami")
    assert await last_seen() != old


async def test_session_absolute_expiry_is_set(make_user: UserFactory, db: AsyncSession) -> None:
    member = await make_user()
    new = await sessions_service.create_session(
        db, user_id=member.id, ip="10.0.0.9", user_agent="Mozilla/5.0 (iPhone) Safari/604.1"
    )
    await db.commit()
    assert new.session.id_hash != new.token
    assert new.session.device_label == "Safari · iOS"
    lifetime = new.session.expires_at - new.session.created_at
    assert lifetime == timedelta(days=30)
    count = await sessions_service.revoke_user_sessions(db, member.id)
    assert count == 1


async def test_require_admin(
    deps_app: FastAPI,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    anonymous = await make_client()
    assert (await anonymous.get("/api/test/admin-only")).status_code == 401

    member = await login(await make_client(), await make_user(role="member"))
    response = await member.get("/api/test/admin-only")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "common.forbidden"

    admin = await login(await make_client(), await make_user(role="admin"))
    assert (await admin.get("/api/test/admin-only")).status_code == 200


def test_admin_router_requires_admin_role() -> None:
    # Зависимость стоит на всем роутере /api/admin: новые маршруты защищены автоматически
    from app.api.routes import admin as admin_routes
    from app.core.deps import require_admin

    assert admin_routes.router.prefix == "/admin"
    assert require_admin in [d.dependency for d in admin_routes.router.dependencies]


async def test_client_ip(deps_app: FastAPI, make_client: ClientFactory) -> None:
    c = await make_client("10.1.2.3")
    assert (await c.get("/api/test/ip")).json() == {"ip": "10.1.2.3"}
    mapped = await make_client("::ffff:192.0.2.7")
    assert (await mapped.get("/api/test/ip")).json() == {"ip": "192.0.2.7"}


def test_client_ip_unknown_host() -> None:
    request = Request({"type": "http", "client": ("testclient", 50000), "headers": []})
    assert client_ip(request) == "0.0.0.0"
    request = Request({"type": "http", "client": None, "headers": []})
    assert client_ip(request) == "0.0.0.0"


async def test_client_ip_from_trusted_proxy_only(
    deps_app: FastAPI, make_client: ClientFactory
) -> None:
    # За Caddy (CAPPER_TRUSTED_PROXIES, по умолчанию 127.0.0.1) IP берется из X-Forwarded-For
    proxy = await make_client("127.0.0.1")
    forwarded = await proxy.get("/api/test/ip", headers={"X-Forwarded-For": "203.0.113.5"})
    assert forwarded.json() == {"ip": "203.0.113.5"}
    # Чужой клиент подделать IP заголовком не может
    stranger = await make_client("10.0.0.7")
    spoofed = await stranger.get("/api/test/ip", headers={"X-Forwarded-For": "203.0.113.5"})
    assert spoofed.json() == {"ip": "10.0.0.7"}


async def test_login_fixture_records_client_ip(
    deps_app: FastAPI,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    for ip, expected in ((None, "10.0.0.2"), ("10.9.9.9", "10.9.9.9")):
        c = await login(await make_client("10.0.0.2"), member, ip=ip)
        sid = int((await c.get("/api/test/whoami")).json()["session_id"])
        stored = await db.execute(select(UserSession.ip).where(UserSession.id == sid))
        assert stored.scalar_one() == expected
