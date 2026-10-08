"""Регистрация по приглашению → настройка 2FA → вход, ошибки кода приглашения,
гонка двух регистраций с одним кодом, политика пароля и проверка по базе утечек."""

import asyncio
import hashlib
from collections.abc import Callable
from datetime import timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import unquote

import httpx
import httpx2
import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security.tokens import hash_code
from app.core.security.totp import code_at_step, current_step
from app.db.models import AccessCode, AiLimit, AppSettings, RecoveryCode, User
from tests.helpers_auth import (
    code_step,
    cookie_value,
    make_invite,
    make_reset_code,
    password_step,
    set_cookie_header,
)
from tests.support import ClientFactory, MadeUser, SettingsOverride, UserFactory

PASSWORD = "a-long-and-unique-password"


def _body(code: str, email: str, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "invite_code": code,
        "email": email,
        "display_name": "Мария",
        "password": PASSWORD,
        "accept_terms": True,
        "consent_training": True,
        "tz": "Europe/Berlin",
    }
    body.update(extra)
    return body


async def _users(db: AsyncSession) -> int:
    return int((await db.execute(select(func.count()).select_from(User))).scalar_one())


async def test_invite_register_setup_and_login(
    make_client: ClientFactory, db: AsyncSession
) -> None:
    code = await make_invite(
        db, email="maria@example.com", ai_mode="own", limit_monthly_usd=Decimal("5")
    )
    client = await make_client()
    # Код вводится без учета регистра и дефисов, email — без учета регистра
    entered = code.lower().replace("-", "")
    registered = await client.post("/api/auth/register", json=_body(entered, "Maria@Example.com"))
    assert registered.status_code == 200, registered.text
    assert registered.json() == {"status": "totp_setup_required", "user": None}
    assert set_cookie_header(registered, "login") is not None
    assert cookie_value(client, "session") is None

    user = (await db.execute(select(User))).scalar_one()
    assert user.email == "Maria@Example.com"
    assert user.display_name == "Мария"
    assert (user.role, user.ai_mode, user.status) == ("member", "own", "active")
    assert user.tz == "Europe/Berlin"
    assert user.consent_training is True
    assert user.terms_accepted_at is not None
    assert user.totp_enabled is False
    assert user.password_hash and PASSWORD not in user.password_hash
    invite = (await db.execute(select(AccessCode))).scalar_one()
    assert invite.used_at is not None and invite.used_by == user.id
    limit = await db.get(AiLimit, user.id)
    assert limit is not None
    # Месячный лимит из приглашения, остальное — по умолчанию из app_settings
    assert (limit.monthly_usd, limit.daily_analyses, limit.per_analysis_usd) == (
        Decimal("5.00"),
        3,
        Decimal("1.00"),
    )

    # Без 2FA кабинет закрыт
    assert (await client.get("/api/me")).status_code == 401

    setup = await client.post("/api/auth/2fa/setup")
    assert setup.status_code == 200, setup.text
    data = setup.json()
    secret = data["secret"]
    uri = unquote(data["otpauth_uri"])
    assert uri.startswith("otpauth://totp/") and "issuer=AI Capper" in uri
    assert "Maria@Example.com" in uri and secret in uri
    assert data["qr_svg"].lstrip().startswith("<svg")
    # Повторный вызов в том же незавершенном входе — тот же секрет
    assert (await client.post("/api/auth/2fa/setup")).json()["secret"] == secret

    wrong = await client.post("/api/auth/2fa/setup/confirm", json={"code": "000000"})
    assert wrong.status_code == 401
    assert wrong.json()["error"]["code"] == "auth.invalid_code"

    step = current_step()
    done = await client.post(
        "/api/auth/2fa/setup/confirm", json={"code": code_at_step(secret, step)}
    )
    assert done.status_code == 200, done.text
    result = done.json()
    assert result["status"] == "ok"
    assert result["user"]["totp_enabled"] is True
    codes = result["recovery_codes"]
    assert len(codes) == 8 and len(set(codes)) == 8
    assert set_cookie_header(done, "session") is not None
    me = await client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["email"] == "Maria@Example.com"

    # В БД только хеши резервных кодов, секрет 2FA зашифрован
    stored = (await db.execute(select(RecoveryCode.code_hash))).scalars().all()
    assert sorted(stored) == sorted(hash_code(c) for c in codes)
    fresh = await db.get(User, user.id, populate_existing=True)
    assert fresh is not None and fresh.totp_enabled
    assert fresh.totp_secret_enc is not None and secret.encode() not in fresh.totp_secret_enc

    # Выход и обычный вход: пароль → код (следующего шага, текущий уже использован)
    assert (await client.post("/api/auth/logout")).status_code == 204
    made = MadeUser(user=fresh, password=PASSWORD, totp_secret=secret)
    assert (await password_step(client, made)).json()["status"] == "totp_required"
    login = await code_step(client, code=code_at_step(secret, step + 1))
    assert login.status_code == 200, login.text
    # И резервным кодом с другого устройства
    other = await make_client("10.0.0.2")
    assert (await password_step(other, made)).json()["status"] == "totp_required"
    assert (await code_step(other, recovery_code=codes[3])).status_code == 200


