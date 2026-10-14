"""Схемы входа, регистрации по приглашению, 2FA и сброса пароля: /api/auth/*."""

import re
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator, BaseModel, StringConstraints, model_validator

from app.schemas.me import MeOut, PasswordStr, TotpCodeStr

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _check_email(value: str) -> str:
    if not _EMAIL_RE.match(value):
        raise ValueError("email")
    return value


def _no_nul(value: str) -> str:
    # PostgreSQL не хранит символ NUL в тексте: без этой проверки запрос падал бы с 500
    if "\x00" in value:
        raise ValueError("nul")
    return value


def _check_tz(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("tz") from None
    return value


# Email при входе не проверяется по формату: ответ на любой неверный ввод одинаковый.
# Отклоняется только символ NUL (422): такого email в базе быть не может
LoginEmailStr = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=320),
    AfterValidator(_no_nul),
]
EmailStr = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=3, max_length=320),
    AfterValidator(_no_nul),
    AfterValidator(_check_email),
]
# Коды CAP-XXXX-XXXX, RST-XXXX-XXXX и резервные xxxx-xxxx: регистр, пробелы и дефисы
# не важны, сервис их нормализует
AccessCodeStr = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=32),
    AfterValidator(_no_nul),
]
DisplayNameStr = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=2, max_length=100),
    AfterValidator(_no_nul),
]
TimeZoneStr = Annotated[str, StringConstraints(max_length=64), AfterValidator(_check_tz)]


class CsrfOut(BaseModel):
    """CSRF-токен: то же значение, что в cookie csrf. Его шлют в заголовке X-CSRF-Token."""

    csrf_token: str


LoginStatus = Literal["ok", "totp_required", "totp_setup_required"]


class LoginIn(BaseModel):
    email: LoginEmailStr
    password: PasswordStr


class LoginOut(BaseModel):
    """ok — вход завершен (user заполнен); totp_required — нужен код 2FA;
    totp_setup_required — нужно настроить 2FA (новый аккаунт или 2FA сброшена)."""

    status: LoginStatus
    user: MeOut | None = None


class TwoFactorIn(BaseModel):
    """Второй шаг входа: код из приложения или один из резервных кодов."""

    code: TotpCodeStr | None = None
    recovery_code: AccessCodeStr | None = None
    remember_device: bool = False

    @model_validator(mode="after")
    def _one_code(self) -> "TwoFactorIn":
        if (self.code is None) == (self.recovery_code is None):
            raise ValueError("code_or_recovery_code")
        return self


class TotpSetupOut(BaseModel):
    """Секрет 2FA для приложения-аутентификатора: строкой, адресом otpauth:// и QR-кодом."""

    secret: str
    otpauth_uri: str
    qr_svg: str


class TotpSetupConfirmIn(BaseModel):
    code: TotpCodeStr


class TotpSetupDoneOut(BaseModel):
    """2FA включена, вход завершен. Резервные коды показываются один раз."""

    status: Literal["ok"]
    user: MeOut
    recovery_codes: list[str]


class RegisterIn(BaseModel):
    invite_code: AccessCodeStr
    email: EmailStr
    display_name: DisplayNameStr
    password: PasswordStr
    accept_terms: bool
    consent_training: bool = False
    # Не передан — часовой пояс по умолчанию из настроек администратора (app_settings)
    tz: TimeZoneStr | None = None


class ResetIn(BaseModel):
    email: LoginEmailStr
    code: AccessCodeStr
    new_password: PasswordStr


class StatusOut(BaseModel):
    status: Literal["ok"]
