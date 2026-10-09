"""Эло по покрытиям (app/ml/elo.py): формулы, порядок матчей, синтетический мир,
пересчет в БД и рейтинг на дату."""

import asyncio
from collections.abc import Sequence
from datetime import date
from typing import Any

import numpy as np
import pytest
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.i18n import t
from app.db.models import IngestionRun, Match, MlModel, Player, PlayerRating, Tournament
from app.db.session import create_sessionmaker
from app.ml import elo
from app.ml.backtest import side_flip
from app.ml.elo import (
    ALL,
    EloEngine,
    EloMatch,
    EloParams,
    current_elo,
    fill_days,
    load_history,
    order_key,
    rating_surface,
    rebuild_ratings,
    sort_history,
    win_probability,
)
from app.ml.metrics import COIN_LOG_LOSS, log_loss
from tests.ml_world import World, make_world, small_world, store_world

K0 = 250.0 / 5.0**0.4


def m(
    match_id: int,
    p1: int,
    p2: int,
    winner: int,
    surface: str | None = "hard",
    day: date = date(2024, 1, 1),
    **fields: Any,
) -> EloMatch:
    return EloMatch(match_id, day, p1, p2, winner, surface, **fields)


def test_formulas() -> None:
    params = EloParams()
    assert params.k_factor(0) == pytest.approx(K0)
    assert params.k_factor(0) == pytest.approx(131.33, abs=0.01)
    assert params.k_factor(20) < params.k_factor(5) < params.k_factor(0)
    assert win_probability(1900, 1500) == pytest.approx(10 / 11)
    assert win_probability(1500, 1500) == 0.5
    assert win_probability(1600, 1700) + win_probability(1700, 1600) == pytest.approx(1.0)
    assert params.blend(1600, 1400) == pytest.approx(1500)
    assert params.blend(1600, None) == 1600
    assert params.blend(1600, 1400, weight=1.0) == 1400


def test_surfaces_carpet_is_hard() -> None:
    assert rating_surface("Hard") == "hard"
    assert rating_surface("carpet") == "hard"
    assert rating_surface("clay") == "clay"
    assert rating_surface(None) is None
    assert rating_surface("") is None


def test_update_moves_overall_and_surface() -> None:
    engine = EloEngine()
    engine.update(1, 2, 1, "clay")
    assert engine.rating(1) == pytest.approx(1500 + K0 / 2)
    assert engine.rating(2) == pytest.approx(1500 - K0 / 2)
    assert engine.rating(1, "clay") == pytest.approx(1500 + K0 / 2)
    assert engine.rating(1, "hard") == 1500
    assert (engine.matches(1), engine.matches(1, "clay"), engine.matches(1, "hard")) == (1, 1, 0)
    # Ковер — это хард
    engine.update(1, 2, 2, "carpet")
    assert engine.matches(2, "hard") == 1
    assert engine.rating(2, "hard") > 1500
    # Без покрытия меняется только общий рейтинг
    engine.update(1, 2, 1, None)
    assert engine.matches(1) == 3
    assert engine.matches(1, "clay") == 1
    assert engine.players() == {1, 2}


def test_k_decreases_with_experience() -> None:
    """Опытный игрок после поражения новичку теряет меньше, чем тот приобретает."""
    engine = EloEngine()
    for opponent in range(10, 30):
        engine.update(1, opponent, 1, "hard")
        engine.update(1, opponent + 100, opponent + 100, "hard")
    before_veteran, before_rookie = engine.rating(1), engine.rating(999)
    engine.update(1, 999, 999, None)
    lost = before_veteran - engine.rating(1)
    gained = engine.rating(999) - before_rookie
    assert 0 < lost < gained


def test_prediction_blends_overall_and_surface() -> None:
    engine = EloEngine(EloParams(surface_weight=0.25))
    for _ in range(5):
        engine.update(1, 2, 1, "clay")
    engine.update(1, 2, 2, "hard")
    state = engine.pre_match(0, 1, 2, "clay")
    overall = win_probability(engine.rating(1), engine.rating(2))
    clay_only = win_probability(engine.rating(1, "clay"), engine.rating(2, "clay"))
    assert state.probability(0.0) == pytest.approx(overall)
    assert state.probability(1.0) == pytest.approx(clay_only)
    assert overall < state.p1 < clay_only
    assert engine.predict(1, 2, "clay") == pytest.approx(state.p1)
    # Без покрытия — только общий рейтинг, вес не важен
    assert engine.predict(1, 2, None) == pytest.approx(overall)
    no_surface = engine.pre_match(0, 1, 2, None)
    assert no_surface.surface1 is None and no_surface.probability(1.0) == pytest.approx(overall)


