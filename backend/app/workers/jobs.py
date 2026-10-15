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

Удаление аккаунтов по запросу участников (delete_requested_accounts, раз в сутки):
аккаунты, у которых запрос на удаление старше 7 дней, удаляются как при удалении
администратором (app/services/account.py, delete_due_accounts).

Сигналы расхода ИИ (check_ai_alerts, раз в час): правила TOKEN_ECONOMY.md, раздел 6, —
администраторам уведомление ai_alert, одно на правило в сутки (app/services/ai_alerts.py).

Этап 5. Ночное обновление заканчивается расчетом по архиву (шаг settle: привязка матчей из
анализов, закрытие из архива, авторасчет). Файл tennis-data, загруженный на сайте,
обрабатывает process_data_upload (app/services/data_uploads.py): если идет другое
обновление, задача повторится через BUSY_RETRY_SECONDS. Раз в час remind_unsettled:
участникам — «ставка ждет результата» (матчи прошли 3 дня назад, исхода нет; одно на
ставку), администраторам в понедельник в 07:00 по их поясу — «пора загрузить файл
tennis-data», если его не загружали больше 7 дней (одно в сутки; время последней загрузки
и год файла — по поясу администратора), и уборка загрузок файла, которые уже никто не
доделает (data_uploads.reap_stuck_uploads).

Этап 5, волна 2 — разборы и уроки. submit_postmortems (каждые 15 минут): новые
рассчитанные матчи — в очередь разбора, пакет Batch — раз в postmortem_every_minutes
(app/services/postmortems.py). collect_batches (каждые 15 минут): пакеты разборов и
быстрых проверок уроков — сбор результатов, agent_runs, гипотезы в уроки; пакеты, которые
не ушли или потеряны, — разборы снова в очередь, проверка — failed. run_quick_check —
быстрая проверка урока (ставит API): досье, запросы и отправка пакета
(app/services/lesson_quick.py). check_lessons (раз в сутки): свои случаи гипотез и
проверка на архиве на пороге; recheck_lessons (1-го числа): перепроверка уроков
(app/services/lessons.py).
"""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from arq import Retry
from redis.asyncio import Redis
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent import batches
from app.agent.client import client_for
from app.agent.errors import ClaudeStepError
from app.core.config import get_settings
from app.core.formatting import format_moment
from app.core.redis import create_redis
from app.db.models import BatchJob, LoginEvent, Notification, TrustedDevice, User, UserSession
from app.ingest.update import run_update
from app.schemas.analytics import AnalyticsFiltersIn
from app.services import (
    account,
    ai_alerts,
    analysis_run,
    analytics,
    analytics_cache,
    auto_settlement,
    dashboard,
    data_uploads,
    eval_runs,
    lesson_quick,
    lessons,
    postmortems,
    recalibration,
)
from app.services.bank import user_zone
from app.services.claude_key import key_for
from app.services.data_status import STALE_AFTER, is_stale, last_ok_loads
from app.services.notifications import notify

log = structlog.get_logger(__name__)

LOGIN_EVENTS_RETENTION = timedelta(days=90)
# Не чаще раза в сутки: 23 часа, чтобы ежедневный запуск, сдвинутый на секунды, не
# пропускал день
STALE_NOTIFY_EVERY = timedelta(hours=23)
# Куда ведет data_stale: «Администрирование → Обзор», там дело «Архив матчей не обновлялся»
STALE_LINK = "/admin"


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
            link=STALE_LINK,
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


async def warm_new_day(ctx: dict[Any, Any]) -> list[int]:
    """Задача arq (cron раз в час): прогреть «Аналитику» и главную тем, у кого по их поясу
    начались новые сутки (analytics_cache.new_day_users): первое открытие за день не ждет
    расчета. По одному участнику подряд — расчет занимает процессор. Возвращает id."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        users = await analytics_cache.new_day_users(db)
    redis = create_redis()
    try:
        for user_id in users:
            async with sessionmaker() as db:
                await warm_user_analytics(db, redis, user_id)
    finally:
        await redis.aclose()
    if users:
        log.info("worker.warm_new_day", users=users)
    return users


