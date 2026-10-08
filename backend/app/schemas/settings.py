"""Публичные настройки программы для вошедшего пользователя: GET /api/settings."""

from typing import Literal

from pydantic import BaseModel


class PublicSettingsOut(BaseModel):
    """Валюта программы (Р17): в ней показываются банки, ставки и прибыль у всех."""

    currency: Literal["RUB", "USD", "EUR"]
