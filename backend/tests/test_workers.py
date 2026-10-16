"""Воркер arq: ночная очистка сеансов, доверенных устройств и журнала входов, ночное
обновление данных и уведомление data_stale, настройки воркера, запуск задачи через
настоящую очередь, ключи arq с префиксом CAPPER_REDIS_PREFIX и проверка здоровья для
healthcheck."""

import asyncio
import inspect
import os
import shutil
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import arq.connections
import arq.constants
import arq.cron
import arq.jobs
import arq.worker
import httpx
import pytest
from arq.jobs import Job, JobStatus
from arq.worker import async_check_health, create_worker
from redis.asyncio import Redis
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import Settings, get_settings
from app.core.security.tokens import hash_token, new_token
from app.db.models import (
    AccessCode,
    IngestionRun,
    LoginEvent,
    Notification,
    PlayerRating,
    TrustedDevice,
    User,
    UserSession,
)
from app.db.session import create_sessionmaker
from app.ingest import update
from app.services import analysis_run, data_uploads, eval_runs, lesson_quick
from app.services.data_status import DATA_UPDATE_MINUTE, STALE_AFTER
from app.services.sessions import create_session, get_active_session
from app.workers import jobs
from app.workers.jobs import (
    LOGIN_EVENTS_RETENTION,
    check_ai_alerts,
    cleanup_auth_data,
    cleanup_auth_records,
    delete_requested_accounts,
    notify_stale_data,
    reap_stuck_analyses,
    run_analysis,
    update_data,
)
from app.workers.main import (
    ACCOUNT_DELETION_HOUR_UTC,
    ACCOUNT_DELETION_MINUTE,
    AI_ALERTS_MINUTE,
    ANALYSIS_TIMEOUT_SECONDS,
    CLEANUP_HOUR_UTC,
    CLEANUP_MINUTE,
    COLLECT_MINUTES,
    EVAL_RUN_TIMEOUT_SECONDS,
    LESSONS_HOUR_UTC,
    LESSONS_MINUTE,
    POSTMORTEM_MINUTES,
    QUICK_CHECK_TIMEOUT_SECONDS,
    REAP_MINUTES,
    RECALIBRATE_HOUR_UTC,
    RECALIBRATE_MINUTE,
    RECALIBRATE_WEEKDAY,
    RECHECK_DAY,
    RECHECK_MINUTE,
    REMIND_MINUTE,
    UPLOAD_TIMEOUT_SECONDS,
    WARM_NEW_DAY_MINUTE,
    WEEKLY_REPORTS_MINUTE,
    WorkerSettings,
    build_cron_jobs,
)
from app.workers.queue import apply_redis_prefix, create_queue_pool
from tests.claude_mock import seed_prices
from tests.support import BACKEND_DIR, UserFactory
from tests.tennis_data_files import write_year
from tests.test_ingest_update import FIXTURES, rows_2024

NOW = datetime(2026, 10, 8, 3, 15, tzinfo=UTC)


def _session_row(
    user_id: int,
    *,
    last_seen: datetime,
    expires: datetime,
    revoked: datetime | None = None,
) -> UserSession:
    return UserSession(
        id_hash=hash_token(new_token()),
        user_id=user_id,
        created_at=last_seen,
        last_seen_at=last_seen,
        expires_at=expires,
        revoked_at=revoked,
    )


def _device_row(
    user_id: int, *, expires: datetime, revoked: datetime | None = None
) -> TrustedDevice:
    return TrustedDevice(
        token_hash=hash_token(new_token()),
        user_id=user_id,
        created_at=expires - timedelta(days=30),
        expires_at=expires,
        revoked_at=revoked,
    )


def _login_event(user_id: int | None, at: datetime) -> LoginEvent:
    return LoginEvent(user_id=user_id, at=at, ip="10.0.0.1", result="ok", method="password")


async def _ids(db: AsyncSession, model: type[UserSession | TrustedDevice | LoginEvent]) -> set[int]:
    return set((await db.execute(select(model.id))).scalars())


