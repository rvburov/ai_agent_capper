"""Публичные настройки программы для вошедшего пользователя: GET /api/settings
(валюта программы). Меняет их администратор в своем кабинете."""

from fastapi import APIRouter

from app.core.deps import CurrentUser, DbSession
from app.schemas.settings import PublicSettingsOut
from app.services.app_settings import get_app_settings

router = APIRouter(tags=["settings"])


@router.get("/settings")
async def public_settings(user: CurrentUser, db: DbSession) -> PublicSettingsOut:
    row = await get_app_settings(db)
    return PublicSettingsOut.model_validate({"currency": row.currency})