async def test_admin_invite_and_default_limits(
    client: httpx2.AsyncClient, db: AsyncSession
) -> None:
    await db.execute(
        update(AppSettings)
        .where(AppSettings.id == 1)
        .values(default_member_limit_usd=Decimal("7"), default_daily_analyses=5)
    )
    await db.commit()
    code = await make_invite(db, email="second-admin@example.com", role="admin")
    response = await client.post(
        "/api/auth/register", json=_body(code, "second-admin@example.com", consent_training=False)
    )
    assert response.status_code == 200, response.text
    user = (await db.execute(select(User))).scalar_one()
    assert user.role == "admin" and user.consent_training is False
    limit = await db.get(AiLimit, user.id)
    assert limit is not None
    assert (limit.monthly_usd, limit.daily_analyses) == (Decimal("7.00"), 5)


@pytest.mark.parametrize(
    "variant",
    ["wrong_email", "expired", "used", "revoked", "unknown", "reset_code_kind"],
)
async def test_invalid_invite(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession, variant: str
) -> None:
    email = "invited@example.com"
    if variant == "unknown":
        code = "CAP-AAAA-BBBB"
    elif variant == "reset_code_kind":
        member = await make_user(email="someone@example.com")
        code = await make_reset_code(db, user_id=member.id)
    else:
        code = await make_invite(
            db,
            email=email,
            expires_in=timedelta(seconds=-1) if variant == "expired" else timedelta(days=7),
            used=variant == "used",
            revoked=variant == "revoked",
        )
    target = "other@example.com" if variant == "wrong_email" else email
    before = await _users(db)
    response = await client.post("/api/auth/register", json=_body(code, target))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "auth.invite_invalid"
    assert await _users(db) == before
    assert cookie_value(client, "login") is None


async def test_invite_for_registered_email(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession
) -> None:
    await make_user(email="taken@example.com")
    code = await make_invite(db, email="TAKEN@example.com")
    response = await client.post("/api/auth/register", json=_body(code, "taken@example.com"))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "auth.invite_invalid"
    invite = (await db.execute(select(AccessCode))).scalar_one()
    assert invite.used_at is None


async def test_two_parallel_registrations_with_one_code(
    make_client: ClientFactory, db: AsyncSession
) -> None:
    code = await make_invite(db, email="race@example.com")
    first = await make_client("10.0.0.1")
    second = await make_client("10.0.0.2")
    body = _body(code, "race@example.com")
    results = await asyncio.gather(
        first.post("/api/auth/register", json=body),
        second.post("/api/auth/register", json=body),
    )
    assert sorted(r.status_code for r in results) == [200, 400]
    assert await _users(db) == 1


