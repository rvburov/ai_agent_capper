"""Просмотр данных участника администратором (Р27): чьи данные отдает маршрут чтения и
запись просмотра в журнал администратора.

Администратор читает ставки, банк, стратегию и анализы участника теми же маршрутами, что и
сам участник, с параметром as_user (зависимости — app/core/deps.py). Только чтение: любой
запрос с as_user, кроме GET маршрутов просмотра, — 403.

Журнал: просмотр — member_view {user_id, screen}, одна запись на (администратор, участник,
экран) раз в VIEW_DEDUP_SECONDS: экран дергает несколько GET, перерисовка и обновление
страницы новых записей не дают (метка в Redis). Выгрузка CSV — member_export {user_id,
what} каждый раз. Участнику даты просмотров не показываются (В1 Р27).
"""

from dataclasses import dataclass
from typing import Any, Literal

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.redis import redis_key
from app.db.models import User
from app.services.audit import write_audit

# Экран (группа маршрутов) в записи member_view; summary — «Администрирование → Сводка»
ViewScreen = Literal[
    "dashboard", "bets", "analytics", "bank", "analyses", "learning", "ai", "summary"
]
# Что выгружено в CSV (member_export)
ExportWhat = Literal["bets", "analytics"]

VIEW_DEDUP_SECONDS = 600


@dataclass(frozen=True)
class Viewed:
    """Чьи данные отдает маршрут чтения (user) и кто их смотрит (viewer). Без as_user или
    с as_user = свой id — один и тот же человек."""

    user: User
    viewer: User
    ip: str

    @property
    def foreign(self) -> bool:
        """Администратор смотрит чужие данные."""
        return self.user.id != self.viewer.id


async def find_member(db: AsyncSession, user_id: int) -> User:
    """Участник для просмотра: любая роль и статус, кроме удаленного (404, как
    несуществующий)."""
    user = await db.get(User, user_id)
    if user is None or user.status == "deleted":
        raise AppError(404, "common.not_found")
    return user


async def log_view(
    db: AsyncSession,
    redis: Redis,
    *,
    viewer_id: int,
    user_id: int | None,
    screen: ViewScreen,
    ip: str | None,
    extra: dict[str, Any] | None = None,
) -> bool:
    """Запись member_view, если за VIEW_DEDUP_SECONDS такой еще не было. user_id None —
    просмотр по всем участникам (сводка). True — запись сделана. commit."""
    key = redis_key("member_view", viewer_id, user_id if user_id is not None else "all", screen)
    if not await redis.set(key, "1", nx=True, ex=VIEW_DEDUP_SECONDS):
        return False
    try:
        await write_audit(
            db,
            action="member_view",
            actor_id=viewer_id,
            target_user_id=user_id,
            details={"user_id": user_id, "screen": screen, **(extra or {})},
            ip=ip,
        )
        await db.commit()
    except BaseException:
        # Запись не легла — следующий запрос экрана попробует снова
        await redis.delete(key)
        raise
    return True


async def log_export(
    db: AsyncSession, viewed: Viewed, what: ExportWhat, extra: dict[str, Any] | None = None
) -> None:
    """Запись member_export о выгрузке CSV чужих данных (каждая выгрузка). Свои данные не
    пишутся. commit."""
    if not viewed.foreign:
        return
    await write_audit(
        db,
        action="member_export",
        actor_id=viewed.viewer.id,
        target_user_id=viewed.user.id,
        details={"user_id": viewed.user.id, "what": what, **(extra or {})},
        ip=viewed.ip,
    )
    await db.commit()
