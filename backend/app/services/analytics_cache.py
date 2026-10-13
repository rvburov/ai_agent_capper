"""Кэш аналитики и главной в Redis (решение Т15): бутстрэп на тысячах ставок идет секунды,
а экран должен открываться за 200 мс.

Ключ — участник, вид ответа (analytics, dashboard), фильтры и версия данных: последняя
запись журнала банка, последнее изменение и число ставок, сумма номеров матчей их ног
(слияние матчей переносит ногу на другой матч), последняя замена прогноза (supersedes),
последняя загрузка архива (она меняет турниры и покрытия матчей), активная версия
стратегии, валюта, пояс и сегодняшний день по нему (периоды считаются от сегодня) и
версия кода расчета — хеш исходников модулей расчета и схем ответа: новая выкладка не
читает ответы прежнего кода (Redis с AOF переживает перезапуск). Запись, которую не
удалось разобрать по схеме, считается промахом: она удаляется и считается заново.

Новый анализ кэш не сбрасывает: его прогнозы попадают в аналитику только со ставкой. Любое
изменение денег или ставок дает новый ключ: старый ответ больше не читается и истекает сам
(TTL сутки). Отдельно сбрасывать кэш не нужно, кроме удаления участника: его ответы —
личные данные, они удаляются сразу (clear_user), а метка удаления не дает записать ответ
расчету, который шел в этот момент.

Один ключ считается один раз: первый расчет берет замок (SET NX), остальные — запросы
участника и прогрев воркера — ждут его ответ. Холодных расчетов в процессе одновременно
не больше COMPUTE_SLOTS: они занимают процессор, а цикл событий обслуживает всех.

Прогрев: после расчета, сторно, закрывающего кэфа, новой ставки и движения банка API
ставит задачу воркера warm_analytics (request_warm), и она считает набор «без фильтров» —
аналитику за все время и главную за 30 дней. Задача одна на участника: повтор, пока она
ждет в очереди или идет, не ставится (тот же id задачи, отложена на WARM_DELAY); если
данные изменились, пока задача считала, она считает еще раз (app/workers/jobs.py).
Прогрев — только ускорение: если Redis или очередь недоступны, экран посчитает сам.
"""

import asyncio
import hashlib
import importlib
import json
import secrets
import time
import weakref
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any, cast

import structlog
from pydantic import BaseModel, ValidationError
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.redis import redis_key
from app.db.models import (
    BankrollLedger,
    Bet,
    BetLeg,
    IngestionRun,
    Prediction,
    StrategyVersion,
    User,
)
from app.services.app_settings import get_app_settings
from app.services.bank import local_today, user_zone
from app.services.sessions import utcnow

log = structlog.get_logger(__name__)

TTL = timedelta(days=1)
WARM_DELAY = timedelta(seconds=2)
WARM_JOB = "warm_analytics"
# Сколько ждать очередь задач: прогрев не должен задерживать ответ участнику
WARM_TIMEOUT_SECONDS = 2.0
# Удаление ключей участника — пачками
_SCAN_COUNT = 500
# Холодных расчетов в процессе одновременно (бутстрэп и сбор строк держат процессор)
COMPUTE_SLOTS = 2
# Замок расчета ключа: живет дольше самого долгого расчета (10 тыс. ставок — около 5 с);
# ждущий проверяет ответ каждые LOCK_POLL и после LOCK_WAIT считает сам
LOCK_TTL = timedelta(seconds=60)
LOCK_POLL_SECONDS = 0.1
LOCK_WAIT_SECONDS = 30.0
# Метка удаленного участника: ответы, посчитанные после удаления, не записываются
GONE_TTL = timedelta(days=1)