async def test_two_parallel_registrations_with_different_emails(
    make_client: ClientFactory, db: AsyncSession
) -> None:
    # Код один, второй запрос с другим email: успех только у владельца приглашения
    code = await make_invite(db, email="owner@example.com")
    first = await make_client("10.0.0.1")
    second = await make_client("10.0.0.2")
    results = await asyncio.gather(
        first.post("/api/auth/register", json=_body(code, "owner@example.com")),
        second.post("/api/auth/register", json=_body(code, "intruder@example.com")),
    )
    assert [r.status_code for r in results] == [200, 400]


@pytest.mark.parametrize(
    ("changes", "status", "code"),
    [
        ({"password": "short-pass"}, 400, "auth.password_too_short"),
        ({"password": "x" * 129}, 400, "auth.password_too_long"),
        ({"accept_terms": False}, 400, "auth.terms_required"),
        ({"tz": "Mars/Olympus"}, 422, "validation"),
        ({"email": "not-an-email"}, 422, "validation"),
        ({"display_name": " "}, 422, "validation"),
    ],
)
async def test_register_validation_keeps_invite(
    client: httpx2.AsyncClient,
    db: AsyncSession,
    changes: dict[str, Any],
    status: int,
    code: str,
) -> None:
    invite = await make_invite(db, email="valid@example.com")
    body = _body(invite, "valid@example.com")
    body.update(changes)
    response = await client.post("/api/auth/register", json=body)
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
    if code == "auth.password_too_short":
        assert "12" in response.json()["error"]["message"]
    # Код не израсходован: с исправленными данными регистрация проходит
    ok = await client.post("/api/auth/register", json=_body(invite, "valid@example.com"))
    assert ok.status_code == 200, ok.text


def _hibp_client_factory(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> list[httpx.Request]:
    """Подменяет httpx.AsyncClient: запросы к HIBP уходят в handler, а не в сеть."""
    seen: list[httpx.Request] = []
    real = httpx.AsyncClient

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(recording)
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return seen


async def test_pwned_password_is_rejected(
    client: httpx2.AsyncClient,
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    override_settings: SettingsOverride,
) -> None:
    override_settings(hibp_enabled=True)
    digest = hashlib.sha1(PASSWORD.encode()).hexdigest().upper()
    seen = _hibp_client_factory(
        monkeypatch,
        lambda request: httpx.Response(200, text=f"{digest[5:]}:42\r\n0000000000:0"),
    )
    invite = await make_invite(db, email="pwned@example.com")
    response = await client.post("/api/auth/register", json=_body(invite, "pwned@example.com"))
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "auth.password_pwned"
    # Наружу ушли только 5 символов SHA-1
    assert len(seen) == 1 and str(seen[0].url).endswith(f"/range/{digest[:5]}")
    assert await _users(db) == 0


async def test_hibp_network_failure_is_skipped(
    client: httpx2.AsyncClient,
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    override_settings: SettingsOverride,
) -> None:
    override_settings(hibp_enabled=True)

    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network down", request=request)

    seen = _hibp_client_factory(monkeypatch, fail)
    invite = await make_invite(db, email="offline@example.com")
    response = await client.post("/api/auth/register", json=_body(invite, "offline@example.com"))
    assert response.status_code == 200, response.text
    assert len(seen) == 1
    assert await _users(db) == 1


async def test_setup_confirm_without_setup_and_after_enabled(
    make_client: ClientFactory, db: AsyncSession
) -> None:
    invite = await make_invite(db, email="steps@example.com")
    client = await make_client()
    assert (
        await client.post("/api/auth/register", json=_body(invite, "steps@example.com"))
    ).status_code == 200
    # Подтверждение без выданного секрета — начать заново
    early = await client.post("/api/auth/2fa/setup/confirm", json={"code": "123456"})
    assert early.status_code == 401
    assert early.json()["error"]["code"] == "auth.login_expired"
    # Код 2FA на этапе настройки не принимается
    assert (await code_step(client, code="123456")).status_code == 401
