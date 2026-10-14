"""Ставка по итогу анализа POST /api/bets, банк GET /api/me/bank и букмекеры
GET /api/me/bookmakers: начальный банк, журнал, идемпотентность, состав ног, сумма,
права."""

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import Analysis, BankrollLedger, Bet, BetLeg, Bookmaker
from tests.analysis_helpers import install, make_analysis, run, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import Signed, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec, get_bet, settle_body
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal

PAIRS = (("sinner", "rune"), ("djokovic", "rublev"))


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


async def _done(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    member: Signed,
    world: dict[str, int],
    *pairs: tuple[str, str],
) -> dict[str, Any]:
    analysis_id = await make_analysis(db, redis, member.user.user, world, *pairs)
    assert await run(engine, redis, analysis_id) == "done"
    data: dict[str, Any] = (await member.client.get(f"/api/analyses/{analysis_id}")).json()
    return data


def _bet(
    analysis: dict[str, Any], *, ref: str = "ref-0001", stake: str = "250", **extra: Any
) -> dict[str, Any]:
    legs = [
        {"prediction_id": leg["prediction_id"], "odds_taken": leg["odds"]}
        for leg in analysis["result"]["express"]["legs"]
    ]
    return {
        "analysis_id": analysis["id"],
        "stake": stake,
        "bookmaker": "Fonbet",
        "legs": legs,
        "client_ref": ref,
        **extra,
    }


async def _ledger(db: AsyncSession, user_id: int) -> list[BankrollLedger]:
    rows = await db.scalars(
        select(BankrollLedger)
        .where(BankrollLedger.user_id == user_id)
        .order_by(BankrollLedger.id)
        .execution_options(populate_existing=True)
    )
    return list(rows)


