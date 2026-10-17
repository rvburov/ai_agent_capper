"""Досье матча (app/services/dossier.py): состав, отсутствие утечки будущего,
детерминизм sha256 и одна строка dossiers на одинаковое содержание."""

import json
import time
from datetime import UTC, date, datetime, timedelta
from datetime import time as dt_time
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.models import (
    Dossier,
    Match,
    MatchStat,
    Player,
    PlayerNews,
    PlayerRating,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ml.backtest import PlattScaling
from app.ml.elo import rebuild_ratings, upsert_model, win_probability
from app.ml.sets import SETS_PLATT, CoverPlatt, base_probs, sets_calibration_of
from app.services.dossier import (
    DETAIL_MAX,
    FEATURE_SET,
    DossierResult,
    build_dossier,
    calibrated_p1,
    canonical_json,
)
from tests.ml_world import small_world, store_world

FORBIDDEN_LETTERS = ("\u0451", "\u0401")


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Фабрика сеансов для пересчета Эло (db — ради чистой базы перед тестом)."""
    return create_sessionmaker(engine)


async def _world(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> None:
    await store_world(db, small_world())
    await rebuild_ratings(db_factory=factory)


async def _match_on(db: AsyncSession, year: int) -> Match:
    """Матч с датой в году year, у обоих игроков которого есть матчи до него."""
    match = await db.scalar(
        select(Match)
        .where(Match.match_date >= date(year, 1, 1), Match.match_date < date(year + 1, 1, 1))
        .order_by(Match.match_date.desc(), Match.id.desc())
        .limit(1)
    )
    assert match is not None and match.match_date is not None
    return match


def _noon(day: date) -> datetime:
    return datetime.combine(day, dt_time(12, 0), tzinfo=UTC)


def _dates(content: dict[str, Any]) -> list[str]:
    """Все дни матчей в досье: форма, H2H, последние матчи."""
    days = [item["d"] for key in ("p1", "p2") for item in content[key]["form"]["m"]]
    days += [item["d"] for item in content["h2h"]["last"]]
    days += [content[key]["last"] for key in ("p1", "p2") if content[key]["last"]]
    return days


async def _build(db: AsyncSession, match: Match, as_of: datetime) -> DossierResult:
    result = await build_dossier(db, match, as_of=as_of, best_of=3, surface="hard")
    await db.commit()
    return result


async def test_dossier_content(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> None:
    await _world(db, factory)
    match = await _match_on(db, 2025)
    assert match.match_date is not None
    as_of = _noon(match.match_date)
    result = await _build(db, match, as_of)
    content = result.content

    assert result.text == canonical_json(content)
    assert json.loads(result.text) == content
    assert not any(letter in result.text for letter in FORBIDDEN_LETTERS)
    assert content["v"] == FEATURE_SET
    assert content["as_of"] == match.match_date.isoformat()
    assert content["match"]["id"] == match.id and content["match"]["bo"] == 3
    assert content["match"]["tour"] is not None and content["match"]["round"] == match.round

    p1, p2 = content["p1"], content["p2"]
    assert (p1["id"], p2["id"]) == (match.player1_id, match.player2_id)
    assert p1["name"] and p1["elo"]["n"] > 0 and p1["elo"]["use"] > 0
    assert len(p1["form"]["m"]) == 10
    assert p1["form"]["w10"] + p1["form"]["l10"] == 10
    assert p1["form"]["w5"] + p1["form"]["l5"] == 5
    first = p1["form"]["m"][0]
    assert first["r"] in ("W", "L") and first["opp"] and first["opp_elo"] is not None
    # Счет со стороны игрока: в мире у всех «6-4 6-4»
    assert first["sc"] == ("6-4 6-4" if first["r"] == "W" else "4-6 4-6")
    assert p1["last"] == first["d"]
    assert p1["load"]["rest"] == (match.match_date - date.fromisoformat(first["d"])).days
    assert content["data_to"] is not None and content["data_to"] < content["as_of"]

    # p_base: три числа по модели сетов, без калибровки — как Эло; p(−1.5) — с поправкой
    # модели сетов по умолчанию (у версии модели нет своих чисел)
    assert content["p_base"]["cal"] is False and not result.calibrated
    assert result.p_base == base_probs(result.p_raw, 3, SETS_PLATT)
    raw = base_probs(result.p_raw, 3)
    assert result.p_base.p1_win == raw.p1_win
    decider = 1 - result.p_base.p1_cover - result.p_base.p2_cover
    assert decider < 1 - raw.p1_cover - raw.p2_cover
    assert content["p_base"]["p1_win"] == round(result.p_raw, 3)
    assert set(content["refs"]) >= {"elo", "form", "h2h", "load"}
    assert result.features["elo1"] > 0 and result.features["surface_weight"] == 0.5
    assert result.news_ids == () and result.news_version is None

    row = await db.get(Dossier, result.dossier_id)
    assert row is not None and row.sha256 == result.sha256 and row.content == content
    assert row.feature_set == FEATURE_SET and row.match_id == match.id and row.as_of == as_of


async def test_dossier_has_no_future(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    await _world(db, factory)
    match = await _match_on(db, 2024)
    assert match.match_date is not None
    day = match.match_date
    as_of = _noon(day)
    before = await _build(db, match, as_of)
    # Ни одного матча в день as_of и позже, включая сам анализируемый матч
    assert all(item < day.isoformat() for item in _dates(before.content))

    # Новые матчи этих игроков в день as_of и позже, их статистика, новость из будущего
    # и пересчет Эло с ними: досье на тот же момент не меняется
    future = [
        Match(
            player1_id=match.player1_id,
            player2_id=match.player2_id,
            winner_id=match.player2_id,
            match_date=day + timedelta(days=offset),
            status="finished",
            score="7-6(5) 6-7(3) 7-6(1)",
            best_of=3,
            source="web",
            source_ref=f"future-{offset}",
        )
        for offset in (0, 2)
    ]
    db.add_all(future)
    await db.flush()
    db.add_all(
        MatchStat(
            match_id=future[0].id,
            player_id=player,
            serve_points=80,
            first_in=50,
            first_won=40,
            second_won=15,
            source="web",
        )
        for player in (match.player1_id, match.player2_id)
    )
    db.add(
        PlayerNews(
            player_id=match.player1_id,
            published_at=as_of + timedelta(hours=1),
            kind="injury",
            summary="Травма после матча",
            source_url="https://example.com/later",
        )
    )
    # Новость опубликована раньше, но получена после as_of — тоже не видна
    db.add(
        PlayerNews(
            player_id=match.player1_id,
            published_at=as_of - timedelta(days=1),
            kind="other",
            summary="Найдено позже",
            source_url="https://example.com/fetched-later",
            fetched_at=as_of + timedelta(hours=2),
        )
    )
    await db.commit()
    await rebuild_ratings(db_factory=factory)
    after = await _build(db, match, as_of)
    assert after.sha256 == before.sha256
    assert after.dossier_id == before.dossier_id and not after.created

    # Со следующего дня матч виден: форма, H2H и нагрузка
    later = await _build(db, match, _noon(day + timedelta(days=1)))
    assert later.sha256 != before.sha256
    assert later.content["p1"]["last"] == day.isoformat()
    assert later.content["h2h"]["n"] == before.content["h2h"]["n"] + 2  # сам матч и future-0


async def test_undated_matches_wait_for_tournament_end(db: AsyncSession) -> None:
    alice, bob, carl = Player(name="Alice A"), Player(name="Bob B"), Player(name="Carl C")
    db.add_all([alice, bob, carl])
    await db.flush()
    day = date(2026, 3, 1)
    old = Tournament(name="Old Open", start_date=day - timedelta(days=20), source="sackmann")
    fresh = Tournament(name="Fresh Open", start_date=day - timedelta(days=10), source="sackmann")
    db.add_all([old, fresh])
    await db.flush()
    db.add_all(
        Match(
            tournament_id=tour.id,
            round="R32",
            player1_id=alice.id,
            player2_id=carl.id,
            winner_id=alice.id,
            status="finished",
            score="6-3 6-3",
            source="sackmann",
            source_ref=f"undated-{tour.name}",
        )
        for tour in (old, fresh)
    )
    target = Match(
        player1_id=alice.id,
        player2_id=bob.id,
        status="scheduled",
        source="web",
        source_ref="target",
    )
    db.add(target)
    await db.commit()
    result = await _build(db, target, _noon(day))
    form = result.content["p1"]["form"]["m"]
    # Турнир начался 20 дней назад — матч виден, 10 дней назад — еще нет
    assert [item["t"] for item in form] == ["Old Open"]
    assert result.content["data_to"] == (day - timedelta(days=20)).isoformat()
    # Новых игроков без рейтинга досье тоже собирает: начальный рейтинг
    assert result.content["p2"]["elo"] == {
        "all": 1500,
        "n": 0,
        "surf": None,
        "n_surf": 0,
        "use": 1500,
    }
    assert result.content["p2"]["form"]["m"] == [] and result.content["p2"]["last"] is None
    assert "form" in result.content["refs"]


async def test_dossier_is_deterministic(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    await _world(db, factory)
    match = await _match_on(db, 2025)
    assert match.match_date is not None
    first = await _build(db, match, _noon(match.match_date))
    assert first.created
    # Тот же день, другое время — то же досье, строка не добавляется
    again = await build_dossier(
        db,
        match,
        as_of=_noon(match.match_date) + timedelta(hours=5),
        best_of=3,
        surface="hard",
    )
    await db.commit()
    assert again.sha256 == first.sha256 and again.text == first.text
    assert again.dossier_id == first.dossier_id and not again.created
    assert await db.scalar(select(func.count()).select_from(Dossier)) == 1
    # Другой формат матча — другие форы и другое досье
    five = await build_dossier(db, match, as_of=_noon(match.match_date), best_of=5, surface="hard")
    await db.commit()
    assert five.sha256 != first.sha256 and five.created
    assert five.p_base.p1_win == first.p_base.p1_win
    assert five.p_base.p1_cover != first.p_base.p1_cover


async def test_calibration_news_serve_and_symmetry(db: AsyncSession) -> None:
    alice, bob, carl = (
        Player(name="Alice A", country="ITA"),
        Player(name="Bob B"),
        Player(name="Carl C"),
    )
    alice.birth_date = date(2000, 3, 1)
    db.add_all([alice, bob, carl])
    await db.flush()
    day = date(2026, 3, 1)
    tour = Tournament(
        name="Spring Open",
        surface="hard",
        category="250",
        start_date=day - timedelta(days=6),
        source="tennis_data",
        source_ref="2026-1",
    )
    db.add(tour)
    await db.flush()
    played = Match(
        tournament_id=tour.id,
        round="R32",
        match_date=day - timedelta(days=3),
        player1_id=alice.id,
        player2_id=carl.id,
        winner_id=alice.id,
        status="finished",
        score="7-6(4) 3-6 6-7(5)",
        source="tennis_data",
        source_ref="m-1",
    )
    db.add(played)
    await db.flush()
    db.add_all(
        [
            MatchStat(
                match_id=played.id,
                player_id=alice.id,
                serve_points=100,
                first_in=60,
                first_won=45,
                second_won=20,
                source="tennis_data",
            ),
            MatchStat(
                match_id=played.id,
                player_id=carl.id,
                serve_points=90,
                first_in=50,
                first_won=35,
                second_won=20,
                source="tennis_data",
            ),
        ]
    )
    as_of = _noon(day)
    news = PlayerNews(
        player_id=alice.id,
        published_at=as_of - timedelta(days=2),
        kind="injury",
        summary="Жалобы на плечо",
        source_url="https://example.com/a",
        source_name="Example",
        fetched_at=as_of - timedelta(hours=1),
    )
    stale = PlayerNews(
        player_id=alice.id,
        published_at=as_of - timedelta(days=40),
        kind="other",
        summary="Старая новость",
        source_url="https://example.com/old",
        fetched_at=as_of - timedelta(days=39),
    )
    db.add_all([news, stale])
    pair = Match(
        player1_id=alice.id,
        player2_id=bob.id,
        status="scheduled",
        source="web",
        source_ref="pair",
    )
    swapped = Match(
        player1_id=bob.id,
        player2_id=alice.id,
        status="scheduled",
        source="web",
        source_ref="swapped",
    )
    db.add_all([pair, swapped])
    # Рейтинг Alice до матча: общий и на харде (строка дня as_of не видна)
    db.add_all(
        [
            PlayerRating(
                player_id=alice.id,
                surface="all",
                as_of=day - timedelta(days=3),
                elo=1650.0,
                matches=10,
            ),
            PlayerRating(
                player_id=alice.id,
                surface="hard",
                as_of=day - timedelta(days=3),
                elo=1700.0,
                matches=6,
            ),
            PlayerRating(player_id=alice.id, surface="all", as_of=day, elo=1900.0, matches=11),
        ]
    )
    await upsert_model(
        db,
        params={
            "surface_weight": 0.5,
            "platt": {"a": 0.05, "b": 0.8},
            "sets_platt": {"3": {"a": 0.3, "b": 0.9}},
        },
        train_from=None,
        train_to=None,
    )
    await db.commit()

    result = await _build(db, pair, as_of)
    content = result.content
    assert result.calibrated and content["p_base"]["cal"] is True
    p1 = content["p1"]
    assert p1["elo"] == {"all": 1650, "n": 10, "surf": 1700, "n_surf": 6, "use": 1675}
    assert result.p_raw == pytest.approx(win_probability(1675.0, 1500.0))
    platt = PlattScaling(0.05, 0.8)
    expected = (
        float(platt.apply([result.p_raw])[0]) + 1.0 - float(platt.apply([1 - result.p_raw])[0])
    ) / 2.0
    assert result.p_base.p1_win == pytest.approx(expected)
    assert result.p_base.p1_win != pytest.approx(result.p_raw)
    # Поправка модели сетов — из параметров модели (до 2 побед), а не SETS_PLATT
    own = sets_calibration_of({"3": {"a": 0.3, "b": 0.9}})
    assert own[3] == CoverPlatt(0.3, 0.9) and own[5] == SETS_PLATT[5]
    assert result.p_base == base_probs(result.p_base.p1_win, 3, own)
    assert result.p_base != base_probs(result.p_base.p1_win, 3, SETS_PLATT)
    assert content["p_base"]["elo_p"] == round(result.p_raw, 3)
    assert p1["country"] == "ITA" and p1["age"] == 26.0
    assert p1["news"] == [
        {
            "id": news.id,
            "kind": "injury",
            "d": (day - timedelta(days=2)).isoformat(),
            "text": "Жалобы на плечо",
            "src": "Example",
            "url": "https://example.com/a",
        }
    ]
    assert p1["results"] == []
    assert content["refs"][f"news:{news.id}"] == "p1.news"
    assert result.news_ids == (news.id,) and result.news_version is not None
    # Подача и прием за 52 недели; тай-брейки — по счету (один выигран, один проигран)
    assert p1["serve"] == {
        "m": 1,
        "first_in": 0.6,
        "first_won": 0.75,
        "second_won": 0.5,
        "return_won": round(35 / 90, 2),
        "tb_w": 1,
        "tb_l": 1,
    }
    assert content["p2"]["serve"] is None
    assert "serve" in content["refs"]
    assert p1["load"] == {"m14": 1, "s14": 3, "rest": 3}
    assert p1["form"]["m"][0]["sc"] == "7-6(4) 3-6 6-7(5)"
    assert p1["form"]["m"][0]["opp"] == "Carl C"

    # Перестановка игроков дает дополнение до 1, даже с несимметричным Платтом
    reverse = await _build(db, swapped, as_of)
    assert result.p_base.p1_win + reverse.p_base.p1_win == pytest.approx(1.0)
    assert result.p_base.p1_cover == pytest.approx(reverse.p_base.p2_cover)
    assert calibrated_p1(0.7, None) == 0.7


def test_symmetric_platt_stays_near_backtest() -> None:
    # Симметричная калибровка досье отличается от cal(p) бэктеста не больше |a|/4
    for a, b in ((0.00896, 0.8816), (0.05, 0.8), (-0.2, 1.1)):
        platt = PlattScaling(a, b)
        for step in range(1, 100):
            p = step / 100
            backtest = float(platt.apply([p])[0])
            dossier = calibrated_p1(p, platt)
            assert abs(dossier - backtest) <= abs(a) / 4 + 1e-12
            assert dossier + calibrated_p1(1 - p, platt) == pytest.approx(1.0)


async def test_result_details_from_search(db: AsyncSession) -> None:
    alice, bob = Player(name="Alice A"), Player(name="Bob B")
    db.add_all([alice, bob])
    await db.flush()
    as_of = _noon(date(2026, 3, 1))

    def item(days: int, kind: str, url: str, details: dict[str, Any] | None) -> PlayerNews:
        return PlayerNews(
            player_id=alice.id,
            published_at=as_of - timedelta(days=days),
            kind=kind,
            summary=f"Новость {url}",
            source_url=f"https://example.com/{url}",
            fetched_at=as_of - timedelta(hours=1),
            details=details,
        )

    full = item(
        1,
        "result",
        "full",
        {
            "opponent": "Carl C",
            "score": "6-4 7-6(5)",
            "tournament": "Spring Open " + "x" * 100,
            "date": "2026-02-28",
            "won": True,
            "comment": "лишний ключ не попадает в досье",
        },
    )
    bare = item(2, "result", "bare", None)
    odd = item(3, "result", "odd", {"won": "yes", "score": 64, "opponent": "  "})
    plain = item(4, "injury", "plain", {"opponent": "Carl C"})
    db.add_all([full, bare, odd, plain])
    match = Match(
        player1_id=alice.id, player2_id=bob.id, status="scheduled", source="web", source_ref="r"
    )
    db.add(match)
    await db.commit()

    result = await _build(db, match, as_of)
    p1 = result.content["p1"]
    assert [entry["id"] for entry in p1["results"]] == [full.id, bare.id, odd.id]
    assert p1["results"][0]["det"] == {
        "opp": "Carl C",
        "sc": "6-4 7-6(5)",
        "t": ("Spring Open " + "x" * 100)[:DETAIL_MAX],
        "d": "2026-02-28",
        "won": True,
    }
    assert p1["results"][1]["det"] is None and p1["results"][2]["det"] is None
    # У обычной новости подробностей в досье нет
    assert p1["news"] == [
        {
            "id": plain.id,
            "kind": "injury",
            "d": (as_of - timedelta(days=4)).date().isoformat(),
            "text": "Новость plain",
            "src": None,
            "url": "https://example.com/plain",
        }
    ]
    assert result.content["refs"][f"news:{full.id}"] == "p1.results"
    assert "лишний" not in result.text


async def test_dossier_speed(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> None:
    """Число запросов не зависит от истории: на маленьком мире — с большим запасом."""
    await _world(db, factory)
    match = await _match_on(db, 2025)
    assert match.match_date is not None
    started = time.perf_counter()
    await build_dossier(db, match, as_of=_noon(match.match_date), best_of=3, surface="hard")
    assert time.perf_counter() - started < 0.5
    await db.rollback()


async def test_naive_as_of_is_rejected(db: AsyncSession) -> None:
    match = Match(player1_id=1, player2_id=2)
    with pytest.raises(ValueError, match="часового пояса"):
        await build_dossier(db, match, as_of=datetime(2026, 3, 1), best_of=3, surface="hard")
