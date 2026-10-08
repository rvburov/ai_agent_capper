"""Шифрование секретов в БД: AES-256-GCM (библиотека cryptography).

Что шифруем: секрет TOTP (users.totp_secret_enc), ключи Claude администратора
(app_settings.anthropic_key_enc) и участников (user_secrets.ciphertext), секрет 2FA
во время настройки (Redis). Мастер-ключи живут только в окружении сервера
(CAPPER_MASTER_KEYS), в БД рядом с шифротекстом пишется лишь номер версии ключа.

Формат шифротекста: nonce (12 байт) + шифротекст + тег (16 байт).
aad («связанные данные») привязывает шифротекст к месту хранения: шифротекст, скопированный
в чужую строку, не расшифруется. Строится через aad_for() из констант AAD_* ниже, например
aad_for(AAD_TOTP_SECRET, user.id).

Смена мастер-ключа: новый ключ дописывается в конец CAPPER_MASTER_KEYS, старые остаются
для расшифровки; needs_reencrypt() подсказывает, что запись пора перешифровать.
"""

import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core.config import get_settings

NONCE_SIZE = 12

# Поля для aad_for(): одно имя на одно место хранения
AAD_TOTP_SECRET = "users.totp_secret"  # aad_for(AAD_TOTP_SECRET, user.id)
AAD_LOGIN_SETUP = "login.setup_secret"  # секрет 2FA до подтверждения, по user.id
AAD_USER_SECRET = "user_secrets.anthropic_key"  # свой ключ Claude, по user.id
AAD_ADMIN_KEY = "app_settings.anthropic_key"  # ключ администратора, aad_for(AAD_ADMIN_KEY, 1)


class CryptoError(Exception):
    """Расшифровать не удалось: неизвестная версия ключа, чужой aad или испорченные данные."""


def aad_for(field: str, row_id: int | str) -> bytes:
    """Связанные данные для шифрования: "<таблица.поле>:<id строки>"."""
    return f"{field}:{row_id}".encode()


def _as_bytes(value: bytes | str) -> bytes:
    return value.encode() if isinstance(value, str) else value


def current_key_version() -> int:
    keys = get_settings().master_key_map
    return list(keys)[-1]


def needs_reencrypt(key_version: int) -> bool:
    return key_version != current_key_version()


def encrypt(plaintext: bytes | str, aad: bytes | str) -> tuple[bytes, int]:
    """Шифрует текущим мастер-ключом. Возвращает (шифротекст, версия ключа)."""
    keys = get_settings().master_key_map
    version = list(keys)[-1]
    nonce = os.urandom(NONCE_SIZE)
    ciphertext = AESGCM(keys[version]).encrypt(nonce, _as_bytes(plaintext), _as_bytes(aad))
    return nonce + ciphertext, version


def decrypt(ciphertext: bytes, key_version: int, aad: bytes | str) -> bytes:
    keys = get_settings().master_key_map
    key = keys.get(key_version)
    if key is None or len(ciphertext) <= NONCE_SIZE:
        raise CryptoError("unknown key version or broken data")
    nonce, body = ciphertext[:NONCE_SIZE], ciphertext[NONCE_SIZE:]
    try:
        return AESGCM(key).decrypt(nonce, body, _as_bytes(aad))
    except InvalidTag:
        raise CryptoError("decryption failed") from None


def encrypt_str(plaintext: str, aad: bytes | str) -> tuple[bytes, int]:
    return encrypt(plaintext.encode(), aad)


def decrypt_str(ciphertext: bytes, key_version: int, aad: bytes | str) -> str:
    return decrypt(ciphertext, key_version, aad).decode()
