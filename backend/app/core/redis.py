"""Клиент Redis (redis.asyncio) и имена ключей.

Все ключи приложения строятся через redis_key(): к ним добавляется settings.redis_prefix.
Так тесты разных исполнителей и окружения не пересекаются в одном Redis.
Клиент отдает строки (decode_responses=True). У arq свой пул соединений.
"""

from redis.asyncio import Redis

from app.core.config import get_settings


def create_redis(url: str | None = None) -> Redis:
    client: Redis = Redis.from_url(
        url or get_settings().redis_url,
        decode_responses=True,
        socket_connect_timeout=3,
        socket_timeout=3,
        health_check_interval=30,
    )
    return client


def redis_key(*parts: str | int) -> str:
    """redis_key("login", "pending", h) → "capper:login:pending:<h>"."""
    return get_settings().redis_prefix + ":".join(str(p) for p in parts)
