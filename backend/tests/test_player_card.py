"""Карточка игрока (этап 4): GET /api/players/{id}, /matches, /news, /h2h/{opponent_id}.
Числа — по матчам мира tests/players_world.py; «сегодня» — только свои ставки и анализы."""

import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.models import (
    AdminAuditLog,
    Analysis,
    Bet,
    BetLeg,
    IngestionRun,
    Match,
    MatchStat,
    Player,
    PlayerEloCurrent,
    Tournament,
    User,
)
from app.db.session import create_sessionmaker
from app.ml.elo import rebuild_ratings
from app.services import player_card
from app.services.analysis_input import ConfirmedEvent, attach_matches
from app.services.bank import local_today, user_zone
from tests.helpers_admin import error_code, signed_in
from tests.players_world import (
    PlayersWorld,
    add_news,
    add_profile,
    build_players_world,
    own_open_bet,
    today,
)
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> async_sessionmaker[AsyncSession]:
    return create_sessionmaker(engine)


@pytest.fixture
async def world(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> PlayersWorld:
    player_card._TOUR_CACHE.clear()
    return await build_players_world(db, factory)


def ago(days: int) -> str:
    return (today() - timedelta(days=days)).isoformat()


async def test_player_routes_require_login(make_client: ClientFactory) -> None:
    client = await make_client()
    for url in ("/api/players/1", "/api/players/1/matches", "/api/players/1/news"):
        assert (await client.get(url)).status_code == 401
    assert (await client.get("/api/players/1/h2h/2")).status_code == 401


async def test_card_header_and_overview(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get(f"/api/players/{world.sinner}")).json()
    row = await db.get_one(PlayerEloCurrent, world.sinner)
    assert (body["name"], body["name_ru"], body["country"], body["hand"]) == (
        "Jannik Sinner",
        "Янник Синнер",
        "ITA",
        "R",
    )
    assert body["birth_date"] == "2001-08-16" and body["age"] >= 24
    assert (body["rank"], body["matches_52w"], body["rank_days"]) == (row.rank_all, 4, 364)
    assert body["sackmann"] is True and body["legacy_profile"] is None
    assert body["today"] == []

    elo = body["elo"]
    assert elo["all"] == round(row.elo_all or 0) and elo["matches"] == row.n_all == 4
    surfaces = {item["surface"]: item for item in elo["surfaces"]}
    assert surfaces["hard"]["elo"] == round(row.elo_hard or 0)
    # Разница — показанных целых чисел: «1447 (−65)» при общем 1512, а не округленная
    # разница дробных
    assert surfaces["hard"]["delta"] == round(row.elo_hard or 0) - round(row.elo_all or 0)
    assert (surfaces["grass"]["elo"], surfaces["grass"]["matches"]) == (None, 0)
    best = max(v for v in (row.elo_hard, row.elo_clay) if v is not None)
    assert elo["best_surface"] == ("hard" if best == row.elo_hard else "clay")

    form = body["form"]
    assert [m["won"] for m in form["matches"]] == [False, True, True, True]
    assert (form["wins"], form["losses"], form["matches_14d"], form["rest_days"]) == (3, 1, 0, 35)
    final = form["matches"][0]
    assert final["match_id"] == world.matches["hard_f"]
    assert final["opponent"]["id"] == world.alcaraz
    # Счет со стороны игрока: финал проигран 3-6 2-6
    assert final["score"] == "3-6 2-6" and final["round"] == "F"
    assert body["last_match"] == {
        "match_id": world.matches["hard_f"],
        "day": ago(35),
        "tournament": "Hard Open",
        "category": "masters",
        "round": "F",
    }

    # Два сезона: хард 2–1, грунт 1–0 (неявка не в счет)
    results = body["results"]
    assert results["since"] == f"{today().year - 1}-01-01"
    assert {item["surface"]: (item["wins"], item["losses"]) for item in results["surfaces"]} == {
        "hard": (2, 1),
        "clay": (1, 0),
    }
    assert results["total"] == {"wins": 3, "losses": 1}
    # 52 недели: против десятки по Эло — все соперники; решающие сеты — полуфинал хард-турнира
    # (3 сета до двух побед) и четвертьфинал грунта (5 до трех); тай-брейки 1–1
    key = body["key_matches"]
    assert key["since"] == ago(363)
    assert key["top10"] == {"wins": 3, "losses": 1}
    assert key["deciders"] == {"wins": 2, "losses": 0}
    assert key["tiebreaks"] == {"wins": 1, "losses": 1}
    assert body["news"] == {
        "checked_at": None,
        "fresh": False,
        "ttl_hours": 12,
        "lookback_days": 14,
        "count": 0,
    }
    assert body["archive"]["data_to"] == ago(35)


async def test_card_window_edges(
    world: PlayersWorld,
    db: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Окна карточки по сегодня включительно: 52 недели — 364 дня (матч 364 дня назад не
    входит, 363 — входит), как место по Эло и matches_52w; нагрузка — 14 дней (матч 14
    дней назад не входит, 13 — входит)."""
    tour = Tournament(
        name="Edge Hard",
        category="250",
        surface="hard",
        best_of=3,
        start_date=today() - timedelta(days=400),
        source="sackmann",
        source_ref="t-edge",
    )
    db.add(tour)
    await db.flush()
    for days_ago, round_code in zip(
        (364, 363, 14, 13, 0), ("R128", "R64", "R32", "R16", "QF"), strict=True
    ):
        db.add(
            Match(
                tournament_id=tour.id,
                round=round_code,
                player1_id=world.sinner,
                player2_id=world.medvedev,
                winner_id=world.sinner,
                score="6-4 6-4",
                status="finished",
                best_of=3,
                match_date=today() - timedelta(days=days_ago),
                source="sackmann",
                source_ref=f"edge-{days_ago}",
            )
        )
    await db.commit()
    await rebuild_ratings(db_factory=factory)
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get(f"/api/players/{world.sinner}")).json()
    # Было 4 сыгранных за 52 недели, из пяти новых входят четыре
    assert body["matches_52w"] == 8
    key = body["key_matches"]
    assert key["since"] == ago(363)
    # Все соперники — в десятке по Эло: ключевые матчи — все матчи окна
    assert key["top10"]["wins"] + key["top10"]["losses"] == body["matches_52w"]
    assert key["top10"] == {"wins": 7, "losses": 1}
    assert (body["form"]["matches_14d"], body["form"]["rest_days"]) == (2, 0)


async def test_card_serve_against_tour(
    world: PlayersWorld, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    serve = (await member.client.get(f"/api/players/{world.sinner}")).json()["serve"]
    assert (serve["period_to"], serve["period_from"]) == (ago(35), ago(35 + 363))
    assert serve["tour_players"] == 50
    # Суммы трех матчей Sinner на «Hard Open» (tests/players_world.py)
    assert serve["player"] == {
        "matches": 3,
        "first_in": round(133 / 205, 4),
        "first_won": round(97 / 133, 4),
        "second_won": round(39 / 72, 4),
        "aces_per_match": 7.0,
        "double_faults_per_match": round(11 / 3, 4),
        "first_return_won": round((128 - 95) / 128, 4),
        "second_return_won": round((200 - 128 - 37) / 72, 4),
        "bp_converted": round((16 - 10) / 16, 4),
        "bp_saved": round(11 / 19, 4),
    }
    # Тур — суммы всех игроков с местом по Эло (их трое) за то же окно
    tour = serve["tour"]
    assert tour["matches"] == 6
    assert tour["first_in"] == round((133 + 128) / (205 + 200), 4)
    no_stats = (await member.client.get(f"/api/players/{world.veteran}")).json()["serve"]
    assert no_stats["player"] is None and no_stats["tour"] == tour


async def test_card_today_only_from_own_bets(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    owner = await signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    match_id, bet_id, analysis_id = await own_open_bet(db, owner.id, world.sinner, world.alcaraz)
    today_items = (await owner.client.get(f"/api/players/{world.sinner}")).json()["today"]
    assert len(today_items) == 1
    item = today_items[0]
    assert (item["match_id"], item["opponent"]["id"], item["surface"]) == (
        match_id,
        world.alcaraz,
        "hard",
    )
    assert [bet["bet_id"] for bet in item["bets"]] == [bet_id]
    assert item["analyses"] == [analysis_id]
    assert item["tournament"] == "Мой турнир"
    assert 0 < item["elo_prob"] < 1
    # Личные встречи: хард-турнир 1–1 и грунт 1–0 в пользу Sinner
    assert item["h2h"] == {
        "wins": 2,
        "losses": 1,
        "surface_wins": 1,
        "surface_losses": 1,
        "last_day": ago(35),
        "last_won": False,
    }
    # Чужой участник своей ставки не видит
    foreign = await other.client.get(f"/api/players/{world.sinner}")
    assert foreign.status_code == 200
    assert foreign.json()["today"] == []
    assert str(bet_id) not in foreign.text.split('"today"')[1]


async def test_card_today_surface_only_from_own_input(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Т29: турнир и матч из ввода участника общие — их создает тот, кто ввел матч первым.
    Покрытие в «сегодня» — как у ноги в «Ставках»: только из своего ввода. Алиса ввела
    матч первой (грунт), Боб — тот же матч с хардом и поставил: у Боба хард и вероятность
    по Эло на харде, у Алисы — ее грунт."""
    alice = await signed_in(make_client, make_user, login, ip="10.0.0.1")
    bob = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    first, second = Player(name="Surface Pick"), Player(name="Surface Opp")
    db.add_all([first, second])
    await db.flush()
    # Общий Эло равный, на харде сильнее второй, на грунте — первый
    day = today()
    db.add_all(
        [
            PlayerEloCurrent(
                player_id=first.id, elo_all=1600, elo_hard=1500, elo_clay=1800, as_of=day
            ),
            PlayerEloCurrent(
                player_id=second.id, elo_all=1600, elo_hard=1700, elo_clay=1500, as_of=day
            ),
        ]
    )
    await db.commit()

    def event(surface: str, best_of: int, name: str) -> ConfirmedEvent:
        return ConfirmedEvent(
            position=1,
            player1_id=first.id,
            player2_id=second.id,
            surface=surface,
            best_of=best_of,
            round="",
            odds={},
            bookmaker="Fonbet",
            tournament_name=name,
        )

    async def analysis(user_id: int, confirmed: ConfirmedEvent) -> int:
        row = Analysis(
            user_id=user_id,
            input_text="",
            input_kind="form",
            status="done",
            confirmed={"bank": None, "bookmaker": "Fonbet", "events": [confirmed.to_json()]},
            decision="bet",
        )
        db.add(row)
        await db.flush()
        return row.id

    bob_day = local_today(user_zone((await db.get_one(User, bob.id)).tz))
    (a_event,) = await attach_matches(db, [event("clay", 5, "Турнир Алисы")], day=bob_day)
    await analysis(alice.id, a_event)
    await db.commit()
    (b_event,) = await attach_matches(db, [event("hard", 3, "Турнир Боба")], day=bob_day)
    assert (b_event.match_id, b_event.tournament_id) == (a_event.match_id, a_event.tournament_id)
    assert b_event.match_id is not None
    # Ставка Боба — по анализу, который сделан не сегодня: покрытие берется из него
    bob_analysis = await analysis(bob.id, b_event)
    await db.execute(
        update(Analysis)
        .where(Analysis.id == bob_analysis)
        .values(created_at=datetime.now(UTC) - timedelta(days=2))
    )
    bet = Bet(
        user_id=bob.id,
        analysis_id=bob_analysis,
        placed_at=datetime.now(UTC),
        bookmaker="Fonbet",
        stake=Decimal("100"),
        currency="RUB",
        total_odds=Decimal("1.80"),
        status="open",
        source="app",
        source_ref=f"surface-{bob.id}",
    )
    db.add(bet)
    await db.flush()
    db.add(
        BetLeg(
            bet_id=bet.id,
            match_id=b_event.match_id,
            market="ML",
            selection=1,
            odds_taken=Decimal("1.80"),
        )
    )
    await db.commit()

    leg = (await bob.client.get("/api/bets")).json()["items"][0]["legs"][0]
    [mine] = (await bob.client.get(f"/api/players/{first.id}")).json()["today"]
    assert leg["match"]["surface"] == mine["surface"] == "hard"
    assert mine["tournament"] == "Турнир Боба" and mine["bets"][0]["bet_id"] == bet.id
    assert mine["analyses"] == []
    # На харде первый слабее: 1500 против 1700 на покрытии
    assert mine["elo_prob"] < 0.5
    [hers] = (await alice.client.get(f"/api/players/{first.id}")).json()["today"]
    assert (hers["surface"], hers["tournament"], hers["bets"]) == ("clay", "Турнир Алисы", [])
    assert hers["elo_prob"] > 0.5


async def test_card_legacy_profile_and_missing_player(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    await add_profile(db, world.sinner)
    await add_profile(db, world.alcaraz, source="llm")
    member = await signed_in(make_client, make_user, login)
    sinner = (await member.client.get(f"/api/players/{world.sinner}")).json()
    assert sinner["legacy_profile"]["profile"] == {"01": {"стиль": "агрессивный с задней линии"}}
    # Профиль не из старого бота не показываем (Р24: профили не собираем)
    alcaraz = (await member.client.get(f"/api/players/{world.alcaraz}")).json()
    assert alcaraz["legacy_profile"] is None
    nobody = (await member.client.get(f"/api/players/{world.nobody}")).json()
    assert (nobody["rank"], nobody["elo"]["all"], nobody["form"]["matches"]) == (None, None, [])
    assert nobody["sackmann"] is False and nobody["last_match"] is None
    missing = await member.client.get("/api/players/999999")
    assert missing.status_code == 404 and error_code(missing) == "player.not_found"
    assert (await member.client.get("/api/players/0")).status_code == 422


async def test_matches_pages_and_summary(
    world: PlayersWorld, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    first = (await member.client.get(f"/api/players/{world.sinner}/matches?limit=2")).json()
    assert first["total"] == 5
    assert [item["match_id"] for item in first["items"]] == [
        world.matches["hard_f"],
        world.matches["hard_sf"],
    ]
    assert first["next_before"] == world.matches["hard_sf"]
    summary = first["summary"]
    assert (summary["played"], summary["wins"], summary["best_of_5"]) == (4, 3, 1)
    assert summary["tiebreaks"] == {"wins": 1, "losses": 1}
    assert summary["deciders"] == {"wins": 2, "losses": 0}

    url = f"/api/players/{world.sinner}/matches?limit=2&before={first['next_before']}"
    second = (await member.client.get(url)).json()
    assert [item["match_id"] for item in second["items"]] == [
        world.matches["hard_r16"],
        world.matches["clay_qf"],
    ]
    assert second["summary"] is None
    url = f"/api/players/{world.sinner}/matches?limit=2&before={second['next_before']}"
    third = (await member.client.get(url)).json()
    walkover = third["items"][0]
    assert walkover["match_id"] == world.matches["clay_r32"]
    assert (walkover["walkover"], walkover["won"], walkover["score"]) == (True, False, None)
    assert third["next_before"] is None
    qf = second["items"][1]
    assert (qf["surface"], qf["best_of"], qf["category"]) == ("clay", 5, "grand_slam")
    assert qf["score"] == "6-7(4) 6-4 6-4 3-6 7-5" and qf["won"] is True
    # Курсор — матч другого игрока
    url = f"/api/players/{world.sinner}/matches?before={world.matches['grass_sf']}"
    response = await member.client.get(url)
    assert response.status_code == 422 and error_code(response) == "player.bad_cursor"


async def test_news_window_pages_and_details(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    old = await add_news(db, world.sinner, days_ago=20)
    first = await add_news(db, world.sinner, days_ago=1, kind="withdrawal")
    second = await add_news(
        db,
        world.sinner,
        days_ago=2,
        kind="result",
        details={"opponent": "Carlos Alcaraz", "score": "6-4 6-4", "won": True, "extra": "x"},
    )
    other = await add_news(db, world.alcaraz, days_ago=1)
    member = await signed_in(make_client, make_user, login)
    page = (await member.client.get(f"/api/players/{world.sinner}/news?limit=1")).json()
    assert [item["id"] for item in page["items"]] == [first]
    assert page["next_before"] == first and page["lookback_days"] == 14
    rest = (
        await member.client.get(f"/api/players/{world.sinner}/news?limit=5&before={first}")
    ).json()
    assert [item["id"] for item in rest["items"]] == [second]
    assert rest["items"][0]["details"] == {
        "opponent": "Carlos Alcaraz",
        "score": "6-4 6-4",
        "won": True,
    }
    assert rest["next_before"] is None
    assert old not in [item["id"] for item in rest["items"]]
    card = (await member.client.get(f"/api/players/{world.sinner}")).json()
    assert card["news"]["count"] == 2
    response = await member.client.get(f"/api/players/{world.sinner}/news?before={other}")
    assert response.status_code == 422 and error_code(response) == "player.bad_cursor"


async def test_head_to_head(
    world: PlayersWorld, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    body: dict[str, Any] = (
        await member.client.get(f"/api/players/{world.sinner}/h2h/{world.alcaraz}")
    ).json()
    assert (body["player"]["id"], body["opponent"]["id"]) == (world.sinner, world.alcaraz)
    assert (body["player_wins"], body["opponent_wins"]) == (2, 1)
    assert {item["surface"]: (item["wins"], item["losses"]) for item in body["surfaces"]} == {
        "hard": (1, 1),
        "clay": (1, 0),
    }
    assert [item["match_id"] for item in body["matches"]] == [
        world.matches["hard_f"],
        world.matches["hard_sf"],
        world.matches["clay_qf"],
    ]
    assert body["matches"][0]["winner_id"] == world.alcaraz
    # Неявка в личные встречи не входит
    medvedev = (await member.client.get(f"/api/players/{world.sinner}/h2h/{world.medvedev}")).json()
    assert (medvedev["player_wins"], medvedev["opponent_wins"]) == (1, 0)
    same = await member.client.get(f"/api/players/{world.sinner}/h2h/{world.sinner}")
    assert same.status_code == 422 and error_code(same) == "player.h2h_same"
    missing = await member.client.get(f"/api/players/{world.sinner}/h2h/999999")
    assert missing.status_code == 404


async def test_stats_to_and_tour_cache(world: PlayersWorld, db: AsyncSession) -> None:
    assert await player_card.stats_to(db) == today() - timedelta(days=35)
    ranked = list(await db.scalars(select(PlayerEloCurrent).where(PlayerEloCurrent.rank_all <= 50)))
    assert len(ranked) == 3


async def test_archive_day_from_matches_without_elo_step(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Обновление без шага elo (--skip-elo или сбой в нем): матч уже в базе, а
    player_elo_current — прошлого шага. «Архив по» в списке и карточке — по самим матчам,
    как последний матч карточки, а не по player_elo_current."""
    member = await signed_in(make_client, make_user, login)
    before = (await member.client.get("/api/players/ranking")).json()["archive"]["data_to"]
    assert before == ago(35)
    final = await db.get(Match, world.matches["hard_f"])
    assert final is not None
    db.add(
        Match(
            tournament_id=final.tournament_id,
            round="RR",
            player1_id=world.sinner,
            player2_id=world.medvedev,
            winner_id=world.sinner,
            score="6-1 6-1",
            status="finished",
            best_of=3,
            match_date=today() - timedelta(days=1),
            source="sackmann",
            source_ref="after-skip-elo",
        )
    )
    await db.commit()
    card = (await member.client.get(f"/api/players/{world.sinner}")).json()
    assert card["last_match"]["day"] == card["archive"]["data_to"] == ago(1)
    ranking = (await member.client.get("/api/players/ranking")).json()
    assert ranking["archive"]["data_to"] == ago(1)


async def test_tour_average_follows_data_version(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Средний по туру в памяти процесса пересчитывается после новой успешной загрузки
    (перезагрузка архива с исправлениями) и записи журнала администратора (слияние
    игроков), а правка мимо них — не позже TOUR_CACHE_TTL."""
    member = await signed_in(make_client, make_user, login)

    async def tour_first_in() -> float:
        body = (await member.client.get(f"/api/players/{world.sinner}")).json()
        value: float = body["serve"]["tour"]["first_in"]
        return value

    before = await tour_first_in()
    assert before == round((133 + 128) / (205 + 200), 4)
    # Исправление статистики загрузкой архива: новая успешная загрузка — новая версия
    await db.execute(update(MatchStat).values(first_in=MatchStat.serve_points))
    await db.commit()
    assert await tour_first_in() == before
    db.add(IngestionRun(source="sackmann", status="ok"))
    await db.commit()
    assert await tour_first_in() == 1.0
    # Слияние игроков пишет журнал администратора
    await db.execute(update(MatchStat).values(first_in=0))
    await db.commit()
    db.add(AdminAuditLog(action="player_merge", details={}))
    await db.commit()
    assert await tour_first_in() == 0.0
    # Правка мимо загрузок и журнала: старое значение живет не дольше TOUR_CACHE_TTL
    await db.execute(update(MatchStat).values(first_in=MatchStat.serve_points))
    await db.commit()
    assert await tour_first_in() == 0.0
    started = time.monotonic()
    monkeypatch.setattr(player_card, "_clock", lambda: started + player_card.TOUR_CACHE_TTL + 1)
    assert await tour_first_in() == 1.0
