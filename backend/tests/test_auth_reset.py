"""Сброс пароля по коду от администратора: новый пароль, отзыв сеансов и доверенных
устройств, 2FA остается; ошибки кода."""

import asyncio
from datetime import timedelta

import httpx2
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AccessCode, TrustedDevice, User
from tests.helpers_auth import (
    code_step,
    full_login,
    make_invite,
    make_reset_code,
    password_step,
)
from tests.support import ClientFactory, LoginFn, MadeUser, TotpCodeFn, UserFactory

NEW_PASSWORD = "brand-new-password-2026"


async def test_reset_code_sets_new_password_and_ends_sessions(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user(email="forgot@example.com")
    phone = await login(await make_client("10.0.0.2"), member)
    laptop = await make_client("10.0.0.3")
    await full_login(laptop, member, await totp_code(member), remember_device=True)
    assert (await phone.get("/api/me")).status_code == 200
    assert (await laptop.get("/api/me")).status_code == 200

    code = await make_reset_code(db, user_id=member.id)
    anonymous = await make_client("10.0.0.4")
    # Email без учета регистра, код — без префикса RST, строчными и с пробелом
    entered = code.removeprefix("RST-").replace("-", " ").lower()
    response = await anonymous.post(
        "/api/auth/reset",
        json={"email": "FORGOT@example.com", "code": entered, "new_password": NEW_PASSWORD},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ok"}

    # Все сеансы завершены, доверенные устройства отозваны
    assert (await phone.get("/api/me")).status_code == 401
    assert (await laptop.get("/api/me")).status_code == 401
    devices = (await db.execute(select(TrustedDevice.revoked_at))).scalars().all()
    assert devices and all(d is not None for d in devices)
    stored = (await db.execute(select(AccessCode))).scalar_one()
    assert stored.used_at is not None and stored.used_by == member.id

    # Старый пароль не подходит, новый — подходит, но код 2FA все равно нужен
    # (в том числе на бывшем доверенном устройстве)
    old = await password_step(laptop, member)
    assert old.status_code == 401
    renewed = MadeUser(user=member.user, password=NEW_PASSWORD, totp_secret=member.totp_secret)
    second = await password_step(laptop, renewed)
    assert second.status_code == 200
    assert second.json()["status"] == "totp_required"
    assert (await code_step(laptop, code=await totp_code(member))).status_code == 200
    user = await db.get(User, member.id, populate_existing=True)
    assert user is not None and user.totp_enabled

    # Код одноразовый
    again = await anonymous.post(
        "/api/auth/reset",
        json={"email": member.email, "code": code, "new_password": "another-password-xyz"},
    )
    assert again.status_code == 400
    assert again.json()["error"]["code"] == "auth.reset_invalid"


@pytest.mark.parametrize("variant", ["expired", "revoked", "foreign", "unknown", "invite_code"])
async def test_invalid_reset_code(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession, variant: str
) -> None:
    owner = await make_user()
    victim = await make_user()
    if variant == "unknown":
        code = "RST-AAAA-BBBB"
    elif variant == "invite_code":
        code = await make_invite(db, email=victim.email)
    else:
        code = await make_reset_code(
            db,
            user_id=owner.id,
            expires_in=timedelta(seconds=-1) if variant == "expired" else timedelta(hours=24),
            revoked=variant == "revoked",
        )
    # Чужой код: выдан владельцу, а вводится с email другого человека
    email = victim.email if variant in {"foreign", "invite_code"} else owner.email
    target = victim if email == victim.email else owner
    response = await client.post(
        "/api/auth/reset", json={"email": email, "code": code, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "auth.reset_invalid"
    # Пароль не изменился
    assert (await password_step(client, target)).json()["status"] == "totp_required"


async def test_reset_password_policy_keeps_code(
    client: httpx2.AsyncClient, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    code = await make_reset_code(db, user_id=member.id)
    short = await client.post(
        "/api/auth/reset", json={"email": member.email, "code": code, "new_password": "short"}
    )
    assert short.status_code == 400
    assert short.json()["error"]["code"] == "auth.password_too_short"
    ok = await client.post(
        "/api/auth/reset",
        json={"email": member.email, "code": code, "new_password": NEW_PASSWORD},
    )
    assert ok.status_code == 200


async def test_reset_cancels_pending_login_with_old_password(
    make_client: ClientFactory, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    attacker = await make_client("10.0.0.50")
    assert (await password_step(attacker, member)).json()["status"] == "totp_required"
    code = await make_reset_code(db, user_id=member.id)
    owner = await make_client("10.0.0.51")
    reset = await owner.post(
        "/api/auth/reset",
        json={"email": member.email, "code": code, "new_password": NEW_PASSWORD},
    )
    assert reset.status_code == 200
    response = await code_step(attacker, code=member.current_totp())
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth.login_expired"


async def test_parallel_resets_with_one_code(
    make_client: ClientFactory, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    code = await make_reset_code(db, user_id=member.id)
    first = await make_client("10.0.0.1")
    second = await make_client("10.0.0.2")
    results = await asyncio.gather(
        first.post(
            "/api/auth/reset",
            json={"email": member.email, "code": code, "new_password": NEW_PASSWORD},
        ),
        second.post(
            "/api/auth/reset",
            json={"email": member.email, "code": code, "new_password": "other-new-password"},
        ),
    )
    assert sorted(r.status_code for r in results) == [200, 400]
