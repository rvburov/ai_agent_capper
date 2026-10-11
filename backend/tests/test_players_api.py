"""Поиск игроков для подсказок формы: GET /api/players?q=, GET /api/strategy/active."""

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from tests.analysis_helpers import seed_world
from tests.helpers_admin import error_code, signed_in
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    return await seed_world(db, engine)


async def test_search_in_cyrillic_and_latin(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, world: dict[str, int]
) -> None:
    member = await signed_in(make_client, make_user, login)
    found = (await member.client.get("/api/players", params={"q": "Синнер"})).json()
    assert found[0]["id"] == world["sinner"] and found[0]["score"] >= 0.9
    assert found[0]["elo_rank"] == 1 and found[0]["last_match"] is not None
    assert found[0]["country"] == "ITA" and found[0]["matches"] > 0
    latin = (await member.client.get("/api/players", params={"q": "djokovic"})).json()
    assert latin[0]["id"] == world["djokovic"]
    limited = (await member.client.get("/api/players", params={"q": "a", "limit": 2})).json()
    assert len(limited) <= 2


@pytest.mark.parametrize(
    ("query", "code"),
    [("   ", "players.errors.query_empty"), ("x" * 150, "players.errors.query_too_long")],
)
async def test_bad_query(
    query: str,
    code: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    response = await member.client.get("/api/players", params={"q": query})
    assert response.status_code == 422 and error_code(response) == code


async def test_players_need_login(make_client: ClientFactory) -> None:
    anonymous = await make_client()
    assert (await anonymous.get("/api/players", params={"q": "x"})).status_code == 401


async def test_strategy_defaults_before_first_analysis(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    data = (await member.client.get("/api/strategy/active")).json()
    assert data["id"] is None and data["code"] == "v3"
    params = data["params"]
    assert params["min_p"] == 0.65 and params["leg_odds"] == ["1.13", "1.80"]
    assert params["drawdown"][1] == {
        "start": "0.20",
        "max_pct": "0.015",
        "max_legs": 2,
        "max_leg_odds": "1.50",
    }
    assert params["adapt"] == {
        "dd10": True,
        "dd20": True,
        "up15": True,
        "week_loss": True,
        "week_win": True,
    }


@pytest.mark.parametrize(
    ("method", "url"),
    [
        ("GET", "/api/analyses"),
        ("POST", "/api/analyses"),
        ("POST", "/api/bets"),
        ("GET", "/api/me/bank"),
        ("GET", "/api/me/bookmakers"),
        ("GET", "/api/strategy/active"),
        ("GET", "/api/players?q=a"),
    ],
)
async def test_new_routes_need_login(method: str, url: str, make_client: ClientFactory) -> None:
    anonymous = await make_client()
    body: dict[str, str] | None = {} if method == "POST" else None
    response = await anonymous.request(method, url, json=body)
    assert response.status_code == 401 and error_code(response) == "auth.not_authenticated"
