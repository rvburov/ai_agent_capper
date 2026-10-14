"""«Администрирование → Сообщение»: /api/admin/messages — короткое уведомление всем
участникам или одному (В14) и отправленные сообщения.

Доступ только у роли admin (require_admin на роутере).
"""

from fastapi import APIRouter, Depends, status

from app.core.deps import AdminUser, ClientIp, DbSession, require_admin
from app.schemas.admin_settings import MessageIn, MessageOut, MessagesOut
from app.services import admin_messages

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/messages")
async def list_messages(db: DbSession) -> MessagesOut:
    """Отправленные сообщения, новые сверху (не больше 50): кому, текст, когда, сколько
    получили, кто отправил."""
    return await admin_messages.history(db)


@router.post("/messages", status_code=status.HTTP_201_CREATED)
async def send_message(
    db: DbSession, admin: AdminUser, ip: ClientIp, body: MessageIn
) -> MessageOut:
    """Сообщение (1–280 знаков) всем активным участникам (user_id = null) или одному —
    в центр уведомлений; запись message в журнал. preview=true — без отправки: кому и
    сколько получат. Получателя нет — 404 admin.message_recipient."""
    return await admin_messages.send(
        db, text=body.text, user_id=body.user_id, actor=admin, preview=body.preview, ip=ip
    )
