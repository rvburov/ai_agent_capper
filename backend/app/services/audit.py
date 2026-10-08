"""Журнал действий администратора и команд терминала (admin_audit_log).

Пишут кабинет администратора, команды терминала и импорт. В details — подробности
действия для журнала (email, роль, срок кода), но никогда не пароли, коды, ключи и токены.
Функция делает flush(), commit — за сервисом, который выполняет действие целиком:
запись в журнал и само действие фиксируются одной транзакцией.
"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AdminAuditLog
from app.db.models.admin import AUDIT_ACTIONS

TERMINAL = "terminal"


async def write_audit(
    db: AsyncSession,
    *,
    action: str,
    actor_id: int | None,
    target_user_id: int | None = None,
    details: dict[str, Any] | None = None,
    ip: str | None = None,
) -> AdminAuditLog:
    """Добавляет запись в журнал. actor_id=None — действие из терминала:
    тогда в details сам ставится source=terminal."""
    if action not in AUDIT_ACTIONS:
        raise ValueError(f"неизвестное действие журнала: {action}")
    data = dict(details or {})
    if actor_id is None:
        data.setdefault("source", TERMINAL)
    entry = AdminAuditLog(
        action=action,
        actor_id=actor_id,
        target_user_id=target_user_id,
        details=data,
        ip=ip,
    )
    db.add(entry)
    await db.flush()
    return entry
