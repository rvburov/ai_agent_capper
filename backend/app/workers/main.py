"""Воркер arq: фоновые задачи и расписание (cron).

Запуск:
    python -m app.workers.main            воркер (в docker compose — сервис worker)
    python -m app.workers.main --check    проверка здоровья для healthcheck: 0 — воркер
                                          отмечался в Redis за последнюю минуту, 1 — нет

Своя точка входа вместо команды arq: логи идут через structlog с фильтром секретов
(app.core.logging), как у API. Настройки — те же CAPPER_*: Redis из CAPPER_REDIS_URL,
база из CAPPER_DATABASE_URL. Очередь и все ключи arq (задачи, результаты, повторы,
отметка здоровья) — с префиксом CAPPER_REDIS_PREFIX (app/workers/queue.py): так тесты и
разные окружения в одном Redis не берут чужие задачи и не видят чужих результатов. Ставить
задачи в очередь — только через app.workers.queue.create_queue_pool(): у работающего
воркера этот модуль — __main__, и его импорт из сервиса создал бы вторую копию.

Время в расписании — UTC. Ночная очистка в 03:15 UTC: после бэкапа (01:30 UTC,
deploy/backup/crontab) и до утра в Европе. Обновление данных — в час
CAPPER_DATA_UPDATE_HOUR_UTC (по умолчанию 5) и 25 минут: после очистки и до утра в
Европе. Минуты не нулевые: в начале часа запускается больше всего чужих задач.
Анализ (run_analysis) ставит API, у задачи свой предел 15 минут и нет повтора arq;
уборщик зависших анализов — каждые 5 минут. Прогрев кэша аналитики (warm_analytics)
ставит API после изменения ставок и банка, одна задача на участника; тем, у кого по их
поясу начались новые сутки, — воркер сам, каждый час на 9-й минуте (warm_new_day).
Удаление аккаунтов по запросу участников — раз в сутки в 03:45 UTC (после очистки),
сигналы расхода ИИ — каждый час на 41-й минуте. Этап 5: загруженный файл tennis-data
(process_data_upload) ставит API, у задачи предел часа и повторы, пока идет ночное
обновление; напоминания «ставка ждет результата» и «пора загрузить файл» (в понедельник в
07:04 по поясу администратора) и уборка зависших загрузок файла — каждый час на 4-й минуте.
Волна 2: очередь и пакет разборов ставок — каждые 15 минут с 13-й минуты, сбор пакетов
Batch — каждые 15 минут с 6-й, быструю проверку урока (run_quick_check) ставит API; уроки:
проверка гипотез — раз в сутки в 06:33 UTC (после ночного обновления), перепроверка —
1-го числа в 06:48 UTC. Волна 3: прогон версии на наборе (run_eval) ставит API, следующие
пакеты прогона уходят после сбора предыдущих (сбор пакетов, каждые 15 минут);
перекалибровка базовой модели — по понедельникам в 06:12 UTC. Волна 4: еженедельный отчет —
каждый час на 1-й минуте (тем, у кого по их поясу наступил понедельник 07:00). Этап 6:
push-уведомление (send_push) ставит notify после commit, у задачи предел минуты и нет
повтора arq: подписки после 429 и 5xx задача ставит сама еще раз, один раз.
"""

import argparse
import gc
from collections.abc import Sequence
from datetime import UTC
from typing import Any

from arq import cron
from arq.connections import RedisSettings
from arq.cron import CronJob
from arq.typing import StartupShutdown, WorkerCoroutine
from arq.worker import Function, check_health, run_worker
from arq.worker import func as job_function

