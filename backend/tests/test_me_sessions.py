"""Сеансы в личном кабинете: сроки, список, завершение своего и чужого, «выйти на
остальных», смена пароля с заменой токена."""

from datetime import timedelta

import httpx2
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cookies import cookie_name
from app.core.security.tokens import hash_token
from app.db.models import UserSession
from app.services.sessions import utcnow
from tests.helpers_auth import cookie_value, full_login, password_step, set_cookie_header
from tests.support import COOKIE_DOMAIN, ClientFactory, LoginFn, MadeUser, TotpCodeFn, UserFactory


async def _session_id(db: AsyncSession, client: httpx2.AsyncClient) -> int:
    token = cookie_value(client, "session")
    assert token is not None
    row = await db.execute(select(UserSession.id).where(UserSession.id_hash == hash_token(token)))
    return int(row.scalar_one())


async def test_idle_and_absolute_expiry(
    make_client: ClientFactory, make_user: UserFactory, totp_code: TotpCodeFn, db: AsyncSession
) -> None:
    member = await make_user()

    idle = await make_client("10.0.0.1")
    await full_login(idle, member, await totp_code(member))
    sid = await _session_id(db, idle)
    now = utcnow()
    await db.execute(
        update(UserSession)
        .where(UserSession.id == sid)
        .values(last_seen_at=now - timedelta(days=14, minutes=1))
    )
    await db.commit()
    response = await idle.get("/api/me")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth.not_authenticated"

    # Активный каждый день, но вход был больше 30 дней назад
    old = await make_client("10.0.0.2")
    await full_login(old, member, await totp_code(member))
    sid = await _session_id(db, old)
    await db.execute(
        update(UserSession)
        .where(UserSession.id == sid)
        .values(
            created_at=now - timedelta(days=30, minutes=1),
            expires_at=now - timedelta(minutes=1),
            last_seen_at=now - timedelta(hours=1),
        )
    )
    await db.commit()
    assert (await old.get("/api/me")).status_code == 401

    # Сеанс на 13-й день бездействия еще действует
    alive = await make_client("10.0.0.3")
    await full_login(alive, member, await totp_code(member))
    sid = await _session_id(db, alive)
    await db.execute(
        update(UserSession)
        .where(UserSession.id == sid)
        .values(last_seen_at=now - timedelta(days=13))
    )
    await db.commit()
    assert (await alive.get("/api/me")).status_code == 200


async def test_list_and_end_own_sessions(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await make_user()
    current = await login(await make_client("10.0.0.1"), member)
    second = await login(await make_client("10.0.0.2"), member)
    third = await login(await make_client("10.0.0.3"), member)

    listed = await current.get("/api/me/sessions")
    assert listed.status_code == 200
    items = listed.json()
    assert len(items) == 3
    assert [i["current"] for i in items].count(True) == 1
    mine = next(i for i in items if i["current"])
    assert mine["id"] == await _session_id(db, current)
    assert mine["ip"] == "10.0.0.1"
    assert mine["device_label"] == "Chrome · Windows"
    assert set(mine) == {"id", "device_label", "ip", "created_at", "last_seen_at", "current"}

    second_id = await _session_id(db, second)
    assert (await current.delete(f"/api/me/sessions/{second_id}")).status_code == 204
    assert (await second.get("/api/me")).status_code == 401
    assert (await third.get("/api/me")).status_code == 200
    # Повторное завершение того же сеанса — 404
    assert (await current.delete(f"/api/me/sessions/{second_id}")).status_code == 404
    assert len((await current.get("/api/me/sessions")).json()) == 2


async def test_cannot_end_someone_elses_session(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    alice = await login(await make_client("10.0.0.1"), await make_user())
    bob = await login(await make_client("10.0.0.2"), await make_user())
    bob_session = await _session_id(db, bob)
    response = await alice.delete(f"/api/me/sessions/{bob_session}")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "common.not_found"
    assert (await bob.get("/api/me")).status_code == 200
    ids = {i["id"] for i in (await alice.get("/api/me/sessions")).json()}
    assert bob_session not in ids


async def test_end_current_session_clears_cookie(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await login(client, await make_user())
    sid = await _session_id(db, client)
    response = await client.delete(f"/api/me/sessions/{sid}")
    assert response.status_code == 204
    assert set_cookie_header(response, "session") is not None
    assert (await client.get("/api/me")).status_code == 401


async def test_revoke_other_sessions(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await make_user()
    stranger = await login(await make_client("10.0.0.9"), await make_user())
    current = await login(await make_client("10.0.0.1"), member)
    others = [await login(await make_client(f"10.0.0.{n}"), member) for n in (2, 3)]
    response = await current.post("/api/me/sessions/revoke-others")
    assert response.status_code == 204
    assert (await current.get("/api/me")).status_code == 200
    for other in others:
        assert (await other.get("/api/me")).status_code == 401
    # Сеансы другого пользователя не тронуты
    assert (await stranger.get("/api/me")).status_code == 200
    assert len((await current.get("/api/me/sessions")).json()) == 1


async def test_change_password_rotates_token_and_ends_other_sessions(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await make_user()
    current = await login(await make_client("10.0.0.1"), member)
    other = await login(await make_client("10.0.0.2"), member)
    old_token = cookie_value(current, "session")

    wrong = await current.post(
        "/api/me/password",
        json={"current_password": "not-my-password", "new_password": "new-password-2026"},
    )
    assert wrong.status_code == 400
    assert wrong.json()["error"]["code"] == "auth.current_password_invalid"
    short = await current.post(
        "/api/me/password", json={"current_password": member.password, "new_password": "short"}
    )
    assert short.status_code == 400
    assert short.json()["error"]["code"] == "auth.password_too_short"

    response = await current.post(
        "/api/me/password",
        json={"current_password": member.password, "new_password": "new-password-2026"},
    )
    assert response.status_code == 204
    new_token = cookie_value(current, "session")
    assert new_token and new_token != old_token
    assert (await current.get("/api/me")).status_code == 200
    assert (await other.get("/api/me")).status_code == 401
    # Старый токен этого же браузера больше не действует
    stale = await make_client("10.0.0.1")
    assert old_token is not None
    stale.cookies.set(cookie_name("session"), old_token, domain=COOKIE_DOMAIN)
    assert (await stale.get("/api/me")).status_code == 401

    fresh = await make_client("10.0.0.3")
    assert (await password_step(fresh, member)).status_code == 401
    renewed = MadeUser(user=member.user, password="new-password-2026", totp_secret=None)
    assert (await password_step(fresh, renewed)).json()["status"] == "totp_required"


async def test_wrong_current_password_counts_as_failure(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn
) -> None:
    member = await make_user()
    await login(client, member)
    body = {"current_password": "not-my-password", "new_password": "new-password-2026"}
    for _ in range(5):
        assert (await client.post("/api/me/password", json=body)).status_code == 400
    locked = await client.post("/api/me/password", json=body)
    assert locked.status_code == 429
    assert locked.json()["error"]["retry_after"] > 0
