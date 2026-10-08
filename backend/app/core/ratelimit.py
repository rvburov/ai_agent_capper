"""Защита от подбора пароля и кодов: счетчики в Redis (PLAN.md, раздел 7).

Три вида счетчиков:

1. Попытки по паре (аккаунт, IP). Аккаунт — sha256(lower(email)), поэтому для
   несуществующих email все работает так же. Окно 15 минут с первой попытки.
   После 5 неудач пара получает паузу 15 минут: шестая попытка с этого IP получает 429
   еще до проверки пароля, а вход того же аккаунта с другого IP работает.
   Неудачи шага 2FA и резервного кода идут в тот же счетчик. Успешный вход его сбрасывает.
   Попытка резервируется атомарно ДО проверки пароля (begin_attempt): иначе параллельные
   запросы успели бы проверить пароль больше 5 раз, пока пауза еще не включилась.

2. Неудачи шага 2FA по аккаунту, без IP: 10 за час, затем шаг 2FA этого аккаунта закрыт
   на час. Иначе тот, кто знает пароль, перебирает код с разных адресов по 4 попытки,
   и ни пауза, ни уведомление владельцу не наступают. До шага 2FA доходит только тот,
   кто ввел верный пароль, поэтому, зная один email, вход чужого аккаунта не закрыть.

3. Общий лимит запросов с одного IP в фиксированном окне: вход — 20 в минуту,
   регистрация и сброс пароля — по 10 за 15 минут.

IPv6 в ключах сворачивается в сеть /64 (rate_limit_subject): у одного сервера или
провайдера клиента обычно вся /64, и смена адреса внутри нее лимиты не обходит.
В login_events и sessions пишется полный адрес.

Как пользоваться в сервисе входа (шаг пароля):

    if wait := await hit_ip_limit(redis, ip, LOGIN_IP_RULE): -> 429, retry_after=wait
    attempt = await begin_attempt(redis, email, ip)
    if attempt.retry_after: -> 429 errors.auth.rate_limited, retry_after (пароль не проверять)
    ...пароль неверный:
        result = await register_failure(redis, email, ip, attempt)
        if result.just_locked and user and await allow_failure_notice(redis, user.id):
            -> уведомление login_failures владельцу аккаунта
        -> 401
    ...пароль верный, нужен код 2FA:
        await release_attempt(redis, email, ip)   # верный пароль неудачей не считается
    ...вход завершен (доверенное устройство):
        await reset_failures(redis, email, ip)

Шаг 2FA и резервного кода:

    if wait := await hit_ip_limit(redis, ip, LOGIN_IP_RULE): -> 429
    attempt = await begin_attempt(redis, email, ip)
    if attempt.retry_after: -> 429
    attempt_2fa = await begin_2fa_attempt(redis, email)
    if attempt_2fa.retry_after: -> удалить login:pending, 429
    ...код неверный:
        result = await register_failure(redis, email, ip, attempt)
        result_2fa = await register_2fa_failure(redis, email, attempt_2fa)
        if (result.just_locked or result_2fa.just_locked) and await allow_failure_notice(...):
            -> уведомление login_failures
        if result_2fa.just_locked: -> удалить login:pending
    ...код верный:
        await reset_failures(redis, email, ip)
        await release_2fa_attempt(redis, email)

Время ожидания везде в секундах (retry_after), 0 — ограничения нет.
"""

import hashlib
import ipaddress
from dataclasses import dataclass
from typing import Any, cast

from redis.asyncio import Redis

from app.core.redis import redis_key

MAX_FAILURES = 5
FAILURE_WINDOW_SECONDS = 15 * 60
LOCK_SECONDS = 15 * 60
NOTICE_INTERVAL_SECONDS = 15 * 60
IPV6_PREFIX = 64


@dataclass(frozen=True)
class FailureRule:
    """Не больше limit неудач за window секунд, затем пауза lock секунд."""

    scope: str
    limit: int
    window: int
    lock: int


PAIR_RULE = FailureRule("pair", MAX_FAILURES, FAILURE_WINDOW_SECONDS, LOCK_SECONDS)
ACCOUNT_2FA_RULE = FailureRule("2fa", 10, 60 * 60, 60 * 60)


@dataclass(frozen=True)
class RateRule:
    """Не больше limit запросов за window секунд с одного IP. scope разделяет счетчики."""

    scope: str
    limit: int
    window: int


LOGIN_IP_RULE = RateRule("login", 20, 60)
REGISTER_IP_RULE = RateRule("register", 10, 15 * 60)
RESET_IP_RULE = RateRule("reset", 10, 15 * 60)


@dataclass(frozen=True)
class Attempt:
    """Зарезервированная попытка. retry_after > 0 — отказ: ответ 429, пароль и код
    не проверяются. number — номер попытки в окне (0 при отказе)."""

    number: int
    retry_after: int


@dataclass(frozen=True)
class FailureResult:
    failures: int  # неудач в текущем окне, включая эту
    retry_after: int  # пауза в секундах, 0 — пауза не наступила
    just_locked: bool  # эта неудача включила паузу (повод для уведомления владельцу)


def account_hash(email: str) -> str:
    """Имя аккаунта в ключах Redis: sha256(lower(email)). Сам email в Redis не пишем."""
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


def rate_limit_subject(ip: str) -> str:
    """Чей это счетчик: IPv4 — сам адрес, IPv6 — его сеть /64."""
    try:
        address = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if isinstance(address, ipaddress.IPv6Address):
        network = ipaddress.IPv6Network(f"{address}/{IPV6_PREFIX}", strict=False)
        return str(network)
    return str(address)