async def test_cleanup_deletes_only_sessions_that_no_longer_work(
    db: AsyncSession, make_user: UserFactory, settings: Settings
) -> None:
    user = await make_user()
    idle = timedelta(days=settings.session_idle_days)
    live = await create_session(
        db, user_id=user.id, ip="10.0.0.1", user_agent=None, now=NOW - timedelta(hours=1)
    )
    recent = _session_row(
        user.id, last_seen=NOW - idle + timedelta(minutes=1), expires=NOW + timedelta(days=1)
    )
    dead = [
        # бездействие дольше 14 дней, хотя абсолютный срок не прошел
        _session_row(user.id, last_seen=NOW - idle, expires=NOW + timedelta(days=10)),
        # прошел абсолютный срок
        _session_row(user.id, last_seen=NOW - timedelta(hours=1), expires=NOW),
        # отозван (выход, смена пароля, блокировка)
        _session_row(
            user.id,
            last_seen=NOW - timedelta(hours=1),
            expires=NOW + timedelta(days=20),
            revoked=NOW - timedelta(minutes=1),
        ),
    ]
    db.add_all([recent, *dead])
    await db.commit()

    result = await cleanup_auth_data(db, now=NOW)

    assert result.sessions == 3
    assert await _ids(db, UserSession) == {live.session.id, recent.id}
    # Оставшийся сеанс по-прежнему пускает: условия очистки — обратные условиям входа
    assert await get_active_session(db, live.token, now=NOW) is not None


async def test_cleanup_deletes_revoked_and_expired_trusted_devices(
    db: AsyncSession, make_user: UserFactory
) -> None:
    user = await make_user()
    active = _device_row(user.id, expires=NOW + timedelta(days=5))
    expired = _device_row(user.id, expires=NOW)
    revoked = _device_row(user.id, expires=NOW + timedelta(days=5), revoked=NOW)
    db.add_all([active, expired, revoked])
    await db.commit()

    result = await cleanup_auth_data(db, now=NOW)

    assert result.trusted_devices == 2
    assert await _ids(db, TrustedDevice) == {active.id}


async def test_cleanup_keeps_login_events_for_90_days(
    db: AsyncSession, make_user: UserFactory
) -> None:
    user = await make_user()
    keep = [
        _login_event(user.id, NOW - timedelta(days=1)),
        _login_event(user.id, NOW - LOGIN_EVENTS_RETENTION + timedelta(minutes=1)),
    ]
    drop = [
        _login_event(user.id, NOW - LOGIN_EVENTS_RETENTION - timedelta(minutes=1)),
        # попытка входа с неизвестным email: user_id пустой
        _login_event(None, NOW - timedelta(days=200)),
    ]
    db.add_all([*keep, *drop])
    await db.commit()

    result = await cleanup_auth_data(db, now=NOW)

    assert result.login_events == 2
    assert await _ids(db, LoginEvent) == {event.id for event in keep}


async def test_cleanup_keeps_expired_access_codes(db: AsyncSession, make_user: UserFactory) -> None:
    """Истекшие и неиспользованные коды — история действий администратора."""
    user = await make_user()
    db.add_all(
        [
            AccessCode(
                kind="invite",
                code_hash=hash_token(new_token()),
                email="guest@example.com",
                role="member",
                ai_mode="shared",
                expires_at=NOW - timedelta(days=30),
            ),
            AccessCode(
                kind="password_reset",
                code_hash=hash_token(new_token()),
                user_id=user.id,
                expires_at=NOW - timedelta(days=30),
            ),
        ]
    )
    await db.commit()

    await cleanup_auth_data(db, now=NOW)

    assert (await db.execute(select(func.count()).select_from(AccessCode))).scalar_one() == 2


async def test_cleanup_job_uses_sessionmaker_from_context(
    engine: AsyncEngine, db: AsyncSession, make_user: UserFactory
) -> None:
    user = await make_user()
    db.add(_login_event(user.id, datetime.now(UTC) - timedelta(days=120)))
    await db.commit()

    counts = await cleanup_auth_records({"sessionmaker": create_sessionmaker(engine)})

    assert counts == {"sessions": 0, "trusted_devices": 0, "login_events": 1}


