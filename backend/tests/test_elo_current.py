"""Текущее Эло для списка «Игроки» (player_elo_current, этап 4): пишет шаг elo
(rebuild_ratings) и команда elo-current. Значения — те же, что у расчета Эло
(current_elo), места и последний матч — как у анализа (elo_ranks, last_match_days)."""

import asyncio
from datetime import date, timedelta
from typing import Any

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.admin import cli
from app.core.i18n import t
from app.db.models import IngestionRun, Match, Player, PlayerEloCurrent, Tournament
from app.db.session import create_sessionmaker
from app.ml import elo
from app.ml.elo import (
    CURRENT_DAYS,
    current_elo,
    current_since,
    rebuild_ratings,
    refresh_current,
)
from app.services.analysis_input import ELO_RANK_DAYS, elo_ranks, last_match_days
from tests.ml_world import small_world, store_world

TODAY = date(2025, 12, 31)


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> async_sessionmaker[AsyncSession]:
    return create_sessionmaker(engine)


async def table(db: AsyncSession) -> list[tuple[Any, ...]]:
    rows = await db.execute(
        select(PlayerEloCurrent)
        .order_by(PlayerEloCurrent.player_id)
        .execution_options(populate_existing=True)
    )
    return [
        (
            row.player_id,
            row.elo_all,
            row.elo_hard,
            row.elo_clay,
            row.elo_grass,
            row.n_all,
            row.n_hard,
            row.n_clay,
            row.n_grass,
            row.rank_all,
            row.last_match,
            row.matches_52w,
            row.as_of,
        )
        for (row,) in rows
    ]


def test_window_is_the_analysis_rank_window() -> None:
    assert CURRENT_DAYS == ELO_RANK_DAYS == 364


