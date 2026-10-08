import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.security.tokens import hash_code
from app.core.security.totp import current_step, verify_totp
from app.db.models import RecoveryCode, User
from app.db.session import create_sessionmaker
from app.services.two_factor import consume_recovery_code, consume_totp_step
from tests.support import TotpCodeFn, UserFactory


async def _parallel(
    engine: AsyncEngine, consume: Callable[..., Awaitable[bool]], *args: Any
) -> list[bool]:
    """Один и тот же код в двух параллельных запросах, у каждого свое соединение."""
    maker = create_sessionmaker(engine)

    async def one() -> bool:
        async with maker() as session:
            ok = await consume(session, *args)
            await session.commit()
            return ok

    return list(await asyncio.gather(one(), one()))


async def test_same_totp_code_in_parallel_is_accepted_once(
    make_user: UserFactory, engine: AsyncEngine
) -> None:
    member = await make_user()
    assert member.totp_secret is not None
    step = verify_totp(member.totp_secret, member.current_totp(), last_step=None)
    assert step is not None
    results = await _parallel(engine, consume_totp_step, member.id, step)
    assert sorted(results) == [False, True]

    async with create_sessionmaker(engine)() as session:
        user = await session.get(User, member.id)
        assert user is not None and user.totp_last_step == step
        # Тот же и более ранний шаг больше не принимаются, следующий — принимается
        assert not await consume_totp_step(session, member.id, step)
        assert not await consume_totp_step(session, member.id, step - 1)
        assert await consume_totp_step(session, member.id, current_step() + 1)
        await session.commit()


async def test_recovery_code_in_parallel_is_accepted_once(
    make_user: UserFactory, engine: AsyncEngine
) -> None:
    member = await make_user()
    code_hash = hash_code("abcd-efgh")
    async with create_sessionmaker(engine)() as session:
        session.add(RecoveryCode(user_id=member.id, code_hash=code_hash))
        await session.commit()
    results = await _parallel(engine, consume_recovery_code, member.id, code_hash)
    assert sorted(results) == [False, True]

    other = await make_user()
    async with create_sessionmaker(engine)() as session:
        assert not await consume_recovery_code(session, member.id, code_hash)
        # Чужой код не подходит
        assert not await consume_recovery_code(session, other.id, code_hash)


async def test_totp_code_fixture_gives_a_valid_code_every_time(
    make_user: UserFactory, totp_code: TotpCodeFn, engine: AsyncEngine
) -> None:
    member = await make_user()
    assert member.totp_secret is not None
    for _ in range(3):
        code = await totp_code(member)
        async with create_sessionmaker(engine)() as session:
            user = await session.get(User, member.id)
            assert user is not None
            step = verify_totp(member.totp_secret, code, last_step=user.totp_last_step)
            assert step is not None
            assert await consume_totp_step(session, member.id, step)
            await session.commit()
