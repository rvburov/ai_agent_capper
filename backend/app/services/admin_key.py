"""Ключ Claude API администратора (app_settings.anthropic_key_enc).

Ключ хранится только зашифрованным (AES-256-GCM, aad app_settings.anthropic_key:1),
наружу показываются последние 4 символа. Проверка ключа — легкий запрос списка моделей:
он ничего не стоит и отвечает 401, если ключ неверный или отозван.
Ключ не пишется ни в логи, ни в журнал действий.
"""

import re
from dataclasses import dataclass
from typing import Literal

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import crypto
from app.db.models import AppSettings, User
from app.services.audit import write_audit
from app.services.sessions import utcnow

_KEY_FORMAT = re.compile(r"^sk-ant-[A-Za-z0-9_-]{16,}$")
CHECK_TIMEOUT_SECONDS = 15.0


def looks_like_key(key: str) -> bool:
    """Ключ Claude API начинается с sk-ant- и длиннее 20 символов."""
    return bool(_KEY_FORMAT.match(key))


@dataclass(frozen=True)
class KeyCheck:
    """Итог проверки: ok, rejected (401/403), unavailable (сеть) или error (иной ответ)."""

    result: Literal["ok", "rejected", "unavailable", "error"]
    status_code: int | None = None


async def check_anthropic_key(
    key: str, *, http_client: anthropic.DefaultAsyncHttpxClient | None = None
) -> KeyCheck:
    """Проверяет ключ запросом models.list(limit=1). http_client — для тестов."""
    try:
        async with anthropic.AsyncAnthropic(
            api_key=key,
            max_retries=1,
            timeout=CHECK_TIMEOUT_SECONDS,
            http_client=http_client,
        ) as client:
            await client.models.list(limit=1)
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
        return KeyCheck("rejected", exc.status_code)
    except anthropic.APIStatusError as exc:
        return KeyCheck("error", exc.status_code)
    except anthropic.APIConnectionError:
        return KeyCheck("unavailable")
    return KeyCheck("ok")


async def save_admin_key(
    db: AsyncSession, key: str, *, verified: bool, actor: User | None, ip: str | None
) -> str:
    """Сохраняет ключ зашифрованным и пишет журнал key_change. Возвращает последние
    4 символа. verified — ключ прошел проверочный запрос (иначе дата проверки пустая)."""
    row = await db.scalar(select(AppSettings).where(AppSettings.id == 1).with_for_update())
    if row is None:
        raise AppError(500, "admin.settings_missing")
    ciphertext, version = crypto.encrypt_str(key, crypto.aad_for(crypto.AAD_ADMIN_KEY, 1))
    now = utcnow()
    last4 = key[-4:]
    row.anthropic_key_enc = ciphertext
    row.key_version = version
    row.key_last4 = last4
    row.key_verified_at = now if verified else None
    row.updated_by = actor.id if actor is not None else None
    row.updated_at = now
    await write_audit(
        db,
        action="key_change",
        actor_id=actor.id if actor is not None else None,
        details={"last4": last4, "verified": verified},
        ip=ip,
    )
    await db.commit()
    return last4