async def test_cabinet_jobs_use_sessionmaker_from_context(
    engine: AsyncEngine, db: AsyncSession, make_user: UserFactory
) -> None:
    """Задачи этапа 4 берут сеанс базы из ctx воркера: удаление аккаунтов по запросу
    и сигналы расхода ИИ."""
    ctx = {"sessionmaker": create_sessionmaker(engine)}
    waiting = await make_user()
    due = await make_user()
    waiting_id, due_id = waiting.id, due.id
    now = datetime.now(UTC)
    (await db.get_one(User, waiting_id)).deletion_requested_at = now - timedelta(days=3)
    (await db.get_one(User, due_id)).deletion_requested_at = now - timedelta(days=8)
    await db.commit()
    assert await delete_requested_accounts(ctx) == [due_id]
    # Цен Opus нет — сигнал no_price; уведомление получает администратор
    await seed_prices(db, "claude-haiku-5-5", "claude-sonnet-5-5")
    admin = await make_user(role="admin")
    admin_id = admin.id
    assert "no_price" in await check_ai_alerts(ctx)
    kinds = await db.scalars(select(Notification.kind).where(Notification.user_id == admin_id))
    assert list(kinds) == ["ai_alert"]


def test_worker_settings(settings: Settings) -> None:
    assert WorkerSettings.queue_name == f"{settings.redis_prefix}arq:queue"
    functions = WorkerSettings.functions
    (
        cleanup_job,
        update_job,
        analysis_job,
        reaper_job,
        warm_job,
        deletion_job,
        alerts_job,
        upload_job,
        remind_job,
        submit_job,
        collect_job,
        quick_job,
        lessons_job,
        recheck_job,
        eval_job,
        recalibrate_job,
        weekly_job,
    ) = functions
    assert (cleanup_job, update_job, reaper_job, deletion_job, alerts_job) == (
        cleanup_auth_records,
        update_data,
        reap_stuck_analyses,
        delete_requested_accounts,
        check_ai_alerts,
    )
    # Прогрев кэша аналитики: без повтора и без хранения результата — иначе задача с тем
    # же id участника не ставилась бы, пока результат не истечет
    assert isinstance(warm_job, arq.worker.Function)
    assert warm_job.coroutine is jobs.warm_analytics and warm_job.name == "warm_analytics"
    assert warm_job.max_tries == 1 and warm_job.keep_result_s == 0
    # Анализ: свой предел 15 минут и без повтора arq (перезапуск — с чекпойнта)
    assert isinstance(analysis_job, arq.worker.Function)
    assert analysis_job.coroutine is run_analysis and analysis_job.name == "run_analysis"
    assert analysis_job.timeout_s == ANALYSIS_TIMEOUT_SECONDS == 900
    assert analysis_job.max_tries == 1
    # Свой предел анализа короче: анализ кончается своим failed, а не снятием задачи
    assert analysis_run.RUN_DEADLINE_SECONDS < ANALYSIS_TIMEOUT_SECONDS
    # Этап 5: файл tennis-data — предел часа и повторы, пока идет ночное обновление
    assert isinstance(upload_job, arq.worker.Function)
    assert upload_job.coroutine is jobs.process_data_upload
    assert upload_job.name == "process_data_upload" == data_uploads.UPLOAD_JOB
    assert upload_job.timeout_s == UPLOAD_TIMEOUT_SECONDS and upload_job.max_tries == 30
    assert remind_job is jobs.remind_unsettled
    # Волна 2: разборы, сбор пакетов, быстрая проверка урока (ставит API), уроки
    assert (submit_job, collect_job, lessons_job, recheck_job) == (
        jobs.submit_postmortems,
        jobs.collect_batches,
        jobs.check_lessons,
        jobs.recheck_lessons,
    )
    assert isinstance(quick_job, arq.worker.Function)
    assert quick_job.coroutine is jobs.run_quick_check
    assert quick_job.name == "run_quick_check" == lesson_quick.QUICK_JOB
    assert quick_job.timeout_s == QUICK_CHECK_TIMEOUT_SECONDS and quick_job.max_tries == 1
    # Волна 3: прогон версии на наборе (ставит API), перекалибровка базовой модели
    assert isinstance(eval_job, arq.worker.Function)
    assert eval_job.coroutine is jobs.run_eval and eval_job.name == "run_eval" == eval_runs.RUN_JOB
    assert eval_job.timeout_s == EVAL_RUN_TIMEOUT_SECONDS and eval_job.max_tries == 1
    assert recalibrate_job is jobs.recalibrate_model
    # Волна 4: еженедельный отчет
    assert weekly_job is jobs.weekly_reports
    assert WorkerSettings.cron_jobs is not None
    (
        cleanup,
        data,
        reaper,
        deletion,
        alerts,
        new_day,
        remind,
        submit,
        collect,
        lessons_cron,
        recheck,
        recalibrate,
        weekly,
    ) = WorkerSettings.cron_jobs
    # Еженедельный отчет — раз в час, без повтора, не в минуты соседних задач
    assert weekly.coroutine is jobs.weekly_reports and weekly.max_tries == 1
    assert weekly.hour is None and weekly.minute == WEEKLY_REPORTS_MINUTE
    assert WEEKLY_REPORTS_MINUTE not in REAP_MINUTES | POSTMORTEM_MINUTES | COLLECT_MINUTES | {
        0,
        CLEANUP_MINUTE,
        DATA_UPDATE_MINUTE,
        ACCOUNT_DELETION_MINUTE,
        AI_ALERTS_MINUTE,
        WARM_NEW_DAY_MINUTE,
        REMIND_MINUTE,
        LESSONS_MINUTE,
        RECHECK_MINUTE,
        RECALIBRATE_MINUTE,
    }
    # Перекалибровка — по понедельникам после ночного обновления, до проверки уроков
    assert recalibrate.coroutine is jobs.recalibrate_model and recalibrate.max_tries == 1
    assert (recalibrate.weekday, recalibrate.hour, recalibrate.minute) == (
        RECALIBRATE_WEEKDAY,
        RECALIBRATE_HOUR_UTC,
        RECALIBRATE_MINUTE,
    )
    assert (
        (settings.data_update_hour_utc, DATA_UPDATE_MINUTE)
        < (
            RECALIBRATE_HOUR_UTC,
            RECALIBRATE_MINUTE,
        )
        < (LESSONS_HOUR_UTC, LESSONS_MINUTE)
    )
    # Разборы и пакеты — каждые 15 минут, не в минуты соседних задач
    hourly = {
        CLEANUP_MINUTE,
        DATA_UPDATE_MINUTE,
        0,
        ACCOUNT_DELETION_MINUTE,
        AI_ALERTS_MINUTE,
        WARM_NEW_DAY_MINUTE,
        REMIND_MINUTE,
    } | REAP_MINUTES
    assert submit.coroutine is jobs.submit_postmortems and submit.minute == set(POSTMORTEM_MINUTES)
    assert collect.coroutine is jobs.collect_batches and collect.minute == set(COLLECT_MINUTES)
    assert len(POSTMORTEM_MINUTES) == len(COLLECT_MINUTES) == 4
    assert not (POSTMORTEM_MINUTES | COLLECT_MINUTES) & hourly
    assert not POSTMORTEM_MINUTES & COLLECT_MINUTES
    assert submit.max_tries == collect.max_tries == 1
    assert lessons_cron.coroutine is jobs.check_lessons
    assert (lessons_cron.hour, lessons_cron.minute) == (LESSONS_HOUR_UTC, LESSONS_MINUTE)
    assert recheck.coroutine is jobs.recheck_lessons
    assert (recheck.day, recheck.hour, recheck.minute) == (
        RECHECK_DAY,
        LESSONS_HOUR_UTC,
        RECHECK_MINUTE,
    )
    assert settings.data_update_hour_utc != LESSONS_HOUR_UTC
    # Напоминания — раз в час, без повтора, не в минуты соседних задач
    assert remind.coroutine is jobs.remind_unsettled and remind.max_tries == 1
    assert remind.hour is None and remind.minute == REMIND_MINUTE
    assert REMIND_MINUTE not in {CLEANUP_MINUTE, DATA_UPDATE_MINUTE, 0} | REAP_MINUTES | {
        ACCOUNT_DELETION_MINUTE,
        AI_ALERTS_MINUTE,
        WARM_NEW_DAY_MINUTE,
    }
    # Уборщик зависших анализов — каждые 5 минут, не в минуты соседних задач
    assert reaper.coroutine is reap_stuck_analyses and reaper.max_tries == 1
    assert reaper.minute == set(REAP_MINUTES) and len(REAP_MINUTES) == 12
    assert not REAP_MINUTES & {CLEANUP_MINUTE, DATA_UPDATE_MINUTE, 0}
    assert cleanup.coroutine is cleanup_auth_records
    assert (cleanup.hour, cleanup.minute, cleanup.second) == (CLEANUP_HOUR_UTC, CLEANUP_MINUTE, 0)
    # Обновление данных — раз в сутки в час из настроек, минута не нулевая
    assert data.coroutine is update_data
    assert (data.hour, data.minute, data.second) == (
        settings.data_update_hour_utc,
        DATA_UPDATE_MINUTE,
        0,
    )
    assert DATA_UPDATE_MINUTE != 0 and data.max_tries == 1
    assert data.timeout_s is not None and data.timeout_s >= 1800
    # Удаление аккаунтов по запросу — раз в сутки после очистки; сигналы расхода ИИ — раз
    # в час. Обе задачи без повтора и не в минуты соседних
    assert deletion.coroutine is delete_requested_accounts and deletion.max_tries == 1
    assert (deletion.hour, deletion.minute, deletion.second) == (
        ACCOUNT_DELETION_HOUR_UTC,
        ACCOUNT_DELETION_MINUTE,
        0,
    )
    assert alerts.coroutine is check_ai_alerts and alerts.max_tries == 1
    assert alerts.hour is None and alerts.minute == AI_ALERTS_MINUTE
    busy = {CLEANUP_MINUTE, DATA_UPDATE_MINUTE, 0} | REAP_MINUTES
    assert not {ACCOUNT_DELETION_MINUTE, AI_ALERTS_MINUTE} & busy
    # Ночной прогрев аналитики (у кого по их поясу начались сутки) — каждый час, без повтора
    assert new_day.coroutine is jobs.warm_new_day and new_day.max_tries == 1
    assert new_day.hour is None and new_day.minute == WARM_NEW_DAY_MINUTE
    assert WARM_NEW_DAY_MINUTE not in busy | {ACCOUNT_DELETION_MINUTE, AI_ALERTS_MINUTE}
    assert WorkerSettings.timezone is UTC
    redis_url = settings.redis_url.removeprefix("redis://")
    assert redis_url.startswith(
        f"{WorkerSettings.redis_settings.host}:{WorkerSettings.redis_settings.port}"
    )


