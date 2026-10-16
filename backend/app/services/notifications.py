"""Уведомления в центре уведомлений (колокольчик) — Р3.

Текст берется из локали по виду уведомления: notifications.<kind>.title и .body.
У вида может быть несколько текстов (variant): notifications.<kind>.<variant>.title и .body.
В строке сохраняется и готовый текст, и params (с variant), чтобы потом показать его
на другом языке.
Функция делает flush(), commit — за сервисом, который выполняет действие целиком.

Человек сам выбирает, что присылать (app/services/notification_prefs.py): вид, выключенный
на сайте, в колокольчик не записывается, notify возвращает None. Обязательные виды (вход с
нового устройства, неудачные попытки входа, сообщение администратора) на сайте приходят
всегда.

Push (этап 6): тот же путь для всех видов. Если вид разрешен в push, у человека есть
активная подписка и на сервере есть ключи VAPID, notify готовит текст push (свои ключи
push.<вид>, без сумм — В1) и ставит задачу воркера send_push после commit транзакции
(app/services/push.py). Push уходит и тогда, когда вид выключен на сайте. push=False —
не слать push (сообщение администратора без флажка «Также push»).
"""

from collections.abc import Mapping
from typing import Any, cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.i18n import t
from app.db.models import Notification
from app.db.models.auth import NOTIFICATION_KINDS
from app.schemas.me import NotificationOut, NotificationOutcome
from app.services import push as push_service
from app.services.notification_prefs import has_push, kind_prefs

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
    None — человек выключил этот вид на сайте, в колокольчике уведомления нет (push при
    этом может уйти)."""
    return await create(db, user_id=user_id, kind=kind, variant=variant, link=link, params=params)


async def create(
    db: AsyncSession,
    *,
    user_id: int,
    kind: str,
    params: Mapping[str, Any],
    variant: str | None = None,
    link: str | None = None,
    push: bool = True,
) -> Notification | None:
    """То же, что notify, с выбором push: push=False — только на сайт."""
    if kind not in NOTIFICATION_KINDS:
        raise ValueError(f"неизвестный вид уведомления: {kind}")
    on_site, push_on = await kind_prefs(db, user_id, kind)
    send_push = push and push_on and get_settings().push_enabled
    if send_push:
        send_push = await has_push(db, user_id)
    if not on_site and not send_push:
        return None
    clean = {key: str(value) for key, value in params.items()}
    note: Notification | None = None
    if on_site:
        text_key = f"notifications.{kind}"
        stored = dict(clean)
        if variant is not None:
            stored["variant"] = variant
            text_key = f"{text_key}.{variant}"
        note = Notification(
            user_id=user_id,
            kind=kind,
            title=t(f"{text_key}.title", **stored),
            body=t(f"{text_key}.body", **stored),
            params=stored,
            link=link,
        )
        db.add(note)
        await db.flush()
    if send_push:
        message = push_service.build_message(
            user_id=user_id,
            kind=kind,
            variant=variant,
            params=clean,
            link=link,
            ref=str(note.id) if note is not None else None,
        )
        push_service.schedule(db, message)
    return note


def notification_out(note: Notification) -> NotificationOut:
    """Уведомление для центра уведомлений: у «Ставка рассчитана» — исход из params
    (выигрыш, проигрыш, возврат) для цвета значка; чужого в нем нет — только своя ставка."""
    status = (note.params or {}).get("status") if note.kind == "bet_settled" else None
    outcome = cast(NotificationOutcome, status) if status in OUTCOMES else None
    return NotificationOut.model_validate(note).model_copy(update={"outcome": outcome})
