"""Вход через маршруты: пароль → 2FA → сеанс, резервные коды, доверенное устройство,
выход, блокировка, CSRF, журнал входов и уведомление о новом устройстве."""

import asyncio
from datetime import timedelta

import httpx2
from argon2 import PasswordHasher
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cookies import CSRF_HEADER, cookie_name
from app.core.security.passwords import needs_rehash
from app.core.security.tokens import hash_token
from app.db.models import LoginEvent, Notification, User, UserSession
from app.services.sessions import utcnow
from app.workers.jobs import purge_old_login_events
from tests.helpers_auth import (
    code_step,
    cookie_value,
    full_login,
    make_reset_code,
    password_step,
    set_cookie_header,
)
from tests.support import (
    COOKIE_DOMAIN,
    ClientFactory,
    LoginFn,
    SettingsOverride,
    TotpCodeFn,
    UserFactory,
)


async def _events(db: AsyncSession, user_id: int | None) -> list[tuple[str, str]]:
    rows = await db.execute(
        select(LoginEvent.result, LoginEvent.method)
        .where(LoginEvent.user_id == user_id if user_id else LoginEvent.user_id.is_(None))
        .order_by(LoginEvent.id)
    )
    return [(r[0], r[1]) for r in rows.all()]


async def test_login_with_2fa_end_to_end(
    client: httpx2.AsyncClient,
    make_client: ClientFactory,
    make_user: UserFactory,
    db: AsyncSession,
) -> None:
    member = await make_user()

    first = await password_step(client, member)
    assert first.status_code == 200
    assert first.json() == {"status": "totp_required", "user": None}
    login_cookie = set_cookie_header(first, "login")
    assert login_cookie is not None
    assert "HttpOnly" in login_cookie and "Max-Age=300" in login_cookie
    assert cookie_value(client, "session") is None
    # До кода 2FA кабинет закрыт
    assert (await client.get("/api/me")).status_code == 401

    code = member.current_totp()
    second = await code_step(client, code=code)
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["status"] == "ok"
    assert body["user"]["id"] == member.id
    assert body["user"]["email"] == member.email
    assert body["user"]["totp_enabled"] is True

    session_cookie = set_cookie_header(second, "session")
    assert session_cookie is not None
    flags = [part.strip().lower() for part in session_cookie.split(";")]
    assert "httponly" in flags
    assert "path=/" in flags
    assert "samesite=lax" in flags
    assert f"max-age={30 * 24 * 3600}" in flags
    assert "secure" not in flags  # dev и test работают по http
    assert cookie_value(client, "login") is None

    me = await client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["id"] == member.id

    # В БД только sha256 токена сеанса
    token = cookie_value(client, "session")
    assert token is not None
    stored = (await db.execute(select(UserSession.id_hash))).scalars().all()
    assert stored == [hash_token(token)]

    # Тот же код второй раз не принимается
    other = await make_client("10.0.0.2")
    assert (await password_step(other, member)).json()["status"] == "totp_required"
    replay = await code_step(other, code=code)
    assert replay.status_code == 401
    assert replay.json()["error"]["code"] == "auth.invalid_code"

    assert await _events(db, member.id) == [("ok", "totp"), ("bad_totp", "totp")]
    user = await db.get(User, member.id, populate_existing=True)
    assert user is not None and user.last_login_at is not None


async def test_secure_cookies_with_host_prefix(
    make_client: ClientFactory,
    make_user: UserFactory,
    override_settings: SettingsOverride,
) -> None:
    override_settings(cookie_secure=True)
    member = await make_user()
    client = await make_client()
    first = await password_step(client, member)
    login_cookie = set_cookie_header(first, "login")
    assert login_cookie is not None and login_cookie.startswith("__Host-login=")
    assert "Secure" in login_cookie
    # Банк cookie клиента тестов не отправит Secure-cookie по http: передаем ее явно
    token = login_cookie.split(";", 1)[0].split("=", 1)[1]
    client.cookies.set("__Host-login", token, domain=COOKIE_DOMAIN)
    second = await code_step(client, code=member.current_totp())
    assert second.status_code == 200, second.text
    session_cookie = set_cookie_header(second, "session")
    assert session_cookie is not None and session_cookie.startswith("__Host-session=")
    assert "Secure" in session_cookie and "HttpOnly" in session_cookie


