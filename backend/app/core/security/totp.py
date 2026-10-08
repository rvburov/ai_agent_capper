"""Коды 2FA по RFC 6238: 6 цифр, шаг 30 секунд, допуск ±1 шаг.

verify_totp() возвращает номер шага, на котором код совпал. Код того же или более
раннего шага, чем users.totp_last_step, больше не принимается, поэтому подсмотренный код
нельзя использовать второй раз.

Шаг записывается только атомарно, через app.services.two_factor.consume_totp_step:
UPDATE users SET totp_last_step = :step WHERE id = :id AND (totp_last_step IS NULL
OR totp_last_step < :step). Если строка не обновилась — код уже использован
(invalid_code). Схема «прочитать, проверить, записать» пропускает один и тот же код в двух
параллельных запросах. Так же одноразово помечаются резервные коды (consume_recovery_code).
"""

import hmac
import time
import unicodedata
from datetime import datetime

import pyotp
import segno

ISSUER = "AI Capper"
DIGITS = 6
INTERVAL = 30
VALID_WINDOW = 1


def new_totp_secret() -> str:
    """Секрет base32, 160 бит. Хранится в БД зашифрованным (crypto.encrypt)."""
    return pyotp.random_base32(length=32)


def totp_uri(secret: str, email: str) -> str:
    """Адрес otpauth:// для приложения-аутентификатора: издатель «AI Capper», имя — email."""
    return pyotp.TOTP(secret, digits=DIGITS, interval=INTERVAL).provisioning_uri(
        name=email, issuer_name=ISSUER
    )


def qr_svg(uri: str) -> str:
    """QR-код адреса otpauth:// в SVG (строка), без внешних ресурсов."""
    qr = segno.make(uri, error="m")
    svg: str = qr.svg_inline(scale=4, border=2)
    return svg


def _timestamp(now: datetime | float | None) -> float:
    if now is None:
        return time.time()
    if isinstance(now, datetime):
        return now.timestamp()
    return float(now)


def current_step(now: datetime | float | None = None) -> int:
    return int(_timestamp(now) // INTERVAL)


def code_at_step(secret: str, step: int) -> str:
    return pyotp.TOTP(secret, digits=DIGITS, interval=INTERVAL).generate_otp(step)


def normalize_totp_input(code: str) -> str | None:
    """Убирает пробелы и дефисы, цифры любой письменности (например, полноширинные
    с японской клавиатуры телефона) приводит к ASCII. Другие символы — None."""
    digits: list[str] = []
    for ch in code:
        if ch.isspace() or ch == "-":
            continue
        if not ch.isdecimal():
            return None
        digits.append(str(unicodedata.decimal(ch)))
    return "".join(digits)


def verify_totp(
    secret: str,
    code: str,
    *,
    last_step: int | None,
    now: datetime | float | None = None,
) -> int | None:
    """Номер шага, если код верный и новее last_step, иначе None.

    Проверяются шаги текущий −1, текущий и текущий +1 (часы телефона могут спешить
    или отставать на 30 секунд).
    """
    candidate = normalize_totp_input(code)
    if candidate is None or len(candidate) != DIGITS:
        return None
    step = current_step(now)
    matched: int | None = None
    for offset in range(-VALID_WINDOW, VALID_WINDOW + 1):
        s = step + offset
        if hmac.compare_digest(code_at_step(secret, s), candidate):
            matched = s
    if matched is None or (last_step is not None and matched <= last_step):
        return None
    return matched
