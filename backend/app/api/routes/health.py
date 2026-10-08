"""Проверка, что сервер жив. Ее вызывают Caddy и деплой после перезапуска.

200 и status = ok — PostgreSQL и Redis отвечают; 503 и status = degraded — нет.
Причины сбоя наружу не отдаются (они в логе сервера).
"""

from fastapi import APIRouter, Response

from app.core.config import get_settings
from app.core.deps import DbSession, RedisClient
from app.schemas.common import HealthOut
from app.services import health as health_service

router = APIRouter(tags=["health"])


@router.get("/health", responses={503: {"model": HealthOut}})
async def health(db: DbSession, redis: RedisClient, response: Response) -> HealthOut:
    db_ok = await health_service.check_database(db)
    redis_ok = await health_service.check_redis(redis)
    out = HealthOut(
        status="ok" if db_ok and redis_ok else "degraded",
        version=get_settings().version,
        db="ok" if db_ok else "fail",
        redis="ok" if redis_ok else "fail",
    )
    if out.status != "ok":
        response.status_code = 503
    return out