# --- удаление аккаунтов и сигналы расхода (этап 4) ---


async def delete_requested_accounts(ctx: dict[Any, Any]) -> list[int]:
    """Задача arq (cron раз в сутки): удалить аккаунты, у которых прошло 7 дней после
    запроса участника. Возвращает id удаленных."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    redis = create_redis()
    try:
        async with sessionmaker() as db:
            deleted = await account.delete_due_accounts(db, redis)
    finally:
        await redis.aclose()
    if deleted:
        log.info("worker.delete_requested_accounts", users=deleted)
    return deleted


async def check_ai_alerts(ctx: dict[Any, Any]) -> list[str]:
    """Задача arq (cron раз в час): проверить правила расхода ИИ и разослать сигналы.
    Возвращает сработавшие правила."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        fired = await ai_alerts.run_checks(db)
    if fired:
        log.warning("worker.ai_alerts", rules=fired)
    return fired


# --- расчет по архиву (этап 5) ---

# Напоминание «пора загрузить файл»: понедельник, 07:00 по поясу администратора
UPLOAD_REMINDER_WEEKDAY = 0
UPLOAD_REMINDER_HOUR = 7
# Куда ведет «пора загрузить файл»: «Администрирование → Данные» (волна 2)
UPLOAD_LINK = "/admin/data"
# Тексты «пора загрузить файл»: была загрузка и еще не было ни одной
UPLOAD_VARIANTS = ("upload", "upload_first")


async def process_data_upload(ctx: dict[Any, Any], upload_id: int) -> str:
    """Задача arq: обработать загруженный файл tennis-data. Идет другое обновление —
    повтор позже (Retry), загрузка ждет в очереди."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    status = await data_uploads.process_upload(sessionmaker, upload_id)
    log.info("worker.process_data_upload", upload_id=upload_id, status=status)
    if status == "busy":
        raise Retry(defer=data_uploads.BUSY_RETRY_SECONDS)
    return status


async def notify_upload_due(db: AsyncSession, *, now: datetime | None = None) -> list[int]:
    """Понедельник, 07:00 по поясу администратора, файл tennis-data не загружали больше
    STALE_DAYS дней — data_stale (повод upload), не чаще раза в сутки каждому. Делает
    commit. Возвращает id администраторов, кому ушло."""
    moment = now or datetime.now(UTC)
    archive = await data_uploads.archive_status(db, moment)
    if not archive.stale:
        return []
    admins = list(
        await db.scalars(
            select(User).where(User.role == "admin", User.status == "active").order_by(User.id)
        )
    )
    recent = set(
        (
            await db.scalars(
                select(Notification.user_id).where(
                    Notification.kind == "data_stale",
                    Notification.created_at > moment - STALE_NOTIFY_EVERY,
                    Notification.params["variant"].astext.in_(UPLOAD_VARIANTS),
                )
            )
        ).all()
    )
    sent: list[int] = []
    for admin in admins:
        zone = user_zone(admin.tz)
        local = moment.astimezone(zone)
        if local.weekday() != UPLOAD_REMINDER_WEEKDAY or local.hour != UPLOAD_REMINDER_HOUR:
            continue
        if admin.id in recent:
            continue
        # Время — по поясу администратора; загрузок еще не было — свой текст
        params: dict[str, Any] = {"year": local.year}
        if archive.last_load is not None:
            params["last"] = format_moment(archive.last_load, zone, now=moment)
        await notify(
            db,
            user_id=admin.id,
            kind="data_stale",
            variant="upload" if archive.last_load is not None else "upload_first",
            link=UPLOAD_LINK,
            **params,
        )
        sent.append(admin.id)
    await db.commit()
    return sent


async def remind_unsettled(ctx: dict[Any, Any]) -> dict[str, int]:
    """Задача arq (cron раз в час): «ставка ждет результата» участникам, «пора загрузить
    файл» администраторам и уборка зависших загрузок файла (см. docstring модуля)."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        bets = await auto_settlement.remind_unsettled(db)
    async with sessionmaker() as db:
        admins = await notify_upload_due(db)
    async with sessionmaker() as db:
        stuck = await data_uploads.reap_stuck_uploads(db)
    summary = {"bets": bets, "admins": len(admins), "stuck_uploads": len(stuck)}
    if bets or admins or stuck:
        log.info("worker.remind_unsettled", **summary)
    return summary