def test_run_gives_probabilities_before_each_match() -> None:
    matches = [m(1, 1, 2, 1), m(2, 1, 2, 1), m(3, 2, 3, 3)]
    states = EloEngine().run(matches)
    assert [state.match_id for state in states] == [1, 2, 3]
    assert states[0].p1 == 0.5
    assert states[1].p1 > 0.5  # игрок 1 уже выигрывал у 2
    assert states[2].p1 < 0.5  # игрок 2 проиграл, игрок 3 новичок
    assert (states[1].matches1, states[1].matches2) == (1, 1)


def test_bad_matches() -> None:
    engine = EloEngine()
    with pytest.raises(ValueError):
        engine.update(1, 1, 1, "hard")
    with pytest.raises(ValueError):
        engine.update(1, 2, 3, "hard")


def test_order_key() -> None:
    start = date(2024, 5, 20)
    final = m(1, 1, 2, 1, day=start, start_date=start, tournament_id=7, round="F")
    semi = m(9, 1, 3, 1, day=start, start_date=start, tournament_id=7, round="SF")
    robin = m(5, 1, 3, 1, day=start, start_date=start, tournament_id=7, round="RR")
    dated = m(2, 1, 2, 1, day=date(2024, 5, 19), start_date=date(2024, 5, 13), tournament_id=9)
    no_round = m(3, 1, 2, 1, day=start, start_date=start, tournament_id=7)
    ordered = sorted([final, semi, dated, robin, no_round], key=order_key)
    assert [match.match_id for match in ordered] == [2, 3, 5, 9, 1]


def test_undated_match_waits_for_dated_rounds() -> None:
    """Турнир со смешанными датами (строку tennis-data не сопоставили): матч без даты не
    обсчитывается раньше сыгранных до него кругов с датой, иначе их прогноз «до матча»
    видел бы исход более позднего круга."""
    start = date(2024, 1, 1)
    jan = {day: date(2024, 1, day) for day in (2, 3, 5)}
    t7: dict[str, Any] = {"start_date": start, "tournament_id": 7}
    matches = [
        m(6, 3, 10, 3, day=jan[5], match_date=jan[5], round="SF", **t7),
        m(3, 1, 3, 3, day=start, round="R16", **t7),  # без даты
        m(2, 3, 4, 3, day=jan[3], match_date=jan[3], round="R32", **t7),
        m(1, 1, 2, 1, day=jan[2], match_date=jan[2], round="R32", **t7),
        m(5, 8, 9, 8, day=start, round="R64", **t7),  # без даты, раньше кругов нет
        m(7, 11, 12, 11, day=start, **t7),  # без даты и без раунда
        m(8, 13, 14, 13, day=jan[2], start_date=jan[2], tournament_id=8, round="R32"),
    ]
    days = {match.match_id: match.day for match in fill_days(matches)}
    assert days == {6: jan[5], 3: jan[3], 2: jan[3], 1: jan[2], 5: start, 7: start, 8: jan[2]}

    ordered = sort_history(matches)
    assert [match.match_id for match in ordered] == [7, 5, 1, 8, 2, 3, 6]
    assert sort_history(ordered) == ordered
    # Оба R32 — между новичками: прогноз 0,5, исход R16 в него не попал
    states = {state.match_id: state for state in EloEngine().run(ordered)}
    assert states[1].p1 == 0.5 and states[2].p1 == 0.5
    # С днем начала турнира R16 шел бы первым — это и была утечка
    old = [match.match_id for match in sorted(matches, key=order_key)]
    assert old.index(3) < old.index(1)