async def test_bet_with_initial_bank_and_repeat(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(
        db, engine, redis, member, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    body = _bet(analysis)
    # Участник поправил кэф первой ноги: итоговый кэф — произведение фактических
    body["legs"][0]["odds_taken"] = "1.28"
    # Букмекер анализа скрыт до ставки: ставка возвращает его в список (скрытый — без ставок
    # в игре)
    await db.execute(
        update(Bookmaker).where(Bookmaker.user_id == member.id).values(archived_at=func.now())
    )
    await db.commit()
    assert (await member.client.get("/api/me/bookmakers")).json() == []
    response = await member.client.post("/api/bets", json=body)
    assert response.status_code == 201, response.text
    bet = response.json()
    assert bet["stake"] == "250.00" and bet["currency"] == "RUB" and bet["status"] == "open"
    other_odds = Decimal(body["legs"][1]["odds_taken"])
    assert Decimal(bet["total_odds"]) == (Decimal("1.28") * other_odds).quantize(Decimal("0.001"))
    assert [leg["odds_taken"] for leg in bet["legs"]] == ["1.28", str(other_odds)]
    ledger = await _ledger(db, member.id)
    assert [(row.kind, row.amount) for row in ledger] == [
        ("deposit", Decimal("10000.00")),
        ("stake", Decimal("-250.00")),
    ]
    assert ledger[0].note == "Начальный банк" and ledger[1].bet_id == bet["id"]
    stored = await db.get_one(Analysis, analysis["id"], populate_existing=True)
    assert stored.decision == "bet"
    view = (await member.client.get(f"/api/analyses/{analysis['id']}")).json()
    assert view["bet_id"] == bet["id"] and view["decision"] == "bet"
    # Экран анализа после перезагрузки показывает сохраненную ставку, а не рекомендацию
    assert view["bet"] == {
        "id": bet["id"],
        "stake": "250.00",
        "currency": "RUB",
        "total_odds": bet["total_odds"],
        "bookmaker": "Fonbet",
        "legs": [
            {"prediction_id": leg["prediction_id"], "odds_taken": leg["odds_taken"]}
            for leg in bet["legs"]
        ],
    }
    assert view["bet"]["legs"][0]["odds_taken"] == "1.28"
    # Повтор с тем же client_ref — та же ставка, журнал не растет
    again = await member.client.post("/api/bets", json=body)
    assert again.status_code == 201 and again.json()["id"] == bet["id"]
    assert len(await _ledger(db, member.id)) == 2
    # Другая ставка по тому же анализу — нельзя
    other = await member.client.post("/api/bets", json=_bet(analysis, ref="ref-0002"))
    assert other.status_code == 409 and error_code(other) == "bet.duplicate"
    # Банк: учет, в игре, адаптации; букмекеры
    bank = (await member.client.get("/api/me/bank")).json()
    assert bank["balance"] == "9750.00" and bank["in_play"] == "250.00"
    assert bank["equity"] == "10000.00" and bank["empty"] is False
    assert bank["invested"] == "10000.00" and bank["drawdown"] == "0.0000"
    assert [item["key"] for item in bank["adaptations"]] == [
        "dd10",
        "dd20",
        "up15",
        "week_loss",
        "week_win",
    ]
    assert not any(item["active"] for item in bank["adaptations"])
    assert (await member.client.get("/api/me/bookmakers")).json() == ["Fonbet"]


@pytest.mark.parametrize(
    ("change", "status", "code"),
    [
        ({"legs": "first"}, 422, "bet.bad_legs"),
        ({"stake": "20000"}, 422, "bet.stake_range"),
        ({"odds": "0.90"}, 422, "bet.odds_range"),
    ],
)
async def test_bet_checks(
    change: dict[str, str],
    status: int,
    code: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(
        db, engine, redis, member, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    body = _bet(analysis)
    if change.get("legs") == "first":
        body["legs"] = body["legs"][:1]
    if "stake" in change:
        body["stake"] = change["stake"]
    if "odds" in change:
        body["legs"][0]["odds_taken"] = change["odds"]
    response = await member.client.post("/api/bets", json=body)
    assert response.status_code == status and error_code(response) == code
    assert await db.scalar(select(Bet.id)) is None
    assert await _ledger(db, member.id) == []


async def test_bet_needs_done_own_analysis(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    owner = await signed_in(make_client, make_user, login)
    analysis = await _done(
        db, engine, redis, owner, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    other = await signed_in(make_client, make_user, login, ip="10.0.0.5")
    response = await other.client.post("/api/bets", json=_bet(analysis))
    assert response.status_code == 404 and error_code(response) == "analysis.not_found"
    draft = (await owner.client.post("/api/analyses", json={"input_kind": "form"})).json()
    body = {**_bet(analysis), "analysis_id": draft["id"]}
    response = await owner.client.post("/api/bets", json=body)
    assert response.status_code == 409 and error_code(response) == "bet.analysis_state"


async def test_parallel_bets_share_one_initial_deposit(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await signed_in(make_client, make_user, login)
    first = await _done(
        db, engine, redis, member, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    second = await _done(
        db, engine, redis, member, world, ("djokovic", "rublev"), ("alcaraz", "medvedev")
    )
    responses = await asyncio.gather(
        member.client.post("/api/bets", json=_bet(first, ref="ref-aaaa")),
        member.client.post("/api/bets", json=_bet(second, ref="ref-bbbb")),
    )
    assert [response.status_code for response in responses] == [201, 201]
    kinds = [row.kind for row in await _ledger(db, member.id)]
    assert kinds.count("deposit") == 1 and kinds.count("stake") == 2
    legs = list(await db.scalars(select(BetLeg)))
    assert len(legs) == 4 and all(leg.prediction_id is not None for leg in legs)


async def test_bank_of_new_member_and_csrf(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    bank = (await member.client.get("/api/me/bank")).json()
    assert bank["empty"] is True and bank["balance"] == "0" and bank["drawdown_level"] is None
    assert (await member.client.get("/api/me/bookmakers")).json() == []
    user = await make_user()
    no_csrf = await login(await make_client("10.0.0.9", csrf=False), user)
    response = await no_csrf.post("/api/bets", json={})
    assert response.status_code == 403 and error_code(response) == "common.csrf"


async def test_settlement_and_new_bet_race(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Расчет одной ставки и новая ставка одновременно: обе под одной блокировкой денег
    участника — новая ставка проверяет сумму по банку уже с выплатой или без нее, журнал
    сходится, начальный банк второй раз не пишется."""
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(
        db, engine, redis, member, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    open_bet = await BetMaker(db).bet(member.user, [LegSpec(odds="2.00")], stake="9000")
    card = await get_bet(member.client, open_bet.id)
    # Банк 1000: ставка на 1500 пройдет, только если выплата 18 000 уже записана
    settled, placed = await asyncio.gather(
        member.client.put(f"/api/bets/{open_bet.id}/result", json=settle_body(card, "win")),
        member.client.post("/api/bets", json=_bet(analysis, stake="1500")),
    )
    assert settled.status_code == 200
    assert placed.status_code in (201, 422)
    kinds = [row.kind for row in await _ledger(db, member.id)]
    assert kinds.count("deposit") == 1 and kinds.count("payout") == 1
    assert kinds.count("stake") == (2 if placed.status_code == 201 else 1)
    if placed.status_code == 422:
        assert error_code(placed) == "bet.stake_range"
    bank = (await member.client.get("/api/me/bank")).json()
    in_play = D("1500") if placed.status_code == 201 else D(0)
    assert D(bank["balance"]) == D("10000") - D("9000") + D("18000") - in_play
    assert D(bank["in_play"]) == in_play


async def test_bet_payout_over_money_limit(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Возможная выплата больше NUMERIC(12, 2): ставку не принимаем, иначе ее выигрыш
    нельзя было бы рассчитать."""
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(
        db, engine, redis, member, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    db.add(
        BankrollLedger(
            user_id=member.id,
            at=datetime.now(UTC),
            kind="deposit",
            amount=D("9500000000"),
            currency="RUB",
        )
    )
    await db.commit()
    response = await member.client.post("/api/bets", json=_bet(analysis, stake="9000000000"))
    assert response.status_code == 422 and error_code(response) == "bet.payout_range"
    assert await db.scalar(select(Bet.id)) is None
    placed = await member.client.post("/api/bets", json=_bet(analysis, stake="1000000"))
    assert placed.status_code == 201