def test_worker_cron_can_be_turned_off(settings: Settings) -> None:
    # CAPPER_WORKER_CRON=false (стек сквозных тестов): только задачи из очереди, без
    # ночной загрузки архивов и уборщика
    jobs_on = build_cron_jobs(settings)
    assert jobs_on is not None and len(jobs_on) == 13
    assert build_cron_jobs(settings.model_copy(update={"worker_cron": False})) is None
    assert Settings.model_fields["worker_cron"].default is True


def test_arq_keys_use_redis_prefix(settings: Settings) -> None:
    """Все ключи arq в каждом модуле, который их держит, — с префиксом приложения;
    повторный вызов не удваивает префикс."""
    prefix = settings.redis_prefix
    expected = {
        "default_queue_name": f"{prefix}arq:queue",
        "job_key_prefix": f"{prefix}arq:job:",
        "in_progress_key_prefix": f"{prefix}arq:in-progress:",
        "result_key_prefix": f"{prefix}arq:result:",
        "retry_key_prefix": f"{prefix}arq:retry:",
        "abort_jobs_ss": f"{prefix}arq:abort",
    }
    apply_redis_prefix(prefix)
    for module in (arq.constants, arq.connections, arq.jobs, arq.worker):
        for name, value in expected.items():
            if hasattr(module, name):
                assert getattr(module, name) == value, (module.__name__, name)
    # В arq.constants есть все имена: новых ключей без префикса там не появилось
    keys = {
        name
        for name, value in vars(arq.constants).items()
        if isinstance(value, str) and value.startswith(prefix)
    }
    assert keys == set(expected)
    assert not [
        name
        for name, value in vars(arq.constants).items()
        if isinstance(value, str) and value.startswith("arq:")
    ]
    # Очередь по умолчанию в параметрах функций arq Python вычислил при импорте arq: она
    # тоже с префиксом, и новых параметров с ключами без префикса не появилось
    queue_defaults = _arq_key_defaults()
    assert set(queue_defaults) >= {
        "arq.jobs.Job.__init__(_queue_name)",
        "arq.connections.ArqRedis.__init__(default_queue_name)",
        "arq.connections.create_pool(default_queue_name)",
        "arq.worker.Worker.__init__(queue_name)",
    }
    assert set(queue_defaults.values()) == {f"{prefix}arq:queue"}