def _keys(rule: FailureRule, *parts: str) -> tuple[str, str]:
    return redis_key("rl", rule.scope, "fail", *parts), redis_key("rl", rule.scope, "lock", *parts)


def _pair_keys(email: str, ip: str) -> tuple[str, str]:
    return _keys(PAIR_RULE, account_hash(email), rate_limit_subject(ip))


def _account_2fa_keys(email: str) -> tuple[str, str]:
    return _keys(ACCOUNT_2FA_RULE, account_hash(email))


# KEYS: счетчик, пауза. ARGV: лимит, окно. Ответ: {номер попытки, 0} или {0, ожидание}.
# Скрипт выполняется в Redis целиком, поэтому проверка и счет не разделены гонкой
_BEGIN_ATTEMPT_LUA = """
local lock_ttl = redis.call('TTL', KEYS[2])
if lock_ttl > 0 then return {0, lock_ttl} end
if lock_ttl == -1 then return {0, tonumber(ARGV[2])} end
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if n > tonumber(ARGV[1]) then
    local wait = redis.call('TTL', KEYS[1])
    if wait < 1 then wait = 1 end
    return {0, wait}
end
return {n, 0}
"""

# KEYS: счетчик. Отменяет одну зарезервированную попытку, ниже нуля не опускается
_RELEASE_ATTEMPT_LUA = """
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then redis.call('DECR', KEYS[1]) end
return 0
"""


async def _eval(redis: Redis, script: str, keys: list[str], args: list[int]) -> Any:
    return await cast(Any, redis.eval(script, len(keys), *keys, *(str(a) for a in args)))


async def _ttl(redis: Redis, key: str) -> int:
    ttl = int(await redis.ttl(key))
    return max(ttl, 1) if ttl != -2 else 0


async def _begin(redis: Redis, rule: FailureRule, keys: tuple[str, str]) -> Attempt:
    number, wait = await _eval(redis, _BEGIN_ATTEMPT_LUA, list(keys), [rule.limit, rule.window])
    return Attempt(number=int(number), retry_after=int(wait))


async def _fail(
    redis: Redis, rule: FailureRule, keys: tuple[str, str], attempt: Attempt
) -> FailureResult:
    fail_key, lock_key = keys
    just_locked = False
    if attempt.number >= rule.limit:
        # SET NX: пауза включается один раз и не продлевается следующими неудачами
        just_locked = bool(await redis.set(lock_key, "1", ex=rule.lock, nx=True))
        if just_locked:
            await redis.delete(fail_key)
    return FailureResult(
        failures=attempt.number,
        retry_after=await _ttl(redis, lock_key),
        just_locked=just_locked,
    )


async def begin_attempt(redis: Redis, email: str, ip: str) -> Attempt:
    """Резервирует попытку пары (email, IP) до проверки пароля или кода."""
    return await _begin(redis, PAIR_RULE, _pair_keys(email, ip))


async def register_failure(redis: Redis, email: str, ip: str, attempt: Attempt) -> FailureResult:
    """Попытка из begin_attempt оказалась неудачной. Пятая неудача включает паузу на
    15 минут. Если пауза уже идет, retry_after — ее остаток."""
    return await _fail(redis, PAIR_RULE, _pair_keys(email, ip), attempt)


async def release_attempt(redis: Redis, email: str, ip: str) -> None:
    """Пароль верный, но вход ждет код 2FA: зарезервированная попытка не считается."""
    fail_key, _ = _pair_keys(email, ip)
    await _eval(redis, _RELEASE_ATTEMPT_LUA, [fail_key], [])


async def reset_failures(redis: Redis, email: str, ip: str) -> None:
    """Успешный вход: счетчик и пауза пары обнуляются. Счетчик 2FA по аккаунту остается:
    иначе тот, кто знает пароль, обнулял бы его, дождавшись входа владельца."""
    await redis.delete(*_pair_keys(email, ip))


async def begin_2fa_attempt(redis: Redis, email: str) -> Attempt:
    """Резервирует попытку шага 2FA или резервного кода по аккаунту (без IP)."""
    return await _begin(redis, ACCOUNT_2FA_RULE, _account_2fa_keys(email))


async def register_2fa_failure(redis: Redis, email: str, attempt: Attempt) -> FailureResult:
    """Неверный код 2FA или резервный код. Десятая неудача за час закрывает шаг 2FA
    аккаунта на час (just_locked — повод для уведомления login_failures)."""
    return await _fail(redis, ACCOUNT_2FA_RULE, _account_2fa_keys(email), attempt)


async def release_2fa_attempt(redis: Redis, email: str) -> None:
    """Код 2FA верный: зарезервированная попытка не считается в лимит неудач аккаунта.
    Иначе одиннадцатый успешный вход за час получил бы 429."""
    fail_key, _ = _account_2fa_keys(email)
    await _eval(redis, _RELEASE_ATTEMPT_LUA, [fail_key], [])


async def hit_ip_limit(redis: Redis, ip: str, rule: RateRule) -> int:
    """Считает запрос с IP. Возвращает 0, если лимит не превышен, иначе секунды до сброса."""
    key = redis_key("rl", "ip", rule.scope, rate_limit_subject(ip))
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, rule.window, nx=True)
        count = int((await pipe.execute())[0])
    if count <= rule.limit:
        return 0
    return await _ttl(redis, key)


async def allow_failure_notice(redis: Redis, user_id: int) -> bool:
    """True не чаще раза в 15 минут на пользователя: уведомление о неудачных входах."""
    key = redis_key("rl", "notice", "login_failures", user_id)
    return bool(await redis.set(key, "1", ex=NOTICE_INTERVAL_SECONDS, nx=True))