# --- разборы и уроки (этап 5, волна 2) ---

BATCH_TIMEOUT_S = 120.0


async def submit_postmortems(ctx: dict[Any, Any]) -> dict[str, Any]:
    """Задача arq (cron каждые 15 минут): очередь разборов и пакет Batch."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        summary = await postmortems.submit(db)
    if summary.get("sent") or summary.get("queued") or summary.get("waiting"):
        log.info("worker.submit_postmortems", **summary)
    return summary


def _eval_kind(job: BatchJob) -> str:
    """Чей пакет вида eval: прогон версии на наборе (eval) или быстрая проверка урока."""
    return str((job.params or {}).get("eval_kind") or "quick")


async def _release(db: AsyncSession, job: BatchJob, reason: str) -> None:
    """Пакет не ушел или потерян: разборы — снова в очередь, проверка урока — failed,
    пакет прогона версии — отправить снова (не ушел) или прогон failed (потерян)."""
    if job.kind == "postmortem":
        await postmortems.requeue_job(db, job.id)
    elif job.kind == "eval" and _eval_kind(job) == eval_runs.KIND:
        await eval_runs.mark_lost(db, job, reason)
    elif job.kind == "eval":
        await lesson_quick.mark_lost(db, job, reason)


async def collect_all(db: AsyncSession) -> dict[str, Any]:
    """Сбор всех отправленных пакетов batch_jobs (разборы, быстрые проверки) и проверка
    уроков, у которых прибавились основания. Пакеты в работе не трогаются. Сначала
    уборка: строки pending, которые не ушли (пакет, созданный до сбоя, ищется у Anthropic
    и привязывается), и быстрые проверки, зависшие до отправки (failed)."""
    summary: dict[str, Any] = {
        "collected": 0,
        "lost": 0,
        "failed_sends": 0,
        "attached": 0,
        "lessons": {},
    }
    summary["quick_reaped"] = len(await lesson_quick.reap_stuck(db))
    stale = await db.scalar(
        select(func.count())
        .select_from(BatchJob)
        .where(
            BatchJob.status == batches.PENDING,
            BatchJob.created_at < datetime.now(UTC) - batches.PENDING_STALE,
        )
    )
    submitted = await db.scalar(
        select(func.count()).select_from(BatchJob).where(BatchJob.status == batches.SUBMITTED)
    )
    client = None
    key_error: str | None = None
    if stale or submitted:
        try:
            key = await key_for(db, key_source="admin", user_id=0)
            client = client_for(key, timeout=BATCH_TIMEOUT_S)
        except ClaudeStepError as exc:
            key_error = exc.code
        await db.commit()
    failed, attached = await batches.reap_pending(db, client=client)
    for job_id in failed:
        job = await db.get(BatchJob, job_id)
        if job is not None:
            await _release(db, job, "not_sent")
            summary["failed_sends"] += 1
    summary["attached"] = len(attached)
    jobs = list(
        await db.scalars(
            select(BatchJob).where(BatchJob.status == batches.SUBMITTED).order_by(BatchJob.id)
        )
    )
    await db.commit()
    if not jobs:
        return summary
    if client is None:
        return {**summary, "skipped": key_error or "ai.no_admin_key"}
    touched: set[int] = set()
    for job in jobs:
        try:
            if job.kind == "postmortem":
                collected, lessons_touched = await postmortems.collect(db, client, job)
                touched |= lessons_touched
            elif job.kind == "eval" and _eval_kind(job) == eval_runs.KIND:
                collected = await eval_runs.collect(db, client, job)
            elif job.kind == "eval":
                collected = await lesson_quick.collect(db, client, job)
            else:
                meta = batches.RunMeta.from_params(job.kind, job.params or {})
                collected = await batches.collect_job(
                    db, client, job.id, meta=meta, handle=_skip_item
                )
        except batches.BatchLost as exc:
            await _release(db, job, exc.reason)
            summary["lost"] += 1
            continue
        except ClaudeStepError as exc:
            await db.rollback()
            log.warning("worker.collect_batches.error", job_id=job.id, code=exc.code)
            continue
        if collected.status == batches.COLLECTED:
            summary["collected"] += 1
    if touched:
        summary["lessons"] = await lessons.check_lessons(db, lesson_ids=sorted(touched))
    return summary


async def advance_eval_runs(db: AsyncSession) -> list[tuple[int, str]]:
    """Следующие пакеты прогонов версий на наборе (после сбора предыдущих)."""
    return await eval_runs.advance_all(db)


async def _skip_item(db: AsyncSession, item: batches.BatchItem, run: Any) -> None:
    return None


async def collect_batches(ctx: dict[Any, Any]) -> dict[str, Any]:
    """Задача arq (cron каждые 15 минут): сбор пакетов Batch (collect_all)."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        summary = await collect_all(db)
    async with sessionmaker() as db:
        advanced = await advance_eval_runs(db)
    if advanced:
        summary["eval_runs"] = advanced
    if summary.get("collected") or summary.get("lost") or summary.get("failed_sends"):
        log.info("worker.collect_batches", **summary)
    return summary


