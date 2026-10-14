"""Профиль вошедшего пользователя: имя, часовой пояс и согласие на обезличенные прогнозы
(Р15), состояние резервных кодов 2FA.

Email, роль, статус и режим ключа здесь не меняются: email — логин, остальное решает
администратор. Функции, которые меняют данные, сами делают commit.
"""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RecoveryCode, User


async def update_profile(
    db: AsyncSession,
    user: User,
    *,
    display_name: str | None,
    tz: str | None,
    consent_training: bool | None = None,
) -> User:
    """Меняет переданные поля; None — поле не трогаем. Значения уже проверены схемой."""
    changed = False
    if consent_training is not None and consent_training != user.consent_training:
        user.consent_training = consent_training
        changed = True
    if display_name is not None and display_name != user.display_name:
        user.display_name = display_name
        changed = True
    if tz is not None and tz != user.tz:
        from app.services.play_limits import keep_day

        # Сутки лимитов ответственной игры досчитываются по прежнему поясу
        await keep_day(db, user)
        user.tz = tz
        changed = True
    if changed:
        await db.commit()
    return user


@dataclass(frozen=True, slots=True)
class RecoveryCodesStatus:
    left: int
    total: int
    created_at: datetime | None


async def recovery_codes_status(db: AsyncSession, user_id: int) -> RecoveryCodesStatus:
    """Сколько резервных кодов не использовано. Коды выпускаются пачкой по 8 и
    перевыпуском заменяются целиком, поэтому дата выпуска — у самого раннего."""
    row = (
        await db.execute(
            select(
                func.count().filter(RecoveryCode.used_at.is_(None)),
                func.count(),
                func.min(RecoveryCode.created_at),
            ).where(RecoveryCode.user_id == user_id)
        )
    ).one()
    left, total, created_at = row
    return RecoveryCodesStatus(left=int(left), total=int(total), created_at=created_at)
