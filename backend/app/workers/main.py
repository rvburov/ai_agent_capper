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
deploy/backup/crontab) и до утра в Европе. Обновление данных — в час
CAPPER_DATA_UPDATE_HOUR_UTC (по умолчанию 5) и 25 минут: после очистки и до утра в
Европе. Минуты не нулевые: в начале часа запускается больше всего чужих задач.
Анализ (run_analysis) ставит API, у задачи свой предел 15 минут и нет повтора arq;
уборщик зависших анализов — каждые 5 минут. Прогрев кэша аналитики (warm_analytics)
ставит API после изменения ставок и банка, одна задача на участника; тем, у кого по их
поясу начались новые сутки, — воркер сам, каждый час на 9-й минуте (warm_new_day).
Удаление аккаунтов по запросу участников — раз в сутки в 03:45 UTC (после очистки),
сигналы расхода ИИ — каждый час на 41-й минуте.
"""

import argparse
import gc
from collections.abc import Sequence
from datetime import UTC
from types import FunctionType
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
from arq.worker import func as job_function

from app.agent.client import close_client
from app.core.config import Settings, get_settings
from app.core.logging import setup_logging
from app.db.session import create_engine, create_sessionmaker
from app.services.data_status import DATA_UPDATE_MINUTE
from app.workers.jobs import (
    check_ai_alerts,
    cleanup_auth_records,
    delete_requested_accounts,
    reap_stuck_analyses,
    run_analysis,
    update_data,
    warm_analytics,
    warm_new_day,
)

# Как часто воркер отмечается в Redis (ключ живет на секунду дольше). Healthcheck
# контейнера раз в 30 с, поэтому живой воркер всегда успевает отметиться
HEALTH_CHECK_INTERVAL_SECONDS = 60
CLEANUP_HOUR_UTC = 3
CLEANUP_MINUTE = 15
# Ночное обновление идет секунды-минуты (только текущий год), но пересчет Эло по всей
# истории и медленный источник не должны обрываться на общем пределе задачи
DATA_UPDATE_TIMEOUT_SECONDS = 3600
# Анализ: новости, досье и вызовы Claude с повторами SDK — до 15 минут. Без повтора arq:
# перезапуск идет с чекпойнта по кнопке участника, оплаченные шаги не повторяются
ANALYSIS_TIMEOUT_SECONDS = 900
# Уборщик зависших анализов — каждые 5 минут, со 2-й минуты часа: не совпадает с
# очисткой (:15) и обновлением данных (:25)
REAP_MINUTES = frozenset(range(2, 60, 5))
REAP_TIMEOUT_SECONDS = 60
# Прогрев кэша аналитики: на 10 тыс. ставок бутстрэп идет секунды. Результат не хранится
# (keep_result=0): иначе задача с тем же id участника не ставилась бы до его истечения
WARM_TIMEOUT_SECONDS = 300
# Удаление аккаунтов по запросу — после ночной очистки (03:15), до утра в Европе
ACCOUNT_DELETION_HOUR_UTC = 3
ACCOUNT_DELETION_MINUTE = 45
# Сигналы расхода ИИ — раз в час, на минуте, которая не совпадает с остальными задачами
AI_ALERTS_MINUTE = 41
# Прогрев аналитики тем, у кого по их поясу начались новые сутки, — раз в час
WARM_NEW_DAY_MINUTE = 9
WARM_NEW_DAY_TIMEOUT_SECONDS = 1800


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
# Параметры, у которых очередь по умолчанию — значение константы на момент импорта arq
# (Python вычисляет его при определении функции): Job(job_id, pool) без них искал бы
# задачу в очереди без префикса и для ждущей задачи отвечал not_found
_ARQ_QUEUE_PARAMS: tuple[tuple[object, str], ...] = (
    (arq.jobs.Job.__init__, "_queue_name"),
    (arq.connections.ArqRedis.__init__, "default_queue_name"),
    (arq.connections.create_pool, "default_queue_name"),
    (arq.worker.Worker.__init__, "queue_name"),
)


def _set_param_default(func: object, param: str, value: str) -> None:
    """Новое значение параметра по умолчанию: именованный после * — в __kwdefaults__,
    обычный — в __defaults__ (они выровнены по последним параметрам)."""
    if not isinstance(func, FunctionType):
        raise TypeError(f"{func!r}: ожидается функция")
    kwdefaults = func.__kwdefaults__ or {}
    if param in kwdefaults:
        func.__kwdefaults__ = {**kwdefaults, param: value}
        return
    names = func.__code__.co_varnames[: func.__code__.co_argcount]
    defaults = func.__defaults__ or ()
    index = names.index(param) - (len(names) - len(defaults)) if param in names else -1
    if index < 0:
        raise ValueError(f"{func.__qualname__}: нет параметра {param} со значением по умолчанию")
    func.__defaults__ = (*defaults[:index], value, *defaults[index + 1 :])


def apply_redis_prefix(prefix: str) -> None:
    """Ключи arq с префиксом приложения: capper:arq:job:<id>, capper:arq:result:<id> и т. д.
    Меняются константы модулей и очередь по умолчанию в параметрах Job, ArqRedis,
    create_pool и Worker. Действует на весь процесс (воркер или API); повторный вызов с тем
    же префиксом ничего не меняет. Проверка, что ни один ключ не ушел без префикса, —
    tests/test_workers.py: после обновления arq она покажет, если в нем появились новые
    ключи или параметры."""
    for module in _ARQ_MODULES:
        for name, default in _ARQ_DEFAULT_KEYS.items():
            if hasattr(module, name):
                setattr(module, name, prefix + default)
    queue_name = prefix + _ARQ_DEFAULT_KEYS["default_queue_name"]
    for func, param in _ARQ_QUEUE_PARAMS:
        _set_param_default(func, param, queue_name)


def make_queue_name(settings: Settings) -> str:
    """Очередь arq с префиксом приложения: capper:arq:queue."""
    return f"{settings.redis_prefix}{_ARQ_DEFAULT_KEYS['default_queue_name']}"


# При импорте: WorkerSettings ниже, check_health и create_queue_pool работают уже с префиксом
apply_redis_prefix(get_settings().redis_prefix)


async def create_queue_pool(
    settings: Settings | None = None, *, retries: int | None = None
) -> ArqRedis:
    """Соединение для постановки задач: та же очередь и те же ключи, что у воркера.
    Статус уже поставленной задачи — Job(job_id, pool): очередь по умолчанию у Job тоже
    с префиксом (apply_redis_prefix). retries — попыток соединиться (по умолчанию arq —
    5 раз с паузой в секунду); 0 — для необязательных задач вроде прогрева кэша."""
    settings = settings or get_settings()
    apply_redis_prefix(settings.redis_prefix)
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    if retries is not None:
        redis_settings.conn_retries = retries
    return await create_pool(redis_settings, default_queue_name=make_queue_name(settings))


async def startup(ctx: dict[Any, Any]) -> None:
    """Один движок БД на воркер; задачи берут сеанс из ctx["sessionmaker"]. Объекты,
    созданные при запуске (модули, схемы), — вне сборки мусора (gc.freeze): полная сборка
    по ним идет сотни миллисекунд и останавливала бы цикл событий посреди задач."""
    gc.freeze()
    engine = create_engine()
    ctx["engine"] = engine
    ctx["sessionmaker"] = create_sessionmaker(engine)


async def shutdown(ctx: dict[Any, Any]) -> None:
    await close_client()
    engine = ctx.get("engine")
    if engine is not None:
        await engine.dispose()


def build_cron_jobs(settings: Settings) -> tuple[CronJob, ...] | None:
    """Расписание воркера; CAPPER_WORKER_CRON=false выключает его целиком (стек
    сквозных тестов: ночная загрузка архивов не должна начаться посреди прогона)."""
    if not settings.worker_cron:
        return None
    return (
        cron(
            cleanup_auth_records,
            hour=CLEANUP_HOUR_UTC,
            minute=CLEANUP_MINUTE,
            # Повтор той же ночью не нужен: следующая очистка — через сутки
            max_tries=1,
            timeout=600,
        ),
        cron(
            update_data,
            hour=settings.data_update_hour_utc,
            minute=DATA_UPDATE_MINUTE,
            # Шаг с ошибкой уже записан в ingestion_runs, повтор — следующей ночью;
            # о давно не обновленных данных администраторам скажет data_stale
            max_tries=1,
            timeout=DATA_UPDATE_TIMEOUT_SECONDS,
        ),
        cron(
            reap_stuck_analyses,
            minute=set(REAP_MINUTES),
            max_tries=1,
            timeout=REAP_TIMEOUT_SECONDS,
        ),
        cron(
            delete_requested_accounts,
            hour=ACCOUNT_DELETION_HOUR_UTC,
            minute=ACCOUNT_DELETION_MINUTE,
            # Не удалось — следующей ночью: запрос на удаление остается в базе
            max_tries=1,
            timeout=600,
        ),
        cron(check_ai_alerts, minute=AI_ALERTS_MINUTE, max_tries=1, timeout=120),
        cron(
            warm_new_day,
            minute=WARM_NEW_DAY_MINUTE,
            max_tries=1,
            timeout=WARM_NEW_DAY_TIMEOUT_SECONDS,
        ),
    )


class WorkerSettings:
    """Настройки воркера для arq (arq читает атрибуты класса)."""

    functions: Sequence[WorkerCoroutine | Function] = (
        cleanup_auth_records,
        update_data,
        job_function(run_analysis, timeout=ANALYSIS_TIMEOUT_SECONDS, max_tries=1),
        reap_stuck_analyses,
        job_function(warm_analytics, timeout=WARM_TIMEOUT_SECONDS, max_tries=1, keep_result=0),
        delete_requested_accounts,
        check_ai_alerts,
    )
    cron_jobs: Sequence[CronJob] | None = build_cron_jobs(get_settings())
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
