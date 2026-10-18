"""Р29: варианты ставки в итоге анализа и сохранение ставок разных видов (POST /api/bets):
экспресс стратегии, ординар из вариантов, своя ставка; несколько ставок по одному
анализу, защита от двойного нажатия, права (чужой анализ, просмотр администратора Р27),
банк и ответственная игра; варианты анализа до Р29 пересчитываются при чтении."""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import Analysis, Bet, Match, PlayLimit
from app.ml.strategy import StrategyParams
from app.services.analysis_result import stored_variants
from app.services.bank import bank_state
from tests.analysis_helpers import install, make_analysis, run, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import Signed, admin_signed_in, error_code, signed_in
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
TWO = (("sinner", "rune"), ("djokovic", "rublev"))


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
    response = await member.client.get(f"/api/analyses/{analysis_id}")
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def _variant(analysis: dict[str, Any], code: str) -> dict[str, Any]:
    found: list[dict[str, Any]] = [
        item for item in analysis["result"]["variants"] if item["code"] == code
    ]
    assert found, [item["code"] for item in analysis["result"]["variants"]]
    return found[0]


def _body(
    analysis: dict[str, Any],
    kind: str,
    legs: list[dict[str, Any]],
    *,
    ref: str,
    stake: str = "100",
) -> dict[str, Any]:
    return {
        "analysis_id": analysis["id"],
        "kind": kind,
        "stake": stake,
        "bookmaker": "Fonbet",
        "legs": legs,
        "client_ref": ref,
    }


def _legs_of(variant: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"prediction_id": leg["prediction_id"], "odds_taken": leg["odds"]}
        for leg in variant["legs"]
    ]


def _row(analysis: dict[str, Any], match: int, market: str, selection: int) -> dict[str, Any]:
    rows = analysis["result"]["matches"][match]["markets"]
    return next(row for row in rows if row["market"] == market and row["selection"] == selection)