def test_undated_match_stays_before_next_round_of_its_players() -> None:
    """Круг в другой половине сетки доигран позже (дождь): матч без даты не уходит за
    следующий матч своего игрока. Иначе его прогноз видел бы исход следующего круга, а
    следующий круг считался бы без него."""
    start = date(2024, 6, 24)
    wimbledon: dict[str, Any] = {"start_date": start, "tournament_id": 1, "surface": "grass"}
    late, second = date(2024, 6, 27), date(2024, 6, 26)
    matches = [
        m(1, 1, 2, 1, day=start, round="R128", **wimbledon),  # без даты, на деле 24 июня
        m(2, 3, 4, 3, day=start, match_date=start, round="R128", **wimbledon),
        m(3, 5, 6, 5, day=late, match_date=late, round="R128", **wimbledon),
        m(4, 1, 3, 1, day=second, match_date=second, round="R64", **wimbledon),
    ]
    days = {match.match_id: match.day for match in fill_days(matches)}
    assert days[1] == second
    ordered = sort_history(matches)
    assert [match.match_id for match in ordered] == [2, 1, 4, 3]
    states = {state.match_id: state for state in EloEngine().run(ordered)}
    # Оба новички: 0,5; второй круг игрока 1 учитывает его первый круг
    assert states[1].p1 == 0.5
    assert states[4].overall1 > 1500.0


# --- синтетический мир ---
# --- синтетический мир ---


def _side_log_losses(world: World, weight: float) -> tuple[float, float, float, int]:
    """Лог-лосс Эло, истинной вероятности и доля «игрок A выиграл» на 2022–2025 годах
    при случайном назначении сторон по хешу."""
    states = EloEngine(EloParams(surface_weight=weight)).run(world.matches)
    elo_p, true_p, y = [], [], []
    for match, state in zip(world.matches, states, strict=True):
        if match.day.year < 2022:
            continue
        flip = side_flip(match.match_id)
        elo_p.append(1 - state.p1 if flip else state.p1)
        true_p1 = world.true_p1[match.match_id]
        true_p.append(1 - true_p1 if flip else true_p1)
        y.append(0.0 if flip else 1.0)  # игрок 1 в мире — победитель
    share = float(np.mean(y))
    return log_loss(elo_p, y), log_loss(true_p, y), share, len(y)


def test_elo_beats_coin_but_not_the_truth() -> None:
    world = make_world(seed=11)
    elo_ll, true_ll, share, n = _side_log_losses(world, 0.5)
    assert n > 3000
    # Стороны назначены не «всегда победитель — игрок 1»
    assert 0.45 < share < 0.55
    assert elo_ll < COIN_LOG_LOSS - 0.03
    assert true_ll < elo_ll
    # Без случайных сторон исход был бы «всегда 1»: тест это и ловит
    assert all(match.winner_id == match.player1_id for match in world.matches)


