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
from datetime import date, timedelta
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
    Bookmaker,
    Lesson,
    LessonWatch,
    Notification,
    StrategyVersion,
    TrustedDevice,
    UserSession,
    WeeklyReport,
)
from app.main import create_app
from app.services.notifications import notify
from app.services.sessions import utcnow
from tests.helpers_bets import BetMaker, LegSpec
from tests.players_world import own_open_bet
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
    assert note is not None
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


async def _bookmaker(env: Env, owner: MadeUser) -> int:
    row = Bookmaker(user_id=owner.id, name="Fonbet", created_at=utcnow())
    env.db.add(row)
    await env.db.commit()
    return row.id


async def _bookmaker_untouched(db: AsyncSession, row_id: int) -> bool:
    row = await db.get(Bookmaker, row_id, populate_existing=True)
    return row is not None and row.name == "Fonbet" and row.archived_at is None


async def _report(env: Env, owner: MadeUser) -> int:
    row = WeeklyReport(user_id=owner.id, week_start=date(2026, 10, 5), payload={"empty": True})
    env.db.add(row)
    await env.db.commit()
    return row.id


async def _report_untouched(db: AsyncSession, row_id: int) -> bool:
    row = await db.get(WeeklyReport, row_id, populate_existing=True)
    return row is not None and row.payload == {"empty": True}


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
    ("PATCH", "/api/me/bookmakers/{bookmaker_id}"): {"name": "Чужой", "archived": True},
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
    ("GET", "/api/bets/{bet_id}/review"): (_bet, _bet_untouched),
    ("PUT", "/api/bets/{bet_id}/result"): (_bet, _bet_untouched),
    ("POST", "/api/bets/{bet_id}/reverse"): (_bet, _bet_untouched),
    ("PUT", "/api/bets/{bet_id}/legs/{leg_id}/closing"): (_bet_leg, _bet_untouched),
    ("PATCH", "/api/me/bookmakers/{bookmaker_id}"): (_bookmaker, _bookmaker_untouched),
    ("DELETE", "/api/me/bookmakers/{bookmaker_id}"): (_bookmaker, _bookmaker_untouched),
    # Еженедельный отчет (этап 5, волна 4): только свой
    ("GET", "/api/learning/reports/{report_id}"): (_report, _report_untouched),
}


# Общие данные (игроки, матчи, новости): чужой участник получает их (200), но без личного
# владельца — «сегодня» в карточке игрока строится только из своих ставок и анализов
SHARED_ROUTES = {
    ("GET", "/api/players/{player_id}"),
    ("GET", "/api/players/{player_id}/matches"),
    ("GET", "/api/players/{player_id}/news"),
    ("GET", "/api/players/{player_id}/h2h/{opponent_id}"),
}


# Уроки (этап 5, волна 2): общие уроки видит каждый, решения — только администратор (403),
# свой урок участника (user_id) другому не виден (404)
LESSON_ROUTES = {
    ("GET", "/api/lessons/{lesson_id}"),
    ("GET", "/api/lessons/{lesson_id}/quick-check"),
    ("POST", "/api/lessons/{lesson_id}/quick-check"),
    ("POST", "/api/lessons/{lesson_id}/enable"),
    ("POST", "/api/lessons/{lesson_id}/disable"),
    ("POST", "/api/lessons/{lesson_id}/notify-when-ready"),
}
LESSON_ADMIN_ROUTES = {
    ("GET", "/api/lessons/{lesson_id}/quick-check"),
    ("POST", "/api/lessons/{lesson_id}/quick-check"),
    ("POST", "/api/lessons/{lesson_id}/enable"),
    ("POST", "/api/lessons/{lesson_id}/disable"),
}


# Версии стратегии (этап 5, волна 3): свои правила суммы другого участника — 404 и не
# меняются; общую линию инструкций видит каждый, решения по ней — только администратор
STRATEGY_ROUTES = {
    ("GET", "/api/strategy/versions/{version_id}"),
    ("POST", "/api/strategy/versions/{version_id}/activate"),
    ("POST", "/api/strategy/versions/{version_id}/rollback"),
    ("POST", "/api/strategy/versions/{version_id}/reject"),
}