# Воркер — python -m app.workers.main: у него этот модуль — __main__ (здесь — копия под
# другим именем, чтобы не запускать воркер). Шаг загрузки файла ставит задачу через сервис
# (archive_settlement → analytics_cache.request_warm), тот импортирует очередь; раньше это
# был второй импорт app.workers.main и префикс ставился второй раз. Еще одна копия самого
# app/workers/queue.py — на случай, если и он исполнится дважды
_DOUBLE_IMPORT_SCRIPT = """
import importlib.util, runpy, sys
import arq.constants, arq.jobs, arq.worker
runpy.run_module("app.workers.main", run_name="__worker__")
from app.services import analytics_cache, archive_settlement, data_uploads, lesson_quick
import app.api.routes.analyses
import app.workers.main
spec = importlib.util.spec_from_file_location("queue_copy", sys.argv[1])
spec.loader.exec_module(importlib.util.module_from_spec(spec))
import inspect
job_queue = inspect.signature(arq.jobs.Job.__init__).parameters["_queue_name"].default
print(arq.constants.job_key_prefix, arq.jobs.job_key_prefix, arq.worker.result_key_prefix,
      job_queue)
"""


async def test_arq_prefix_survives_double_import(settings: Settings) -> None:
    prefix = settings.redis_prefix
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        _DOUBLE_IMPORT_SCRIPT,
        str(BACKEND_DIR / "app" / "workers" / "queue.py"),
        cwd=BACKEND_DIR,
        env=os.environ.copy(),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await asyncio.wait_for(process.communicate(), timeout=60)
    assert process.returncode == 0, err.decode()
    assert out.decode().split() == [
        f"{prefix}arq:job:",
        f"{prefix}arq:job:",
        f"{prefix}arq:result:",
        f"{prefix}arq:queue",
    ]