# --- БД ---


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Фабрика сеансов для пересчета (db — ради чистой базы перед тестом)."""
    return create_sessionmaker(engine)


async def add_extra_matches(db: AsyncSession) -> None:
    """Неявка, несыгранный матч и матч без дня: Эло их не учитывает."""
    tournament = await db.scalar(select(Tournament).limit(1))
    assert tournament is not None
    db.add_all(
        [
            Match(
                tournament_id=tournament.id,
                round="R32",
                player1_id=1,
                player2_id=2,
                winner_id=1,
                status="walkover",
                source="sackmann",
                source_ref="wo-1",
            ),
            Match(
                round="",
                player1_id=3,
                player2_id=4,
                status="scheduled",
                source="legacy",
                source_ref="2024-06-01:3:4",
            ),
            Match(
                round="",
                player1_id=5,
                player2_id=6,
                winner_id=5,
                status="finished",
                source="web",
                source_ref="web-1",
            ),
        ]
    )
    await db.commit()


async def count(db: AsyncSession, *where: ColumnElement[bool]) -> int:
    stmt = select(func.count()).select_from(PlayerRating)
    if where:
        stmt = stmt.where(*where)
    return int(await db.scalar(stmt) or 0)


def expected_rows(matches: Sequence[EloMatch]) -> tuple[int, int]:
    """Строки (игрок, all, день) и (игрок, покрытие, день) — без расчета Эло."""
    overall = {(p, match.day) for match in matches for p in (match.player1_id, match.player2_id)}
    surface = {
        (p, rating_surface(match.surface), match.day)
        for match in matches
        for p in (match.player1_id, match.player2_id)
    }
    return len(overall), len(surface)


async def test_rebuild_ratings(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> None:
    world = small_world()
    await store_world(db, world)
    await add_extra_matches(db)

    summary = await rebuild_ratings(db_factory=factory)
    assert summary.matches == len(world.matches)
    assert summary.skipped == {"no_date": 1, "walkover": 1}
    assert summary.players == world.players
    overall_rows, surface_rows = expected_rows(world.matches)
    assert summary.rows == overall_rows + surface_rows
    assert await count(db) == summary.rows
    assert await count(db, PlayerRating.surface == ALL) == overall_rows
    assert await count(db, PlayerRating.surface == "carpet") == 0
    assert (summary.train_from, summary.train_to) == (
        world.matches[0].day,
        max(match.day for match in world.matches),
    )

    # Последний общий рейтинг каждого игрока — как у расчета в памяти по миру
    engine = EloEngine()
    engine.run(sorted(world.matches, key=order_key))
    names = {
        name: player_id for player_id, name in (await db.execute(select(Player.id, Player.name)))
    }
    for number in (1, 7, 24):
        snapshot = await current_elo(db, names[f"Player {number}"], None)
        assert snapshot is not None
        assert snapshot.overall == pytest.approx(engine.rating(number), abs=1e-9)
        assert snapshot.overall_matches == engine.matches(number)

    model = await db.get(MlModel, elo.MODEL_ID)
    assert model is not None and model.kind == "elo"
    assert model.params["k_num"] == 250.0 and model.params["surface_weight"] == 0.5
    assert model.params["carpet_as"] == "hard"
    run = await db.scalar(select(IngestionRun).where(IngestionRun.source == "elo"))
    assert run is not None and run.status == "ok" and run.rows == summary.rows
    assert run.details["counts"]["skipped.walkover"] == 1
    assert run.details["counts"]["matches.used"] == len(world.matches)

    # Повторный пересчет заменяет строки, а не добавляет; вес покрытия, подобранный
    # бэктестом, не затирается
    model.params = {**model.params, "surface_weight": 0.75, "platt": {"a": 0.1, "b": 0.9}}
    await db.commit()
    again = await rebuild_ratings(params=EloParams(k_num=200.0), db_factory=factory)
    assert again.rows == summary.rows
    assert await count(db) == summary.rows
    db.expire_all()
    model = await db.get(MlModel, elo.MODEL_ID)
    assert model is not None
    assert model.params["surface_weight"] == 0.75
    assert model.params["platt"] == {"a": 0.1, "b": 0.9}
    assert model.params["k_num"] == 200.0


async def test_current_elo_does_not_see_undated_matches(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    """current_elo(before=день внутри турнира) не видит матчи без даты этого турнира: их
    строки стоят на последнем дне, когда они могли быть сыграны (reveal_days)."""
    people = [Player(name=name) for name in "ABCDEFGH"]
    db.add_all(people)
    await db.flush()
    a, b, c, d, e, f, g, h = (person.id for person in people)
    t0 = Tournament(name="T0", surface="hard", start_date=date(2023, 12, 1))
    # Только из архива Сакманна: дат матчей нет
    t1 = Tournament(name="T1", surface="hard", start_date=date(2024, 1, 1))
    # Смешанный: R16 и SF с датой, QF без даты (строка tennis-data не сопоставилась)
    t2 = Tournament(name="T2", surface="hard", start_date=date(2024, 2, 5))
    db.add_all([t0, t1, t2])
    await db.flush()

    def row(tour: Tournament, rnd: str, p1: int, p2: int, day: date | None = None) -> Match:
        return Match(
            tournament_id=tour.id,
            round=rnd,
            match_date=day,
            player1_id=p1,
            player2_id=p2,
            winner_id=p1,
            status="finished",
            source="sackmann",
            source_ref=f"{tour.name}-{rnd}-{p1}-{p2}",
        )

    db.add_all(
        [
            row(t0, "F", a, h, date(2023, 12, 3)),
            row(t1, "SF", a, b),
            row(t1, "SF", c, d),
            row(t1, "F", a, c),
            row(t2, "R16", e, f, date(2024, 2, 5)),
            row(t2, "R16", g, h, date(2024, 2, 6)),
            row(t2, "QF", e, g),  # на деле 7 февраля
            row(t2, "SF", e, a, date(2024, 2, 8)),
        ]
    )
    await db.commit()
    await rebuild_ratings(db_factory=factory)

    engine = EloEngine()
    engine.update(a, h, a, "hard")
    before_t1 = engine.rating(a)
    # Внутри T1 (до полуфинала и до финала) — рейтинг до турнира
    for day in (date(2024, 1, 2), date(2024, 1, 4), date(2024, 1, 7)):
        snapshot = await current_elo(db, a, "hard", before=day)
        assert snapshot is not None and snapshot.as_of == date(2023, 12, 3)
        assert snapshot.overall == pytest.approx(before_t1)
    # После окна турнира итог виден
    after = await current_elo(db, a, "hard", before=date(2024, 1, 20))
    assert after is not None and after.overall > before_t1

    engine.update(e, f, e, "hard")
    after_r16 = engine.rating(e)
    # Смешанный турнир: перед QF (7 февраля) — рейтинг после R16, без исхода QF
    snapshot = await current_elo(db, e, "hard", before=date(2024, 2, 7))
    assert snapshot is not None and snapshot.as_of == date(2024, 2, 5)
    assert snapshot.overall == pytest.approx(after_r16)
    # Матч с датой себя не видит
    assert await current_elo(db, e, "hard", before=date(2024, 2, 5)) is None


async def test_current_elo_on_date(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    world = small_world()
    await store_world(db, world)
    await rebuild_ratings(db_factory=factory)
    player_id = 1
    rows = (
        await db.execute(
            select(PlayerRating)
            .where(PlayerRating.player_id == player_id)
            .order_by(PlayerRating.as_of)
        )
    ).scalars()
    by_surface: dict[str, list[PlayerRating]] = {}
    for row in rows:
        by_surface.setdefault(row.surface, []).append(row)
    overall = by_surface[ALL]
    assert len(overall) >= 3

    latest = await current_elo(db, player_id, "clay")
    assert latest is not None
    assert latest.overall == overall[-1].elo
    clay = by_surface.get("clay")
    if clay:
        assert latest.surface_elo == clay[-1].elo
        assert latest.surface_matches == clay[-1].matches
        expected = 0.5 * latest.overall + 0.5 * clay[-1].elo
        assert latest.rating(0.5) == pytest.approx(expected)

    # До дня строки — строка предыдущего дня
    middle = overall[len(overall) // 2]
    before = await current_elo(db, player_id, None, before=middle.as_of)
    assert before is not None
    assert before.as_of < middle.as_of
    assert before.overall == overall[len(overall) // 2 - 1].elo
    assert before.surface is None and before.rating(0.5) == before.overall

    # Ковер — это хард
    carpet = await current_elo(db, player_id, "carpet")
    assert carpet is not None and carpet.surface == "hard"
    if "hard" not in by_surface:
        assert carpet.surface_elo is None and carpet.rating(1.0) == 1500.0
    # До первого матча и у неизвестного игрока рейтинга нет
    assert await current_elo(db, player_id, None, before=overall[0].as_of) is None
    assert await current_elo(db, 10_000, "hard") is None


async def test_load_history_fills_days(db: AsyncSession) -> None:
    """load_history ставит матч без даты после круга того же турнира с датой."""
    people = [Player(name=f"Mixed {number}") for number in range(3)]
    tournament = Tournament(
        name="Mixed",
        surface="hard",
        category="250",
        start_date=date(2024, 1, 1),
        source="sackmann",
        source_ref="2024-mixed",
    )
    db.add_all([*people, tournament])
    await db.flush()
    a, b, c = (person.id for person in people)
    db.add_all(
        [
            Match(
                tournament_id=tournament.id,
                round="R16",
                player1_id=a,
                player2_id=c,
                winner_id=a,
                status="finished",
                source="sackmann",
                source_ref="mixed-2",
            ),
            Match(
                tournament_id=tournament.id,
                round="R32",
                match_date=date(2024, 1, 2),
                player1_id=a,
                player2_id=b,
                winner_id=a,
                status="finished",
                source="sackmann",
                source_ref="mixed-1",
            ),
        ]
    )
    await db.commit()
    history = await load_history(db)
    assert [(match.round, match.day) for match in history.matches] == [
        ("R32", date(2024, 1, 2)),
        ("R16", date(2024, 1, 2)),
    ]


async def test_main(db: AsyncSession, capsys: pytest.CaptureFixture[str]) -> None:
    await store_world(db, small_world())
    code = await asyncio.to_thread(elo.main, [])
    assert code == 0
    out = capsys.readouterr().out
    rows = await count(db)
    assert t("ml.elo.report.done", matches=540, players=24, rows=rows) in out
    assert rows > 0
