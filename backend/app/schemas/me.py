"""Схемы личного кабинета: /api/me/* (профиль, пароль, сеансы, журнал входов,
резервные коды, доверенные устройства, уведомления)."""

from datetime import datetime
from functools import cache
from typing import Annotated, Literal
from zoneinfo import available_timezones

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints

from app.core.useragent import device_label
from app.db.models import LoginEvent

# Пароль проверяется по длине в сервисе (errors.auth.password_too_short/long), здесь —
# только защита от огромного тела запроса
PasswordStr = Annotated[str, StringConstraints(min_length=1, max_length=4096)]
# Код 2FA из приложения: ровно 6 цифр ASCII
TotpCodeStr = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[0-9]{6}$")]

Role = Literal["admin", "member"]
UserStatus = Literal["active", "blocked", "deleted"]
AiMode = Literal["shared", "own"]
LoginResult = Literal["ok", "bad_password", "bad_totp", "bad_recovery", "rate_limited", "blocked"]
LoginMethod = Literal["password", "totp", "recovery", "trusted_device"]


class MeOut(BaseModel):
    """Вошедший пользователь."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    display_name: str
    role: Role
    status: UserStatus
    ai_mode: AiMode
    tz: str
    totp_enabled: bool
    created_at: datetime
    # Согласие на обезличенные прогнозы для общей модели (Р15)
    consent_training: bool
    # Удаление аккаунта самим участником (В10): когда попросил и когда удалится. Пока
    # запрос действует, открыт только этот адрес и отмена (DELETE /api/me/deletion)
    deletion_requested_at: datetime | None
    deletion_at: datetime | None


# Не пояса, а служебные файлы базы: «localtime» — пояс самого сервера (на части систем
# лежит в /usr/share/zoneinfo), «Factory» — заглушка без смещения
_NOT_TIMEZONES = frozenset({"localtime", "Factory"})


@cache
def _known_timezones() -> frozenset[str]:
    # Список поясов читается с диска (tzdata) один раз за процесс
    return frozenset(available_timezones()) - _NOT_TIMEZONES


def _check_profile_name(value: str) -> str:
    # PostgreSQL не хранит символ NUL в тексте: без проверки был бы ответ 500
    if "\x00" in value:
        raise ValueError("nul")
    return value


def _check_profile_tz(value: str) -> str:
    # Только имена из базы поясов IANA: «Europe/Helsinki», а не путь к файлу или «localtime»
    if value not in _known_timezones():
        raise ValueError("tz")
    return value


ProfileNameStr = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=2, max_length=100),
    AfterValidator(_check_profile_name),
]
ProfileTimeZoneStr = Annotated[
    str, StringConstraints(max_length=64), AfterValidator(_check_profile_tz)
]


class ProfileUpdateIn(BaseModel):
    """Правка профиля: имя, часовой пояс и согласие на обезличенные прогнозы (Р15). Поле
    не передано (или null) — не меняется. Остальные поля (email, роль, режим ключа) так
    не меняются: лишнее поле — 422."""

    model_config = ConfigDict(extra="forbid")

    display_name: ProfileNameStr | None = None
    tz: ProfileTimeZoneStr | None = None
    consent_training: bool | None = None


class RecoveryCodesStatusOut(BaseModel):
    """Сколько резервных кодов еще не использовано и когда выпущены нынешние.
    Нет кодов — left = total = 0, created_at = null."""

    left: int
    total: int
    created_at: datetime | None


class PasswordChangeIn(BaseModel):
    current_password: PasswordStr
    new_password: PasswordStr


class SessionOut(BaseModel):
    """Действующий сеанс. device_label пустой — устройство не распознано."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    device_label: str
    ip: str | None
    created_at: datetime
    last_seen_at: datetime
    current: bool = False


class LoginEventOut(BaseModel):
    """Запись журнала входов (за 90 дней). Ее же показывает кабинет администратора."""

    at: datetime
    ip: str | None
    device_label: str
    result: LoginResult
    method: LoginMethod

    @classmethod
    def from_row(cls, event: LoginEvent) -> "LoginEventOut":
        return cls.model_validate(
            {
                "at": event.at,
                "ip": event.ip,
                "device_label": device_label(event.user_agent),
                "result": event.result,
                "method": event.method,
            }
        )


class RecoveryCodesIn(BaseModel):
    """Текущий код 2FA: перевыпуск резервных кодов — действие с подтверждением."""

    code: TotpCodeStr


class RecoveryCodesOut(BaseModel):
    """Новые резервные коды. Показываются один раз, в БД — только хеши."""

    recovery_codes: list[str]


class TrustedDeviceOut(BaseModel):
    """Устройство, на котором вход не спрашивает код 2FA (до expires_at)."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    device_label: str
    ip: str | None
    created_at: datetime
    last_used_at: datetime | None
    expires_at: datetime
    current: bool = False


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    title: str
    body: str
    link: str | None
    created_at: datetime
    read_at: datetime | None


class NotificationsOut(BaseModel):
    items: list[NotificationOut]
    # Сколько всего непрочитанных (не только среди items)
    unread: int
