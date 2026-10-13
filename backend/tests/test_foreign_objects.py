"""Участник не видит и не меняет чужое (PLAN.md, этап 1: «участник не видит чужие ставки»).

Список адресов с id в пути берется из схемы OpenAPI приложения (кроме /api/admin, их
проверяет test_admin_permissions). Каждый такой адрес обязан быть в FOREIGN_CASES:
там сказано, как создать объект другого участника и как убедиться, что он не тронут.
Появится /api/bets/{bet_id} — test_every_id_route_is_checked упадет, пока для него не
добавят случай сюда. Так проверка чужих ставок, банка и анализов не потеряется на
следующих этапах.
"""

import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security.tokens import hash_token, new_token
from app.db.models import (
    Analysis,
    BankrollLedger,
    Bet,
    BetLeg,
    Notification,
    TrustedDevice,
    UserSession,
)
from app.main import create_app
from app.services.notifications import notify
from app.services.sessions import utcnow
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, MadeUser, UserFactory

_SCHEMA = create_app().openapi()
ID_ROUTES = sorted(
    (method.upper(), path)
    for path, operations in _SCHEMA["paths"].items()
    if path.startswith("/api/") and not path.startswith("/api/admin") and "{" in path
    for method in operations
)


@dataclass(frozen=True)
class Env:
    db: AsyncSession
    make_client: ClientFactory
    login: LoginFn


# Создает объект владельца (owner) и возвращает его id (или id для каждого {параметра}
# пути, если их несколько)
Create = Callable[[Env, MadeUser], Awaitable[int | dict[str, int]]]
# True, если объект после запроса чужого участника остался как был
Untouched = Callable[[AsyncSession, int], Awaitable[bool]]


async def _session(env: Env, owner: MadeUser) -> int:
    await env.login(await env.make_client("10.0.0.2"), owner)
    found = await env.db.scalar(select(UserSession.id).where(UserSession.user_id == owner.id))
    assert found is not None
    return int(found)


async def _session_alive(db: AsyncSession, row_id: int) -> bool:
    row = await db.get_one(UserSession, row_id, populate_existing=True)
    return row.revoked_at is None


async def _device(env: Env, owner: MadeUser) -> int:
    device = TrustedDevice(
        user_id=owner.id,
        token_hash=hash_token(new_token()),
        expires_at=utcnow() + timedelta(days=30),
    )
    env.db.add(device)
    await env.db.commit()
    return device.id


async def _device_alive(db: AsyncSession, row_id: int) -> bool:
    row = await db.get_one(TrustedDevice, row_id, populate_existing=True)
    return row.revoked_at is None


async def _notification(env: Env, owner: MadeUser) -> int:
    note = await notify(env.db, user_id=owner.id, kind="new_device", device="Safari", ip="1.2.3.4")
    await env.db.commit()
    return note.id


async def _notification_unread(db: AsyncSession, row_id: int) -> bool:
    row = await db.get_one(Notification, row_id, populate_existing=True)
    return row.read_at is None


async def _analysis(env: Env, owner: MadeUser) -> int:
    row = Analysis(user_id=owner.id, input_text="", input_kind="form", status="needs_confirmation")
    env.db.add(row)
    await env.db.commit()
    return row.id


async def _analysis_untouched(db: AsyncSession, row_id: int) -> bool:
    row = await db.get_one(Analysis, row_id, populate_existing=True)
    return (row.status, row.attempt, row.decision, row.confirmed) == (
        "needs_confirmation",
        0,
        None,
        None,
    )


async def _bet(env: Env, owner: MadeUser) -> int:
    bet = await BetMaker(env.db).bet(owner, [LegSpec(), LegSpec()])
    return bet.id


async def _bet_leg(env: Env, owner: MadeUser) -> dict[str, int]:
    bet_id = await _bet(env, owner)
    leg_id = await env.db.scalar(select(BetLeg.id).where(BetLeg.bet_id == bet_id).limit(1))
    assert leg_id is not None
    return {"bet_id": bet_id, "leg_id": leg_id}


