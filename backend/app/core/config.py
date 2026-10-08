"""Настройки из переменных окружения (файл .env в корне репозитория или в backend/).

Здесь только то, что нужно для запуска. Настройки, которые меняет администратор
(валюта программы, бюджет и лимиты Claude, ключ администратора), хранятся в базе
и редактируются в кабинете администратора.
"""

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CAPPER_",
        env_file=("../.env", ".env"),
        extra="ignore",
    )

    env: Literal["dev", "test", "prod"] = "dev"
    version: str = "0.1.0"
    database_url: str = "postgresql+asyncpg://capper:capper@localhost:5432/capper"
    redis_url: str = "redis://localhost:6379/0"
    secret_key: SecretStr = SecretStr("")


@lru_cache
def get_settings() -> Settings:
    return Settings()