async def run_eval(ctx: dict[Any, Any], eval_run_id: int) -> str:
    """Задача arq (ставит API при запуске прогона): отправить очередной пакет прогона
    версии на наборе (досье, худший случай, бюджет проверок, пакет)."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        status = await eval_runs.advance(db, eval_run_id)
    log.info("worker.run_eval", eval_run_id=eval_run_id, status=status)
    return status


async def recalibrate_model(ctx: dict[Any, Any]) -> dict[str, Any]:
    """Задача arq (cron по понедельникам после ночного обновления данных): перекалибровка
    базовой модели; включается сама, если не хуже прежней (В6)."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        result = await recalibration.recalibrate(db)
    summary = {
        "decision": result.decision,
        "reason": result.reason,
        "model": result.version.id if result.version is not None else None,
    }
    log.info("worker.recalibrate_model", **summary)
    return summary


async def run_quick_check(ctx: dict[Any, Any], eval_run_id: int) -> str:
    """Задача arq (ставит API): быстрая проверка урока — досье, запросы и пакет."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        status = await lesson_quick.prepare_and_submit(db, eval_run_id)
    log.info("worker.run_quick_check", eval_run_id=eval_run_id, status=status)
    return status


async def check_lessons(ctx: dict[Any, Any]) -> dict[str, int]:
    """Задача arq (cron раз в сутки): свои случаи гипотез и проверка на архиве."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        summary = await lessons.check_lessons(db)
    if summary.get("ready") or summary.get("rejected"):
        log.info("worker.check_lessons", **summary)
    return summary


async def recheck_lessons(ctx: dict[Any, Any]) -> dict[str, int]:
    """Задача arq (cron 1-го числа): перепроверка готовых и действующих уроков."""
    sessionmaker: async_sessionmaker[AsyncSession] = ctx["sessionmaker"]
    async with sessionmaker() as db:
        summary = await lessons.recheck_lessons(db)
    log.info("worker.recheck_lessons", **summary)
    return summary
