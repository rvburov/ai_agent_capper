"""Настройки из переменных окружения (файл .env в корне репозитория или в backend/).

Здесь только то, что нужно для запуска. Настройки, которые меняет администратор
(валюта программы, бюджет и лимиты Claude, ключ администратора), хранятся в базе
(`app_settings`) и редактируются в кабинете администратора.
"""

import base64
import binascii
import hashlib
import re
from functools import lru_cache
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.i18n import t
from app.core.vapid import keys_match

# Значения только для разработки и тестов, они лежат в открытом репозитории. Годятся только
# для запуска на http://localhost; в prod и на любом другом адресе нужны свои ключи.
_DEV_SECRET_KEY = b"capper-dev-secret-key-not-for-production"
_DEV_MASTER_KEY = hashlib.sha256(b"capper-dev-master-key-not-for-production").digest()
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
MIN_SECRET_KEY_LENGTH = 32
# Контакт VAPID (RFC 8292): mailto: с адресом почты или https:// с адресом сайта без пути —
# та же проверка, что у подписи py_vapid
VAPID_SUBJECT = re.compile(
    r"^(mailto:[^@\s]+@(localhost|[\w%-]+(\.[\w%-]+)+)|https://(localhost|[\w-]+\.[\w.-]+))$"
)
# Серверы push браузеров (Web Push): Chrome, Android, Opera, Яндекс — FCM, Firefox — Mozilla,
# Safari — Apple, Edge — Windows. Подписка на другой адрес не принимается: сервер не шлет
# запросы куда попало. Совпадение — сам адрес или его поддомен
DEFAULT_PUSH_HOSTS = (
    "fcm.googleapis.com,android.googleapis.com,push.services.mozilla.com,"
    "push.apple.com,notify.windows.com"
)


