"""Сборка маршрутов /api. Новый раздел: файл в app/api/routes/ и строка здесь.

Разделы этапа 1 уже подключены (auth, me, settings, admin), исполнители заполняют
свои файлы в routes/ и этот файл не правят.
Ответ с ошибкой у всех маршрутов один (ErrorOut), он описан в OpenAPI как 4XX.
"""

from typing import Any

from fastapi import APIRouter

from app.api.routes import (
    admin,
    admin_ai,
    admin_data,
    admin_learning,
    admin_messages,
    admin_settings,
    ai,
    analyses,
    analytics,
    auth,
    bank,
    bets,
    bookmakers,
    dashboard,
    health,
    learning,
    lessons,
    me,
    players,
    push,
    settings,
    strategy,
)
from app.schemas.common import ErrorOut

ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    "4XX": {"model": ErrorOut, "description": "Ошибка: {error: {code, message}}"},
}

api_router = APIRouter(responses=ERROR_RESPONSES)
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(me.router)
api_router.include_router(push.router)
api_router.include_router(bookmakers.router)
api_router.include_router(settings.router)
api_router.include_router(admin.router)
api_router.include_router(ai.router)
api_router.include_router(admin_ai.router)
api_router.include_router(admin_settings.router)
api_router.include_router(admin_messages.router)
api_router.include_router(admin_data.router)
api_router.include_router(admin_learning.router)
api_router.include_router(analyses.router)
api_router.include_router(bets.router)
api_router.include_router(bank.router)
api_router.include_router(analytics.router)
api_router.include_router(dashboard.router)
api_router.include_router(players.router)
api_router.include_router(strategy.router)
api_router.include_router(lessons.router)
api_router.include_router(learning.router)
