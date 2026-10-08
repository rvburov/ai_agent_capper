"""Логи через structlog: JSON в prod, читаемый вывод в dev.

Секреты в лог не попадают: фильтр redact_secrets заменяет значения полей, в имени которых
есть password, totp, code, token, key, secret, cookie, authorization (и похожие, в том
числе в camelCase: newPassword, sessionToken), а также ключи Anthropic вида sk-ant-...
внутри любых строк. Модели Pydantic и dataclass разбираются по полям, как словари;
прочие объекты превращаются в строку и чистятся как текст. Через тот же фильтр идут
записи стандартного logging (uvicorn, SQLAlchemy).
"""

import dataclasses
import logging
import re
import sys
from collections.abc import Mapping, MutableMapping
from typing import Any

import structlog
from pydantic import BaseModel

REDACTED = "[скрыто]"

# Слова в имени поля, по которым значение считается секретом
_SENSITIVE_WORDS = frozenset(
    {
        "password",
        "passwd",
        "pwd",
        "totp",
        "otp",
        "code",
        "codes",
        "token",
        "tokens",
        "key",
        "keys",
        "secret",
        "secrets",
        "cookie",
        "cookies",
        "authorization",
        "auth",
        "csrf",
        "ciphertext",
        "dsn",
    }
)
# Поля с «опасным» словом в имени, которые секретом не являются
_SAFE_FIELDS = frozenset(
    {"status_code", "key_version", "totp_enabled", "error_code", "event", "code_kind"}
)
_WORD_SPLIT = re.compile(r"[^a-z0-9]+")
_CAMEL_BOUNDARY = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
# Служебные поля ProcessorFormatter: объекты записи, их не трогаем
_META_FIELDS = frozenset({"_record", "_from_structlog"})
_INLINE_SECRETS = (
    re.compile(r"sk-ant-[A-Za-z0-9_\-]+"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+"),
    # Пароль в адресе подключения: postgresql://user:pass@host
    re.compile(r"(://[^:/@\s]+:)[^@\s]+(@)"),
)


def is_sensitive_field(name: str) -> bool:
    # newPassword → new_password: слова в camelCase тоже разделяются
    lowered = _CAMEL_BOUNDARY.sub("_", name).lower()
    if lowered in _SAFE_FIELDS:
        return False
    words = [w for w in _WORD_SPLIT.split(lowered) if w]
    return any(w in _SENSITIVE_WORDS for w in words) or "apikey" in lowered


def _scrub_text(value: str) -> str:
    value = _INLINE_SECRETS[0].sub("sk-ant-" + REDACTED, value)
    value = _INLINE_SECRETS[1].sub(r"\1" + REDACTED, value)
    return _INLINE_SECRETS[2].sub(r"\1" + REDACTED + r"\2", value)


def _scrub(value: Any, depth: int = 0) -> Any:
    if value is None or isinstance(value, bool | int | float):
        return value
    if depth > 8:
        return REDACTED
    if isinstance(value, str):
        return _scrub_text(value)
    if isinstance(value, BaseModel):
        # Тело запроса (например, вход с паролем): по полям, как словарь
        return _scrub(dict(value), depth)
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        fields = {f.name: getattr(value, f.name) for f in dataclasses.fields(value)}
        return _scrub(fields, depth)
    if isinstance(value, Mapping):
        return {
            k: (REDACTED if isinstance(k, str) and is_sensitive_field(k) else _scrub(v, depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, list | tuple | set | frozenset):
        return [_scrub(v, depth + 1) for v in value]
    # Прочие объекты выводятся строкой: repr может содержать секрет
    return _scrub_text(str(value))


def redact_secrets(
    logger: Any, method_name: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """Процессор structlog: прячет секреты в полях и в тексте события."""
    for key in list(event_dict.keys()):
        if key in _META_FIELDS:
            continue
        if is_sensitive_field(key):
            event_dict[key] = REDACTED
        else:
            event_dict[key] = _scrub(event_dict[key])
    return event_dict


def drop_color_message(
    logger: Any, method_name: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """uvicorn кладет в каждую запись color_message с ANSI-кодами цвета: в логах он лишний."""
    event_dict.pop("color_message", None)
    return event_dict


_configured = False


def _shared_processors() -> list[structlog.types.Processor]:
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.stdlib.ExtraAdder(),
        drop_color_message,
        # Трассировка становится текстом до фильтра: секреты в тексте исключений тоже прячутся
        structlog.processors.format_exc_info,
        redact_secrets,
    ]


def build_formatter(*, json_logs: bool) -> logging.Formatter:
    """Форматтер для обработчиков стандартного logging: та же цепочка, что у structlog."""
    renderer: structlog.types.Processor = (
        structlog.processors.JSONRenderer(ensure_ascii=False)
        if json_logs
        else structlog.dev.ConsoleRenderer(colors=False)
    )
    return structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=_shared_processors(),
        processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
    )


def setup_logging(*, json_logs: bool, level: str = "INFO") -> None:
    """Настраивает structlog и стандартный logging. Повторный вызов ничего не меняет.

    Чужие обработчики корня (например, перехват логов pytest) не удаляются.
    """
    global _configured
    if _configured:
        return
    _configured = True

    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            *_shared_processors(),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(build_formatter(json_logs=json_logs))
    root = logging.getLogger()
    root.addHandler(handler)
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
