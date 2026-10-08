"""Личный кабинет вошедшего пользователя: смена пароля, сеансы и доверенные устройства,
журнал входов, резервные коды, уведомления.

Каждая функция работает только с данными переданного пользователя: чужой id ведет
себя как несуществующий (404). Функции, которые меняют данные, сами делают commit.
"""

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import NoReturn

import structlog
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import ratelimit
from app.core.errors import AppError
from app.core.i18n import t
from app.core.redis import redis_key
from app.core.security.passwords import (
    check_new_password,
    hash_password_async,
    verify_password_async,
)
from app.core.useragent import device_label
from app.db.models import LoginEvent, Notification, User, UserSession
from app.services import devices, sessions
from app.services.auth import (
    ClientInfo,
    check_totp,
    issue_recovery_codes,
    notify_failures,
    notify_pair_lock,
)

log = structlog.get_logger(__name__)

LOGIN_EVENTS_DAYS = 90
MAX_LIST_LIMIT = 200
# Перевыпуск резервных кодов: не больше 5 неверных кодов 2FA на сеанс за час, затем
# сеанс завершается. Счетчик свой, по id сеанса, а не общий счетчик 2FA аккаунта:
# иначе тот, у кого есть только cookie сеанса, закрывал бы владельцу шаг 2FA при входе
REISSUE_MAX_FAILURES = 5
REISSUE_WINDOW_SECONDS = 60 * 60


async def change_password(
    db: AsyncSession,
    redis: Redis,
    *,
    user: User,
    current_password: str,
    new_password: str,
    client: ClientInfo,
) -> str:
    """Смена пароля. Все сеансы отзываются, текущий заменяется новым: возвращает токен
    нового сеанса для cookie. Неверный текущий пароль считается неудачной попыткой
    пары (email, IP), как при входе: украденный сеанс не поможет подобрать пароль."""
    attempt = await ratelimit.begin_attempt(redis, user.email, client.ip)
    if attempt.retry_after:
        raise AppError(429, "common.rate_limited", retry_after=attempt.retry_after)
    if not await verify_password_async(user.password_hash, current_password):
        result = await ratelimit.register_failure(redis, user.email, client.ip, attempt)
        if result.just_locked:
            await notify_pair_lock(db, redis, user, client.ip)
            await db.commit()
        raise AppError(400, "auth.current_password_invalid")
    await ratelimit.release_attempt(redis, user.email, client.ip)
    await check_new_password(new_password)
    user.password_hash = await hash_password_async(new_password)
    now = sessions.utcnow()
    await sessions.revoke_user_sessions(db, user.id, now=now)
    new = await sessions.create_session(
        db, user_id=user.id, ip=client.ip, user_agent=client.user_agent, now=now
    )
    await db.commit()
    return new.token


# --- сеансы и доверенные устройства ---


async def list_sessions(db: AsyncSession, user_id: int) -> list[UserSession]:
    return await sessions.list_active_sessions(db, user_id)


async def end_session(db: AsyncSession, *, user_id: int, session_id: int) -> None:
    """Завершает свой сеанс. Чужой или уже завершенный — 404."""
    if not await sessions.revoke_session(db, session_id, user_id=user_id):
        raise AppError(404, "common.not_found")
    await db.commit()


async def end_other_sessions(db: AsyncSession, *, user_id: int, current_session_id: int) -> int:
    """«Выйти на всех других устройствах»: остается только текущий сеанс."""
    count = await sessions.revoke_user_sessions(db, user_id, except_session_id=current_session_id)
    await db.commit()
    return count


async def forget_device(db: AsyncSession, *, user_id: int, device_id: int) -> None:
    """Отзывает доверенное устройство: на нем снова будут спрашивать код 2FA."""
    if not await devices.revoke_trusted_device(db, device_id, user_id=user_id):
        raise AppError(404, "common.not_found")
    await db.commit()


# --- журнал входов ---