def test_services_queue_jobs_without_worker_module() -> None:
    """Сервисы и маршруты ставят задачи через app.workers.queue, а не через модуль воркера:
    у работающего воркера тот — __main__, и импорт по имени создал бы его вторую копию."""
    app_dir = BACKEND_DIR / "app"
    offenders = [
        str(path.relative_to(BACKEND_DIR))
        for path in app_dir.rglob("*.py")
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith(("from app.workers.main ", "import app.workers.main"))
    ]
    assert offenders == []


def _arq_key_defaults() -> dict[str, str]:
    """Строковые значения по умолчанию с «arq:» у параметров функций и методов arq."""
    found: dict[str, str] = {}
    for module in (arq.connections, arq.jobs, arq.worker, arq.cron):
        for obj in vars(module).values():
            if getattr(obj, "__module__", None) != module.__name__:
                continue
            if inspect.isclass(obj):
                funcs = [item for item in vars(obj).values() if inspect.isfunction(item)]
            else:
                funcs = [obj] if inspect.isfunction(obj) else []
            for function in funcs:
                for param in inspect.signature(function).parameters.values():
                    if isinstance(param.default, str) and "arq:" in param.default:
                        name = f"{module.__name__}.{function.__qualname__}({param.name})"
                        found[name] = param.default
    return found


async def _check_health_cli() -> int:
    """python -m app.workers.main --check отдельным процессом, как healthcheck контейнера.
    Настройки (база и префикс Redis этого сеанса тестов) — из окружения."""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app.workers.main",
        "--check",
        cwd=BACKEND_DIR,
        env=os.environ.copy(),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    return await asyncio.wait_for(process.wait(), timeout=30)


