"""Воркер arq: фоновые задачи и расписание (cron).

Запуск:
    python -m app.workers.main            воркер (в docker compose — сервис worker)
    python -m app.workers.main --check    проверка здоровья для healthcheck: 0 — воркер
                                          отмечался в Redis за последнюю минуту, 1 — нет

Своя точка входа вместо команды arq: логи идут через structlog с фильтром секретов
(app.core.logging), как у API. Настройки — те же CAPPER_*: Redis из CAPPER_REDIS_URL,
база из CAPPER_DATABASE_URL. Очередь и все ключи arq (задачи, результаты, повторы,
отметка здоровья) — с префиксом CAPPER_REDIS_PREFIX: так тесты и разные окружения в
одном Redis не берут чужие задачи и не видят чужих результатов. Ставить задачи в
очередь — только через create_queue_pool() отсюда.

Время в расписании — UTC. Ночная очистка в 03:15 UTC: после бэкапа (01:30 UTC,
deploy/backup/crontab) и до утра в Европе.
"""

import argparse
from collections.abc import Sequence
from datetime import UTC
from typing import Any

import arq.connections
import arq.constants
import arq.jobs
import arq.worker
from arq import create_pool, cron
from arq.connections import ArqRedis, RedisSettings
from arq.cron import CronJob
from arq.typing import StartupShutdown, WorkerCoroutine
from arq.worker import Function, check_health, run_worker

from app.core.config import Settings, get_settings
from app.core.logging import setup_logging
from app.db.session import create_engine, create_sessionmaker
from app.workers.jobs import cleanup_auth_records

# Как часто воркер отмечается в Redis (ключ живет на секунду дольше). Healthcheck
# контейнера раз в 30 с, поэтому живой воркер всегда успевает отметиться
HEALTH_CHECK_INTERVAL_SECONDS = 60
CLEANUP_HOUR_UTC = 3
CLEANUP_MINUTE = 15


# Имена ключей arq. В arq 0.28 они — константы модулей (arq.constants), настройки
# префикса нет; модули импортируют их к себе по имени, поэтому меняются копии в каждом
_ARQ_KEY_NAMES = (
    "default_queue_name",
    "job_key_prefix",
    "in_progress_key_prefix",
    "result_key_prefix",
    "retry_key_prefix",
    "abort_jobs_ss",
)
_ARQ_MODULES = (arq.constants, arq.connections, arq.jobs, arq.worker)
_ARQ_DEFAULT_KEYS = {name: str(getattr(arq.constants, name)) for name in _ARQ_KEY_NAMES}


def apply_redis_prefix(prefix: str) -> None:
    """Ключи arq с префиксом приложения: capper:arq:job:<id>, capper:arq:result:<id> и т. д.
    Действует на весь процесс (воркер или API); повторный вызов с тем же префиксом ничего
    не меняет. Проверка, что ни один ключ не ушел без префикса, — tests/test_workers.py:
    после обновления arq она покажет, если в нем появились новые ключи."""
    for module in _ARQ_MODULES:
        for name, default in _ARQ_DEFAULT_KEYS.items():
            if hasattr(module, name):
                setattr(module, name, prefix + default)


def make_queue_name(settings: Settings) -> str:
    """Очередь arq с префиксом приложения: capper:arq:queue."""
    return f"{settings.redis_prefix}{_ARQ_DEFAULT_KEYS['default_queue_name']}"


# При импорте: WorkerSettings ниже, check_health и create_queue_pool работают уже с префиксом
apply_redis_prefix(get_settings().redis_prefix)


async def create_queue_pool(settings: Settings | None = None) -> ArqRedis:
    """Соединение для постановки задач: та же очередь и те же ключи, что у воркера.
    Job(job_id, pool) для уже поставленной задачи — с _queue_name=make_queue_name(settings):
    иначе arq ищет ее в очереди без префикса."""
    settings = settings or get_settings()
    apply_redis_prefix(settings.redis_prefix)
    return await create_pool(
        RedisSettings.from_dsn(settings.redis_url),
        default_queue_name=make_queue_name(settings),
    )


async def startup(ctx: dict[Any, Any]) -> None:
    """Один движок БД на воркер; задачи берут сеанс из ctx["sessionmaker"]."""
    engine = create_engine()
    ctx["engine"] = engine
    ctx["sessionmaker"] = create_sessionmaker(engine)


async def shutdown(ctx: dict[Any, Any]) -> None:
    engine = ctx.get("engine")
    if engine is not None:
        await engine.dispose()


class WorkerSettings:
    """Настройки воркера для arq (arq читает атрибуты класса)."""

    functions: Sequence[WorkerCoroutine | Function] = (cleanup_auth_records,)
    cron_jobs: Sequence[CronJob] | None = (
        cron(
            cleanup_auth_records,
            hour=CLEANUP_HOUR_UTC,
            minute=CLEANUP_MINUTE,
            # Повтор той же ночью не нужен: следующая очистка — через сутки
            max_tries=1,
            timeout=600,
        ),
    )
    on_startup: StartupShutdown | None = startup
    on_shutdown: StartupShutdown | None = shutdown
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    queue_name = make_queue_name(get_settings())
    health_check_interval = HEALTH_CHECK_INTERVAL_SECONDS
    timezone = UTC
    job_timeout = 300
    max_jobs = 10


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.workers.main")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    settings = get_settings()
    setup_logging(json_logs=settings.env == "prod", level=settings.log_level)
    if args.check:
        return check_health(WorkerSettings)
    run_worker(WorkerSettings)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
