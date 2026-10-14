"""Сообщение участникам из «Администрирование → Сообщение» (В14): короткое уведомление
admin_message всем или одному участнику.

Получатели — активные пользователи (не заблокированные и не удаленные), кроме самого
отправителя. Сообщение администратора приходит всегда: выключить его в настройках нельзя.
Отправленные — те же записи message, что в журнале администратора: текст, кому, сколько
получили. Push появится на этапе 6 и будет читать те же уведомления.
"""

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.errors import AppError
from app.db.models import AdminAuditLog, User
from app.schemas.admin_settings import MessageOut, MessagesOut
from app.services.access_codes import person_name
from app.services.audit import write_audit
from app.services.notifications import notify
from app.services.sessions import utcnow

HISTORY_LIMIT = 50


async def _recipients(db: AsyncSession, actor: User, user_id: int | None) -> Sequence[User]:
    stmt = select(User).where(User.status == "active", User.id != actor.id).order_by(User.id)
    if user_id is not None:
        stmt = stmt.where(User.id == user_id)
    return list(await db.scalars(stmt))


async def send(
    db: AsyncSession,
    *,
    text: str,
    user_id: int | None,
    actor: User,
    preview: bool,
    ip: str | None,
) -> MessageOut:
    """Отправить сообщение (или только показать, кому уйдет, preview). Одному — только
    активному участнику, не себе (иначе 404 admin.message_recipient); всем — если
    получателей нет, 409 admin.message_no_recipients. Делает commit."""
    people = await _recipients(db, actor, user_id)
    if user_id is not None and not people:
        raise AppError(404, "admin.message_recipient")
    if not people:
        raise AppError(409, "admin.message_no_recipients")
    recipient_name = people[0].display_name if user_id is not None else None
    if preview:
        return MessageOut(
            id=None,
            sent=False,
            at=utcnow(),
            text=text,
            user_id=user_id,
            recipient_name=recipient_name,
            recipients=len(people),
            actor_name=actor.display_name,
        )
    for person in people:
        await notify(db, user_id=person.id, kind="admin_message", text=text)
    entry = await write_audit(
        db,
        action="message",
        actor_id=actor.id,
        target_user_id=user_id,
        details={
            "text": text,
            "to": "one" if user_id is not None else "all",
            "recipients": len(people),
        },
        ip=ip,
    )
    await db.commit()
    return MessageOut(
        id=entry.id,
        sent=True,
        at=entry.at,
        text=text,
        user_id=user_id,
        recipient_name=recipient_name,
        recipients=len(people),
        actor_name=actor.display_name,
    )


async def history(db: AsyncSession, *, limit: int = HISTORY_LIMIT) -> MessagesOut:
    """Отправленные сообщения, новые сверху (записи message журнала)."""
    actor = aliased(User)
    target = aliased(User)
    rows = (
        await db.execute(
            select(
                AdminAuditLog,
                actor.display_name,
                actor.status,
                target.display_name,
                target.status,
            )
            .outerjoin(actor, actor.id == AdminAuditLog.actor_id)
            .outerjoin(target, target.id == AdminAuditLog.target_user_id)
            .where(AdminAuditLog.action == "message")
            .order_by(AdminAuditLog.id.desc())
            .limit(limit)
        )
    ).all()
    items: list[MessageOut] = []
    for entry, actor_name, actor_status, target_name, target_status in rows:
        details = entry.details or {}
        items.append(
            MessageOut(
                id=entry.id,
                sent=True,
                at=entry.at,
                text=str(details.get("text", "")),
                user_id=entry.target_user_id,
                recipient_name=(
                    person_name(entry.target_user_id, target_name, target_status) or None
                    if entry.target_user_id is not None
                    else None
                ),
                recipients=int(details.get("recipients", 0)),
                actor_name=person_name(entry.actor_id, actor_name, actor_status) or None,
            )
        )
    return MessagesOut(items=items)
