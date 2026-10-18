"""Р28, сквозные проверки новых рынков: «Другие рынки» в форме и в confirmed, прогнозы по
всем введенным рынкам, строки анализа со статусом «для сравнения», экспресс и варианты
без новых рынков, своя ставка на тотал сетов и тотал геймов, ручной расчет по счету по
геймам с возвратом, аналитика по семействам, общий счетчик рынков, перевод семейства в
экспресс администратором (права: только admin, as_user — только чтение) и уведомление о
пройденном пороге, сторона тотала при обмене игроков местами."""

from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.redis import redis_key
from app.db.models import (
    Analysis,
    AppSettings,
    BetLeg,
    Match,
    Notification,
    OddsSnapshot,
    Prediction,
)
from app.ingest import sackmann
from app.schemas.analyses import ConfirmIn, EventIn
from app.services import analyses as analyses_service
from app.services import market_stats
from app.services.analysis_input import Confirmed
from tests.analysis_helpers import ODDS, install, run, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import Signed, admin_signed_in, audit_entries, error_code, signed_in
from tests.helpers_bets import get_bet, settle
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


def _event(
    world: dict[str, int],
    first: str,
    second: str,
    *,
    extra: list[dict[str, Any]] | None = None,
    disputed: list[dict[str, Any]] | None = None,
    best_of: int = 3,
) -> dict[str, Any]:
    ml = ODDS.get((first, second), ("1.50", "2.60"))
    return {
        "player1_id": world[first],
        "player2_id": world[second],
        "tournament_name": "Test Open 9",
        "surface": "hard",
        "best_of": best_of,
        "round": "R16",
        "odds": {"ML": [ml[0], ml[1]], "HCP_-1.5": ["1.62", None], "HCP_+1.5": [None, "2.30"]},
        "extra": extra or [],
        "disputed": disputed or [],
        "bookmaker": "Fonbet",
    }


EXTRA: list[dict[str, Any]] = [
    {"market": "stot", "line": 2.5, "o1": "2.30", "o2": "1.60"},
    {"market": "gtot", "line": "23", "o1": "1.75", "o2": "2.05"},
    {"market": "ghcp", "line": -3.5, "o1": "1.85", "o2": "1.95"},
]


async def _done(
    db: AsyncSession, engine: AsyncEngine, redis: Redis, member: Signed, world: dict[str, int]
) -> dict[str, Any]:
    analysis = await analyses_service.create_form(db, member.user.user)
    body = ConfirmIn(
        events=[
            EventIn.model_validate(_event(world, "sinner", "rune", extra=EXTRA)),
            EventIn.model_validate(_event(world, "djokovic", "rublev")),
        ],
        bank=D("10000"),
        bookmaker="Fonbet",
    )

    async def no_queue(analysis_id: int, attempt: int, job_id: str) -> None:
        return None

    await analyses_service.start_run(
        db, redis, member.user.user, analysis.id, body, enqueue=no_queue
    )
    assert await run(engine, redis, analysis.id) == "done"
    response = await member.client.get(f"/api/analyses/{analysis.id}")
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def _rows(analysis: dict[str, Any], index: int = 0) -> dict[tuple[str, int], dict[str, Any]]:
    return {
        (row["market"], row["selection"]): row
        for row in analysis["result"]["matches"][index]["markets"]
    }


