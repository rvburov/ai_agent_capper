"""Задачи воркера arq.

Задача получает ctx от arq: в нем фабрика сеансов БД (ctx["sessionmaker"]), ее создает
startup в app.workers.main. Логика задачи — отдельной функцией от AsyncSession, чтобы
тесты вызывали ее без воркера.

Ночная очистка (cleanup_auth_records) удаляет то, что больше не нужно ни для входа,
ни для истории:
- сеансы, которые уже не пускают в приложение: отозванные, с прошедшим абсолютным
  сроком или без активности дольше session_idle_days (те же условия, что у
  services.sessions.get_active_session, только наоборот);
- доверенные устройства, отозванные или с прошедшим сроком;
- журнал входов старше 90 дней (PLAN.md, раздел 7: срок хранения журналов входов).
Коды приглашений и сброса не трогаем, даже истекшие: это история действий
администратора, на них ссылается кабинет («использован», «истек», «отозван»).
"""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from sqlalchemy import delete, or_
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.db.models import LoginEvent, TrustedDevice, UserSession

log = structlog.get_logger(__name__)

LOGIN_EVENTS_RETENTION = timedelta(days=90)


@dataclass(frozen=True)
class CleanupResult:
    """Сколько строк удалено."""

    sessions: int
    trusted_devices: int
    login_events: int


def _rowcount(result: Any) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


async def purge_dead_sessions(db: AsyncSession, *, now: datetime) -> int:
    """Удаляет сеансы, которые уже не пускают в приложение. Только flush."""
    idle_since = now - timedelta(days=get_settings().session_idle_days)
    result = await db.execute(
        delete(UserSession).where(
            or_(
                UserSession.revoked_at.is_not(None),
                UserSession.expires_at <= now,
                UserSession.last_seen_at <= idle_since,
            )
        )
    )
    return _rowcount(result)


async def purge_dead_trusted_devices(db: AsyncSession, *, now: datetime) -> int:
    """Удаляет отозванные и истекшие доверенные устройства. Только flush."""
    result = await db.execute(
        delete(TrustedDevice).where(
            or_(TrustedDevice.revoked_at.is_not(None), TrustedDevice.expires_at <= now)
        )
    )
    return _rowcount(result)


async def purge_old_login_events(db: AsyncSession, *, now: datetime) -> int:
    """Удаляет записи журнала входов старше 90 дней. Только flush."""
    result = await db.execute(
        delete(LoginEvent).where(LoginEvent.at < now - LOGIN_EVENTS_RETENTION)
    )
    return _rowcount(result)


async def cleanup_auth_data(db: AsyncSession, *, now: datetime | None = None) -> CleanupResult:
    """Вся ночная очистка одной транзакцией. Делает commit."""
    now = now or datetime.now(UTC)
    result = CleanupResult(
        sessions=await purge_dead_sessions(db, now=now),
        trusted_devices=await purge_dead_trusted_devices(db, now=now),
        login_events=await purge_old_login_events(db, now=now),
    )
    await db.commit()
    return result


async def cleanup_auth_records(ctx: dict[Any, Any]) -> dict[str, int]:
    """Задача arq (cron раз в сутки, см. app.workers.main). Возвращает число удаленных
    строк по таблицам: оно попадает в лог воркера."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        result = await cleanup_auth_data(db)
    counts = asdict(result)
    log.info("worker.cleanup_auth_records", **counts)
    return counts
