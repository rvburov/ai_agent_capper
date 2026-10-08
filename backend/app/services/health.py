"""Проверка зависимостей для GET /api/health: отвечают ли PostgreSQL и Redis.
Детали ошибок наружу не отдаются, только «ok» или «fail»."""

import asyncio

import structlog
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = structlog.get_logger(__name__)

CHECK_TIMEOUT_SECONDS = 2.0


async def check_database(db: AsyncSession) -> bool:
    try:
        async with asyncio.timeout(CHECK_TIMEOUT_SECONDS):
            await db.execute(text("SELECT 1"))
    except Exception as exc:
        log.warning("health.database_unavailable", error=type(exc).__name__)
        return False
    return True


async def check_redis(redis: Redis) -> bool:
    try:
        async with asyncio.timeout(CHECK_TIMEOUT_SECONDS):
            await redis.ping()
    except Exception as exc:
        log.warning("health.redis_unavailable", error=type(exc).__name__)
        return False
    return True
