"""Общие схемы API: формат ошибки и проверка здоровья."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class ErrorField(BaseModel):
    """Поле с ошибкой проверки (только при code = validation)."""

    loc: list[str | int]
    code: str


class ErrorDetail(BaseModel):
    # Ключ ошибки (например auth.invalid_credentials) и текст для человека.
    # Дополнительные поля зависят от ошибки: retry_after (с), fields и т. п.
    model_config = ConfigDict(extra="allow")

    code: str
    message: str
    retry_after: int | None = None
    fields: list[ErrorField] | None = None


class ErrorOut(BaseModel):
    """Тело любого ответа с ошибкой: {"error": {"code", "message", ...}}."""

    error: ErrorDetail


CheckState = Literal["ok", "fail"]


class HealthOut(BaseModel):
    status: Literal["ok", "degraded"]
    version: str
    db: CheckState
    redis: CheckState
