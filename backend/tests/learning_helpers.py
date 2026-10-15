"""Помощники тестов этапа 5, волна 2 (разборы и уроки): своя рассчитанная нога на матче и
маленький архив с известными признаками словаря (сеты за 48 часов, отдых, личные встречи,
кэф архива)."""

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import (
    Analysis,
    Bet,
    BetLeg,
    Match,
    OddsSnapshot,
    Player,
    Prediction,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ml.elo import rebuild_ratings


async def own_leg(
    db: AsyncSession,
    user_id: int,
    match: Match,
    *,
    selection: int = 1,
    market: str = "ML",
    result: str = "loss",
    p_final: float = 0.7,
    source: str = "app",
    placed_at: datetime | None = None,
    is_eval: bool = False,
    odds: str = "1.80",
) -> tuple[Bet, BetLeg, Prediction]:
    """Рассчитанная ставка-ординар участника на матч (без журнала банка: для разборов и
    уроков деньги не нужны). result — исход ноги: win, loss или void. commit."""
    when = placed_at or datetime.combine(
        match.match_date or date(2026, 1, 1), time(9, 0), tzinfo=UTC
    )
    analysis = Analysis(
        user_id=user_id, input_text="", input_kind="form", status="done", decision="bet"
    )
    db.add(analysis)
    await db.flush()
    prediction = Prediction(
        user_id=user_id,
        analysis_id=analysis.id,
        match_id=match.id,
        market=market,
        selection=selection,
        as_of=when,
        p_base=p_final - 0.02,
        p_claude=p_final + 0.01,
        p_final=p_final,
        q_market_at_pred=0.6,
        rationale="Преимущество в Эло на покрытии",
        is_eval=is_eval,
    )
    db.add(prediction)
    await db.flush()
    status = {"win": "won", "loss": "lost", "void": "void"}[result]
    stake = Decimal("100")
    profit = {"won": stake * Decimal(odds) - stake, "lost": -stake, "void": Decimal(0)}[status]
    bet = Bet(
        user_id=user_id,
        analysis_id=analysis.id,
        placed_at=when,
        bookmaker="Fonbet",
        stake=stake,
        currency="RUB",
        total_odds=Decimal(odds),
        status=status,
        profit=profit,
        settled_at=when + timedelta(days=1),
        settled_by="manual",
        source=source,
    )
    db.add(bet)
    await db.flush()
    leg = BetLeg(
        bet_id=bet.id,
        match_id=match.id,
        market=market,
        selection=selection,
        odds_taken=Decimal(odds),
        prediction_id=prediction.id,
        result=result,
        score="2:0" if result == "win" else "0:2",
        settled_at=when + timedelta(days=1),
        result_source="manual",
    )
    db.add(leg)
    await db.commit()
    return bet, leg, prediction


@dataclass
class MiniArchive:
    """Игроки a, b, c и матчи: m0 (D−10, B — C), m1 (D−2, A — B, 2 сета), m2 (D−1, A — C,
    3 сета), m3 (D, A — B, полуфинал на грунте, кэфы архива 1.40 / 3.00 у pinnacle)."""

    day: date
    a: int
    b: int
    c: int
    m0: Match
    m1: Match
    m2: Match
    m3: Match


async def mini_archive(
    db: AsyncSession, engine: AsyncEngine, *, day: date = date(2026, 5, 20)
) -> MiniArchive:
    a, b, c = Player(name="Arno Aalto"), Player(name="Boris Berg"), Player(name="Carl Crane")
    db.add_all([a, b, c])
    await db.flush()
    tour = Tournament(
        name="Mini Open",
        surface="clay",
        best_of=3,
        category="250",
        start_date=day - timedelta(days=12),
        source="sackmann",
        source_ref="mini-open",
    )
    db.add(tour)
    await db.flush()

    def match(
        key: str, days_before: int, first: Player, second: Player, score: str, rnd: str
    ) -> Match:
        return Match(
            tournament_id=tour.id,
            round=rnd,
            match_date=day - timedelta(days=days_before),
            player1_id=first.id,
            player2_id=second.id,
            winner_id=first.id,
            score=score,
            status="finished",
            best_of=3,
            source="sackmann",
            source_ref=f"mini-{key}",
        )

    m0 = match("0", 10, b, c, "6-2 6-2", "R32")
    m1 = match("1", 2, a, b, "6-3 6-3", "R16")
    m2 = match("2", 1, a, c, "6-4 6-7(5) 7-5", "QF")
    m3 = match("3", 0, a, b, "6-1 6-1", "SF")
    db.add_all([m0, m1, m2, m3])
    await db.flush()
    for bookmaker, pair in (("pinnacle", ("1.40", "3.00")), ("avg", ("1.35", "3.10"))):
        for selection, value in enumerate(pair, start=1):
            db.add(
                OddsSnapshot(
                    match_id=m3.id,
                    market="ML",
                    selection=selection,
                    bookmaker=bookmaker,
                    odds=Decimal(value),
                    kind="archive",
                    taken_at=datetime.combine(day, time(0), tzinfo=UTC),
                )
            )
    await db.commit()
    await rebuild_ratings(db_factory=create_sessionmaker(engine))
    return MiniArchive(day, a.id, b.id, c.id, m0, m1, m2, m3)


async def upset(db: AsyncSession, match: Match) -> Match:
    """Матч архива выиграл игрок 2 (аутсайдер мини-архива: рейтинги уже посчитаны по
    прежнему исходу). Счет архива — со стороны победителя, тот же. commit."""
    match.winner_id = match.player2_id
    await db.commit()
    return match
