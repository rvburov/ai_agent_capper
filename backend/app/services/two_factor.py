"""Одноразовость кодов 2FA: код TOTP и резервный код срабатывают ровно один раз.

Проверка и отметка делаются одним условным UPDATE. Схема «прочитать totp_last_step,
проверить, записать» пропускает один и тот же код в двух параллельных запросах: оба
читают старое значение. При условном UPDATE второй запрос ждет фиксации первого
и получает 0 строк.

    step = verify_totp(secret, code, last_step=user.totp_last_step)
    if step is None or not await consume_totp_step(db, user.id, step): -> invalid_code

Функции не делают commit: его делает сервис входа вместе с остальными изменениями.
"""

from datetime import datetime

from sqlalchemy import or_, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RecoveryCode, User
from app.services.sessions import utcnow


async def consume_totp_step(db: AsyncSession, user_id: int, step: int) -> bool:
    """Записывает шаг принятого кода в users.totp_last_step. False — код этого или более
    позднего шага уже принят другим запросом: ответ invalid_code."""
    result = await db.execute(
        update(User)
        .where(
            User.id == user_id,
            or_(User.totp_last_step.is_(None), User.totp_last_step < step),
        )
        .values(totp_last_step=step)
        .returning(User.id)
    )
    return result.scalar_one_or_none() is not None


async def consume_recovery_code(
    db: AsyncSession, user_id: int, code_hash: str, *, now: datetime | None = None
) -> bool:
    """Помечает резервный код использованным. False — такого кода нет или он уже
    использован (в том числе параллельным запросом): ответ invalid_code."""
    result = await db.execute(
        update(RecoveryCode)
        .where(
            RecoveryCode.user_id == user_id,
            RecoveryCode.code_hash == code_hash,
            RecoveryCode.used_at.is_(None),
        )
        .values(used_at=now or utcnow())
        .returning(RecoveryCode.id)
    )
    return len(result.all()) > 0
