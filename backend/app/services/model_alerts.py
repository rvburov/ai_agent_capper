"""Уведомления «Обучение модели» администраторам (вид learning, повод — variant): прогон
версии закончен, кандидат проверен, перекалибровка включена или не включена, прогону не
хватает бюджета проверок. Тексты — notifications.learning.<variant> в локали."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.services.notifications import notify


async def admin_ids(db: AsyncSession) -> list[int]:
    return list(
        await db.scalars(
            select(User.id).where(User.role == "admin", User.status == "active").order_by(User.id)
        )
    )


async def notify_admins(db: AsyncSession, *, variant: str, link: str, **params: Any) -> int:
    """Уведомление всем действующим администраторам. flush. → сколько отправлено."""
    sent = 0
    for user_id in await admin_ids(db):
        note = await notify(
            db, user_id=user_id, kind="learning", variant=variant, link=link, **params
        )
        sent += note is not None
    return sent
