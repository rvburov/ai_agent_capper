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

Ночное обновление данных (update_data) — те же шаги, что python -m app.ingest.update без
--full: текущий год архивов Сакманна и tennis-data (в январе и прошлый), привязка матчей
старого бота, пересчет Эло. После него — проверка свежести: если последняя успешная
загрузка Сакманна или tennis-data старше 3 дней, всем активным администраторам приходит
уведомление data_stale, не чаще раза в сутки каждому. Успешной считается загрузка, которая
получила хотя бы один файл. Привязку и Эло не проверяем: они считаются из уже
загруженного.

Анализ (run_analysis) и уборщик зависших анализов (reap_stuck_analyses) — тонкие
обертки над app/services/analysis_run.py; клиент Redis для прогресса — свой на задачу.

Прогрев аналитики (warm_analytics) — после расчета, сторно, закрывающего кэфа, новой
ставки и движения банка (ставит API, app/services/analytics_cache.py): аналитика без
фильтров за все время и главная за 30 дней считаются заранее и ложатся в кэш Redis; если
данные изменились, пока задача считала, она считает еще раз.
"""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from redis.asyncio import Redis
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.core.redis import create_redis
from app.db.models import LoginEvent, Notification, TrustedDevice, User, UserSession
from app.ingest.update import run_update
from app.schemas.analytics import AnalyticsFiltersIn
from app.services import analysis_run, analytics, analytics_cache, dashboard
from app.services.data_status import STALE_AFTER, is_stale, last_ok_loads
from app.services.notifications import notify

log = structlog.get_logger(__name__)

LOGIN_EVENTS_RETENTION = timedelta(days=90)
# Не чаще раза в сутки: 23 часа, чтобы ежедневный запуск, сдвинутый на секунды, не
# пропускал день
STALE_NOTIFY_EVERY = timedelta(hours=23)


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


# --- ночное обновление данных ---


def _when(value: datetime | None) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M") if value is not None else "—"


async def notify_stale_data(db: AsyncSession, *, now: datetime | None = None) -> list[int]:
    """Уведомление data_stale активным администраторам, если архив давно не загружался
    (см. docstring модуля). Возвращает id администраторов, кому оно ушло. Делает commit."""
    now = now or datetime.now(UTC)
    loads = await last_ok_loads(db)
    if not is_stale(loads, now):
        return []
    admins = (
        await db.scalars(
            select(User.id).where(User.role == "admin", User.status == "active").order_by(User.id)
        )
    ).all()
    recent = set(
        (
            await db.scalars(
                select(Notification.user_id).where(
                    Notification.kind == "data_stale",
                    Notification.created_at > now - STALE_NOTIFY_EVERY,
                )
            )
        ).all()
    )
    sent: list[int] = []
    for admin_id in admins:
        if admin_id in recent:
            continue
        await notify(
            db,
            user_id=admin_id,
            kind="data_stale",
            sackmann=_when(loads["sackmann"]),
            tennis_data=_when(loads["tennis_data"]),
            days=STALE_AFTER.days,
        )
        sent.append(admin_id)
    await db.commit()
    return sent


async def update_data(ctx: dict[Any, Any]) -> dict[str, Any]:
    """Задача arq (cron раз в сутки, час — CAPPER_DATA_UPDATE_HOUR_UTC): обновление данных
    и проверка свежести. Ошибка одного шага не останавливает остальные; итог по шагам —
    в лог воркера и в ingestion_runs."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    result = await run_update(db_factory=sessionmaker)
    for step in result.steps:
        log.info("worker.update_data_step", step=step.step, **step.as_log())
    async with sessionmaker() as db:
        notified = await notify_stale_data(db)
    summary: dict[str, Any] = {
        "ok": result.ok,
        "busy": result.busy,
        "steps": {step.step: step.status for step in result.steps},
        "data_stale_notified": len(notified),
    }
    log.info("worker.update_data", **summary)
    return summary


# --- анализы (этап 3) ---


async def run_analysis(ctx: dict[Any, Any], analysis_id: int, attempt: int | None = None) -> str:
    """Задача arq: выполнение анализа (app/services/analysis_run.py). Ключ Claude в
    аргументы не попадает: воркер расшифрует его сам перед вызовом. attempt — номер
    запуска: задача старого запуска ничего не делает. Возвращает итоговый статус."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    redis = create_redis()
    try:
        status = await analysis_run.execute(analysis_id, sessionmaker, redis, attempt=attempt)
    finally:
        await redis.aclose()
    log.info("worker.run_analysis", analysis_id=analysis_id, attempt=attempt, status=status)
    return status


async def reap_stuck_analyses(ctx: dict[Any, Any]) -> int:
    """Задача arq (cron раз в 5 минут): анализы без движения дольше 15 минут в рабочем
    статусе — failed (analysis.worker_lost), резерв снимается."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    redis = create_redis()
    try:
        reaped = await analysis_run.reap_stuck(sessionmaker, redis)
    finally:
        await redis.aclose()
    if reaped:
        log.warning("worker.reap_stuck_analyses", analyses=reaped)
    return len(reaped)


# --- прогрев аналитики (этап 4) ---


# Сколько раз прогрев считает заново, если данные менялись, пока он считал
WARM_PASSES = 3


async def warm_user_analytics(db: AsyncSession, redis: Redis, user_id: int) -> list[str]:
    """Посчитать и положить в кэш набор «без фильтров»: «Аналитику» за все время и главную
    за 30 дней. Удаленный или неизвестный участник — ничего. Возвращает, что прогрето.

    Пока задача идет, новая с тем же id не ставится (arq держит ключ задачи до конца):
    расчет следующей ставки в это время не поставил бы прогрев своей версии данных. Поэтому
    после расчета версия данных читается заново, и если она сменилась, набор считается еще
    раз (не больше WARM_PASSES раз)."""
    user = await db.get(User, user_id)
    if user is None or user.status == "deleted":
        return []
    warmed: list[str] = []
    for _ in range(WARM_PASSES):
        version = await analytics_cache.data_version(db, user)
        await analytics.analytics_json(db, redis, user, AnalyticsFiltersIn())
        await dashboard.cached_core_json(db, redis, user, dashboard.DEFAULT_PERIOD)
        warmed += ["analytics", "dashboard"]
        if await analytics_cache.data_version(db, user) == version:
            break
    return warmed


async def warm_analytics(ctx: dict[Any, Any], user_id: int) -> list[str]:
    """Задача arq: прогрев кэша аналитики участника (см. docstring модуля)."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    redis = create_redis()
    try:
        async with sessionmaker() as db:
            warmed = await warm_user_analytics(db, redis, user_id)
    finally:
        await redis.aclose()
    log.info("worker.warm_analytics", user_id=user_id, warmed=warmed)
    return warmed
