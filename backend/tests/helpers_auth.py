"""Помощники для тестов настоящего входа через маршруты /api/auth/*.

Фикстура login из conftest создает сеанс прямо в БД (быстро и без зависимости от времени).
Здесь — вход как в браузере: пароль, затем код 2FA. Код 2FA одноразовый: второй вход того же
пользователя в одном тесте берет код через фикстуру totp_code (она сбрасывает
users.totp_last_step) или код следующего шага (MadeUser.current_totp(1)).

    from tests.helpers_auth import full_login, password_step

    await full_login(client, user, await totp_code(user))
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import httpx2
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cookies import CookieKind, cookie_name
from app.core.security.tokens import gen_invite_code, gen_reset_code, hash_code
from app.db.models import AccessCode
from tests.support import COOKIE_DOMAIN, MadeUser


async def password_step(
    client: httpx2.AsyncClient, user: MadeUser, *, password: str | None = None
) -> httpx2.Response:
    """Шаг 1 входа: email и пароль (по умолчанию верный пароль пользователя)."""
    return await client.post(
        "/api/auth/login",
        json={"email": user.email, "password": password if password is not None else user.password},
    )


async def code_step(
    client: httpx2.AsyncClient,
    *,
    code: str | None = None,
    recovery_code: str | None = None,
    remember_device: bool = False,
) -> httpx2.Response:
    """Шаг 2 входа: код 2FA или резервный код."""
    body: dict[str, object] = {"remember_device": remember_device}
    if code is not None:
        body["code"] = code
    if recovery_code is not None:
        body["recovery_code"] = recovery_code
    return await client.post("/api/auth/2fa", json=body)


async def full_login(
    client: httpx2.AsyncClient,
    user: MadeUser,
    code: str,
    *,
    remember_device: bool = False,
) -> httpx2.Response:
    """Вход через маршруты: пароль → код. Клиент после него вошедший."""
    first = await password_step(client, user)
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "totp_required", first.text
    second = await code_step(client, code=code, remember_device=remember_device)
    assert second.status_code == 200, second.text
    assert second.json()["status"] == "ok", second.text
    return second


def cookie_value(client: httpx2.AsyncClient, kind: CookieKind) -> str | None:
    """Значение cookie входа (session, login, device, csrf) в банке cookie клиента."""
    name = cookie_name(kind)
    return client.cookies.get(name, domain=COOKIE_DOMAIN)


def set_cookie_header(response: httpx2.Response, kind: CookieKind) -> str | None:
    """Заголовок Set-Cookie для cookie нужного вида (или None)."""
    name = cookie_name(kind)
    for header in response.headers.get_list("set-cookie"):
        if header.startswith(f"{name}="):
            return header
    return None


async def make_invite(
    db: AsyncSession,
    *,
    email: str,
    role: str = "member",
    ai_mode: str = "shared",
    expires_in: timedelta = timedelta(days=7),
    used: bool = False,
    revoked: bool = False,
    limit_monthly_usd: Decimal | None = None,
    limit_daily_analyses: int | None = None,
    limit_per_analysis_usd: Decimal | None = None,
) -> str:
    """Код приглашения прямо в БД (маршруты администратора — отдельный раздел).
    Возвращает код в открытом виде; в БД — только HMAC-хеш."""
    code = gen_invite_code()
    now = datetime.now(UTC)
    db.add(
        AccessCode(
            kind="invite",
            code_hash=hash_code(code),
            email=email,
            role=role,
            ai_mode=ai_mode,
            limit_monthly_usd=limit_monthly_usd,
            limit_daily_analyses=limit_daily_analyses,
            limit_per_analysis_usd=limit_per_analysis_usd,
            expires_at=now + expires_in,
            used_at=now if used else None,
            revoked_at=now if revoked else None,
        )
    )
    await db.commit()
    return code


async def make_reset_code(
    db: AsyncSession,
    *,
    user_id: int,
    expires_in: timedelta = timedelta(hours=24),
    revoked: bool = False,
) -> str:
    """Код сброса пароля прямо в БД. Возвращает код в открытом виде."""
    code = gen_reset_code()
    now = datetime.now(UTC)
    db.add(
        AccessCode(
            kind="password_reset",
            code_hash=hash_code(code),
            user_id=user_id,
            expires_at=now + expires_in,
            revoked_at=now if revoked else None,
        )
    )
    await db.commit()
    return code
