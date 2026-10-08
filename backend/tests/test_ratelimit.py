import asyncio

from redis.asyncio import Redis

from app.core import ratelimit
from app.core.ratelimit import (
    ACCOUNT_2FA_RULE,
    LOCK_SECONDS,
    LOGIN_IP_RULE,
    MAX_FAILURES,
    REGISTER_IP_RULE,
    RateRule,
    account_hash,
    allow_failure_notice,
    begin_2fa_attempt,
    begin_attempt,
    hit_ip_limit,
    rate_limit_subject,
    register_2fa_failure,
    register_failure,
    release_attempt,
    reset_failures,
)
from app.core.redis import redis_key

EMAIL = "Anna@Example.com"
IP = "10.0.0.1"
OTHER_IP = "10.0.0.2"


async def _fail_times(redis: Redis, n: int, email: str = EMAIL, ip: str = IP) -> None:
    for _ in range(n):
        attempt = await begin_attempt(redis, email, ip)
        assert attempt.retry_after == 0
        await register_failure(redis, email, ip, attempt)


async def test_five_failures_lock_the_pair_for_15_minutes(redis: Redis) -> None:
    for n in range(1, 5):
        attempt = await begin_attempt(redis, EMAIL, IP)
        assert attempt.number == n
        assert attempt.retry_after == 0
        result = await register_failure(redis, EMAIL, IP, attempt)
        assert result.failures == n
        assert result.retry_after == 0
        assert not result.just_locked
    fifth = await register_failure(redis, EMAIL, IP, await begin_attempt(redis, EMAIL, IP))
    assert fifth.just_locked
    assert 0 < fifth.retry_after <= LOCK_SECONDS
    # Шестая попытка с этого IP — пауза, пароль не проверяется
    sixth = await begin_attempt(redis, EMAIL, IP)
    assert sixth.number == 0
    assert LOCK_SECONDS - 5 <= sixth.retry_after <= LOCK_SECONDS


async def test_parallel_attempts_check_password_at_most_five_times(redis: Redis) -> None:
    checked = 0

    async def try_login() -> None:
        nonlocal checked
        attempt = await begin_attempt(redis, EMAIL, IP)
        if attempt.retry_after:
            return
        checked += 1
        await asyncio.sleep(0.05)  # проверка пароля Argon2
        await register_failure(redis, EMAIL, IP, attempt)

    await asyncio.gather(*(try_login() for _ in range(20)))
    assert checked == MAX_FAILURES
    assert (await begin_attempt(redis, EMAIL, IP)).retry_after > 0


async def test_failure_during_lock_reports_the_lock(redis: Redis) -> None:
    # Попытка зарезервирована до паузы, а неудача записана уже во время паузы
    early = await begin_attempt(redis, EMAIL, IP)
    await _fail_times(redis, 3)
    fifth = await register_failure(redis, EMAIL, IP, await begin_attempt(redis, EMAIL, IP))
    assert fifth.just_locked
    late = await register_failure(redis, EMAIL, IP, early)
    assert not late.just_locked
    assert 0 < late.retry_after <= LOCK_SECONDS


async def test_other_ip_and_other_account_still_work(redis: Redis) -> None:
    await _fail_times(redis, 5)
    assert (await begin_attempt(redis, EMAIL, IP)).retry_after > 0
    assert (await begin_attempt(redis, EMAIL, OTHER_IP)).retry_after == 0
    assert (await begin_attempt(redis, "someone@example.com", IP)).retry_after == 0


async def test_email_is_case_insensitive_and_not_stored(redis: Redis) -> None:
    await _fail_times(redis, 5)
    assert (await begin_attempt(redis, "anna@example.com", IP)).retry_after > 0
    keys = [k async for k in redis.scan_iter(match=redis_key("*"))]
    assert keys
    assert all("anna" not in k.lower() for k in keys)
    assert any(account_hash("anna@example.com") in k for k in keys)


async def test_success_resets_counter(redis: Redis) -> None:
    await _fail_times(redis, 4)
    await reset_failures(redis, EMAIL, IP)
    attempt = await begin_attempt(redis, EMAIL, IP)
    assert attempt.number == 1
    assert not (await register_failure(redis, EMAIL, IP, attempt)).just_locked


