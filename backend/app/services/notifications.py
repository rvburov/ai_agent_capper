"""Уведомления в центре уведомлений (колокольчик) — Р3.

Текст берется из локали по виду уведомления: notifications.<kind>.title и .body.
У вида может быть несколько текстов (variant): notifications.<kind>.<variant>.title и .body.
В строке сохраняется и готовый текст, и params (с variant), чтобы потом показать его
на другом языке.
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
    variant: str | None = None,
    link: str | None = None,
    **params: Any,
) -> Notification:
    """Создает уведомление пользователю. params подставляются в текст локали;
    в params не передавать секреты — они хранятся в базе и видны в интерфейсе.
    variant — другой текст того же вида (например, другой повод login_failures)."""
    if kind not in NOTIFICATION_KINDS:
        raise ValueError(f"неизвестный вид уведомления: {kind}")
    clean = {key: str(value) for key, value in params.items()}
    text_key = f"notifications.{kind}"
    if variant is not None:
        clean["variant"] = variant
        text_key = f"{text_key}.{variant}"
    note = Notification(
        user_id=user_id,
        kind=kind,
        title=t(f"{text_key}.title", **clean),
        body=t(f"{text_key}.body", **clean),
        params=clean,
        link=link,
    )
    db.add(note)
    await db.flush()
    return note
