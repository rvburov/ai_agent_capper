"""Пароли: Argon2id, политика длины и проверка по базе утечек Have I Been Pwned.

Параметры Argon2 — профиль RFC 9106 «low memory» (64 МиБ, 3 прохода, 4 потока), это выше
минимума OWASP. Если параметры усилят, needs_rehash() вернет True и сервис входа
пересчитает хеш после успешной проверки пароля.

Хеширование занимает около 0,1 с процессора, поэтому в обработчиках запросов
используются *_async версии: они уходят в поток и не блокируют цикл событий.

Каждый хеш берет 64 МиБ памяти, поэтому одновременно считается не больше
CAPPER_PASSWORD_HASH_SLOTS хешей (по умолчанию 2, по числу vCPU сервера). Остальные
запросы ждут свободного места до HASH_WAIT_SECONDS, затем получают 503 common.busy:
поток входов с выдуманными email не съест память сервера. Ждать места нужно без
соединения с БД (сервис входа завершает транзакцию до проверки пароля), иначе такой
поток займет весь пул соединений.
"""

import asyncio
import hashlib
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import cache

import anyio
import httpx
import structlog
from argon2 import PasswordHasher, profiles
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from app.core.config import Settings, get_settings
from app.core.errors import AppError

log = structlog.get_logger(__name__)

PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 128
HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/{prefix}"

_hasher = PasswordHasher.from_parameters(profiles.RFC_9106_LOW_MEMORY)

HASH_WAIT_SECONDS = 10.0
BUSY_RETRY_AFTER_SECONDS = 5

# Семафор свой у каждого цикла событий: asyncio.Semaphore привязывается к циклу
_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    semaphore = _slots.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(max(get_settings().password_hash_slots, 1))
        _slots[loop] = semaphore
    return semaphore


@asynccontextmanager
async def _hash_slot() -> AsyncIterator[None]:
    """Место для одного хеша Argon2. Нет места за HASH_WAIT_SECONDS — 503 common.busy."""
    semaphore = _semaphore()
    try:
        async with asyncio.timeout(HASH_WAIT_SECONDS):
            await semaphore.acquire()
    except TimeoutError:
        log.warning("passwords.hash_slots_busy")
        raise AppError(503, "common.busy", retry_after=BUSY_RETRY_AFTER_SECONDS) from None
    try:
        yield
    finally:
        semaphore.release()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """True, если пароль подходит. Пустой или испорченный хеш — False, без исключений."""
    if not password_hash:
        return False
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    """Хеш сделан со старыми (слабее текущих) параметрами и его пора пересчитать."""
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


@cache
def _dummy_hash() -> str:
    return _hasher.hash("capper-dummy-password-for-timing")


async def hash_password_async(password: str) -> str:
    async with _hash_slot():
        return await anyio.to_thread.run_sync(hash_password, password)


async def verify_password_async(password_hash: str | None, password: str) -> bool:
    if not password_hash:
        return False
    async with _hash_slot():
        return await anyio.to_thread.run_sync(verify_password, password_hash, password)


async def verify_dummy_async(password: str) -> None:
    """Проверка пароля против фиктивного хеша, когда email не найден.

    Ответ занимает столько же времени, сколько для существующего аккаунта,
    и по времени нельзя узнать, есть ли такой email.
    """
    dummy = _dummy_hash()
    async with _hash_slot():
        await anyio.to_thread.run_sync(verify_password, dummy, password)


def validate_password_policy(password: str) -> None:
    """Длина пароля 12–128 символов. Иначе AppError 400 с ключом errors.auth.*."""
    if len(password) < PASSWORD_MIN_LENGTH:
        raise AppError(400, "auth.password_too_short", min_length=PASSWORD_MIN_LENGTH)
    if len(password) > PASSWORD_MAX_LENGTH:
        raise AppError(400, "auth.password_too_long", max_length=PASSWORD_MAX_LENGTH)


async def hibp_check(
    password: str,
    *,
    client: httpx.AsyncClient | None = None,
    timeout_s: float = 3.0,
) -> int | None:
    """Сколько раз пароль встречался в утечках (0 — не встречался), None — сервис недоступен.

    k-анонимность: наружу уходят только первые 5 символов SHA-1 пароля. Заголовок
    Add-Padding просит сервис дополнить ответ фиктивными строками (у них счетчик 0),
    чтобы по размеру ответа нельзя было угадать префикс.
    """
    digest = hashlib.sha1(password.encode(), usedforsecurity=False).hexdigest().upper()
    prefix, suffix = digest[:5], digest[5:]
    headers = {"Add-Padding": "true", "User-Agent": "AI-Capper"}
    url = HIBP_RANGE_URL.format(prefix=prefix)
    try:
        if client is None:
            async with httpx.AsyncClient(timeout=timeout_s) as own_client:
                response = await own_client.get(url, headers=headers)
        else:
            response = await client.get(url, headers=headers, timeout=timeout_s)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("hibp.unavailable", error=type(exc).__name__)
        return None
    for line in response.text.splitlines():
        candidate, _, count = line.strip().partition(":")
        if candidate.upper() == suffix:
            try:
                return int(count)
            except ValueError:
                return None
    return 0


async def check_new_password(
    password: str,
    *,
    settings: Settings | None = None,
    client: httpx.AsyncClient | None = None,
) -> None:
    """Все проверки нового пароля: длина и, если включено, база утечек.

    Сбой сети при проверке утечек не мешает: пароль принимается, событие пишется в лог.
    """
    validate_password_policy(password)
    settings = settings or get_settings()
    if not settings.hibp_enabled:
        return
    count = await hibp_check(password, client=client)
    if count:
        raise AppError(400, "auth.password_pwned")
