"""Сеансы входа: создание, проверка, продление и отзыв.

Токен сеанса (256 бит) уходит в cookie один раз при создании, в БД — только sha256.
Сеанс действует, пока не отозван, не прошел абсолютный срок (session_absolute_days
от входа) и не было бездействия дольше session_idle_days. last_seen_at обновляется
не чаще раза в 5 минут, чтобы не писать в БД на каждый запрос.

Функции делают flush(), commit — за сервисом, который выполняет действие целиком
(вход, смена пароля, блокировка). Исключение — touch_session(): его вызывает
зависимость current_user, и он фиксирует свое изменение сам.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security.tokens import hash_token, new_token
from app.core.useragent import clip_user_agent, device_label
from app.db.models import User, UserSession

TOUCH_INTERVAL = timedelta(minutes=5)


@dataclass(frozen=True)
class NewSession:
    token: str  # значение для cookie, в БД не хранится
    session: UserSession


def utcnow() -> datetime:
    return datetime.now(UTC)


async def create_session(
    db: AsyncSession,
    *,
    user_id: int,
    ip: str | None,
    user_agent: str | None,
    now: datetime | None = None,
) -> NewSession:
    """Новый сеанс после входа (токен каждый раз новый). Только flush."""
    now = now or utcnow()
    settings = get_settings()
    token = new_token()
    session = UserSession(
        id_hash=hash_token(token),
        user_id=user_id,
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(days=settings.session_absolute_days),
        ip=ip,
        user_agent=clip_user_agent(user_agent),
        device_label=device_label(user_agent),
    )
    db.add(session)
    await db.flush()
    return NewSession(token=token, session=session)


async def get_active_session(
    db: AsyncSession, token: str, *, now: datetime | None = None
) -> tuple[UserSession, User] | None:
    """Действующий сеанс по токену из cookie и его пользователь (только status = active)."""
    if not token:
        return None
    now = now or utcnow()
    idle_since = now - timedelta(days=get_settings().session_idle_days)
    row = (
        await db.execute(
            select(UserSession, User)
            .join(User, User.id == UserSession.user_id)
            .where(
                UserSession.id_hash == hash_token(token),
                UserSession.revoked_at.is_(None),
                UserSession.expires_at > now,
                UserSession.last_seen_at > idle_since,
                User.status == "active",
            )
        )
    ).first()
    if row is None:
        return None
    return row[0], row[1]


async def list_active_sessions(
    db: AsyncSession, user_id: int, *, now: datetime | None = None
) -> list[UserSession]:
    """Действующие сеансы пользователя (те же условия, что у get_active_session),
    последние по активности сверху."""
    now = now or utcnow()
    idle_since = now - timedelta(days=get_settings().session_idle_days)
    rows = await db.execute(
        select(UserSession)
        .where(
            UserSession.user_id == user_id,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > now,
            UserSession.last_seen_at > idle_since,
        )
        .order_by(UserSession.last_seen_at.desc(), UserSession.id.desc())
    )
    return list(rows.scalars())


async def revoke_session_by_token(
    db: AsyncSession, token: str | None, *, now: datetime | None = None
) -> bool:
    """Отзывает сеанс по токену из cookie (выход, повторный вход в том же браузере)."""
    if not token:
        return False
    result = await db.execute(
        update(UserSession)
        .where(UserSession.id_hash == hash_token(token), UserSession.revoked_at.is_(None))
        .values(revoked_at=now or utcnow())
    )
    return bool(getattr(result, "rowcount", 0))


async def touch_session(
    db: AsyncSession, session: UserSession, *, now: datetime | None = None
) -> bool:
    """Отмечает активность сеанса, если с прошлой отметки прошло 5 минут. Делает commit."""
    now = now or utcnow()
    if now - session.last_seen_at < TOUCH_INTERVAL:
        return False
    session.last_seen_at = now
    await db.commit()
    return True


async def revoke_session(
    db: AsyncSession,
    session_id: int,
    *,
    user_id: int | None = None,
    now: datetime | None = None,
) -> bool:
    """Отзывает один сеанс. С user_id — только если сеанс принадлежит этому пользователю."""
    stmt = (
        update(UserSession)
        .where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=now or utcnow())
    )
    if user_id is not None:
        stmt = stmt.where(UserSession.user_id == user_id)
    result = await db.execute(stmt)
    return bool(getattr(result, "rowcount", 0))


async def revoke_user_sessions(
    db: AsyncSession,
    user_id: int,
    *,
    except_session_id: int | None = None,
    now: datetime | None = None,
) -> int:
    """Отзывает все сеансы пользователя (кроме except_session_id). Возвращает их число."""
    stmt = (
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=now or utcnow())
    )
    if except_session_id is not None:
        stmt = stmt.where(UserSession.id != except_session_id)
    result = await db.execute(stmt)
    return int(getattr(result, "rowcount", 0))
