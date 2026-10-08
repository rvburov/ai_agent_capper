"""Чтение настроек программы (app_settings, одна строка id = 1).

Строку создает миграция, поэтому она есть всегда. Меняет настройки кабинет
администратора и команды терминала.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AppSettings

SETTINGS_ROW_ID = 1


async def get_app_settings(db: AsyncSession) -> AppSettings:
    row = await db.get(AppSettings, SETTINGS_ROW_ID)
    if row is None:
        raise RuntimeError("app_settings: нет строки id = 1, примените миграции")
    return row