async def list_login_events(
    db: AsyncSession,
    user_id: int,
    *,
    limit: int,
    results: Sequence[str] | None = None,
    now: datetime | None = None,
) -> Sequence[LoginEvent]:
    """Попытки входа пользователя за 90 дней, новые сверху. results — только с таким
    результатом (None — все)."""
    since = (now or sessions.utcnow()) - timedelta(days=LOGIN_EVENTS_DAYS)
    stmt = select(LoginEvent).where(LoginEvent.user_id == user_id, LoginEvent.at > since)
    if results:
        stmt = stmt.where(LoginEvent.result.in_(results))
    rows = await db.execute(
        stmt.order_by(LoginEvent.at.desc(), LoginEvent.id.desc()).limit(min(limit, MAX_LIST_LIMIT))
    )
    return rows.scalars().all()


# --- резервные коды ---


def _reissue_key(session_id: int) -> str:
    return redis_key("rl", "reissue", "fail", session_id)


async def _begin_reissue_attempt(redis: Redis, session_id: int) -> int:
    """Номер попытки сеанса в окне. Резервируется до проверки кода: параллельные
    запросы не проверят больше REISSUE_MAX_FAILURES кодов."""
    key = _reissue_key(session_id)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, REISSUE_WINDOW_SECONDS, nx=True)
        return int((await pipe.execute())[0])


async def _end_session_after_failures(db: AsyncSession, *, user: User, session_id: int) -> NoReturn:
    await sessions.revoke_session(db, session_id, user_id=user.id)
    await db.commit()
    log.warning("account.reissue_session_ended", user_id=user.id, session_id=session_id)
    raise AppError(401, "auth.too_many_codes")


async def reissue_recovery_codes(
    db: AsyncSession,
    redis: Redis,
    *,
    user: User,
    session_id: int,
    code: str,
    client: ClientInfo,
) -> list[str]:
    """Новые 8 резервных кодов по текущему коду 2FA; прежние перестают действовать.
    Пятый неверный код подряд завершает этот сеанс, владельцу — уведомление. Вход
    владельца это не закрывает: счетчик у каждого сеанса свой."""
    attempt = await _begin_reissue_attempt(redis, session_id)
    if attempt > REISSUE_MAX_FAILURES:
        # Лимит исчерпан параллельными запросами: код не проверяется
        await _end_session_after_failures(db, user=user, session_id=session_id)
    if not await check_totp(db, user, code):
        if attempt < REISSUE_MAX_FAILURES:
            raise AppError(400, "auth.invalid_code")
        await notify_failures(
            db,
            user_id=user.id,
            reason="recovery_codes",
            ip=client.ip,
            device=device_label(client.user_agent) or t("devices.unknown"),
            count=REISSUE_MAX_FAILURES,
        )
        await _end_session_after_failures(db, user=user, session_id=session_id)
    await redis.delete(_reissue_key(session_id))
    codes = await issue_recovery_codes(db, user.id)
    await db.commit()
    return codes


# --- уведомления ---


async def list_notifications(
    db: AsyncSession, user_id: int, *, limit: int
) -> tuple[Sequence[Notification], int]:
    """Последние уведомления и общее число непрочитанных."""
    rows = await db.execute(
        select(Notification)
        .where(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(min(limit, MAX_LIST_LIMIT))
    )
    unread = await db.execute(
        select(func.count())
        .select_from(Notification)
        .where(Notification.user_id == user_id, Notification.read_at.is_(None))
    )
    return rows.scalars().all(), int(unread.scalar_one())


async def mark_notification_read(db: AsyncSession, *, user_id: int, notification_id: int) -> None:
    note = (
        await db.execute(
            select(Notification).where(
                Notification.id == notification_id, Notification.user_id == user_id
            )
        )
    ).scalar_one_or_none()
    if note is None:
        raise AppError(404, "common.not_found")
    if note.read_at is None:
        note.read_at = sessions.utcnow()
        await db.commit()


async def mark_all_notifications_read(db: AsyncSession, *, user_id: int) -> None:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id, Notification.read_at.is_(None))
        .values(read_at=sessions.utcnow())
    )
    await db.commit()