async def test_correct_password_before_2fa_is_not_a_failure(redis: Redis) -> None:
    await _fail_times(redis, 4)
    password_step = await begin_attempt(redis, EMAIL, IP)
    assert password_step.number == 5
    await release_attempt(redis, EMAIL, IP)  # пароль верный, ждем код
    # Неверный код после верного пароля — пятая неудача, она и включает паузу
    attempt = await begin_attempt(redis, EMAIL, IP)
    assert attempt.number == 5
    assert (await register_failure(redis, EMAIL, IP, attempt)).just_locked
    # Отмена без зарезервированной попытки ничего не ломает
    await reset_failures(redis, EMAIL, IP)
    await release_attempt(redis, EMAIL, IP)
    assert (await begin_attempt(redis, EMAIL, IP)).number == 1


async def test_lock_is_not_extended_by_more_failures(redis: Redis) -> None:
    await _fail_times(redis, 5)
    later = await begin_attempt(redis, EMAIL, IP)
    assert later.retry_after > 0
    result = await register_failure(redis, EMAIL, IP, later)
    assert not result.just_locked
    assert result.retry_after <= LOCK_SECONDS


def test_ipv6_subject_is_the_64_network() -> None:
    assert rate_limit_subject("10.0.0.1") == "10.0.0.1"
    assert rate_limit_subject("2001:db8:1:2::1") == "2001:db8:1:2::/64"
    assert rate_limit_subject("2001:db8:1:2:ffff::9") == "2001:db8:1:2::/64"
    assert rate_limit_subject("2001:db8:1:3::1") == "2001:db8:1:3::/64"
    assert rate_limit_subject("garbage") == "garbage"


async def test_ipv6_addresses_of_one_64_share_counters(redis: Redis) -> None:
    await _fail_times(redis, 5, ip="2001:db8:1:2::1")
    assert (await begin_attempt(redis, EMAIL, "2001:db8:1:2::2")).retry_after > 0
    assert (await begin_attempt(redis, EMAIL, "2001:db8:1:3::1")).retry_after == 0

    for n in range(LOGIN_IP_RULE.limit):
        assert await hit_ip_limit(redis, f"2001:db8:9:9::{n + 1:x}", LOGIN_IP_RULE) == 0
    assert await hit_ip_limit(redis, "2001:db8:9:9::ffff", LOGIN_IP_RULE) > 0
    assert await hit_ip_limit(redis, "2001:db8:9:a::1", LOGIN_IP_RULE) == 0


async def test_2fa_failures_are_counted_per_account(redis: Redis) -> None:
    locked = 0
    # По 2 неверных кода с разных адресов: паузы пар не наступают, а счетчик аккаунта растет
    for n in range(ACCOUNT_2FA_RULE.limit):
        ip = f"10.1.0.{n // 2 + 1}"
        pair = await begin_attempt(redis, EMAIL, ip)
        assert pair.retry_after == 0
        attempt = await begin_2fa_attempt(redis, EMAIL)
        assert attempt.retry_after == 0
        await register_failure(redis, EMAIL, ip, pair)
        result = await register_2fa_failure(redis, EMAIL, attempt)
        locked += result.just_locked
    assert locked == 1
    blocked = await begin_2fa_attempt(redis, "anna@example.com")
    assert 0 < blocked.retry_after <= ACCOUNT_2FA_RULE.lock
    # Успешный вход сбрасывает пару, но не счетчик 2FA аккаунта
    await reset_failures(redis, EMAIL, "10.1.0.1")
    assert (await begin_2fa_attempt(redis, EMAIL)).retry_after > 0
    assert (await begin_2fa_attempt(redis, "someone@example.com")).retry_after == 0


async def test_ip_limit_for_login(redis: Redis) -> None:
    for _ in range(LOGIN_IP_RULE.limit):
        assert await hit_ip_limit(redis, IP, LOGIN_IP_RULE) == 0
    wait = await hit_ip_limit(redis, IP, LOGIN_IP_RULE)
    assert 0 < wait <= LOGIN_IP_RULE.window
    # Другой IP и другой счетчик (регистрация) не затронуты
    assert await hit_ip_limit(redis, OTHER_IP, LOGIN_IP_RULE) == 0
    assert await hit_ip_limit(redis, IP, REGISTER_IP_RULE) == 0


async def test_register_and_reset_limits() -> None:
    assert RateRule("register", 10, 900) == ratelimit.REGISTER_IP_RULE
    assert RateRule("reset", 10, 900) == ratelimit.RESET_IP_RULE
    assert RateRule("login", 20, 60) == LOGIN_IP_RULE
    assert (ACCOUNT_2FA_RULE.limit, ACCOUNT_2FA_RULE.window) == (10, 3600)


async def test_failure_notice_once_per_15_minutes(redis: Redis) -> None:
    assert await allow_failure_notice(redis, 42)
    assert not await allow_failure_notice(redis, 42)
    assert await allow_failure_notice(redis, 43)
