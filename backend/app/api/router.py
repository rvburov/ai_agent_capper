"""Сборка маршрутов. Новый раздел: файл в app/api/routes/ и строка здесь."""

from fastapi import APIRouter

from app.api.routes import health

api_router = APIRouter()
api_router.include_router(health.router)
