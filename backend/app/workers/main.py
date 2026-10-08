"""Воркер arq: фоновые задачи и расписание (cron).

Запуск:
    python -m app.workers.main            воркер (в docker compose — сервис worker)
    python -m app.workers.main --check    проверка здоровья для healthcheck: 0 — воркер
                                          отмечался в Redis за последнюю минуту, 1 — нет

Своя точка входа вместо команды arq: логи идут через structlog с фильтром секретов
(app.core.logging), как у API. Настройки — те же CAPPER_*: Redis из CAPPER_REDIS_URL,
очередь с префиксом CAPPER_REDIS_PREFIX (так тесты и разные окружения в одном Redis
не берут чужие задачи), база из CAPPER_DATABASE_URL.

Время в расписании — UTC. Ночная очистка в 03:15 UTC: после бэкапа (01:30 UTC,
deploy/backup/crontab) и до утра в Европе.
"""

import argparse
from collections.abc import Sequence
from datetime import UTC
from typing import Any

from arq import cron
from arq.connections import RedisSettings
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


def make_queue_name(settings: Settings) -> str:
    """Очередь arq с префиксом приложения: capper:arq:queue."""
    return f"{settings.redis_prefix}arq:queue"


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
