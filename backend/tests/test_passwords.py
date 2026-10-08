import hashlib

import httpx
import pytest
from argon2 import PasswordHasher

from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import passwords
from app.core.security.passwords import (
    check_new_password,
    hash_password,
    hibp_check,
    needs_rehash,
    validate_password_policy,
    verify_password,
)


def test_hash_is_argon2id_and_verifies() -> None:
    hashed = hash_password("correct horse battery")
    assert hashed.startswith("$argon2id$")
    assert "m=65536,t=3,p=4" in hashed
    assert verify_password(hashed, "correct horse battery")
    assert not verify_password(hashed, "wrong horse battery")


def test_verify_tolerates_missing_or_broken_hash() -> None:
    assert not verify_password(None, "anything")
    assert not verify_password("", "anything")
    assert not verify_password("not-a-hash", "anything")


def test_needs_rehash_for_weaker_parameters() -> None:
    weak = PasswordHasher(time_cost=1, memory_cost=8192, parallelism=1).hash("pw-123456789012")
    assert needs_rehash(weak)
    assert not needs_rehash(hash_password("pw-123456789012"))
    assert needs_rehash("broken")


async def test_async_helpers() -> None:
    hashed = await passwords.hash_password_async("async password 1")
    assert await passwords.verify_password_async(hashed, "async password 1")
    assert not await passwords.verify_password_async(hashed, "async password 2")
    await passwords.verify_dummy_async("whatever")


@pytest.mark.parametrize(
    ("password", "code"),
    [
        ("short", "auth.password_too_short"),
        ("x" * 11, "auth.password_too_short"),
        ("x" * 129, "auth.password_too_long"),
    ],
)
def test_policy_rejects(password: str, code: str) -> None:
    with pytest.raises(AppError) as info:
        validate_password_policy(password)
    assert info.value.status_code == 400
    assert info.value.code == code
    assert "12" in info.value.message or "128" in info.value.message


@pytest.mark.parametrize("password", ["x" * 12, "x" * 128, "пароль из слов"])
def test_policy_accepts(password: str) -> None:
    validate_password_policy(password)


def _hibp_transport(password: str, count: int, seen: list[httpx.Request]) -> httpx.MockTransport:
    digest = hashlib.sha1(password.encode()).hexdigest().upper()

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = f"0000000000000000000000000000000000A:0\r\n{digest[5:]}:{count}\r\n"
        return httpx.Response(200, text=body)

    return httpx.MockTransport(handler)


async def test_hibp_sends_only_prefix_with_padding() -> None:
    seen: list[httpx.Request] = []
    password = "hunter2hunter2"
    async with httpx.AsyncClient(transport=_hibp_transport(password, 42, seen)) as client:
        assert await hibp_check(password, client=client) == 42
    request = seen[0]
    digest = hashlib.sha1(password.encode()).hexdigest().upper()
    assert request.url.path == f"/range/{digest[:5]}"
    assert request.headers["Add-Padding"] == "true"
    assert digest[5:] not in str(request.url)
    assert password not in str(request.url)


async def test_hibp_not_found_and_network_error() -> None:
    seen: list[httpx.Request] = []
    async with httpx.AsyncClient(transport=_hibp_transport("other", 5, seen)) as client:
        assert await hibp_check("not-in-list-password", client=client) == 0

    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("offline")

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        assert await hibp_check("anything-here", client=client) is None


async def test_check_new_password_uses_hibp_when_enabled(settings: Settings) -> None:
    seen: list[httpx.Request] = []
    password = "leaked-password-1"
    enabled = settings.model_copy(update={"hibp_enabled": True})
    async with httpx.AsyncClient(transport=_hibp_transport(password, 3, seen)) as client:
        with pytest.raises(AppError) as info:
            await check_new_password(password, settings=enabled, client=client)
        assert info.value.code == "auth.password_pwned"
        # Выключено — сеть не трогаем
        await check_new_password(password, settings=settings, client=client)
    assert len(seen) == 1


async def test_check_new_password_accepts_on_network_failure(settings: Settings) -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow")

    enabled = settings.model_copy(update={"hibp_enabled": True})
    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        await check_new_password("fine-password-123", settings=enabled, client=client)