async def _bet_untouched(db: AsyncSession, row_id: int) -> bool:
    bet = await db.get_one(Bet, row_id, populate_existing=True)
    legs = list(
        await db.scalars(
            select(BetLeg).where(BetLeg.bet_id == row_id).execution_options(populate_existing=True)
        )
    )
    ledger = list(
        await db.scalars(select(BankrollLedger.kind).where(BankrollLedger.bet_id == row_id))
    )
    return (
        bet.status == "open"
        and bet.settled_at is None
        and all(leg.result is None and leg.closing_odds is None for leg in legs)
        and ledger == ["stake"]
    )


# Годное тело запроса: иначе проверка формы (422) сработала бы раньше проверки прав
_STAMP = "2026-10-13T10:00:00+00:00"
BODIES: dict[tuple[str, str], dict[str, Any]] = {
    ("PUT", "/api/bets/{bet_id}/result"): {
        "expected_updated_at": _STAMP,
        "legs": [{"leg_id": 1, "result": "win"}],
    },
    ("POST", "/api/bets/{bet_id}/reverse"): {"expected_updated_at": _STAMP},
    ("PUT", "/api/bets/{bet_id}/legs/{leg_id}/closing"): {
        "closing": {"odds": "1.50", "by": "pinnacle"}
    },
}


FOREIGN_CASES: dict[tuple[str, str], tuple[Create, Untouched]] = {
    ("DELETE", "/api/me/sessions/{session_id}"): (_session, _session_alive),
    ("DELETE", "/api/me/trusted-devices/{device_id}"): (_device, _device_alive),
    ("POST", "/api/me/notifications/{notification_id}/read"): (
        _notification,
        _notification_unread,
    ),
    ("GET", "/api/analyses/{analysis_id}"): (_analysis, _analysis_untouched),
    ("GET", "/api/analyses/{analysis_id}/events"): (_analysis, _analysis_untouched),
    ("POST", "/api/analyses/{analysis_id}/preview"): (_analysis, _analysis_untouched),
    ("POST", "/api/analyses/{analysis_id}/run"): (_analysis, _analysis_untouched),
    ("POST", "/api/analyses/{analysis_id}/cancel"): (_analysis, _analysis_untouched),
    ("PUT", "/api/analyses/{analysis_id}/decision"): (_analysis, _analysis_untouched),
    ("GET", "/api/bets/{bet_id}"): (_bet, _bet_untouched),
    ("PUT", "/api/bets/{bet_id}/result"): (_bet, _bet_untouched),
    ("POST", "/api/bets/{bet_id}/reverse"): (_bet, _bet_untouched),
    ("PUT", "/api/bets/{bet_id}/legs/{leg_id}/closing"): (_bet_leg, _bet_untouched),
}


def test_every_id_route_is_checked() -> None:
    """Новый адрес с id в пути (например, /api/bets/{bet_id}) должен попасть сюда."""
    assert set(ID_ROUTES) == set(FOREIGN_CASES), (
        "добавьте в FOREIGN_CASES проверку чужого объекта для новых адресов"
    )


@pytest.mark.parametrize(("method", "path"), sorted(FOREIGN_CASES), ids=lambda v: str(v))
async def test_member_cannot_reach_foreign_object(
    method: str,
    path: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    create, untouched = FOREIGN_CASES[(method, path)]
    owner = await make_user()
    created = await create(Env(db=db, make_client=make_client, login=login), owner)
    ids = created if isinstance(created, dict) else None
    foreign_id = next(iter(ids.values())) if ids is not None else created
    assert isinstance(foreign_id, int)
    alice = await login(await make_client("10.0.0.1"), await make_user())

    url = re.sub(
        r"\{([^}]+)\}",
        lambda found: str(ids[found.group(1)] if ids is not None else foreign_id),
        path,
    )
    body: dict[str, Any] | None = (
        BODIES.get((method, path), {}) if method in {"POST", "PUT", "PATCH"} else None
    )
    response = await alice.request(method, url, json=body)
    assert response.status_code in (403, 404), response.text
    assert await untouched(db, foreign_id)