async def test_recovery_code_login_and_replay(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    owner = await login(await make_client(), member)
    issued = await owner.post("/api/me/recovery-codes", json={"code": await totp_code(member)})
    assert issued.status_code == 200, issued.text
    codes = issued.json()["recovery_codes"]
    assert len(codes) == 8

    client = await make_client("10.0.0.5")
    assert (await password_step(client, member)).json()["status"] == "totp_required"
    # Регистр, пробелы и дефисы не важны
    entered = codes[0].upper().replace("-", " ")
    ok = await code_step(client, recovery_code=entered)
    assert ok.status_code == 200, ok.text
    assert (await client.get("/api/me")).status_code == 200

    again = await make_client("10.0.0.6")
    assert (await password_step(again, member)).json()["status"] == "totp_required"
    replay = await code_step(again, recovery_code=codes[0])
    assert replay.status_code == 401
    assert replay.json()["error"]["code"] == "auth.invalid_code"

    assert await _events(db, member.id) == [("ok", "recovery"), ("bad_recovery", "recovery")]


async def test_remember_device_skips_2fa_until_revoked(
    make_client: ClientFactory,
    make_user: UserFactory,
    totp_code: TotpCodeFn,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    browser = await make_client()
    done = await full_login(browser, member, await totp_code(member), remember_device=True)
    device_cookie = set_cookie_header(done, "device")
    assert device_cookie is not None
    assert "HttpOnly" in device_cookie and f"Max-Age={30 * 24 * 3600}" in device_cookie

    assert (await browser.post("/api/auth/logout")).status_code == 204
    assert (await browser.get("/api/me")).status_code == 401

    # Пароль спрашивается всегда, код 2FA на этом устройстве — нет
    again = await password_step(browser, member)
    assert again.status_code == 200
    assert again.json()["status"] == "ok"
    assert again.json()["user"]["id"] == member.id
    assert (await browser.get("/api/me")).status_code == 200
    # С неверным паролем доверенное устройство не помогает
    wrong = await password_step(browser, member, password="wrong-password-123")
    assert wrong.status_code == 401

    # Отзыв из другого сеанса: этот браузер сохраняет cookie, но 2FA снова нужна
    other = await login(await make_client("10.0.0.9"), member)
    devices = (await other.get("/api/me/trusted-devices")).json()
    assert len(devices) == 1 and devices[0]["current"] is False
    assert devices[0]["device_label"] == "Chrome · Windows"
    deleted = await other.delete(f"/api/me/trusted-devices/{devices[0]['id']}")
    assert deleted.status_code == 204
    assert cookie_value(browser, "device") is not None
    after = await password_step(browser, member)
    assert after.json()["status"] == "totp_required"

    events = await _events(db, member.id)
    assert ("ok", "trusted_device") in events


async def test_other_users_device_cookie_does_not_skip_2fa(
    make_client: ClientFactory, make_user: UserFactory, totp_code: TotpCodeFn
) -> None:
    alice = await make_user()
    bob = await make_user()
    browser = await make_client()
    await full_login(browser, alice, await totp_code(alice), remember_device=True)
    await browser.post("/api/auth/logout")
    response = await password_step(browser, bob)
    assert response.json()["status"] == "totp_required"


async def test_blocked_user_cannot_login_and_loses_session(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    blocked = await make_user(status="blocked")
    client = await make_client()
    response = await password_step(client, blocked)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "auth.blocked"
    # С неверным паролем — обычная ошибка: статус аккаунта не раскрывается
    wrong = await password_step(client, blocked, password="wrong-password-123")
    assert wrong.status_code == 401
    assert wrong.json()["error"]["code"] == "auth.invalid_credentials"
    assert await _events(db, blocked.id) == [("blocked", "password"), ("bad_password", "password")]

    member = await make_user()
    active = await login(await make_client(), member)
    assert (await active.get("/api/me")).status_code == 200
    await db.execute(update(User).where(User.id == member.id).values(status="blocked"))
    await db.commit()
    assert (await active.get("/api/me")).status_code == 401


async def test_blocked_between_password_and_code(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    assert (await password_step(client, member)).json()["status"] == "totp_required"
    await db.execute(update(User).where(User.id == member.id).values(status="blocked"))
    await db.commit()
    response = await code_step(client, code=member.current_totp())
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "auth.blocked"
    assert cookie_value(client, "session") is None


async def test_logout_revokes_session_and_clears_cookie(
    client: httpx2.AsyncClient,
    make_user: UserFactory,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    await full_login(client, member, await totp_code(member))
    token = cookie_value(client, "session")
    assert token is not None

    response = await client.post("/api/auth/logout")
    assert response.status_code == 204
    assert set_cookie_header(response, "session") is not None
    assert cookie_value(client, "session") is None
    assert (await client.get("/api/me")).status_code == 401
    revoked = await db.execute(
        select(UserSession.revoked_at).where(UserSession.id_hash == hash_token(token))
    )
    assert revoked.scalar_one() is not None
    # Повторный выход без сеанса тоже 204
    assert (await client.post("/api/auth/logout")).status_code == 204


async def test_second_login_in_same_browser_revokes_previous_session(
    client: httpx2.AsyncClient, make_user: UserFactory, totp_code: TotpCodeFn, db: AsyncSession
) -> None:
    member = await make_user()
    await full_login(client, member, await totp_code(member))
    first = cookie_value(client, "session")
    await full_login(client, member, await totp_code(member))
    second = cookie_value(client, "session")
    assert first and second and first != second
    rows = await db.execute(select(UserSession.id_hash, UserSession.revoked_at))
    state = {h: r is not None for h, r in rows.all()}
    assert state == {hash_token(first): True, hash_token(second): False}


async def test_csrf_endpoint_and_required_header(
    make_client: ClientFactory, make_user: UserFactory
) -> None:
    member = await make_user()
    browser = await make_client(csrf=False)
    # Без X-CSRF-Token изменяющий запрос не проходит
    blocked = await password_step(browser, member)
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "common.csrf"

    issued = await browser.get("/api/auth/csrf")
    assert issued.status_code == 200
    token = issued.json()["csrf_token"]
    assert cookie_value(browser, "csrf") == token
    header = set_cookie_header(issued, "csrf")
    assert header is not None and "HttpOnly" not in header
    # Повторный запрос не меняет токен: другие вкладки продолжают работать
    assert (await browser.get("/api/auth/csrf")).json()["csrf_token"] == token

    wrong_header = await browser.post(
        "/api/auth/login",
        json={"email": member.email, "password": member.password},
        headers={CSRF_HEADER: "something-else"},
    )
    assert wrong_header.status_code == 403
    passed = await browser.post(
        "/api/auth/login",
        json={"email": member.email, "password": member.password},
        headers={CSRF_HEADER: token},
    )
    assert passed.status_code == 200
    assert passed.json()["status"] == "totp_required"


async def test_csrf_required_for_me_routes(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await make_user()
    browser = await login(await make_client(csrf=False), member)
    assert (await browser.get("/api/me")).status_code == 200
    response = await browser.post("/api/me/sessions/revoke-others")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "common.csrf"
    logout = await browser.post("/api/auth/logout")
    assert logout.status_code == 403


async def test_password_hash_is_upgraded_on_login(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    weak = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash(member.password)
    await db.execute(update(User).where(User.id == member.id).values(password_hash=weak))
    await db.commit()
    assert needs_rehash(weak)
    response = await password_step(client, member)
    assert response.json()["status"] == "totp_required"
    user = await db.get(User, member.id, populate_existing=True)
    assert user is not None and user.password_hash != weak
    assert user.password_hash is not None and not needs_rehash(user.password_hash)
    # Незавершенный вход пережил пересчет хеша
    assert (await code_step(client, code=member.current_totp())).status_code == 200


async def test_new_device_notification(
    make_client: ClientFactory,
    make_user: UserFactory,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user()

    async def notes() -> list[str]:
        rows = await db.execute(
            select(Notification.body).where(
                Notification.user_id == member.id, Notification.kind == "new_device"
            )
        )
        return list(rows.scalars())

    laptop = await make_client("10.0.0.1")
    await full_login(laptop, member, await totp_code(member))
    assert await notes() == []  # первый вход после регистрации — не новое устройство

    phone = await make_client("10.0.0.2")
    phone.headers["User-Agent"] = (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
    )
    await full_login(phone, member, await totp_code(member))
    bodies = await notes()
    assert len(bodies) == 1
    assert "Safari · iOS" in bodies[0] and "10.0.0.2" in bodies[0]

    again = await make_client("10.0.0.3")
    await full_login(again, member, await totp_code(member))
    assert len(await notes()) == 1


async def test_new_device_after_login_journal_purge(
    make_client: ClientFactory,
    make_user: UserFactory,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    laptop = await make_client("10.0.0.1")
    await full_login(laptop, member, await totp_code(member))
    # Воркер удаляет журнал входов старше 90 дней: после долгого перерыва журнал пуст
    await db.execute(update(LoginEvent).values(at=utcnow() - timedelta(days=100)))
    assert await purge_old_login_events(db, now=utcnow()) >= 1
    await db.commit()

    desktop = await make_client("10.0.0.4")
    desktop.headers["User-Agent"] = (
        "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"
    )
    await full_login(desktop, member, await totp_code(member))
    rows = await db.execute(
        select(Notification.body).where(
            Notification.user_id == member.id, Notification.kind == "new_device"
        )
    )
    bodies = list(rows.scalars())
    assert len(bodies) == 1
    assert "Firefox · Linux" in bodies[0] and "10.0.0.4" in bodies[0]


async def test_nul_character_is_rejected(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    reset_code = await make_reset_code(db, user_id=member.id)
    requests: list[tuple[str, dict[str, object]]] = [
        ("/api/auth/login", {"email": "a\u0000b@example.com", "password": member.password}),
        (
            "/api/auth/reset",
            {"email": "a\u0000@example.com", "code": reset_code, "new_password": "x" * 20},
        ),
        (
            "/api/auth/reset",
            {"email": member.email, "code": "RST-\u0000", "new_password": "x" * 20},
        ),
    ]
    register = {
        "invite_code": "CAP-AAAA-BBBB",
        "email": "new@example.com",
        "display_name": "Гость",
        "password": "long-enough-password",
        "accept_terms": True,
    }
    for field, value in (
        ("display_name", "Ab\u0000c"),
        ("email", "a\u0000b@example.com"),
        ("invite_code", "CAP-\u0000"),
    ):
        requests.append(("/api/auth/register", {**register, field: value}))
    for path, body in requests:
        # В JSON символ NUL приходит как \u0000; PostgreSQL его в тексте не хранит
        response = await client.post(path, json=body)
        assert response.status_code == 422, (path, body, response.text)
        assert response.json()["error"]["code"] == "validation"


async def test_second_step_without_pending_login(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    response = await code_step(client, code=member.current_totp())
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth.login_expired"
    for path in ("/api/auth/2fa/setup", "/api/auth/2fa/setup/confirm"):
        body = {"code": "123456"} if path.endswith("confirm") else None
        result = await client.post(path, json=body)
        assert result.status_code == 401, path
        assert result.json()["error"]["code"] == "auth.login_expired"

    # Этап «код 2FA» не дает настроить 2FA заново
    assert (await password_step(client, member)).json()["status"] == "totp_required"
    setup = await client.post("/api/auth/2fa/setup")
    assert setup.status_code == 401


async def test_password_change_cancels_pending_login(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    assert (await password_step(client, member)).json()["status"] == "totp_required"
    await db.execute(
        update(User).where(User.id == member.id).values(password_hash="$argon2id$changed")
    )
    await db.commit()
    response = await code_step(client, code=member.current_totp())
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth.login_expired"


async def test_second_step_validation(client: httpx2.AsyncClient, make_user: UserFactory) -> None:
    member = await make_user()
    await password_step(client, member)
    both = await client.post("/api/auth/2fa", json={"code": "123456", "recovery_code": "abcd-efgh"})
    assert both.status_code == 422
    neither = await client.post("/api/auth/2fa", json={})
    assert neither.status_code == 422
    letters = await client.post("/api/auth/2fa", json={"code": "12345a"})
    assert letters.status_code == 422
    assert letters.json()["error"]["code"] == "validation"


async def test_same_code_in_parallel_logs_in_once(
    make_client: ClientFactory, make_user: UserFactory
) -> None:
    member = await make_user()
    first = await make_client("10.0.0.1")
    second = await make_client("10.0.0.2")
    for c in (first, second):
        assert (await password_step(c, member)).json()["status"] == "totp_required"
    code = member.current_totp()
    results = await asyncio.gather(code_step(first, code=code), code_step(second, code=code))
    assert sorted(r.status_code for r in results) == [200, 401]


async def test_login_email_is_case_insensitive(
    client: httpx2.AsyncClient, make_user: UserFactory
) -> None:
    member = await make_user(email="Case.User@Example.com")
    response = await client.post(
        "/api/auth/login",
        json={"email": "  case.user@EXAMPLE.com ", "password": member.password},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "totp_required"


async def test_user_without_2fa_must_set_it_up(
    client: httpx2.AsyncClient, make_user: UserFactory
) -> None:
    # Например, администратор сбросил 2FA: после пароля — настройка заново
    member = await make_user(totp=False)
    response = await password_step(client, member)
    assert response.status_code == 200
    assert response.json() == {"status": "totp_setup_required", "user": None}
    assert (await code_step(client, code="123456")).status_code == 401
    assert cookie_name("login") in {c.name for c in client.cookies.jar}
