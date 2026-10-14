"""Личный кабинет вошедшего пользователя: смена пароля, сеансы и доверенные устройства,
журнал входов, резервные коды, уведомления, удаление аккаунта самим участником (В10).

Удаление: запрос с паролем и кодом 2FA, через 7 дней аккаунт удаляется задачей воркера
(delete_due_accounts) так же, как удаляет администратор (Р15). Пока запрос действует,
вход возможен, но открыты только GET /api/me и отмена (app/core/deps.py).

Каждая функция работает только с данными переданного пользователя: чужой id ведет
себя как несуществующий (404). Функции, которые меняют данные, сами делают commit.
"""

from collections.abc import Sequence
from dataclasses import dataclass
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
from app.db.models import (
    ACCOUNT_DELETION_DELAY,
    Analysis,
    LoginEvent,
    Notification,
    User,
    UserSession,
)
from app.services import analytics_cache, devices, sessions
from app.services.access_codes import lock_admin_actions
from app.services.admin_users import erase_account, other_active_admins
from app.services.audit import write_audit
from app.services.auth import (
    ClientInfo,
    check_totp,
    issue_recovery_codes,
    notify_failures,
    notify_pair_lock,
    notify_two_factor_lock,
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


# --- удаление аккаунта самим участником (В10) ---

DELETION_DELAY = ACCOUNT_DELETION_DELAY


@dataclass(frozen=True)
class DeletionRequest:
    requested_at: datetime
    delete_at: datetime


async def _check_password(
    db: AsyncSession, redis: Redis, user: User, password: str, client: ClientInfo
) -> None:
    """Пароль — с тем же лимитом попыток пары (email, IP), что вход и смена пароля."""
    attempt = await ratelimit.begin_attempt(redis, user.email, client.ip)
    if attempt.retry_after:
        raise AppError(429, "common.rate_limited", retry_after=attempt.retry_after)
    if not await verify_password_async(user.password_hash, password):
        result = await ratelimit.register_failure(redis, user.email, client.ip, attempt)
        if result.just_locked:
            await notify_pair_lock(db, redis, user, client.ip)
            await db.commit()
        raise AppError(400, "auth.current_password_invalid")
    await ratelimit.release_attempt(redis, user.email, client.ip)


async def _check_code(
    db: AsyncSession, redis: Redis, user: User, code: str, client: ClientInfo
) -> None:
    """Код 2FA — с тем же лимитом аккаунта, что шаг 2FA при входе (10 неверных за час)."""
    account = await ratelimit.begin_2fa_attempt(redis, user.email)
    if account.retry_after:
        raise AppError(429, "auth.two_factor_locked", retry_after=account.retry_after)
    if not await check_totp(db, user, code):
        result = await ratelimit.register_2fa_failure(redis, user.email, account)
        if result.just_locked:
            await notify_two_factor_lock(db, redis, user, client.ip)
        await db.commit()
        raise AppError(400, "auth.invalid_code")
    await ratelimit.release_2fa_attempt(redis, user.email)


async def request_deletion(
    db: AsyncSession,
    redis: Redis,
    *,
    user: User,
    password: str,
    code: str,
    client: ClientInfo,
) -> DeletionRequest:
    """Запрос на удаление своего аккаунта: пароль и код 2FA, удаление через 7 дней.
    Все сеансы завершаются (вход снова — только для отмены), черновики и анализы в работе
    отменяются. Единственный действующий администратор удалить себя не может (409
    account.last_admin). Делает commit."""
    if user.deletion_requested_at is not None:
        raise AppError(409, "account.deletion_pending_already")
    await lock_admin_actions(db)
    if user.role == "admin" and not await other_active_admins(db, user.id):
        raise AppError(409, "account.last_admin")
    await _check_password(db, redis, user, password, client)
    await _check_code(db, redis, user, code, client)
    now = sessions.utcnow()
    locked = await db.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked is None or locked.deletion_requested_at is not None:
        raise AppError(409, "account.deletion_pending_already")
    locked.deletion_requested_at = now
    await sessions.revoke_user_sessions(db, user.id, now=now)
    await db.commit()
    await _cancel_open_analyses(db, redis, locked)
    log.info("account.deletion_requested", user_id=user.id)
    return DeletionRequest(requested_at=now, delete_at=now + DELETION_DELAY)


async def _cancel_open_analyses(db: AsyncSession, redis: Redis, user: User) -> None:
    """Черновики и анализы в работе — отменены, резерв бюджета снят."""
    from app.services import analyses  # анализы тянут клиент Claude: только по делу

    ids = list(
        await db.scalars(
            select(Analysis.id).where(
                Analysis.user_id == user.id, Analysis.status.in_(analyses.CANCELLABLE)
            )
        )
    )
    for analysis_id in ids:
        try:
            await analyses.cancel(db, redis, user, analysis_id)
        except AppError:
            # Анализ успел закончиться сам
            await db.rollback()


async def cancel_deletion(db: AsyncSession, user: User) -> None:
    """Отмена запроса на удаление (в течение 7 дней). Запроса нет — 409. Делает commit."""
    locked = await db.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked is None or locked.deletion_requested_at is None:
        raise AppError(409, "account.no_deletion")
    locked.deletion_requested_at = None
    await db.commit()
    log.info("account.deletion_cancelled", user_id=user.id)


async def delete_due_accounts(
    db: AsyncSession, redis: Redis, *, now: datetime | None = None
) -> list[int]:
    """Удаляет аккаунты, у которых запрос на удаление старше 7 дней (задача воркера раз в
    сутки): личные данные — как при удалении администратором (Р15), кэш аналитики —
    тоже. Запись в журнале — без имени и email. Единственный действующий администратор
    не удаляется (запрос остается, в лог — предупреждение). Возвращает id удаленных."""
    now = now or sessions.utcnow()
    due = list(
        await db.scalars(
            select(User.id)
            .where(
                User.deletion_requested_at.is_not(None),
                User.deletion_requested_at <= now - DELETION_DELAY,
                User.status != "deleted",
            )
            .order_by(User.id)
        )
    )
    done: list[int] = []
    for user_id in due:
        await lock_admin_actions(db)
        user = await db.scalar(
            select(User)
            .where(User.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if user is None or user.deletion_requested_at is None or user.status == "deleted":
            await db.rollback()
            continue
        active_admin = user.role == "admin" and user.status == "active"
        if active_admin and not await other_active_admins(db, user.id):
            await db.rollback()
            log.warning("account.deletion_last_admin", user_id=user_id)
            continue
        await erase_account(db, user, now=now)
        await write_audit(
            db,
            action="delete",
            actor_id=user_id,
            target_user_id=user_id,
            details={"self": True},
        )
        await db.commit()
        await analytics_cache.clear_user(redis, user_id)
        done.append(user_id)
        log.info("account.deleted_by_request", user_id=user_id)
    return done
