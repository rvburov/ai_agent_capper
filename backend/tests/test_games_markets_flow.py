"""Р28, этап 7, волна 3 — рынки по геймам в анализе: шаг модели называет цепь геймов,
семейство, модель которого не прошла проверку, — без вероятности и с причиной в строке,
перевод принятого семейства в экспресс (кнопка администратора) дает ногу в отбор с
вероятностью возврата, счет ноги на тотал при обмене игроков разворачивается."""

from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

import app.ml.markets as markets_ml
from app.db.models import Analysis, Bet, BetLeg
from app.ingest import sackmann
from app.services import market_stats
from tests.fake_claude import FakeClaude
from tests.helpers_admin import admin_signed_in, signed_in
from tests.helpers_bets import get_bet
from tests.support import ClientFactory, LoginFn, UserFactory
from tests.test_markets_r28 import _done, _rows, fake, world

__all__ = ["fake", "world"]


async def test_games_step_and_failed_family(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(db, engine, redis, member, world)
    stored = await db.get_one(Analysis, analysis["id"], populate_existing=True)
    assert stored.checkpoint is not None
    steps = {step["kind"]: step for step in stored.checkpoint["steps"]}
    assert steps["model"]["detail_key"] == "analysis.steps.model_games"
    assert steps["model"]["detail_params"] == {"matches": 2}

    # Тотал геймов не прошел проверку на истории: вероятности нет, причина в строке, фора
    # по геймам считается
    monkeypatch.setattr(markets_ml, "FAILED_FAMILIES", ("gtot",))
    failed = await _done(db, engine, redis, member, world)
    rows = _rows(failed)
    total = rows[("GTOT_23", 1)]
    assert (total["model_state"], total["has_model"]) == ("failed", False)
    assert total["p_final"] is None and total["value"] is None and total["p_push"] == 0.0
    assert total["note_key"] == "analysis.leg.model_failed"
    hcp = rows[("GHCP_-3.5", 1)]
    assert hcp["model_state"] == "ok" and hcp["p_final"] is not None
    # Старый анализ показывает состояние модели на момент анализа
    response = await member.client.get(f"/api/analyses/{analysis['id']}")
    assert _rows(response.json())[("GTOT_23", 1)]["model_state"] == "ok"


async def test_promoted_games_family_goes_to_selection(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member = await signed_in(make_client, make_user, login)
    admin = await admin_signed_in(make_client, make_user, login)
    real_events = market_stats._events

    async def passed(db_: AsyncSession) -> dict[str, Any]:
        found = await real_events(db_)
        found["gtot"] = market_stats._Family([0.1] * 150, [0.03, 0.05, 0.04, 0.06] * 15)
        return found

    monkeypatch.setattr(market_stats, "_events", passed)
    assert await market_stats.notify_ready(db) == ["gtot"]
    response = await admin.client.put("/api/admin/markets/gtot", json={"express": True})
    assert response.status_code == 200, response.text
    gtot = next(item for item in response.json()["families"] if item["family"] == "gtot")
    assert (gtot["status"], gtot["model_state"], gtot["promoted"]) == ("express", "ok", True)

    analysis = await _done(db, engine, redis, member, world)
    rows = _rows(analysis)
    under = rows[("GTOT_23", 2)]
    assert under["status"] == "express" and under["note_key"] != "analysis.leg.market_compare"
    # Нога в отборе: причины — по правилам стратегии (p ниже 65% — p_low), не «для сравнения»
    # Сторона тотала — не игрок: форма игрока 2 (в мире теста хуже 3–2) ее не блокирует,
    # причина — правила стратегии (больше 23 с p ниже 65%)
    assert under["note_key"] != "analysis.leg.form"
    assert rows[("GTOT_23", 1)]["note_key"] == "analysis.leg.p_low"
    assert under["value"] == pytest.approx(under["p_final"] * 2.05 + under["p_push"] - 1, abs=1e-5)


async def test_total_leg_score_flips_with_players(
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
    analysis = await _done(db, engine, redis, member, world)
    rows = _rows(analysis)
    ids = []
    for key, odds in ((("GTOT_23", 1), "1.75"), (("GHCP_-3.5", 1), "1.85")):
        response = await member.client.post(
            "/api/bets",
            json={
                "analysis_id": analysis["id"],
                "kind": "own",
                "stake": "100",
                "bookmaker": "Fonbet",
                "legs": [{"prediction_id": rows[key]["prediction_id"], "odds_taken": odds}],
                "client_ref": f"w3-flip-{key[0].lower().replace('.', '-')}",
            },
        )
        assert response.status_code == 201, response.text
        ids.append(response.json()["id"])
    # Перевес ноги с возвратом: p − (1 − P(возврат))/кэф
    leg_out = (await get_bet(member.client, ids[0]))["legs"][0]
    over = rows[("GTOT_23", 1)]
    assert leg_out["edge"] == pytest.approx(over["p_final"] - (1 - over["p_push"]) / 1.75, abs=1e-5)
    for bet_id in ids:
        leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == bet_id))
        assert leg is not None
        leg.score = "6:4 7:6"
        leg.archive_score = "6:4 6:7"
    await db.commit()
    match_id = analysis["result"]["matches"][0]["match_id"]
    await sackmann._flip_sides(db, [match_id])
    await db.commit()
    legs = {
        leg.market: leg
        for leg in await db.scalars(
            select(BetLeg)
            .join(Bet, Bet.id == BetLeg.bet_id)
            .where(Bet.id.in_(ids))
            .execution_options(populate_existing=True)
        )
    }
    # Тотал: сторона та же, счет (со стороны игрока 1) развернут; фора: сторона меняется,
    # счет (со стороны выбранного игрока) остается
    assert (legs["GTOT_23"].selection, legs["GTOT_23"].score) == (1, "4:6 6:7")
    assert legs["GTOT_23"].archive_score == "4:6 7:6"
    assert (legs["GHCP_-3.5"].selection, legs["GHCP_-3.5"].score) == (2, "6:4 7:6")
