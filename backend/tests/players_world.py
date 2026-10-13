"""Небольшой мир игроков для тестов списка «Игроки» и карточки игрока (этап 4): игроки,
турниры и матчи архива Сакманна с датами относительно сегодняшнего дня (UTC), статистика
подачи, новости и пересчет Эло (player_ratings и player_elo_current).

Матчи (день — сегодня минус N дней):
- «Hard Open» (хард, до двух побед, начало −40): R16 Sinner — Medvedev 6-4 6-4 (−38),
  SF Sinner — Alcaraz 7-6(5) 3-6 6-3 (−36), F Alcaraz — Sinner 6-3 6-2 (−35, Alcaraz
  выиграл; в паре матча Sinner первый — победитель Alcaraz);
- «Clay Slam» (грунт, до трех побед, начало −100): R32 Medvedev — Sinner, неявка (−98,
  победитель Medvedev), QF Sinner — Alcaraz 6-7(4) 6-4 6-4 3-6 7-5 (−95);
- «Grass Cup» (трава, начало −200): SF Alcaraz — Medvedev 6-3 6-4 (−199);
- «Old Hard» (хард, начало −800): F Veteran — Alcaraz 6-4 6-4 (−790).
Статистика подачи — у обоих игроков матчей «Hard Open».
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import (
    Analysis,
    BankrollLedger,
    Bet,
    BetLeg,
    Match,
    MatchStat,
    Player,
    PlayerNews,
    PlayerProfile,
    Tournament,
    User,
)
from app.ml.elo import rebuild_ratings
from app.services.bank import local_today, user_zone


def today() -> date:
    return datetime.now(UTC).date()


@dataclass
class PlayersWorld:
    sinner: int
    alcaraz: int
    medvedev: int
    veteran: int
    nobody: int
    matches: dict[str, int]
    tournaments: dict[str, int]


async def build_players_world(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> PlayersWorld:
    day = today()
    people = {
        "sinner": Player(
            name="Jannik Sinner",
            name_ru="Янник Синнер",
            country="ITA",
            hand="R",
            backhand="two",
            birth_date=date(2001, 8, 16),
            sackmann_id=206173,
        ),
        "alcaraz": Player(
            name="Carlos Alcaraz",
            name_ru="Карлос Алькарас",
            country="ESP",
            hand="R",
            birth_date=date(2003, 5, 5),
            sackmann_id=207989,
        ),
        "medvedev": Player(name="Daniil Medvedev", country="RUS", sackmann_id=106421),
        "veteran": Player(name="Old Veteran", country="FRA", sackmann_id=100001),
        "nobody": Player(name="Never Played", country="USA"),
    }
    db.add_all(people.values())
    await db.flush()
    ids = {key: player.id for key, player in people.items()}
    tours = {
        "hard": Tournament(
            name="Hard Open",
            category="masters",
            surface="hard",
            best_of=3,
            start_date=day - timedelta(days=40),
            source="sackmann",
            source_ref="t-hard",
        ),
        "clay": Tournament(
            name="Clay Slam",
            category="grand_slam",
            surface="clay",
            best_of=5,
            start_date=day - timedelta(days=100),
            source="sackmann",
            source_ref="t-clay",
        ),
        "grass": Tournament(
            name="Grass Cup",
            category="500",
            surface="grass",
            best_of=3,
            start_date=day - timedelta(days=200),
            source="sackmann",
            source_ref="t-grass",
        ),
        "old": Tournament(
            name="Old Hard",
            category="250",
            surface="hard",
            best_of=3,
            start_date=day - timedelta(days=800),
            source="sackmann",
            source_ref="t-old",
        ),
    }
    db.add_all(tours.values())
    await db.flush()

    def match(
        key: str,
        tour: str,
        round_code: str,
        first: str,
        second: str,
        winner: str,
        score: str | None,
        days_ago: int,
        status: str = "finished",
    ) -> Match:
        return Match(
            tournament_id=tours[tour].id,
            round=round_code,
            player1_id=ids[first],
            player2_id=ids[second],
            winner_id=ids[winner],
            score=score,
            status=status,
            best_of=tours[tour].best_of,
            match_date=day - timedelta(days=days_ago),
            source="sackmann",
            source_ref=key,
        )

    rows = {
        "hard_r16": match("hard_r16", "hard", "R16", "sinner", "medvedev", "sinner", "6-4 6-4", 38),
        "hard_sf": match(
            "hard_sf", "hard", "SF", "sinner", "alcaraz", "sinner", "7-6(5) 3-6 6-3", 36
        ),
        "hard_f": match("hard_f", "hard", "F", "sinner", "alcaraz", "alcaraz", "6-3 6-2", 35),
        "clay_r32": match(
            "clay_r32", "clay", "R32", "medvedev", "sinner", "medvedev", "W/O", 98, "walkover"
        ),
        "clay_qf": match(
            "clay_qf",
            "clay",
            "QF",
            "sinner",
            "alcaraz",
            "sinner",
            "6-7(4) 6-4 6-4 3-6 7-5",
            95,
        ),
        "grass_sf": match(
            "grass_sf", "grass", "SF", "alcaraz", "medvedev", "alcaraz", "6-3 6-4", 199
        ),
        "old_f": match("old_f", "old", "F", "veteran", "alcaraz", "veteran", "6-4 6-4", 790),
    }
    db.add_all(rows.values())
    await db.flush()
    # Подача обоих игроков в матчах «Hard Open»: очки, первые, выигранные, эйсы, двойные,
    # брейкпоинты
    stats = {
        ("hard_r16", "sinner"): (60, 40, 32, 12, 8, 2, 3, 4),
        ("hard_r16", "medvedev"): (62, 38, 26, 10, 5, 3, 4, 7),
        ("hard_sf", "sinner"): (90, 60, 45, 18, 10, 4, 6, 8),
        ("hard_sf", "alcaraz"): (88, 55, 40, 17, 7, 2, 5, 8),
        ("hard_f", "sinner"): (55, 33, 20, 9, 3, 5, 2, 7),
        ("hard_f", "alcaraz"): (50, 35, 29, 10, 9, 1, 1, 1),
    }
    for (key, who), values in stats.items():
        svpt, first_in, first_won, second_won, aces, df, saved, faced = values
        db.add(
            MatchStat(
                match_id=rows[key].id,
                player_id=ids[who],
                serve_points=svpt,
                first_in=first_in,
                first_won=first_won,
                second_won=second_won,
                aces=aces,
                double_faults=df,
                bp_saved=saved,
                bp_faced=faced,
                source="sackmann",
            )
        )
    await db.commit()
    await rebuild_ratings(db_factory=factory)
    return PlayersWorld(
        sinner=ids["sinner"],
        alcaraz=ids["alcaraz"],
        medvedev=ids["medvedev"],
        veteran=ids["veteran"],
        nobody=ids["nobody"],
        matches={key: row.id for key, row in rows.items()},
        tournaments={key: row.id for key, row in tours.items()},
    )


async def add_news(
    db: AsyncSession,
    player_id: int,
    *,
    days_ago: float,
    kind: str = "injury",
    summary: str = "Новость",
    details: dict[str, object] | None = None,
) -> int:
    row = PlayerNews(
        player_id=player_id,
        published_at=datetime.now(UTC) - timedelta(days=days_ago),
        kind=kind,
        summary=summary,
        source_url=f"https://www.atptour.com/news/{player_id}-{days_ago}",
        source_name="atptour.com",
        details=details,
    )
    db.add(row)
    await db.commit()
    return row.id


async def add_profile(db: AsyncSession, player_id: int, *, source: str = "legacy_llm") -> None:
    db.add(
        PlayerProfile(
            player_id=player_id,
            profile={"01": {"стиль": "агрессивный с задней линии"}},
            source=source,
        )
    )
    await db.commit()


async def own_open_bet(
    db: AsyncSession, user_id: int, player1: int, player2: int, *, odds: str = "1.80"
) -> tuple[int, int, int]:
    """Своя открытая ставка на матч игроков сегодня (по поясу участника) и анализ с этим
    событием сегодня: → (id матча, id ставки, id анализа)."""
    user = await db.get_one(User, user_id)
    day = local_today(user_zone(user.tz))
    match = Match(
        player1_id=player1,
        player2_id=player2,
        match_date=day,
        source="user",
        source_ref=f"user:test:{user_id}:{player1}:{player2}",
    )
    db.add(match)
    await db.flush()
    analysis = Analysis(
        user_id=user_id,
        input_text="",
        input_kind="form",
        status="done",
        confirmed={
            "bank": None,
            "bookmaker": "Fonbet",
            "events": [
                {
                    "position": 1,
                    "player1_id": player1,
                    "player2_id": player2,
                    "match_id": match.id,
                    "tournament_id": None,
                    "tournament_name": "Мой турнир",
                    "surface": "hard",
                    "best_of": 3,
                    "round": "",
                    "odds": {},
                    "bookmaker": "Fonbet",
                    "line_no": None,
                }
            ],
        },
        decision="bet",
    )
    db.add(analysis)
    await db.flush()
    bet = Bet(
        user_id=user_id,
        analysis_id=analysis.id,
        placed_at=datetime.now(UTC),
        bookmaker="Fonbet",
        stake=Decimal("100"),
        currency="RUB",
        total_odds=Decimal(odds),
        status="open",
        source="app",
        source_ref=f"ref-{user_id}-{match.id}",
    )
    db.add(bet)
    await db.flush()
    db.add(
        BetLeg(bet_id=bet.id, match_id=match.id, market="ML", selection=1, odds_taken=Decimal(odds))
    )
    db.add_all(
        [
            BankrollLedger(
                user_id=user_id,
                at=datetime.now(UTC) - timedelta(minutes=5),
                kind="deposit",
                amount=Decimal("10000"),
                currency="RUB",
            ),
            BankrollLedger(
                user_id=user_id,
                at=datetime.now(UTC),
                kind="stake",
                amount=-Decimal("100"),
                currency="RUB",
                bet_id=bet.id,
            ),
        ]
    )
    await db.commit()
    return match.id, bet.id, analysis.id