async def test_new_markets_through_analysis_bet_and_settlement(
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

    # Ввод: «Другие рынки» в confirmed (format 2) и в событиях анализа, по порядку формы
    stored = await db.get_one(Analysis, analysis["id"], populate_existing=True)
    assert stored.confirmed is not None and stored.confirmed["format"] == 2
    assert [row["market"] for row in stored.confirmed["events"][0]["extra"]] == [
        "stot", "gtot", "ghcp"
    ]  # fmt: skip
    assert analysis["events"][0]["extra"] == [
        {"market": "stot", "line": 2.5, "o1": "2.30", "o2": "1.60"},
        {"market": "gtot", "line": 23.0, "o1": "1.75", "o2": "2.05"},
        {"market": "ghcp", "line": -3.5, "o1": "1.85", "o2": "1.95"},
    ]
    snapshots = set(
        (row.market, row.selection)
        for row in await db.scalars(select(OddsSnapshot).where(OddsSnapshot.kind == "user"))
    )
    assert {("STOT_2.5", 2), ("GTOT_23", 1), ("GHCP_-3.5", 1), ("GHCP_+3.5", 2)} <= snapshots

    rows = _rows(analysis)
    # Шесть прежних исходов и новые рынки — только исходы с кэфом
    assert len(rows) == 6 + 2 + 2 + 2
    under = rows[("STOT_2.5", 2)]
    cover1, cover2 = rows[("HCP_-1.5", 1)]["p_final"], rows[("HCP_-1.5", 2)]["p_final"]
    assert under["p_final"] == pytest.approx(cover1 + cover2, abs=1e-5)
    assert (under["family"], under["line"], under["status"]) == ("stot", 2.5, "compare")
    assert under["has_model"] and under["note_key"] == "analysis.leg.market_compare"
    assert under["q_market"] is not None and under["p_push"] == 0.0
    games = rows[("GTOT_23", 2)]
    assert games["p_final"] is None and games["p_base"] is None and games["value"] is None
    assert not games["has_model"] and games["note_key"] == "analysis.leg.no_model"
    hcp = rows[("GHCP_+3.5", 2)]
    assert (hcp["family"], hcp["line"]) == ("ghcp", 3.5)
    assert rows[("ML", 1)]["status"] == "express" and rows[("HCP_+1.5", 2)]["family"] == "h15"
    predictions = list(
        await db.scalars(select(Prediction).where(Prediction.analysis_id == analysis["id"]))
    )
    assert {p.market for p in predictions} >= {"STOT_2.5", "GTOT_23", "GHCP_-3.5", "GHCP_+3.5"}
    # Экспресс и варианты Р29 — без рынков «для сравнения»
    used = [leg["market"] for variant in analysis["result"]["variants"] for leg in variant["legs"]]
    express = (analysis["result"]["express"] or {}).get("legs") or []
    assert all(market in ("ML", "HCP_-1.5", "HCP_+1.5") for market in used)
    assert all(leg["market"] in ("ML", "HCP_-1.5", "HCP_+1.5") for leg in express)

    # Своя ставка на тотал сетов и на тотал геймов (без вероятности модели)
    ids = []
    for key, odds in ((("STOT_2.5", 2), "1.60"), (("GTOT_23", 2), "2.05")):
        response = await member.client.post(
            "/api/bets",
            json={
                "analysis_id": analysis["id"],
                "kind": "own",
                "stake": "100",
                "bookmaker": "Fonbet",
                "legs": [{"prediction_id": rows[key]["prediction_id"], "odds_taken": odds}],
                "client_ref": f"r28-own-{key[0].lower().replace('.', '-')}",
            },
        )
        assert response.status_code == 201, response.text
        ids.append(response.json()["id"])
    games_bet = await get_bet(member.client, ids[1])
    leg = games_bet["legs"][0]
    assert (leg["family"], leg["line"], leg["score_kind"], leg["void_hint"]) == (
        "gtot", 23.0, "games", True
    )  # fmt: skip
    assert leg["score_outcomes"] == {}
    sets_leg = (await get_bet(member.client, ids[0]))["legs"][0]
    assert sets_leg["score_kind"] == "sets" and sets_leg["score_outcomes"]["2:0"] == "win"

    # Ручной расчет: 6:4 7:6(5) — 23 гейма, ровно линия: возврат по кэфу 1.00
    bad = await settle(member.client, ids[1], "void", score="шесть")
    assert bad.status_code == 422 and error_code(bad) == "bet.bad_games_score"
    response = await settle(member.client, ids[1], "void", score="6:4 7:6(5)")
    assert response.status_code == 200, response.text
    settled = response.json()
    assert settled["status"] == "void" and settled["legs"][0]["score"] == "6:4 7:6"
    stored_leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == ids[1]))
    assert stored_leg is not None and stored_leg.score == "6:4 7:6"
    response = await settle(member.client, ids[0], "win", score="2:0")
    assert response.status_code == 200, response.text

    # Аналитика: фильтр семейства и срез по семействам
    response = await member.client.get("/api/analytics", params={"family": "stot"})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["filtered"] is True
    assert [item["family"] for item in data["slices"]["families"]] == ["stot"]
    response = await member.client.get("/api/bets", params={"family": "gtot"})
    assert response.status_code == 200 and [b["id"] for b in response.json()["items"]] == [ids[1]]
    assert (await member.client.get("/api/bets", params={"family": "xx"})).status_code == 422


