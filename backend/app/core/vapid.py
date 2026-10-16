"""Ключи VAPID для push-уведомлений браузера (Web Push, RFC 8292, этап 6).

Пара ключей P-256: публичный — 65 байт несжатой точки (его браузер получает как
applicationServerKey), закрытый — 32 байта числа. Оба хранятся в настройках строкой
base64url без «=» (CAPPER_VAPID_PUBLIC_KEY и CAPPER_VAPID_PRIVATE_KEY), как их печатает
python -m app.admin.cli generate-vapid. Закрытый ключ в логи и в ответы API не попадает.
"""

import base64
import binascii

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

PUBLIC_KEY_BYTES = 65
PRIVATE_KEY_BYTES = 32


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(value: str) -> bytes:
    """base64url с «=» в конце или без. Ошибка формата — ValueError."""
    text = value.strip()
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError):
        raise ValueError("base64url") from None


def public_bytes(key: ec.EllipticCurvePublicKey) -> bytes:
    return key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def generate_keys() -> tuple[str, str]:
    """Новая пара: (публичный, закрытый) в base64url."""
    private = ec.generate_private_key(ec.SECP256R1())
    number = private.private_numbers().private_value.to_bytes(PRIVATE_KEY_BYTES, "big")
    return b64url_encode(public_bytes(private.public_key())), b64url_encode(number)


def load_private_key(value: str) -> ec.EllipticCurvePrivateKey:
    raw = b64url_decode(value)
    if len(raw) != PRIVATE_KEY_BYTES:
        raise ValueError("vapid private key length")
    return ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())


def keys_match(public: str, private: str) -> bool:
    """Ключи читаются и закрытый соответствует публичному."""
    try:
        key = load_private_key(private)
        return public_bytes(key.public_key()) == b64url_decode(public)
    except ValueError:
        return False


def is_public_point(raw: bytes) -> bool:
    """65 байт несжатой точки, и точка лежит на кривой P-256 (ключ p256dh подписки)."""
    if len(raw) != PUBLIC_KEY_BYTES or raw[0] != 4:
        return False
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError:
        return False
    return True
