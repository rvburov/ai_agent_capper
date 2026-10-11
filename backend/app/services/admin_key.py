"""Ключ Claude API администратора (app_settings.anthropic_key_enc).

Ключ хранится только зашифрованным (AES-256-GCM, aad app_settings.anthropic_key:1),
наружу показываются последние 4 символа. Проверка ключа и расшифровка перед вызовом —
в app/services/claude_key.py (общие для ключа администратора и своих ключей участников).
Ключ не пишется ни в логи, ни в журнал действий.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import crypto
from app.db.models import AppSettings, User
from app.services.audit import write_audit
from app.services.claude_key import (
    CHECK_TIMEOUT_SECONDS,
    KeyCheck,
    check_anthropic_key,
    looks_like_key,
)
from app.services.sessions import utcnow

__all__ = [
    "CHECK_TIMEOUT_SECONDS",
    "KeyCheck",
    "check_anthropic_key",
    "looks_like_key",
    "save_admin_key",
]


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