async def test_rebuild_writes_current_elo(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    world = small_world()
    await store_world(db, world)
    summary = await rebuild_ratings(db_factory=factory, today=TODAY)
    rows = {row.player_id: row for row in await db.scalars(select(PlayerEloCurrent))}
    assert len(rows) == world.players == summary.current
    assert sum(1 for row in rows.values() if row.rank_all is not None) == summary.ranked > 0
    assert t("ml.elo.report.current", players=summary.current, ranked=summary.ranked) in (
        elo.summary_lines(summary)
    )
    run = await db.scalar(select(IngestionRun).where(IngestionRun.source == "elo"))
    assert run is not None and run.details["counts"]["current.players"] == world.players

    # Эло и число матчей — как у расчета Эло: последняя строка player_ratings
    for player_id, row in rows.items():
        assert row.as_of == TODAY
        for surface in ("hard", "clay", "grass"):
            snapshot = await current_elo(db, player_id, surface)
            assert snapshot is not None
            assert row.elo_all == snapshot.overall
            assert row.n_all == snapshot.overall_matches
            assert getattr(row, f"elo_{surface}") == snapshot.surface_elo
            assert getattr(row, f"n_{surface}") == snapshot.surface_matches

    # Место и последний матч — как у анализа на следующий день (матчи дня TODAY видны)
    ranks = await elo_ranks(db, rows, today=TODAY + timedelta(days=1))
    assert {pid: row.rank_all for pid, row in rows.items() if row.rank_all} == ranks
    assert {pid: row.last_match for pid, row in rows.items()} == await last_match_days(db, rows)

    # Матчи за 52 недели — по дням матчей из базы (дата, иначе начало турнира): 364 дня
    # по TODAY включительно
    since = TODAY - timedelta(days=CURRENT_DAYS - 1)
    assert current_since(TODAY) == since
    ids = {name: pid for pid, name in await db.execute(select(Player.id, Player.name))}
    recent: dict[int, int] = dict.fromkeys(rows, 0)
    for match in world.matches:
        if since <= (match.match_date or match.start_date or match.day) <= TODAY:
            for number in (match.player1_id, match.player2_id):
                recent[ids[f"Player {number}"]] += 1
    assert {pid: row.matches_52w for pid, row in rows.items()} == recent
    assert {pid for pid, row in rows.items() if row.rank_all is not None} == {
        pid for pid, count in recent.items() if count
    }


async def test_window_edges(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> None:
    """Окно — 364 дня по as_of включительно: матч на день as_of − 364 не входит, на
    as_of − 363 и на as_of — входят. Место — как у анализа на следующий день."""
    await store_world(db, small_world())
    edge = Tournament(
        name="Edge Open", surface="hard", start_date=TODAY - timedelta(days=400), source="sackmann"
    )
    a, b, c, d = (Player(name=f"Edge {letter}") for letter in "ABCD")
    db.add_all([edge, a, b, c, d])
    await db.flush()
    for number, (winner, loser, back) in enumerate(
        [(a, b, CURRENT_DAYS), (c, d, CURRENT_DAYS - 1), (a, d, 0)]
    ):
        db.add(
            Match(
                tournament_id=edge.id,
                round="R32",
                match_date=TODAY - timedelta(days=back),
                player1_id=winner.id,
                player2_id=loser.id,
                winner_id=winner.id,
                score="6-4 6-4",
                status="finished",
                best_of=3,
                source="sackmann",
                source_ref=f"edge-{number}",
            )
        )
    await db.commit()
    await rebuild_ratings(db_factory=factory, today=TODAY)
    rows = {row.player_id: row for row in await db.scalars(select(PlayerEloCurrent))}
    assert [rows[p.id].matches_52w for p in (a, b, c, d)] == [1, 0, 1, 2]
    assert rows[b.id].rank_all is None
    assert rows[b.id].last_match == TODAY - timedelta(days=CURRENT_DAYS)
    assert all(rows[p.id].rank_all is not None for p in (a, c, d))
    ranks = await elo_ranks(db, rows, today=TODAY + timedelta(days=1))
    assert {pid: row.rank_all for pid, row in rows.items() if row.rank_all} == ranks
    assert b.id not in ranks


async def test_current_elo_is_idempotent_and_follows_today(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    await store_world(db, small_world())
    await rebuild_ratings(db_factory=factory, today=TODAY)
    first = await table(db)
    assert await refresh_current(db_factory=factory, today=TODAY) == (
        len(first),
        sum(1 for row in first if row[9] is not None),
    )
    assert await table(db) == first

    # Через два года ни у кого нет матчей за 52 недели: мест нет, Эло то же
    later = TODAY + timedelta(days=2 * 365)
    players, ranked = await refresh_current(db_factory=factory, today=later)
    assert (players, ranked) == (len(first), 0)
    moved = await table(db)
    assert [row[:9] for row in moved] == [row[:9] for row in first]
    assert all(row[9] is None and row[11] == 0 and row[12] == later for row in moved)


async def test_walkover_is_not_a_played_match(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    """Матч без победителя и неявка не входят ни в Эло, ни в последний матч."""
    ids = await store_world(db, small_world())
    await rebuild_ratings(db_factory=factory, today=TODAY)
    before = {row[0]: row for row in await table(db)}
    some = next(iter(ids.values()))
    await db.execute(update(Match).where(Match.id == some).values(status="walkover"))
    await db.commit()
    await rebuild_ratings(db_factory=factory, today=TODAY)
    after = {row[0]: row for row in await table(db)}
    match = await db.get_one(Match, some)
    for pid in (match.player1_id, match.player2_id):
        assert after[pid][5] == before[pid][5] - 1
    assert len(after) == len(before)


async def test_elo_current_command(
    db: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    capsys: pytest.CaptureFixture[str],
) -> None:
    await store_world(db, small_world())
    await rebuild_ratings(db_factory=factory, today=TODAY)
    await db.execute(delete(PlayerEloCurrent))
    await db.commit()
    assert await asyncio.to_thread(cli.main, ["elo-current"]) == 0
    rows = await table(db)
    assert len(rows) == 24
    ranked = sum(1 for row in rows if row[9] is not None)
    out = capsys.readouterr().out
    assert t("cli.elo_current_done", players=24, ranked=ranked) in out