async def test_form_problems_for_new_markets(
    db: AsyncSession,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Четвертная линия, рынок не того формата и спорная фора без ответа не запускаются."""
    member = await make_user()
    analysis = await analyses_service.create_form(db, member.user)
    events = [
        _event(world, "sinner", "rune", extra=[{"market": "gtot", "line": 22.25, "o1": "1.9"}]),
        _event(world, "djokovic", "rublev", extra=[{"market": "stot", "line": 3.5, "o1": "1.9"}]),
        _event(world, "alcaraz", "medvedev", disputed=[{"line": -1.5, "o1": "2.05"}]),
    ]
    body = ConfirmIn(events=[EventIn.model_validate(item) for item in events])
    preview = await analyses_service.preview(db, member.user, analysis.id, body)
    codes = [[problem.key for problem in event.problems] for event in preview.events]
    assert codes == [
        ["errors.analysis.line_quarter"],
        ["errors.analysis.market_format"],
        ["errors.analysis.hcp_unit"],
    ]
    # Тотал сетов только у П1/П2 в коридоре: рынки «для сравнения» в коридор не идут
    corridor = {item.market for event in preview.events for item in event.in_corridor}
    assert corridor <= {"ML", "HCP_-1.5", "HCP_+1.5"}


def test_old_confirmed_is_read() -> None:
    """analyses.confirmed до Р28 (без format и extra) читается как раньше."""
    old = Confirmed.from_json(
        {
            "bank": "100",
            "bookmaker": None,
            "events": [
                {
                    "position": 1,
                    "player1_id": 1,
                    "player2_id": 2,
                    "surface": "hard",
                    "best_of": 3,
                    "odds": {"ML": ["1.5", "2.6"], "HCP_-1.5": [None, None]},
                }
            ],
        }
    )
    event = old.events[0]
    assert event.odds["ML"] == [D("1.500"), D("2.600")] and event.odds["HCP_+1.5"] == [None, None]
    assert old.to_json()["events"][0]["extra"] == []


async def _finish(db: AsyncSession, match_id: int, *, winner: int, score: str) -> None:
    await db.execute(
        update(Match)
        .where(Match.id == match_id)
        .values(status="finished", winner_id=winner, score=score)
    )
    await db.commit()


async def test_markets_counter_and_admin_switch(
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
    match_id = analysis["result"]["matches"][0]["match_id"]
    await _finish(db, match_id, winner=world["sinner"], score="6-4 7-6(5)")

    # Счетчик общий и виден любому участнику: тотал сетов — 2 события (больше и меньше),
    # 2:0 — меньше 2.5 сыграло; тотал 23 гейма — ровно, возврат
    response = await member.client.get("/api/markets")
    assert response.status_code == 200, response.text
    families = {item["family"]: item for item in response.json()["families"]}
    assert list(families) == ["ml", "h15", "shcp", "stot", "ghcp", "gtot"]
    stot = families["stot"]
    assert (stot["status"], stot["events"], stot["promoted"], stot["ready"]) == (
        "compare", 2, False, False
    )  # fmt: skip
    # Два события — меньше PRIVATE_MIN: только количество, ROI скрыт (счетчик общий)
    assert stot["roi"] is None and stot["roi_low"] is None and stot["clv"] is None
    assert families["gtot"]["events"] == 2 and families["gtot"]["roi"] is None
    events = await market_stats._events(db)
    assert sorted(events["stot"].returns) == pytest.approx([-1.0, 0.6])
    assert events["gtot"].returns == [0.0, 0.0]
    assert families["ghcp"]["has_model"] is False and families["ml"]["status"] == "express"
    assert response.json()["need"] == 150
    # Данные общие, не личные: as_user здесь не принимается (только чтение экранов участника)
    admin = await admin_signed_in(make_client, make_user, login)
    seen = await admin.client.get("/api/markets", params={"as_user": member.id})
    assert seen.status_code == 403 and error_code(seen) == "common.forbidden"
    anonymous = await (await make_client("10.0.0.9")).get("/api/markets")
    assert anonymous.status_code == 401

    # Перевод в экспресс: участник — 403, просмотр as_user — 403, рынок по геймам — 422,
    # порог не пройден — 409
    path = "/api/admin/markets/stot"
    forbidden = await member.client.put(path, json={"express": True})
    assert forbidden.status_code == 403 and error_code(forbidden) == "common.forbidden"
    as_user = await admin.client.put(path, params={"as_user": member.id}, json={"express": True})
    assert as_user.status_code == 403 and error_code(as_user) == "common.forbidden"
    no_model = await admin.client.put("/api/admin/markets/gtot", json={"express": True})
    assert no_model.status_code == 422 and error_code(no_model) == "admin.markets.no_model"
    early = await admin.client.put(path, json={"express": True})
    assert early.status_code == 409 and error_code(early) == "admin.markets.not_ready"
    assert (
        await admin.client.put("/api/admin/markets/ml", json={"express": True})
    ).status_code == 422

    # Порог пройден (150 событий, 60 с закрытием, CLV выше нуля): уведомление
    # администраторам — одно
    real_events = market_stats._events

    async def passed(db_: AsyncSession) -> dict[str, Any]:
        found = await real_events(db_)
        found["stot"] = market_stats._Family([0.1] * 150, [0.03, 0.05, 0.04, 0.06] * 15)
        return found

    monkeypatch.setattr(market_stats, "_events", passed)
    assert await market_stats.notify_ready(db) == ["stot"]
    assert await market_stats.notify_ready(db) == []
    notes = list(await db.scalars(select(Notification).where(Notification.kind == "market_ready")))
    assert [note.user_id for note in notes] == [admin.id]
    assert notes[0].params["family"] == "stot" and "Тотал сетов" in notes[0].title

    response = await admin.client.put(path, json={"express": True})
    assert response.status_code == 200, response.text
    stot = next(item for item in response.json()["families"] if item["family"] == "stot")
    assert stot["status"] == "express" and stot["promoted"] is True
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert settings.express_markets == ["stot"]
    entries = await audit_entries(db, "settings_change")
    assert entries[-1].details == {"field": "express_markets", "from": [], "to": ["stot"]}
    # Старый анализ собирал экспресс без тотала сетов: строка остается «для сравнения»
    response = await member.client.get(f"/api/analyses/{analysis['id']}")
    old_row = _rows(response.json())[("STOT_2.5", 2)]
    assert old_row["status"] == "compare"
    assert old_row["note_key"] == "analysis.leg.market_compare"
    # Новый анализ — уже с тоталом сетов в экспрессе
    fresh = await _done(db, engine, redis, member, world)
    assert _rows(fresh)[("STOT_2.5", 2)]["status"] == "express"
    back = await admin.client.put(path, json={"express": False})
    assert back.status_code == 200
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert settings.express_markets == []
    # После возврата «для сравнения» новый анализ остается «в экспрессе» по своему экспрессу
    response = await member.client.get(f"/api/analyses/{fresh['id']}")
    assert _rows(response.json())[("STOT_2.5", 2)]["status"] == "express"


async def test_markets_threshold_privacy_and_cache(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    redis: Redis,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Порог требует 50 значений CLV и вероятность модели; ROI и CLV скрыты до 10 значений;
    GET /markets берет числа из кэша Redis, статус — из настроек сразу."""
    member = await signed_in(make_client, make_user, login)
    admin = await admin_signed_in(make_client, make_user, login)
    Family = market_stats._Family
    families: dict[str, market_stats._Family] = {}
    calls: list[int] = []

    async def fake_events(db_: AsyncSession) -> dict[str, market_stats._Family]:
        calls.append(1)
        return dict(families)

    monkeypatch.setattr(market_stats, "_events", fake_events)

    async def get() -> dict[str, dict[str, Any]]:
        response = await member.client.get("/api/markets")
        assert response.status_code == 200, response.text
        body = response.json()
        assert (body["clv_need"], body["private_min"]) == (50, 10)
        return {item["family"]: item for item in body["families"]}

    # Меньше 10 значений: только количество, ROI и CLV не видны (чужую ставку не вычислить)
    families["stot"] = Family([0.5] * 9, [0.05] * 9)
    stot = (await get())["stot"]
    assert (stot["events"], stot["clv_n"]) == (9, 9)
    assert [stot[key] for key in ("roi", "roi_low", "roi_high", "clv", "clv_low")] == [None] * 5
    # Второй запрос — из кэша: расчета нет, числа прежние
    families["stot"] = Family([0.5] * 12, [0.05] * 9)
    assert (await get())["stot"]["events"] == 9 and len(calls) == 1
    key = redis_key(*market_stats.CACHE_KEY)
    assert 0 < await redis.ttl(key) <= market_stats.CACHE_TTL
    # Срок кэша вышел — расчет заново: ROI виден (12 событий), CLV еще нет (9 значений)
    await redis.delete(key)
    stot = (await get())["stot"]
    assert len(calls) == 2 and stot["events"] == 12
    assert stot["roi"] == pytest.approx(0.5) and stot["clv"] is None and stot["clv_n"] == 9

    # 150 событий и CLV выше нуля, но с закрытием только 40 — порог не пройден
    families["stot"] = Family([0.1] * 150, [0.03, 0.05] * 20)
    # У тотала геймов числа проходят, но модели нет — не «готов», уведомления нет
    families["gtot"] = Family([0.1] * 150, [0.03, 0.05] * 30)
    stats = {item.family: item for item in (await market_stats.market_stats(db)).families}
    assert stats["stot"].clv_low is not None and stats["stot"].clv_low > 0
    assert stats["stot"].clv_n == 40 and not stats["stot"].ready
    assert stats["gtot"].clv_n == 60 and not stats["gtot"].ready
    assert not stats["gtot"].can_promote
    assert await market_stats.notify_ready(db) == []
    early = await admin.client.put("/api/admin/markets/stot", json={"express": True})
    assert early.status_code == 409 and error_code(early) == "admin.markets.not_ready"
    assert "50 с закрытием" in early.json()["error"]["message"]

    # 50 значений с закрытием — порог пройден, уведомление только о тотале сетов
    families["stot"] = Family([0.1] * 150, [0.03, 0.05] * 25)
    assert await market_stats.notify_ready(db) == ["stot"]
    note = await db.scalar(select(Notification).where(Notification.kind == "market_ready"))
    assert note is not None and "с закрытием: 50" in (note.body or "")
    # Перевод виден в GET сразу (ответ PUT обновил кэш), без нового расчета
    response = await admin.client.put("/api/admin/markets/stot", json={"express": True})
    assert response.status_code == 200, response.text
    before = len(calls)
    stot = (await get())["stot"]
    assert (stot["status"], stot["promoted"], stot["events"]) == ("express", True, 150)
    assert len(calls) == before


async def test_flip_sides_keeps_total_side(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Игроки матча меняются местами (архив): у П1/П2 и фор сторона меняется, у тотала —
    нет (больше остается больше)."""
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(db, engine, redis, member, world)
    match_id = analysis["result"]["matches"][0]["match_id"]
    await sackmann._flip_sides(db, [match_id])
    await db.commit()
    rows = {
        (p.market, p.selection)
        for p in await db.scalars(
            select(Prediction)
            .where(Prediction.match_id == match_id)
            .execution_options(populate_existing=True)
        )
    }
    assert ("STOT_2.5", 2) in rows and ("STOT_2.5", 1) in rows
    assert ("GTOT_23", 1) in rows and ("GHCP_-3.5", 2) in rows and ("GHCP_+3.5", 1) in rows
    snapshots = {
        (s.market, s.selection, str(s.odds))
        for s in await db.scalars(select(OddsSnapshot).where(OddsSnapshot.match_id == match_id))
    }
    assert ("STOT_2.5", 2, "1.600") in snapshots and ("GHCP_-3.5", 2, "1.850") in snapshots


DRAFT_TEXT = """Синнер vs Руне, Шанхай, хард
Кэфы: П1 = 1.34, П2 = 3.30
Ф1(-1.5) = 2.05, Ф2(+1.5) = 1.72
Фора по геймам: П1(-4.5) = 1.85, П2(+4.5) = 1.95
Тотал сетов: Б(2.5) = 2.30, М(2.5) = 1.60
ТБ 22.25 = 1.90
Тотал: Б(10.5) = 1.90"""


async def test_draft_understands_new_markets(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Разбор (parse_input.v2): форы и тоталы — в «Другие рынки», спорная фора — вопрос
    «по сетам или по геймам?» с подсказкой по кэфу победы, четвертная линия и тотал между 5
    и 15 — в «Не понял» с причиной."""
    member = await signed_in(make_client, make_user, login)
    response = await member.client.post("/api/analyses", json={"text": DRAFT_TEXT})
    assert response.status_code == 201, response.text
    draft = response.json()["draft"]
    event = draft["events"][0]
    assert event["extra"] == [
        {"market": "ghcp", "line": -4.5, "o1": "1.85", "o2": "1.95"},
        {"market": "stot", "line": 2.5, "o1": "2.30", "o2": "1.60"},
    ]
    assert event["disputed"] == [
        {
            "line": -1.5,
            "o1": "2.05",
            "o2": "1.72",
            "hint": {
                "key": "analysis.draft.hcp_hint.sets",
                "params": {"odds": "2.05", "ml": "1.34"},
            },
            "sets_ok": True,
        }
    ]
    assert [(line["text"], line["reason_key"]) for line in draft["unknown_lines"]] == [
        ("ТБ 22.25 = 1.90", "analysis.draft.unknown.quarter"),
        ("Тотал: Б(10.5) = 1.90", "analysis.draft.unknown.total_unit"),
    ]
