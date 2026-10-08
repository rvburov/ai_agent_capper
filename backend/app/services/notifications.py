"""Уведомления в центре уведомлений (колокольчик) — Р3.

Текст берется из локали по виду уведомления: notifications.<kind>.title и .body.
В строке сохраняется и готовый текст, и params, чтобы потом показать его на другом языке.
Функция делает flush(), commit — за сервисом, который выполняет действие целиком.
Push браузера появится на этапе 6 и будет читать эти же строки.
"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.db.models import Notification
from app.db.models.auth import NOTIFICATION_KINDS


async def notify(
    db: AsyncSession,
    *,
    user_id: int,
    kind: str,
    link: str | None = None,
    **params: Any,
) -> Notification:
    """Создает уведомление пользователю. params подставляются в текст локали;
    в params не передавать секреты — они хранятся в базе и видны в интерфейсе."""
    if kind not in NOTIFICATION_KINDS:
        raise ValueError(f"неизвестный вид уведомления: {kind}")
    clean = {key: str(value) for key, value in params.items()}
    note = Notification(
        user_id=user_id,
        kind=kind,
        title=t(f"notifications.{kind}.title", **clean),
        body=t(f"notifications.{kind}.body", **clean),
        params=clean,
        link=link,
    )
    db.add(note)
    await db.flush()
    return note
