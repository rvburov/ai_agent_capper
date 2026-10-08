"""Проверка, что сервер жив. Ее вызывают Caddy и деплой после перезапуска."""

from fastapi import APIRouter
from pydantic import BaseModel

from app.core.config import get_settings

router = APIRouter(tags=["health"])


class HealthOut(BaseModel):
    status: str
    version: str


@router.get("/health")
async def health() -> HealthOut:
    return HealthOut(status="ok", version=get_settings().version)