async def test_worker_runs_queued_job_and_reports_health(
    db: AsyncSession, redis: Redis, make_user: UserFactory
) -> None:
    user = await make_user()
    db.add(_login_event(user.id, datetime.now(UTC) - timedelta(days=120)))
    await db.commit()
    # Воркер не запущен: отметки здоровья нет
    assert await _check_health_cli() == 1

    pool = await create_queue_pool()
    assert pool.default_queue_name == WorkerSettings.queue_name
    worker = create_worker(WorkerSettings, burst=True, handle_signals=False, poll_delay=0.05)
    try:
        job = await pool.enqueue_job("cleanup_auth_records", _job_id=f"test-{new_token()}")
        assert job is not None
        # Задача ждет в очереди с префиксом приложения; Job по id (как будет искать статус
        # анализа API) видит ее там без явного имени очереди
        assert await redis.zscore(WorkerSettings.queue_name, job.job_id) is not None
        assert await Job(job.job_id, pool).status() == JobStatus.queued
        await worker.main()
        assert await job.result(timeout=10, poll_delay=0.05) == {
            "sessions": 0,
            "trusted_devices": 0,
            "login_events": 1,
        }
        assert await Job(job.job_id, pool).status() == JobStatus.complete
        # Воркер отметился в Redis: healthcheck контейнера проходит
        assert await _check_health_cli() == 0
        assert (
            await async_check_health(
                WorkerSettings.redis_settings, queue_name=WorkerSettings.queue_name
            )
            == 0
        )
        # Ключи этой задачи во всем Redis: остался только результат, и он с префиксом
        # сеанса тестов (задача, повторы и отметка «в работе» удалены воркером)
        prefix = get_settings().redis_prefix
        job_keys = {key async for key in redis.scan_iter(match=f"*{job.job_id}*")}
        assert job_keys == {f"{prefix}arq:result:{job.job_id}"}
        assert await redis.exists(f"{prefix}arq:queue:health-check") == 1
    finally:
        await worker.close()
        await pool.aclose()

    assert (await db.execute(select(func.count()).select_from(LoginEvent))).scalar_one() == 0


# --- ночное обновление данных и data_stale ---


def _load(
    source: str, finished: datetime | None, status: str = "ok", *, files: bool = True
) -> IngestionRun:
    return IngestionRun(
        source=source,
        status=status,
        started_at=(finished or datetime.now(UTC)) - timedelta(minutes=1),
        finished_at=finished,
        details={"files": {"2026/2026.xlsx": "0" * 64} if files else {}, "counts": {}},
    )


async def _stale_notes(db: AsyncSession) -> list[Notification]:
    db.expunge_all()
    rows = await db.scalars(
        select(Notification).where(Notification.kind == "data_stale").order_by(Notification.id)
    )
    return list(rows)


async def test_data_stale_goes_to_active_admins_once_a_day(
    db: AsyncSession, make_user: UserFactory
) -> None:
    admin = await make_user(role="admin")
    other_admin = await make_user(role="admin")
    await make_user(role="admin", status="blocked")
    await make_user()
    now = datetime.now(UTC)
    old_load = now - STALE_AFTER - timedelta(hours=1)
    db.add_all(
        [
            _load("sackmann", old_load),
            # Неудачный запуск свежее, но он не считается
            _load("sackmann", now - timedelta(hours=2), status="failed"),
            _load("tennis_data", now - timedelta(days=1)),
            # Эло и привязка старого бота не проверяются
            _load("elo", now),
        ]
    )
    await db.commit()

    sent = await notify_stale_data(db, now=now)

    assert sent == [admin.id, other_admin.id]
    notes = await _stale_notes(db)
    assert [note.user_id for note in notes] == [admin.id, other_admin.id]
    note = notes[0]
    assert note.title == "Архив матчей давно не обновлялся"
    assert f"архив Сакманна — {old_load.strftime('%Y-%m-%d %H:%M')}" in note.body
    assert "Больше 3 дней без обновления" in note.body
    assert note.params["days"] == "3"

    # Повтор в те же сутки — без нового уведомления
    assert await notify_stale_data(db, now=now + timedelta(hours=1)) == []
    # Через сутки (точнее, через 23 часа: запуск мог сдвинуться на секунды) — снова
    await db.execute(
        text("UPDATE notifications SET created_at = :at WHERE kind = 'data_stale'"),
        {"at": now - jobs.STALE_NOTIFY_EVERY - timedelta(minutes=1)},
    )
    await db.commit()
    assert await notify_stale_data(db, now=now) == [admin.id, other_admin.id]
    assert len(await _stale_notes(db)) == 4


