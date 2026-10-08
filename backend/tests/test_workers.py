"""Воркер arq: ночная очистка сеансов, доверенных устройств и журнала входов, настройки
воркера, запуск задачи через настоящую очередь, ключи arq с префиксом CAPPER_REDIS_PREFIX
и проверка здоровья для healthcheck."""

import asyncio
import inspect
import os
import sys
from datetime import UTC, datetime, timedelta

import arq.connections
import arq.constants
import arq.cron
import arq.jobs
import arq.worker
from arq.jobs import Job, JobStatus
from arq.worker import async_check_health, create_worker
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import Settings, get_settings
from app.core.security.tokens import hash_token, new_token
from app.db.models import AccessCode, LoginEvent, TrustedDevice, UserSession
from app.db.session import create_sessionmaker
from app.services.sessions import create_session, get_active_session
from app.workers.jobs import LOGIN_EVENTS_RETENTION, cleanup_auth_data, cleanup_auth_records
from app.workers.main import (
    CLEANUP_HOUR_UTC,
    CLEANUP_MINUTE,
    WorkerSettings,
    apply_redis_prefix,
    create_queue_pool,
)
from tests.support import BACKEND_DIR, UserFactory

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


def test_worker_settings(settings: Settings) -> None:
    assert WorkerSettings.queue_name == f"{settings.redis_prefix}arq:queue"
    assert WorkerSettings.functions == (cleanup_auth_records,)
    assert WorkerSettings.cron_jobs is not None
    (job,) = WorkerSettings.cron_jobs
    assert job.coroutine is cleanup_auth_records
    assert (job.hour, job.minute, job.second) == (CLEANUP_HOUR_UTC, CLEANUP_MINUTE, 0)
    assert WorkerSettings.timezone is UTC
    redis_url = settings.redis_url.removeprefix("redis://")
    assert redis_url.startswith(
        f"{WorkerSettings.redis_settings.host}:{WorkerSettings.redis_settings.port}"
    )


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
