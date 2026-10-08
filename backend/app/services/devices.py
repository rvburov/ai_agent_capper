"""Доверенные устройства: «запомнить это устройство на 30 дней».

При входе с галочкой браузер получает cookie device со случайным токеном (256 бит),
в БД (trusted_devices) — только его sha256. Пока устройство не отозвано и срок не
прошел, вход этого пользователя с этого браузера не спрашивает код 2FA. Пароль
спрашивается всегда.

Имя устройства («Chrome · Windows») строится по User-Agent без внешних библиотек:
app.core.useragent.device_label. Функции делают flush(), commit — за сервисом действия.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import ColumnElement, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security.tokens import hash_token, new_token
from app.core.useragent import clip_user_agent, device_label
from app.db.models import TrustedDevice
from app.services.sessions import utcnow


@dataclass(frozen=True)
class NewDevice:
    token: str  # значение для cookie, в БД не хранится
    device: TrustedDevice


def _active(user_id: int, now: datetime) -> list[ColumnElement[bool]]:
    return [
        TrustedDevice.user_id == user_id,
        TrustedDevice.revoked_at.is_(None),
        TrustedDevice.expires_at > now,
    ]


async def create_trusted_device(
    db: AsyncSession,
    *,
    user_id: int,
    ip: str | None,
    user_agent: str | None,
    now: datetime | None = None,
) -> NewDevice:
    now = now or utcnow()
    token = new_token()
    device = TrustedDevice(
        token_hash=hash_token(token),
        user_id=user_id,
        created_at=now,
        expires_at=now + timedelta(days=get_settings().trusted_device_days),
        ip=ip,
        user_agent=clip_user_agent(user_agent),
        device_label=device_label(user_agent),
        last_used_at=now,
    )
    db.add(device)
    await db.flush()
    return NewDevice(token=token, device=device)


async def find_trusted_device(
    db: AsyncSession, user_id: int, token: str | None, *, now: datetime | None = None
) -> TrustedDevice | None:
    """Действующее доверенное устройство этого пользователя по токену из cookie.
    Найденное отмечается last_used_at."""
    if not token:
        return None
    now = now or utcnow()
    device = (
        await db.execute(
            select(TrustedDevice).where(
                TrustedDevice.token_hash == hash_token(token), *_active(user_id, now)
            )
        )
    ).scalar_one_or_none()
    if device is not None:
        device.last_used_at = now
        await db.flush()
    return device


async def current_device_id(
    db: AsyncSession, user_id: int, token: str | None, *, now: datetime | None = None
) -> int | None:
    """id устройства из cookie, если оно действует (без отметки last_used_at)."""
    if not token:
        return None
    now = now or utcnow()
    return (
        await db.execute(
            select(TrustedDevice.id).where(
                TrustedDevice.token_hash == hash_token(token), *_active(user_id, now)
            )
        )
    ).scalar_one_or_none()


async def list_trusted_devices(
    db: AsyncSession, user_id: int, *, now: datetime | None = None
) -> list[TrustedDevice]:
    """Действующие доверенные устройства пользователя, новые сверху."""
    now = now or utcnow()
    rows = await db.execute(
        select(TrustedDevice)
        .where(*_active(user_id, now))
        .order_by(TrustedDevice.created_at.desc(), TrustedDevice.id.desc())
    )
    return list(rows.scalars())


async def revoke_trusted_device(
    db: AsyncSession, device_id: int, *, user_id: int, now: datetime | None = None
) -> bool:
    """Отзывает устройство пользователя. False — нет такого действующего устройства
    у этого пользователя (чужое тоже False: ответ 404)."""
    result = await db.execute(
        update(TrustedDevice)
        .where(
            TrustedDevice.id == device_id,
            TrustedDevice.user_id == user_id,
            TrustedDevice.revoked_at.is_(None),
        )
        .values(revoked_at=now or utcnow())
    )
    return bool(getattr(result, "rowcount", 0))


async def revoke_user_devices(
    db: AsyncSession, user_id: int, *, now: datetime | None = None
) -> int:
    """Отзывает все доверенные устройства пользователя (сброс пароля)."""
    result = await db.execute(
        update(TrustedDevice)
        .where(TrustedDevice.user_id == user_id, TrustedDevice.revoked_at.is_(None))
        .values(revoked_at=now or utcnow())
    )
    return int(getattr(result, "rowcount", 0))
