"""Синтетический теннисный мир для тестов модели (app/ml).

У игроков скрытая сила и поправки по покрытиям; турниры — сетки на выбывание по годам,
покрытиям и уровням; исход матча разыгрывается по истинной вероятности. Кэфы — истинная
вероятность с шумом рынка и маржой букмекера. Игрок 1 в каждом матче — победитель, как
в архивах Сакманна и tennis-data: модель обязана сама назначать стороны.

store_world кладет тот же мир в базу через ORM (турниры и матчи как от загрузчиков).
"""

import math
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_HALF_UP, Decimal

import numpy as np
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Match, OddsSnapshot, Player, Tournament
from app.ml.elo import EloMatch

SURFACES = ("hard", "clay", "grass", "carpet")
SURFACE_SHARES = (0.55, 0.3, 0.1, 0.05)
LEVELS = ("grand_slam", "masters", "500", "250", "davis_cup")
LEVEL_SHARES = (0.1, 0.25, 0.25, 0.35, 0.05)
# Маржа букмекера: у «максимума по рынку» она отрицательная
MARGINS = {"pinnacle": 0.025, "avg": 0.06, "max": -0.01}
ROUNDS_BY_SIZE = {
    2: "F",
    4: "SF",
    8: "QF",
    16: "R16",
    32: "R32",
    64: "R64",
    128: "R128",
}


@dataclass(frozen=True)
class WorldTournament:
    key: int
    name: str
    surface: str
    level: str
    start: date


@dataclass
class World:
    """matches — в порядке игры; true_p1 — истинная вероятность победы игрока 1
    (победителя); odds — id матча → букмекер → (кэф игрока 1, кэф игрока 2)."""

    matches: list[EloMatch] = field(default_factory=list)
    true_p1: dict[int, float] = field(default_factory=dict)
    odds: dict[int, dict[str, tuple[Decimal | None, Decimal | None]]] = field(default_factory=dict)
    tournaments: dict[int, WorldTournament] = field(default_factory=dict)
    players: int = 0


def _probability(diff: float) -> float:
    return float(1.0 / (1.0 + 10.0 ** (-diff / 400.0)))


def _odds(q: float, margin: float) -> Decimal:
    value = Decimal(str(1.0 / (q * (1.0 + margin)))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    return max(value, Decimal("1.01"))


def make_world(
    *,
    players: int = 80,
    years: range = range(2015, 2026),
    tournaments_per_year: int = 30,
    draw: int = 32,
    seed: int = 7,
    noise: float = 0.15,
    odds_from: int = 2013,
    retired_share: float = 0.01,
    dated_from: int = 0,
) -> World:
    """Мир с турнирами на draw игроков. Кэфы — у матчей с года odds_from; день матча
    (match_date) — с года dated_from (раньше — только дата начала турнира, как у
    Сакманна)."""
    rng = np.random.default_rng(seed)
    strength = rng.normal(0.0, 150.0, players)
    surface_bonus = {surface: rng.normal(0.0, 80.0, players) for surface in SURFACES}
    world = World(players=players)
    match_id = 0
    for year in years:
        for number in range(tournaments_per_year):
            key = year * 1000 + number
            surface = str(rng.choice(SURFACES, p=SURFACE_SHARES))
            level = str(rng.choice(LEVELS, p=LEVEL_SHARES))
            start = date(year, 1, 6) + timedelta(days=int(number * 340 / tournaments_per_year))
            world.tournaments[key] = WorldTournament(key, f"Турнир {key}", surface, level, start)
            alive = [int(player) for player in rng.choice(players, size=draw, replace=False)]
            day_no = 0
            while len(alive) > 1:
                round_code = ROUNDS_BY_SIZE[len(alive)]
                winners: list[int] = []
                for index in range(0, len(alive), 2):
                    a, b = alive[index], alive[index + 1]
                    diff = (strength[a] + surface_bonus[surface][a]) - (
                        strength[b] + surface_bonus[surface][b]
                    )
                    p_a = _probability(float(diff))
                    a_wins = bool(rng.random() < p_a)
                    winner, loser = (a, b) if a_wins else (b, a)
                    p_winner = p_a if a_wins else 1.0 - p_a
                    match_id += 1
                    # Без даты матча днем считается начало турнира, как в базе
                    played = start + timedelta(days=day_no)
                    day = played if year >= dated_from else start
                    status = "retired" if rng.random() < retired_share else "finished"
                    world.matches.append(
                        EloMatch(
                            match_id=match_id,
                            day=day,
                            player1_id=winner + 1,
                            player2_id=loser + 1,
                            winner_id=winner + 1,
                            surface=surface,
                            status=status,
                            match_date=played if year >= dated_from else None,
                            tournament_id=key,
                            start_date=start,
                            round=round_code,
                            level=level,
                        )
                    )
                    world.true_p1[match_id] = p_winner
                    if year >= odds_from:
                        logit = math.log(p_winner / (1.0 - p_winner)) + rng.normal(0.0, noise)
                        q = 1.0 / (1.0 + math.exp(-logit))
                        world.odds[match_id] = {
                            book: (_odds(q, margin), _odds(1.0 - q, margin))
                            for book, margin in MARGINS.items()
                        }
                    winners.append(winner)
                alive = winners
                day_no += 2 if day_no < 6 else 1
    return world


def small_world() -> World:
    """Небольшой мир для тестов с базой: 540 матчей 2017–2025 годов, даты матчей с 2019."""
    return make_world(
        players=24,
        years=range(2017, 2026),
        tournaments_per_year=4,
        draw=16,
        seed=3,
        dated_from=2019,
        retired_share=0.03,
    )


async def store_world(db: AsyncSession, world: World) -> dict[int, int]:
    """Мир в базу: игроки, турниры Сакманна, матчи и кэфы archive (ML). Возвращает
    id матча мира → id в базе. Делает commit."""
    people = [Player(name=f"Player {number}") for number in range(1, world.players + 1)]
    db.add_all(people)
    await db.flush()
    player_ids = {number: person.id for number, person in enumerate(people, start=1)}
    tournaments = {
        key: Tournament(
            name=item.name,
            surface=item.surface,
            category=item.level,
            start_date=item.start,
            source="sackmann",
            source_ref=f"{item.start.year}-{key}",
        )
        for key, item in world.tournaments.items()
    }
    db.add_all(tournaments.values())
    await db.flush()
    rows: dict[int, Match] = {}
    for match in world.matches:
        assert match.tournament_id is not None
        rows[match.match_id] = Match(
            tournament_id=tournaments[match.tournament_id].id,
            round=match.round,
            match_date=match.match_date,
            player1_id=player_ids[match.player1_id],
            player2_id=player_ids[match.player2_id],
            winner_id=player_ids[match.winner_id],
            score="6-4 6-4",
            status=match.status,
            best_of=3,
            source="sackmann",
            source_ref=f"{match.tournament_id}-{match.match_id}",
        )
    db.add_all(rows.values())
    await db.flush()
    for match in world.matches:
        books = world.odds.get(match.match_id, {})
        day = match.match_date or match.day
        taken_at = datetime.combine(day, time(0, 0), tzinfo=UTC)
        for bookmaker, pair in books.items():
            for selection, value in enumerate(pair, start=1):
                if value is None:
                    continue
                db.add(
                    OddsSnapshot(
                        match_id=rows[match.match_id].id,
                        market="ML",
                        selection=selection,
                        bookmaker=bookmaker,
                        odds=value,
                        kind="archive",
                        taken_at=taken_at,
                    )
                )
    await db.commit()
    return {key: row.id for key, row in rows.items()}
