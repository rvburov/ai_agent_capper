"""Случайные токены и одноразовые коды.

- new_token() — 256 бит для cookie сеанса, доверенного устройства, незавершенного входа,
  CSRF. В БД хранится только hash_token() — sha256 в hex.
- Коды от администратора: приглашение CAP-XXXX-XXXX и сброс пароля RST-XXXX-XXXX.
  Алфавит без похожих символов (нет I, O, 0, 1), 8 знаков — 40 бит.
- Резервные коды 2FA: 8 штук вида xxxx-xxxx (строчные буквы и цифры того же алфавита).
- Коды вводятся без учета регистра, пробелов и дефисов. В БД лежит hash_code() —
  HMAC-SHA256 с секретом сервера (CAPPER_SECRET_KEY) от нормализованного кода: по утекшей
  базе коды не перебрать без секрета.
"""

import hashlib
import hmac
import secrets

from app.core.config import get_settings

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
INVITE_PREFIX = "CAP"
RESET_PREFIX = "RST"
RECOVERY_CODES_COUNT = 8
_CODE_BODY_LENGTH = 8


def new_token() -> str:
    """Случайный токен 256 бит в base64url (43 символа)."""
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _random_chars(n: int) -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(n))


def _prefixed_code(prefix: str) -> str:
    body = _random_chars(_CODE_BODY_LENGTH)
    return f"{prefix}-{body[:4]}-{body[4:]}"


def gen_invite_code() -> str:
    """Код приглашения: CAP-XXXX-XXXX."""
    return _prefixed_code(INVITE_PREFIX)


def gen_reset_code() -> str:
    """Код сброса пароля: RST-XXXX-XXXX."""
    return _prefixed_code(RESET_PREFIX)


def gen_recovery_codes(n: int = RECOVERY_CODES_COUNT) -> list[str]:
    """Резервные коды 2FA: n разных кодов вида xxxx-xxxx."""
    codes: set[str] = set()
    while len(codes) < n:
        body = _random_chars(_CODE_BODY_LENGTH).lower()
        codes.add(f"{body[:4]}-{body[4:]}")
    return sorted(codes)


def normalize_code(raw: str, prefix: str = "") -> str:
    """Приводит введенный код к виду для хеша: верхний регистр, без пробелов и дефисов.

    Если указан prefix (CAP или RST), а человек ввел только 8 знаков без него,
    префикс дописывается: "abcd efgh" → "CAPABCDEFGH".
    """
    cleaned = "".join(ch for ch in raw.upper() if ch.isalnum())
    if prefix and not cleaned.startswith(prefix) and len(cleaned) == _CODE_BODY_LENGTH:
        cleaned = prefix + cleaned
    return cleaned


def hash_code(code: str, prefix: str = "") -> str:
    """HMAC-SHA256(secret_key, нормализованный код) в hex."""
    normalized = normalize_code(code, prefix)
    key = get_settings().secret_key_bytes
    return hmac.new(key, b"code:" + normalized.encode(), hashlib.sha256).hexdigest()
