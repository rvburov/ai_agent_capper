"""Общие схемы API: формат ошибки и проверка здоровья."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

# Query-параметр просмотра данных участника администратором (Р27, app/core/deps.py)
AS_USER_QUERY = "as_user"


def without_as_user(data: Any) -> Any:
    """Входные данные query-модели фильтров без as_user. Модели с extra="forbid" иначе
    отклонили бы его: as_user читает зависимость просмотра, а не модель."""
    if isinstance(data, dict) and AS_USER_QUERY in data:
        return {key: value for key, value in data.items() if key != AS_USER_QUERY}
    return data


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