async def test_data_stale_when_fresh_or_never_loaded(
    db: AsyncSession, make_user: UserFactory
) -> None:
    admin = await make_user(role="admin")
    now = datetime.now(UTC)
    db.add_all([_load("sackmann", now - timedelta(days=2)), _load("tennis_data", now)])
    await db.commit()
    assert await notify_stale_data(db, now=now) == []

    # tennis-data не загружался ни разу (например, всегда 403): это тоже старые данные
    await db.execute(text("DELETE FROM ingestion_runs WHERE source = 'tennis_data'"))
    await db.commit()
    assert await notify_stale_data(db, now=now) == [admin.id]
    (note,) = await _stale_notes(db)
    assert "tennis-data.co.uk — —" in note.body


async def test_data_stale_ignores_runs_without_files(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """Запуск «ok», который не получил ни одного файла (источник отвечает 404 на файл
    текущего года, папка пустая), данные не обновил: свежим он не считается."""
    admin = await make_user(role="admin")
    now = datetime.now(UTC)
    db.add_all(
        [
            _load("sackmann", now),
            _load("tennis_data", now - STALE_AFTER - timedelta(hours=1)),
            _load("tennis_data", now, files=False),
        ]
    )
    await db.commit()
    assert await notify_stale_data(db, now=now) == [admin.id]


async def test_update_data_job_runs_all_steps_and_checks_freshness(
    engine: AsyncEngine,
    db: AsyncSession,
    make_user: UserFactory,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Задача воркера: те же шаги, что команда update без --full (здесь — из папок, без
    сети), потом проверка свежести: все загрузки свежие, уведомлений нет."""
    admin = await make_user(role="admin")
    sackmann_dir = tmp_path / "sackmann"
    shutil.copytree(FIXTURES, sackmann_dir)
    tennis_dir = tmp_path / "tennis-data"
    write_year(tennis_dir, 2024, rows_2024())
    seen: dict[str, Any] = {}

    async def fake_run_update(**kwargs: Any) -> update.UpdateResult:
        seen.update(kwargs)
        return await update.run_update(
            **kwargs, years=[2023, 2024], sackmann_dir=sackmann_dir, tennis_data_dir=tennis_dir
        )

    monkeypatch.setattr(jobs, "run_update", fake_run_update)
    sessionmaker = create_sessionmaker(engine)

    summary = await update_data({"sessionmaker": sessionmaker})

    # Задача сама не задает ни годов, ни папок: без --full, источники по HTTP из настроек
    assert seen == {"db_factory": sessionmaker}
    assert summary == {
        "ok": True,
        "busy": False,
        "steps": {
            "sackmann": "ok",
            "tennis_data": "ok",
            "players_link": "ok",
            "elo": "ok",
            "settle": "ok",
        },
        "data_stale_notified": 0,
    }
    assert (await db.scalar(select(func.count()).select_from(PlayerRating)) or 0) > 0
    assert await _stale_notes(db) == []

    # Сакманн упал (нет справочника по HTTP): загрузка устарела на 4 дня — уведомление
    await db.execute(
        text("UPDATE ingestion_runs SET finished_at = :at WHERE source = 'sackmann'"),
        {"at": datetime.now(UTC) - timedelta(days=4)},
    )
    await db.commit()

    async def failing_sackmann(**kwargs: Any) -> update.UpdateResult:
        transport = httpx.MockTransport(lambda request: httpx.Response(404))
        return await update.run_update(
            **kwargs, years=[2024], tennis_data_dir=tennis_dir, transport=transport
        )

    monkeypatch.setattr(jobs, "run_update", failing_sackmann)
    summary = await update_data({"sessionmaker": sessionmaker})
    assert summary["ok"] is False
    assert summary["steps"]["sackmann"] == "failed"
    assert summary["data_stale_notified"] == 1
    (note,) = await _stale_notes(db)
    assert note.user_id == admin.id