async def test_variants_in_result(
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
    analysis = await _done(db, engine, redis, member, world, *TWO)
    result = analysis["result"]
    variants = result["variants"]
    codes = [item["code"] for item in variants]
    # Экспресс собран: первым — он, «Экспресса из лучших» нет
    assert codes[0] == "strategy" and "best_express" not in codes
    strategy = variants[0]
    express = result["express"]
    assert strategy["kind"] == "strategy" and not strategy["outside_strategy"]
    assert strategy["legs"] == express["legs"]
    assert strategy["total_odds"] == express["total_odds"]
    assert strategy["stake"] == express["stake"]["amount"]
    assert strategy["stake_calc"] == express["stake"]
    singles = [item for item in variants if item["kind"] == "single"]
    assert singles and all(len(item["legs"]) == 1 for item in singles)
    for item in singles:
        leg = item["legs"][0]
        assert leg["market"] != "HCP_+1.5"
        assert item["why_key"].startswith("analysis.variants.why.")
        assert item["stake_calc"]["steps"][0]["params"]["table"] == "single"
        if "no_value" in item["warnings"]:
            assert item["stake"] is None and item["stake_calc"]["reason"] == "no_value"
        row = next(
            row
            for match in result["matches"]
            for row in match["markets"]
            if row["prediction_id"] == leg["prediction_id"]
        )
        assert item["p"] == pytest.approx(row["p_final"]) and item["value"] == pytest.approx(
            row["value"]
        )
    # Анализ до Р29 (в сохраненном итоге вариантов нет): те же варианты при чтении
    stored = await db.get_one(Analysis, analysis["id"], populate_existing=True)
    old = dict(stored.result or {})
    old.pop("variants")
    await db.execute(update(Analysis).where(Analysis.id == stored.id).values(result=old))
    await db.commit()
    again = (await member.client.get(f"/api/analyses/{analysis['id']}")).json()
    assert again["result"]["variants"] == variants


async def test_single_and_express_on_one_analysis(
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
    analysis = await _done(db, engine, redis, member, world, *TWO)
    single = next(item for item in analysis["result"]["variants"] if item["kind"] == "single")
    body = _body(analysis, "single", _legs_of(single), ref="single-0001")
    # Кэф при ставке может отличаться от кэфа анализа
    body["legs"][0]["odds_taken"] = "1.33"
    placed = await member.client.post("/api/bets", json=body)
    assert placed.status_code == 201, placed.text
    assert placed.json()["kind"] == "single" and placed.json()["total_odds"] == "1.33"
    # Двойное нажатие: тот же ключ — та же ставка; новый ключ, та же ставка — 409
    again = await member.client.post("/api/bets", json=body)
    assert again.status_code == 201 and again.json()["id"] == placed.json()["id"]
    twice = await member.client.post("/api/bets", json={**body, "client_ref": "single-0002"})
    assert twice.status_code == 409 and error_code(twice) == "bet.duplicate"
    # Экспресс стратегии по тому же анализу — можно
    strategy = _variant(analysis, "strategy")
    express = await member.client.post(
        "/api/bets", json=_body(analysis, "strategy", _legs_of(strategy), ref="express-0001")
    )
    assert express.status_code == 201, express.text
    assert express.json()["kind"] == "strategy"
    view = (await member.client.get(f"/api/analyses/{analysis['id']}")).json()
    assert [item["kind"] for item in view["bets"]] == ["single", "strategy"]
    assert view["bet"] == view["bets"][0] and view["decision"] == "bet"
    # Список, карточка, итоги и выгрузка — с видом ставки, фильтр по виду
    listed = (await member.client.get("/api/bets")).json()["items"]
    assert {item["kind"] for item in listed} == {"single", "strategy"}
    only = (await member.client.get("/api/bets", params={"kind": "single"})).json()["items"]
    assert [item["id"] for item in only] == [placed.json()["id"]]
    card = (await member.client.get(f"/api/bets/{express.json()['id']}")).json()
    assert card["kind"] == "strategy"
    summary = (await member.client.get("/api/bets/summary", params={"kind": "own"})).json()
    assert summary["open"] == 0
    summary = (await member.client.get("/api/bets/summary", params={"kind": "single"})).json()
    assert summary["open"] == 1 and D(summary["open_stake"]) == D("100")
    text = (await member.client.get("/api/bets/export.csv")).text
    header = text.lstrip("﻿").splitlines()[0].split(",")
    assert header[3] == "Вид ставки"
    assert {line.split(",")[3] for line in text.splitlines()[1:]} == {"single", "strategy"}
    dashboard = (await member.client.get("/api/dashboard")).json()
    assert {item["kind"] for item in dashboard["open_bets"]} == {"single", "strategy"}
    bad = await member.client.get("/api/bets", params={"kind": "legacy"})
    assert bad.status_code == 422


async def test_strategy_and_single_must_match_variant(
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
    analysis = await _done(db, engine, redis, member, world, *TWO)
    variant_ids = {
        leg["prediction_id"]
        for item in analysis["result"]["variants"]
        if item["kind"] == "single"
        for leg in item["legs"]
    }
    other = next(
        row
        for match in analysis["result"]["matches"]
        for row in match["markets"]
        if row["prediction_id"] not in variant_ids and row["odds"] is not None
    )
    leg = [{"prediction_id": other["prediction_id"], "odds_taken": other["odds"]}]
    single = await member.client.post(
        "/api/bets", json=_body(analysis, "single", leg, ref="single-bad1")
    )
    assert single.status_code == 422 and error_code(single) == "bet.bad_legs"
    strategy = _variant(analysis, "strategy")
    first = _legs_of(strategy)[:1]
    response = await member.client.post(
        "/api/bets", json=_body(analysis, "strategy", first, ref="express-bad1")
    )
    assert response.status_code == 422 and error_code(response) == "bet.bad_legs"
    assert await db.scalar(select(Bet.id)) is None


async def test_own_bet_any_market_one_per_match(
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
    analysis = await _done(db, engine, redis, member, world, *TWO)
    plus = _row(analysis, 0, "HCP_+1.5", 2)
    # Рынок на проверке помечен в таблице (Р28), остальные — нет
    assert plus["suspended"] is True and _row(analysis, 0, "ML", 1)["suspended"] is False
    second = analysis["result"]["matches"][1]
    # Ф(+1.5) на проверке ставится своей ставкой; исход — по матчу, рынку и стороне
    legs = [
        {"prediction_id": plus["prediction_id"], "odds_taken": "2.05"},
        {
            "match_id": second["match_id"],
            "market": "ML",
            "selection": 2,
            "odds_taken": "2.80",
        },
    ]
    placed = await member.client.post(
        "/api/bets", json=_body(analysis, "own", legs, ref="own-00001", stake="70")
    )
    assert placed.status_code == 201, placed.text
    bet = placed.json()
    assert bet["kind"] == "own" and bet["total_odds"] == "5.74"
    assert [(leg["market"], leg["selection"]) for leg in bet["legs"]] == [
        ("HCP_+1.5", 2),
        ("ML", 2),
    ]
    assert bet["legs"][1]["prediction_id"] == _row(analysis, 1, "ML", 2)["prediction_id"]
    # Вероятность модели у ноги своей ставки есть: калибровка и CLV
    card = (await member.client.get(f"/api/bets/{bet['id']}")).json()
    assert card["legs"][0]["p_final"] == pytest.approx(plus["p_final"])
    # Ординар своей ставкой; второй рынок того же матча — 422
    one = [{"prediction_id": _row(analysis, 0, "ML", 1)["prediction_id"], "odds_taken": "1.30"}]
    alone = await member.client.post("/api/bets", json=_body(analysis, "own", one, ref="own-00002"))
    assert alone.status_code == 201 and alone.json()["kind"] == "own"
    same = [
        {"prediction_id": _row(analysis, 0, "ML", 1)["prediction_id"], "odds_taken": "1.30"},
        {"prediction_id": _row(analysis, 0, "HCP_-1.5", 1)["prediction_id"], "odds_taken": "2.0"},
    ]
    response = await member.client.post(
        "/api/bets", json=_body(analysis, "own", same, ref="own-00003")
    )
    assert response.status_code == 422 and error_code(response) == "bet.same_match"
    # Исход другого анализа — 422. У анализа одного матча нет ни экспресса стратегии, ни
    # «Экспресса из лучших» — только ординары
    another = await _done(db, engine, redis, member, world, ("alcaraz", "medvedev"))
    assert another["result"]["express"] is None
    found = [item["code"] for item in another["result"]["variants"]]
    assert found and set(found) <= {"safer", "value"}
    foreign = [{"prediction_id": _row(another, 0, "ML", 1)["prediction_id"], "odds_taken": "1.3"}]
    response = await member.client.post(
        "/api/bets", json=_body(analysis, "own", foreign, ref="own-00004")
    )
    assert response.status_code == 422 and error_code(response) == "bet.not_in_analysis"
    # Нога без исхода — 422 проверки схемы
    response = await member.client.post(
        "/api/bets",
        json=_body(analysis, "own", [{"match_id": 1, "odds_taken": "1.5"}], ref="own-00005"),
    )
    assert response.status_code == 422
    # Фильтр «Свои» в аналитике и итогах
    summary = (await member.client.get("/api/bets/summary", params={"kind": "own"})).json()
    assert summary["open"] == 2 and D(summary["open_stake"]) == D("170")


async def test_own_bet_money_checks(
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
    analysis = await _done(db, engine, redis, member, world, *TWO)
    legs = [{"prediction_id": _row(analysis, 0, "ML", 2)["prediction_id"], "odds_taken": "3.6"}]
    # Сумма больше банка (банк из ввода 10 000)
    response = await member.client.post(
        "/api/bets", json=_body(analysis, "own", legs, ref="money-0001", stake="10000.01")
    )
    assert response.status_code == 422 and error_code(response) == "bet.stake_range"
    # Ответственная игра: пауза — 409, как у экспресса
    db.add(PlayLimit(user_id=member.id, paused_until=datetime.now(UTC) + timedelta(days=1)))
    await db.commit()
    response = await member.client.post(
        "/api/bets", json=_body(analysis, "own", legs, ref="money-0002")
    )
    assert response.status_code == 409 and error_code(response) == "play.paused"
    assert await db.scalar(select(Bet.id)) is None


async def test_bet_permissions(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Чужой анализ — 404 при любом виде ставки; администратор в режиме просмотра (as_user,
    Р27) ставку участнику не записывает — 403, а прочитать варианты может."""
    owner = await signed_in(make_client, make_user, login)
    analysis = await _done(db, engine, redis, owner, world, *TWO)
    legs = [{"prediction_id": _row(analysis, 0, "ML", 1)["prediction_id"], "odds_taken": "1.3"}]
    other = await signed_in(make_client, make_user, login, ip="10.0.0.5")
    for kind in ("own", "single", "strategy"):
        response = await other.client.post(
            "/api/bets", json=_body(analysis, kind, legs, ref=f"perm-{kind}-01")
        )
        assert response.status_code == 404 and error_code(response) == "analysis.not_found"
    admin = await admin_signed_in(make_client, make_user, login)
    response = await admin.client.post(
        "/api/bets",
        params={"as_user": owner.id},
        json=_body(analysis, "own", legs, ref="perm-admin-01"),
    )
    assert response.status_code == 403 and error_code(response) == "common.forbidden"
    seen = await admin.client.get(f"/api/analyses/{analysis['id']}", params={"as_user": owner.id})
    assert seen.status_code == 200
    assert seen.json()["result"]["variants"] == analysis["result"]["variants"]
    for path in ("/api/bets", "/api/bets/summary", "/api/analytics"):
        response = await admin.client.get(path, params={"as_user": owner.id, "kind": "own"})
        assert response.status_code == 200, (path, response.text)
    assert await db.scalar(select(Bet.id)) is None


async def test_bet_needs_result_and_unstarted_matches(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Анализ без итога (импорт старого бота) — 409 bet.no_result у любого вида. Матч с
    исходом или с прошедшим временем начала — 422 bet.match_started у любого вида; матч без
    времени и исхода и прошлая встреча пары (сыграна раньше анализа больше чем на сутки) —
    можно."""
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(db, engine, redis, member, world, *TWO)
    first, second = (item["match_id"] for item in analysis["result"]["matches"])
    strategy = _legs_of(_variant(analysis, "strategy"))
    own = [{"prediction_id": _row(analysis, 1, "ML", 2)["prediction_id"], "odds_taken": "2.8"}]
    # Матч сыгран: исход в базе (после привязки к архиву), время неизвестно
    match = await db.get_one(Match, first, populate_existing=True)
    match.winner_id, match.score, match.status = match.player1_id, "6-3 6-4", "finished"
    match.match_date = datetime.now(UTC).date()
    await db.commit()
    played = [{"prediction_id": _row(analysis, 0, "ML", 2)["prediction_id"], "odds_taken": "3.6"}]
    for kind, legs in (("strategy", strategy), ("own", played)):
        response = await member.client.post(
            "/api/bets", json=_body(analysis, kind, legs, ref=f"started-{kind}")
        )
        assert response.status_code == 422 and error_code(response) == "bet.match_started"
    # Прошлая встреча пары: матч архива за неделю до анализа — нога разрешена
    match.match_date = datetime.now(UTC).date() - timedelta(days=7)
    await db.commit()
    placed = await member.client.post(
        "/api/bets", json=_body(analysis, "strategy", strategy, ref="past-meeting")
    )
    assert placed.status_code == 201, placed.text
    # Время начала известно и прошло, исхода нет — 422; время впереди — можно
    other = await db.get_one(Match, second, populate_existing=True)
    other.scheduled_at = datetime.now(UTC) - timedelta(minutes=5)
    await db.commit()
    response = await member.client.post(
        "/api/bets", json=_body(analysis, "own", own, ref="late-0001")
    )
    assert response.status_code == 422 and error_code(response) == "bet.match_started"
    other.scheduled_at = datetime.now(UTC) + timedelta(hours=2)
    await db.commit()
    response = await member.client.post(
        "/api/bets", json=_body(analysis, "own", own, ref="soon-0001")
    )
    assert response.status_code == 201, response.text
    # Анализ без итога, как у импорта старого бота: 409 у любого вида
    await db.execute(update(Analysis).where(Analysis.id == analysis["id"]).values(result=None))
    await db.commit()
    for kind in ("own", "single", "strategy"):
        response = await member.client.post(
            "/api/bets", json=_body(analysis, kind, own, ref=f"legacy-{kind}-01")
        )
        assert response.status_code == 409 and error_code(response) == "bet.no_result"
    assert len(list(await db.scalars(select(Bet.id)))) == 2


async def test_skip_refused_after_any_bet(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """После ординара «Не ставить» и снятие решения — 409 analysis.bad_state, даже если
    решение анализа почему-то не «поставил»: ставка по нему есть."""
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(db, engine, redis, member, world, *TWO)
    url = f"/api/analyses/{analysis['id']}/decision"
    single = next(item for item in analysis["result"]["variants"] if item["kind"] == "single")
    placed = await member.client.post(
        "/api/bets", json=_body(analysis, "single", _legs_of(single), ref="skip-single1")
    )
    assert placed.status_code == 201, placed.text
    for decision in ("skip", None):
        response = await member.client.put(url, json={"decision": decision})
        assert response.status_code == 409 and error_code(response) == "analysis.bad_state"
    await db.execute(update(Analysis).where(Analysis.id == analysis["id"]).values(decision=None))
    await db.commit()
    response = await member.client.put(url, json={"decision": "skip"})
    assert response.status_code == 409 and error_code(response) == "analysis.bad_state"
    stored = await db.get_one(Analysis, analysis["id"], populate_existing=True)
    assert stored.decision is None


async def test_stored_express_kept_when_leg_not_in_table(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Анализ до Р29: строку ноги экспресса не найти в таблице (у строки нет кэфа) —
    экспресс стратегии все равно есть, «Экспресса из лучших» рядом с ним нет. Ногу не
    восстановить совсем — варианта strategy нет, но и «Экспресса из лучших» нет."""
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(db, engine, redis, member, world, *TWO)
    express = analysis["result"]["express"]
    leg = express["legs"][0]

    async def view(result: dict[str, Any]) -> list[str]:
        await db.execute(
            update(Analysis).where(Analysis.id == analysis["id"]).values(result=result)
        )
        await db.commit()
        data = (await member.client.get(f"/api/analyses/{analysis['id']}")).json()
        return [item["code"] for item in data["result"]["variants"]]

    stored = await db.get_one(Analysis, analysis["id"], populate_existing=True)
    old = dict(stored.result or {})
    old.pop("variants")
    for match in old["matches"]:
        for row in match["markets"]:
            if row["prediction_id"] == leg["prediction_id"]:
                row["odds"] = None
    codes = await view(old)
    assert codes[0] == "strategy" and "best_express" not in codes
    data = (await member.client.get(f"/api/analyses/{analysis['id']}")).json()
    strategy = data["result"]["variants"][0]
    assert [item["prediction_id"] for item in strategy["legs"]] == [
        item["prediction_id"] for item in express["legs"]
    ]
    # Ставка на этот экспресс сохраняется как экспресс стратегии
    placed = await member.client.post(
        "/api/bets", json=_body(data, "strategy", _legs_of(strategy), ref="stored-exp1")
    )
    assert placed.status_code == 201, placed.text
    # Ногу не восстановить (в экспрессе нет кэфа; схема ответа такого не пропустит, поэтому —
    # прямым вызовом)
    broken = {**old, "express": {**express, "legs": [{**leg, "odds": None}, *express["legs"][1:]]}}
    found = stored_variants(
        broken,
        params=StrategyParams(),
        state=await bank_state(db, member.id),
        bank_input=D("10000"),
        currency="RUB",
    )
    codes = [item["code"] for item in found]
    assert codes and "strategy" not in codes and "best_express" not in codes
