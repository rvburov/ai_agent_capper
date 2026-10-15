"""Уведомления в центре уведомлений (колокольчик) — Р3.

Текст берется из локали по виду уведомления: notifications.<kind>.title и .body.
У вида может быть несколько текстов (variant): notifications.<kind>.<variant>.title и .body.
В строке сохраняется и готовый текст, и params (с variant), чтобы потом показать его
на другом языке.
Функция делает flush(), commit — за сервисом, который выполняет действие целиком.
Push браузера появится на этапе 6 и будет читать эти же строки.

Человек сам выбирает, что присылать (app/services/notification_prefs.py): выключенный
вид не записывается, notify возвращает None. Обязательные виды (вход с нового
устройства, неудачные попытки входа, сообщение администратора) приходят всегда.
"""

from typing import Any, cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.db.models import Notification
from app.db.models.auth import NOTIFICATION_KINDS
from app.schemas.me import NotificationOut, NotificationOutcome
from app.services.notification_prefs import is_enabled

# Исходы ставки для цвета значка «Ставка рассчитана» (params.status уведомления)
OUTCOMES = ("won", "lost", "void")


async def notify(
    db: AsyncSession,
    *,
    user_id: int,
    kind: str,
    variant: str | None = None,
    link: str | None = None,
    **params: Any,
) -> Notification | None:
    """Создает уведомление пользователю. params подставляются в текст локали;
    в params не передавать секреты — они хранятся в базе и видны в интерфейсе.
    variant — другой текст того же вида (например, другой повод login_failures).
    None — человек выключил этот вид в настройках, уведомления нет."""
    if kind not in NOTIFICATION_KINDS:
        raise ValueError(f"неизвестный вид уведомления: {kind}")
    if not await is_enabled(db, user_id, kind):
        return None
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


def notification_out(note: Notification) -> NotificationOut:
    """Уведомление для центра уведомлений: у «Ставка рассчитана» — исход из params
    (выигрыш, проигрыш, возврат) для цвета значка; чужого в нем нет — только своя ставка."""
    status = (note.params or {}).get("status") if note.kind == "bet_settled" else None
    outcome = cast(NotificationOutcome, status) if status in OUTCOMES else None
    return NotificationOut.model_validate(note).model_copy(update={"outcome": outcome})