# Модули, от кода которых зависят числа и форма ответа: их исходники входят в версию
_CODE_MODULES = (
    "app.services.analytics",
    "app.services.analytics_cache",
    "app.services.dashboard",
    "app.services.bank",
    "app.services.bets",
    "app.services.strategy_versions",
    "app.ml.metrics",
    "app.ml.strategy",
    "app.schemas.analytics",
    "app.schemas.dashboard",
    "app.schemas.bets",
)
# Запись ответа — только если участник не удален (метка KEYS[2]); атомарно
_SET_IF_PRESENT_USER = """
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
"""
# Снять замок, только если он свой
_RELEASE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"""


def _prefix(user_id: int) -> str:
    return redis_key("analytics", user_id)


def _gone_key(user_id: int) -> str:
    # Вне префикса ответов: clear_user удаляет ответы, но не метку
    return redis_key("analytics-gone", user_id)


@cache
def code_version() -> str:
    """Версия кода расчета: хеш исходников модулей расчета и схем ответа, JSON-схемы
    ответов и версии приложения. Меняется с любой выкладкой, которая трогает расчет."""
    from app.schemas.analytics import AnalyticsOut
    from app.schemas.dashboard import DashboardCoreOut

    digest = hashlib.sha256(get_settings().version.encode())
    for name in _CODE_MODULES:
        digest.update(name.encode())
        path = getattr(importlib.import_module(name), "__file__", None)
        if path:
            digest.update(Path(path).read_bytes())
    for model in (AnalyticsOut, DashboardCoreOut):
        schema = json.dumps(model.model_json_schema(), sort_keys=True)
        digest.update(schema.encode())
    return digest.hexdigest()[:16]


async def data_version(db: AsyncSession, user: User, *, now: datetime | None = None) -> str:
    """Версия данных участника для ключа кэша (один запрос)."""
    uid = user.id
    row = (
        await db.execute(
            select(
                select(func.max(BankrollLedger.id))
                .where(BankrollLedger.user_id == uid)
                .scalar_subquery(),
                select(func.max(Bet.updated_at)).where(Bet.user_id == uid).scalar_subquery(),
                select(func.count()).select_from(Bet).where(Bet.user_id == uid).scalar_subquery(),
                # Слияние матчей (загрузчики, привязка бота, matches-merge) переносит ногу на
                # другой матч: меняются покрытие, турнир и начало матча
                select(func.sum(BetLeg.match_id))
                .join(Bet, Bet.id == BetLeg.bet_id)
                .where(Bet.user_id == uid)
                .scalar_subquery(),
                # Замены прогнозов (supersedes) меняют калибровку; новые анализы — нет
                select(func.max(Prediction.id))
                .where(Prediction.user_id == uid, Prediction.supersedes.is_not(None))
                .scalar_subquery(),
                # Загрузка архива меняет турниры и покрытия матчей ног
                select(func.max(IngestionRun.finished_at)).scalar_subquery(),
                select(StrategyVersion.id)
                .where(StrategyVersion.user_id == uid, StrategyVersion.status == "active")
                .limit(1)
                .scalar_subquery(),
            )
        )
    ).one()
    settings = await get_app_settings(db)
    zone = user_zone(user.tz)
    today: date = local_today(zone, now or utcnow())
    ledger, updated, count, legs, prediction, loaded, strategy = row
    parts = [
        code_version(),
        ledger,
        updated.isoformat() if updated is not None else None,
        count,
        legs,
        prediction,
        loaded.isoformat() if loaded is not None else None,
        strategy,
        settings.currency,
        zone.key,
        today.isoformat(),
    ]
    return json.dumps(parts, default=str)


def cache_key(user_id: int, kind: str, params: BaseModel, version: str) -> str:
    """Ключ ответа: участник, вид, фильтры (в каноническом виде) и версия данных."""
    payload = json.dumps(
        {"params": params.model_dump(mode="json", by_alias=True), "version": version},
        sort_keys=True,
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]
    return f"{_prefix(user_id)}:{kind}:{digest}"


# --- расчет: не больше COMPUTE_SLOTS в процессе ---

_slots: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


@asynccontextmanager
async def compute_slot() -> AsyncIterator[None]:
    """Место для холодного расчета (свой семафор у каждого цикла событий)."""
    loop = asyncio.get_running_loop()
    slots = _slots.get(loop)
    if slots is None:
        slots = _slots[loop] = asyncio.Semaphore(COMPUTE_SLOTS)
    async with slots:
        yield


# --- чтение и запись ---


async def _read(redis: Redis, key: str, model: type[BaseModel]) -> str | None:
    """Ответ из кэша, разобранный по схеме. Ошибка Redis — промах; запись другой формы —
    промах, она удаляется."""
    try:
        found = await redis.get(key)
    except RedisError as exc:
        log.warning("analytics.cache_read_failed", error=str(exc))
        return None
    if found is None:
        return None
    text = str(found)
    try:
        model.model_validate_json(text)
    except ValidationError as exc:
        log.warning("analytics.cache_bad_entry", key=key, errors=exc.error_count())
        with suppress(RedisError):
            await redis.delete(key)
        return None
    return text


async def _lock(redis: Redis, key: str) -> str | None:
    """Замок расчета ключа: свой токен или None (замок у другого, или Redis недоступен —
    тогда считаем без замка)."""
    token = secrets.token_hex(8)
    try:
        taken = await redis.set(f"{key}:lock", token, nx=True, ex=LOCK_TTL)
    except RedisError:
        return token
    return token if taken else None


async def _release(redis: Redis, key: str, token: str) -> None:
    try:
        await cast(Any, redis.eval(_RELEASE, 1, f"{key}:lock", token))
    except RedisError as exc:
        log.warning("analytics.cache_unlock_failed", error=str(exc))


async def _wait(redis: Redis, key: str, model: type[BaseModel]) -> str | None:
    """Ждать ответ расчета, у которого замок: ответ, или None — замок снят без ответа
    (расчет упал) или ждали дольше LOCK_WAIT."""
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while time.monotonic() < deadline:
        await asyncio.sleep(LOCK_POLL_SECONDS)
        found = await _read(redis, key, model)
        if found is not None:
            return found
        try:
            locked = await redis.exists(f"{key}:lock")
        except RedisError:
            return None
        if not locked:
            return await _read(redis, key, model)
    return None


async def _write(redis: Redis, user_id: int, key: str, text: str) -> None:
    try:
        await cast(
            Any,
            redis.eval(
                _SET_IF_PRESENT_USER,
                2,
                key,
                _gone_key(user_id),
                text,
                str(int(TTL.total_seconds())),
            ),
        )
    except RedisError as exc:
        log.warning("analytics.cache_write_failed", error=str(exc))


async def cached_json(
    redis: Redis | None,
    user_id: int,
    key: str,
    model: type[BaseModel],
    compute: Callable[[], Awaitable[BaseModel]],
) -> str:
    """Ответ из кэша или посчитанный и сохраненный (JSON схемы model). Один ключ считается
    один раз: остальные ждут ответ того, кто взял замок. Ошибка Redis не мешает ответу:
    он считается без кэша."""
    if redis is None:
        async with compute_slot():
            return (await compute()).model_dump_json()
    found = await _read(redis, key, model)
    if found is not None:
        return found
    token = await _lock(redis, key)
    if token is None:
        found = await _wait(redis, key, model)
        if found is not None:
            return found
        token = await _lock(redis, key)
    try:
        async with compute_slot():
            text = (await compute()).model_dump_json()
        await _write(redis, user_id, key, text)
        return text
    finally:
        if token is not None:
            await _release(redis, key, token)


async def clear_user(redis: Redis, user_id: int) -> int:
    """Удалить все ответы участника (удаление аккаунта). Сначала метка удаления: расчет,
    который идет сейчас, свой ответ уже не запишет. Возвращает число ключей."""
    await redis.set(_gone_key(user_id), "1", ex=GONE_TTL)
    removed = 0
    batch: list[str] = []
    async for key in redis.scan_iter(match=f"{_prefix(user_id)}:*", count=_SCAN_COUNT):
        batch.append(str(key))
        if len(batch) >= _SCAN_COUNT:
            removed += int(await redis.delete(*batch))
            batch = []
    if batch:
        removed += int(await redis.delete(*batch))
    return removed


async def request_warm(user_id: int) -> None:
    """Поставить прогрев аналитики участника (не чаще одной задачи в очереди). Сбой
    очереди не роняет запрос: прогрев — только ускорение."""
    # Модуль воркера тянет загрузчики данных: API грузит его при первом прогреве
    from app.workers.main import create_queue_pool

    async def enqueue() -> Any:
        pool = await create_queue_pool(retries=0)
        try:
            return await pool.enqueue_job(
                WARM_JOB, user_id, _job_id=f"{WARM_JOB}:{user_id}", _defer_by=WARM_DELAY
            )
        finally:
            await pool.aclose()

    try:
        await asyncio.wait_for(enqueue(), timeout=WARM_TIMEOUT_SECONDS)
    except (TimeoutError, OSError, RedisError) as exc:
        log.warning("analytics.warm_enqueue_failed", user_id=user_id, error=str(exc))