def test_every_id_route_is_checked() -> None:
    """Новый адрес с id в пути (например, /api/bets/{bet_id}) должен попасть сюда."""
    checked = set(FOREIGN_CASES) | SHARED_ROUTES | LESSON_ROUTES | STRATEGY_ROUTES
    assert set(ID_ROUTES) == checked, (
        "добавьте в FOREIGN_CASES проверку чужого объекта для новых адресов"
    )
    assert not set(FOREIGN_CASES) & SHARED_ROUTES


@pytest.mark.parametrize(("method", "path"), sorted(STRATEGY_ROUTES), ids=lambda v: str(v))
async def test_strategy_routes_hide_foreign_rules_and_keep_shared_to_admin(
    method: str,
    path: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    owner = await make_user()
    own = StrategyVersion(
        user_id=owner.id, code="r2", name="r2", status="candidate", params={}, goal="rules"
    )
    shared = StrategyVersion(
        user_id=None, code="v4", name="v4", status="candidate", params={}, goal="quality"
    )
    db.add_all([own, shared])
    await db.commit()
    alice = await login(await make_client("10.0.0.1"), await make_user())
    foreign = await alice.request(method, path.replace("{version_id}", str(own.id)))
    assert foreign.status_code == 404, foreign.text
    common = await alice.request(method, path.replace("{version_id}", str(shared.id)))
    assert common.status_code == (200 if method == "GET" else 403), common.text
    for row_id in (own.id, shared.id):
        row = await db.get_one(StrategyVersion, row_id, populate_existing=True)
        assert row.status == "candidate"


@pytest.mark.parametrize(("method", "path"), sorted(LESSON_ROUTES), ids=lambda v: str(v))
async def test_lesson_routes_hide_personal_and_keep_decisions_to_admin(
    method: str,
    path: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    owner = await make_user()
    personal = Lesson(user_id=owner.id, code="L-001", text="Свой урок", kind="numeric")
    shared = Lesson(user_id=None, code="L-001", text="Общий урок", kind="numeric")
    db.add_all([personal, shared])
    await db.commit()
    alice = await login(await make_client("10.0.0.1"), await make_user())
    foreign = await alice.request(method, path.replace("{lesson_id}", str(personal.id)))
    assert foreign.status_code in (403, 404), foreign.text
    common = await alice.request(method, path.replace("{lesson_id}", str(shared.id)))
    if (method, path) in LESSON_ADMIN_ROUTES:
        assert common.status_code == 403, common.text
    else:
        assert common.status_code == 200, common.text
    row = await db.get_one(Lesson, personal.id, populate_existing=True)
    assert (row.status, row.in_prompt) == ("hypothesis", False)
    assert (
        await db.scalar(select(LessonWatch.user_id).where(LessonWatch.lesson_id == personal.id))
        is None
    )


def _keys(node: Any) -> set[str]:
    if isinstance(node, dict):
        return set(node) | {key for value in node.values() for key in _keys(value)}
    if isinstance(node, list):
        return {key for item in node for key in _keys(item)}
    return set()


@pytest.mark.parametrize(("method", "path"), sorted(SHARED_ROUTES), ids=lambda v: str(v))
async def test_shared_player_routes_hide_foreign_bets(
    method: str,
    path: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    owner = await make_user()
    maker = BetMaker(db)
    first = await maker.player("Owner Pick")
    second = await maker.player("Owner Opponent")
    await db.commit()
    _, bet_id, analysis_id = await own_open_bet(db, owner.id, first.id, second.id)
    alice = await login(await make_client("10.0.0.1"), await make_user())
    url = path.replace("{player_id}", str(first.id)).replace("{opponent_id}", str(second.id))
    response = await alice.request(method, url)
    assert response.status_code == 200, response.text
    body = response.json()
    if path == "/api/players/{player_id}":
        assert body["today"] == []
    assert not _keys(body) & {"bet_id", "leg_id", "analysis_id", "analyses", "bets"} - (
        {"analyses", "bets"} if path == "/api/players/{player_id}" else set()
    )
    owner_client = await login(await make_client("10.0.0.2"), owner)
    mine = (await owner_client.request(method, url)).json()
    if path == "/api/players/{player_id}":
        assert [bet["bet_id"] for bet in mine["today"][0]["bets"]] == [bet_id]
        assert mine["today"][0]["analyses"] == [analysis_id]


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