from app.agent.client import close_client
from app.core.config import Settings, get_settings
from app.core.logging import setup_logging
from app.db.session import create_engine, create_sessionmaker
from app.services import data_uploads
from app.services.data_status import DATA_UPDATE_MINUTE
from app.workers.jobs import (
    check_ai_alerts,
    check_lessons,
    cleanup_auth_records,
    collect_batches,
    delete_requested_accounts,
    process_data_upload,
    reap_stuck_analyses,
    recalibrate_model,
    recheck_lessons,
    remind_unsettled,
    run_analysis,
    run_eval,
    run_quick_check,
    send_push,
    submit_postmortems,
    update_data,
    warm_analytics,
    warm_new_day,
    weekly_reports,
)
from app.workers.queue import make_queue_name

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
# Файл tennis-data: загрузка, привязка, Эло по всей истории и расчет — до часа; повторы,
# пока идет ночное обновление (каждые 2 минуты, до часа ожидания), и после падения
# воркера (загрузку берет повтор задачи, app/services/data_uploads.py)
UPLOAD_TIMEOUT_SECONDS = data_uploads.PROCESS_TIMEOUT_SECONDS
UPLOAD_MAX_TRIES = 30
# Напоминания — раз в час, на 4-й минуте: свободная от других задач минута в начале часа,
# «пора загрузить файл» приходит в понедельник в 07:04 по поясу администратора
REMIND_MINUTE = 4
# Разборы ставок и пакеты Batch (волна 2) — каждые 15 минут, в свободные минуты
POSTMORTEM_MINUTES = frozenset({13, 28, 43, 58})
COLLECT_MINUTES = frozenset({6, 21, 36, 51})
BATCH_JOB_TIMEOUT_SECONDS = 900
# Быстрая проверка урока: досье 40 матчей и отправка пакета
QUICK_CHECK_TIMEOUT_SECONDS = 900
# Уроки: проверка гипотез — после ночного обновления данных, перепроверка — 1-го числа
LESSONS_HOUR_UTC = 6
LESSONS_MINUTE = 33
RECHECK_DAY = 1
RECHECK_MINUTE = 48
LESSONS_TIMEOUT_SECONDS = 1800
# Прогон версии на наборе: досье до 100 матчей и отправка пакета; дальше — сбор пакетов
EVAL_RUN_TIMEOUT_SECONDS = 900
# Перекалибровка базовой модели — по понедельникам после ночного обновления данных (05:25)
# и до проверки уроков (06:33)
RECALIBRATE_WEEKDAY = 0
RECALIBRATE_HOUR_UTC = 6
RECALIBRATE_MINUTE = 12
RECALIBRATE_TIMEOUT_SECONDS = 1800
# Еженедельный отчет — раз в час, на свободной 1-й минуте: отчет приходит в 07:01 по поясу
# участника (у поясов с получасом — на следующем запуске после 07:00)
WEEKLY_REPORTS_MINUTE = 1
WEEKLY_REPORTS_TIMEOUT_SECONDS = 900
# Push: запросы ко всем устройствам человека сразу, у каждого предел 10 секунд
PUSH_TIMEOUT_SECONDS = 60


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
        cron(remind_unsettled, minute=REMIND_MINUTE, max_tries=1, timeout=300),
        cron(
            submit_postmortems,
            minute=set(POSTMORTEM_MINUTES),
            max_tries=1,
            timeout=BATCH_JOB_TIMEOUT_SECONDS,
        ),
        cron(
            collect_batches,
            minute=set(COLLECT_MINUTES),
            max_tries=1,
            timeout=BATCH_JOB_TIMEOUT_SECONDS,
        ),
        cron(
            check_lessons,
            hour=LESSONS_HOUR_UTC,
            minute=LESSONS_MINUTE,
            max_tries=1,
            timeout=LESSONS_TIMEOUT_SECONDS,
        ),
        cron(
            recheck_lessons,
            day=RECHECK_DAY,
            hour=LESSONS_HOUR_UTC,
            minute=RECHECK_MINUTE,
            max_tries=1,
            timeout=LESSONS_TIMEOUT_SECONDS,
        ),
        cron(
            recalibrate_model,
            weekday=RECALIBRATE_WEEKDAY,
            hour=RECALIBRATE_HOUR_UTC,
            minute=RECALIBRATE_MINUTE,
            max_tries=1,
            timeout=RECALIBRATE_TIMEOUT_SECONDS,
        ),
        cron(
            weekly_reports,
            minute=WEEKLY_REPORTS_MINUTE,
            max_tries=1,
            timeout=WEEKLY_REPORTS_TIMEOUT_SECONDS,
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
        job_function(
            process_data_upload, timeout=UPLOAD_TIMEOUT_SECONDS, max_tries=UPLOAD_MAX_TRIES
        ),
        remind_unsettled,
        submit_postmortems,
        collect_batches,
        job_function(run_quick_check, timeout=QUICK_CHECK_TIMEOUT_SECONDS, max_tries=1),
        check_lessons,
        recheck_lessons,
        job_function(run_eval, timeout=EVAL_RUN_TIMEOUT_SECONDS, max_tries=1),
        recalibrate_model,
        weekly_reports,
        job_function(send_push, timeout=PUSH_TIMEOUT_SECONDS, max_tries=1),
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