def is_local_origin(origin: str) -> bool:
    """http://localhost, http://127.0.0.1 или http://[::1] с любым портом."""
    parts = urlsplit(origin)
    return parts.scheme == "http" and (parts.hostname or "") in _LOCAL_HOSTS


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="CAPPER_",
        env_file=("../.env", ".env"),
        extra="ignore",
    )

    env: Literal["dev", "test", "prod"] = "dev"
    version: str = "0.1.0"
    log_level: str = "INFO"

    database_url: str = "postgresql+asyncpg://capper:capper@localhost:5432/capper"
    redis_url: str = "redis://localhost:6379/0"
    # Все ключи Redis приложения начинаются с этого префикса (у тестов свой)
    redis_prefix: str = "capper:"

    # Ключ для HMAC кодов доступа; в prod обязателен, не короче 32 символов
    secret_key: SecretStr = SecretStr("")
    # Мастер-ключи AES-256-GCM: "версия:base64(32 байта)" через запятую, последний — текущий
    master_keys: SecretStr = SecretStr("")

    # Адрес сайта, как его видит браузер. С ним сверяется заголовок Origin
    public_origin: str = "http://localhost:5173"
    # Secure и префикс __Host- у cookie. По умолчанию True в prod, False в dev и test
    cookie_secure: bool = False
    # Проверка пароля по Have I Been Pwned. По умолчанию True в prod
    hibp_enabled: bool = False

    session_idle_days: int = 14
    session_absolute_days: int = 30
    trusted_device_days: int = 30
    login_pending_minutes: int = 5
    invite_days: int = 7
    reset_code_hours: int = 24
    # Сколько хешей пароля Argon2 (64 МиБ каждый) считается одновременно. Обычно число
    # vCPU сервера; остальные проверки пароля ждут очереди (app/core/security/passwords.py)
    password_hash_slots: int = 2

    # Адреса и сети прокси (Caddy) через запятую, которым приложение верит в
    # X-Forwarded-For и X-Forwarded-Proto (ProxyHeadersMiddleware в create_app)
    trusted_proxies: str = "127.0.0.1"

    # Архивы матчей и кэфов (этап 2, app/ingest). Адреса меняются, если источник переедет;
    # без сети те же файлы берутся из папки (--dir у команды загрузки). Сакманн убрал
    # tennis_atp с GitHub в сентябре 2026: по умолчанию — архивная копия (снимок июня 2026)
    sackmann_base_url: str = (
        "https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main/atp"
    )
    tennis_data_base_url: str = "http://www.tennis-data.co.uk"
    # Первый год архива Сакманна и tennis-data (более ранние файлы tennis-data — .xls,
    # их не берем)
    data_first_year: int = Field(default=2000, ge=1968)
    tennis_data_first_year: int = Field(default=2013, ge=2013)
    # Час (UTC) ночного обновления данных воркером
    data_update_hour_utc: int = Field(default=5, ge=0, le=23)
    # Расписание воркера (очистка, ночное обновление данных, уборщик анализов). false —
    # только задачи из очереди: стек сквозных тестов не качает архивы посреди прогона
    worker_cron: bool = True

    # Адрес Claude API. Меняется только для локальных прогонов без ключа: поддельный
    # сервер tests/fake_claude.py. В prod — только https (ключ уходит в заголовке)
    anthropic_base_url: str = "https://api.anthropic.com"

    # Push-уведомления браузера (Web Push, этап 6): ключи VAPID. Без них приложение работает,
    # push выключен (GET /api/me/push-config отвечает null). Новые ключи:
    # python -m app.admin.cli generate-vapid. Закрытый ключ в логи и ответы не попадает
    vapid_public_key: str = ""
    vapid_private_key: SecretStr = SecretStr("")
    # Контакт для сервисов push: mailto:<email администратора> или https://<сайт>
    vapid_subject: str = ""
    # Подписка с адресом http:// и на любом сервере — только localhost, тесты и стек
    # сквозных тестов (поддельный сервис push). В prod запрещено
    push_allow_http: bool = False
    # Серверы push, которым приложение шлет уведомления, через запятую
    push_service_hosts: str = DEFAULT_PUSH_HOSTS

    # Только для тестов: подключение к служебной базе, из которой создается тестовая
    test_admin_database_url: str = "postgresql://capper:capper@localhost:5432/postgres"

    @model_validator(mode="before")
    @classmethod
    def _prod_defaults(cls, data: Any) -> Any:
        # В prod cookie_secure и hibp_enabled включены, если не заданы явно
        if isinstance(data, dict) and str(data.get("env", "")).lower() == "prod":
            data.setdefault("cookie_secure", True)
            data.setdefault("hibp_enabled", True)
        return data

    @model_validator(mode="after")
    def _check_secrets(self) -> "Settings":
        self._check_vapid()
        if self.env != "prod":
            return self._check_dev_keys()
        if self.push_allow_http:
            raise ValueError(t("config.push_allow_http_prod"))
        if len(self.secret_key.get_secret_value()) < MIN_SECRET_KEY_LENGTH:
            raise ValueError(t("config.secret_key_required"))
        if not self.master_keys.get_secret_value().strip():
            raise ValueError(t("config.master_keys_required"))
        parse_master_keys(self.master_keys.get_secret_value())
        if not self.public_origin.startswith("https://"):
            raise ValueError(t("config.public_origin_https"))
        if not self.cookie_secure:
            raise ValueError(t("config.cookie_secure_required"))
        if not self.anthropic_base_url.startswith("https://"):
            raise ValueError(t("config.anthropic_base_url_https"))
        return self

    def _check_dev_keys(self) -> "Settings":
        """dev и test: без своих ключей — только локальный запуск. Если забыли
        CAPPER_ENV=prod на сервере, приложение не стартует с открытыми ключами."""
        if is_local_origin(self.public_origin) and not self.cookie_secure:
            return self
        if len(self.secret_key.get_secret_value()) < MIN_SECRET_KEY_LENGTH:
            raise ValueError(t("config.dev_keys_local_only", name="CAPPER_SECRET_KEY"))
        if not self.master_keys.get_secret_value().strip():
            raise ValueError(t("config.dev_keys_local_only", name="CAPPER_MASTER_KEYS"))
        parse_master_keys(self.master_keys.get_secret_value())
        return self

    def _check_vapid(self) -> None:
        """Ключи VAPID: все три настройки или ни одной; ключи — пара P-256."""
        values = (
            self.vapid_public_key.strip(),
            self.vapid_private_key.get_secret_value().strip(),
            self.vapid_subject.strip(),
        )
        if not any(values):
            return
        if not all(values):
            raise ValueError(t("config.vapid_incomplete"))
        if not keys_match(values[0], values[1]):
            raise ValueError(t("config.vapid_keys"))
        if not VAPID_SUBJECT.match(values[2]):
            raise ValueError(t("config.vapid_subject"))

    @property
    def push_enabled(self) -> bool:
        """Push включен: ключи VAPID заданы (их проверяет _check_vapid)."""
        return bool(self.vapid_public_key.strip())

    @property
    def push_hosts(self) -> tuple[str, ...]:
        return tuple(
            host.strip().lower() for host in self.push_service_hosts.split(",") if host.strip()
        )

    @property
    def secret_key_bytes(self) -> bytes:
        """Ключ HMAC. В dev и test без настройки берется значение для разработки."""
        value = self.secret_key.get_secret_value()
        if value:
            return value.encode()
        return _DEV_SECRET_KEY

    @property
    def master_key_map(self) -> dict[int, bytes]:
        """Мастер-ключи по версиям, в порядке из настройки (последний — текущий)."""
        value = self.master_keys.get_secret_value().strip()
        if not value:
            if self.env == "prod":
                raise ValueError(t("config.master_keys_required"))
            return {1: _DEV_MASTER_KEY}
        return parse_master_keys(value)

    @property
    def public_origin_normalized(self) -> str:
        return self.public_origin.rstrip("/")


def parse_master_keys(value: str) -> dict[int, bytes]:
    """Разбирает строку "1:base64,2:base64". Ошибка формата — ValueError с понятным текстом."""
    keys: dict[int, bytes] = {}
    for raw in value.split(","):
        item = raw.strip()
        if not item:
            continue
        version_str, sep, encoded = item.partition(":")
        try:
            if not sep:
                raise ValueError
            version = int(version_str)
            key = base64.b64decode(encoded.strip(), validate=True)
        except (ValueError, binascii.Error):
            raise ValueError(t("config.master_keys_format")) from None
        if version < 1 or len(key) != 32 or version in keys:
            raise ValueError(t("config.master_keys_format"))
        keys[version] = key
    if not keys:
        raise ValueError(t("config.master_keys_format"))
    return keys


class SettingsError(RuntimeError):
    """Настройки не прошли проверку. Текст без значений полей: в них бывают пароли."""


def load_settings() -> Settings:
    """Читает настройки из окружения. Ошибка — SettingsError с понятным текстом."""
    try:
        return Settings()
    except ValidationError as exc:
        problems = []
        for err in exc.errors(include_input=False, include_url=False):
            message = str(err["msg"]).removeprefix("Value error, ")
            loc = ".".join(str(part) for part in err["loc"])
            problems.append(f"{loc}: {message}" if loc else message)
        raise SettingsError("; ".join(problems)) from None


@lru_cache
def get_settings() -> Settings:
    return load_settings()
