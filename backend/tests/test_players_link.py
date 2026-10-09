"""Привязка матчей и игроков старого бота к архивам (app/ingest/players_link.py).

Данные — в формате импорта этапа 1 (app/ingest/legacy.py): игроки-заготовки
«Синнер» и «Медведев» (name = name_ru = псевдоним), турнир source = legacy, матч
source = legacy с source_ref «день:id1:id2», ставка с событием, прогноз и кэфы user.
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import (
    Analysis,
    Bet,
    BetLeg,
    IngestionRun,
    Match,
    OddsSnapshot,
    Player,
    PlayerProfile,
    Prediction,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ingest import players_link
from app.ingest.players_link import (
    NAME_THRESHOLD,
    link_legacy,
    name_score,
    ref_day,
    surname_forms,
    trigram_similarity,
)
from tests.helpers_admin import audit_entries
from tests.support import UserFactory

PLACED = datetime(2025, 1, 20, 9, tzinfo=UTC)


@dataclass
class World:
    legacy_sinner: int
    legacy_medvedev: int
    legacy_match: int
    legacy_tournament: int
    sinner: int
    medvedev: int
    archive_match: int
    other_match: int
    stray_match: int
    bet_leg: int
    prediction: int


async def _player(db: AsyncSession, name: str, **fields: object) -> int:
    player = Player(name=name, **fields)
    db.add(player)
    await db.flush()
    return player.id


async def _stub(db: AsyncSession, name: str) -> int:
    """Игрок, каким его создает импорт старого бота."""
    return await _player(db, name, name_ru=name, aliases=[name])


async def _legacy_match(
    db: AsyncSession, day: date, player1: int, player2: int, tournament_id: int | None
) -> int:
    match = Match(
        tournament_id=tournament_id,
        round="",
        player1_id=player1,
        player2_id=player2,
        status="scheduled",
        source="legacy",
        source_ref=f"{day.isoformat()}:{min(player1, player2)}:{max(player1, player2)}",
    )
    db.add(match)
    await db.flush()
    return match.id


async def _archive_match(
    db: AsyncSession,
    tournament_id: int,
    round_: str,
    player1: int,
    player2: int,
    match_date: date | None,
) -> int:
    match = Match(
        tournament_id=tournament_id,
        round=round_,
        player1_id=player1,
        player2_id=player2,
        winner_id=player1,
        status="finished",
        source="tennis_data" if match_date else "sackmann",
        source_ref=f"{tournament_id}-{round_}-{player1}-{player2}",
        match_date=match_date,
        score="6-4 6-4 6-4",
        best_of=5,
    )
    db.add(match)
    await db.flush()
    return match.id


@pytest.fixture
async def world(db: AsyncSession, make_user: UserFactory) -> World:
    user = await make_user()
    # Старый бот
    legacy_sinner = await _stub(db, "Синнер")
    legacy_medvedev = await _stub(db, "Медведев")
    ivanov = await _stub(db, "Иванов")
    petrov = await _stub(db, "Петров")
    legacy_ao = Tournament(
        name="Australian Open", surface="hard", start_date=date(2025, 1, 20), source="legacy"
    )
    legacy_other = Tournament(name="Турнир", start_date=date(2025, 3, 1), source="legacy")
    db.add_all([legacy_ao, legacy_other])
    await db.flush()
    legacy_match = await _legacy_match(
        db, date(2025, 1, 20), legacy_sinner, legacy_medvedev, legacy_ao.id
    )
    stray = await _legacy_match(db, date(2025, 3, 1), ivanov, petrov, legacy_other.id)
    analysis = Analysis(user_id=user.id, input_text="запись 1", status="done")
    db.add(analysis)
    await db.flush()
    bet = Bet(
        user_id=user.id,
        analysis_id=analysis.id,
        placed_at=PLACED,
        bookmaker="fonbet",
        stake=Decimal("1000"),
        currency="RUB",
        total_odds=Decimal("1.25"),
        status="won",
        profit=Decimal("250"),
        source="legacy",
        source_ref="1",
    )
    db.add(bet)
    await db.flush()
    prediction = Prediction(
        user_id=user.id,
        analysis_id=analysis.id,
        match_id=legacy_match,
        market="ML",
        selection=1,
        as_of=PLACED,
        llm_model="legacy",
        p_claude=0.8,
    )
    db.add(prediction)
    await db.flush()
    leg = BetLeg(
        bet_id=bet.id,
        match_id=legacy_match,
        market="ML",
        selection=1,
        odds_taken=Decimal("1.25"),
        prediction_id=prediction.id,
        result="win",
    )
    db.add(leg)
    for selection, odds in ((1, "1.25"), (2, "4.00")):
        db.add(
            OddsSnapshot(
                match_id=legacy_match,
                market="ML",
                selection=selection,
                bookmaker="fonbet",
                odds=Decimal(odds),
                kind="user",
                taken_at=PLACED,
            )
        )
    # Архив: тот же матч с обратным порядком игроков и соседние матчи
    sinner = await _player(db, "Jannik Sinner", sackmann_id=206173, country="ITA")
    medvedev = await _player(db, "Daniil Medvedev", sackmann_id=106421)
    alcaraz = await _player(db, "Carlos Alcaraz", sackmann_id=207989)
    djokovic = await _player(db, "Novak Djokovic", sackmann_id=104925)
    ao = Tournament(
        name="Australian Open",
        surface="hard",
        start_date=date(2025, 1, 12),
        source="sackmann",
        source_ref="2025-580",
    )
    db.add(ao)
    await db.flush()
    archive_match = await _archive_match(db, ao.id, "QF", medvedev, sinner, date(2025, 1, 21))
    other = await _archive_match(db, ao.id, "QF", alcaraz, djokovic, date(2025, 1, 21))
    for selection, odds in ((1, "3.60"), (2, "1.30")):
        db.add(
            OddsSnapshot(
                match_id=archive_match,
                market="ML",
                selection=selection,
                bookmaker="pinnacle",
                odds=Decimal(odds),
                kind="archive",
                taken_at=datetime(2025, 1, 21, tzinfo=UTC),
            )
        )
    await db.commit()
    return World(
        legacy_sinner=legacy_sinner,
        legacy_medvedev=legacy_medvedev,
        legacy_match=legacy_match,
        legacy_tournament=legacy_ao.id,
        sinner=sinner,
        medvedev=medvedev,
        archive_match=archive_match,
        other_match=other,
        stray_match=stray,
        bet_leg=leg.id,
        prediction=prediction.id,
    )


def test_ref_day() -> None:
    assert ref_day("2025-01-20:12:34") == date(2025, 1, 20)
    assert ref_day("2025-02-30:1:2") is None
    assert ref_day("12") is None
    assert ref_day(None) is None


async def _snapshot(db: AsyncSession) -> dict[str, object]:
    db.expire_all()
    return {
        "players": sorted((await db.execute(select(Player.id, Player.name, Player.name_ru))).all()),
        "matches": sorted((await db.execute(select(Match.id, Match.source))).all()),
        "tournaments": sorted((await db.execute(select(Tournament.id))).all()),
        "legs": sorted(
            (await db.execute(select(BetLeg.id, BetLeg.match_id, BetLeg.selection))).all()
        ),
        "odds": sorted(
            (
                await db.execute(
                    select(OddsSnapshot.id, OddsSnapshot.match_id, OddsSnapshot.selection)
                )
            ).all()
        ),
        "runs": await db.scalar(select(func.count()).select_from(IngestionRun)),
    }


async def test_dry_run_reports_and_changes_nothing(
    db: AsyncSession, engine: AsyncEngine, world: World
) -> None:
    before = await _snapshot(db)
    report = await link_legacy(dry_run=True, db_factory=create_sessionmaker(engine))
    assert report.rows_read == 2
    assert report.counts["linked.matches"] == 1
    assert report.counts["merged.players"] == 2
    assert report.counts["deleted.tournaments"] == 1
    assert report.freshness == {"legacy_matches_left": 1}
    assert await _snapshot(db) == before


async def test_link_legacy_end_to_end(db: AsyncSession, engine: AsyncEngine, world: World) -> None:
    factory = create_sessionmaker(engine)
    report = await link_legacy(db_factory=factory)
    db.expire_all()

    assert report.rows_read == 2
    assert report.updated == 3
    assert report.counts["linked.matches"] == 1
    assert report.counts["merged.players"] == 2
    assert report.counts["deleted.tournaments"] == 1
    assert report.counts["unmatched.legacy_match_not_found"] == 1
    [row] = report.unmatched
    assert row["kind"] == "legacy_match_not_found"
    assert row["match_id"] == world.stray_match and row["candidates"] == 0
    assert len(report.warnings) == 2 and "Jannik Sinner" in " ".join(report.warnings)

    # Ставка, прогноз и кэфы — на матче архива, сторона перевернута (Синнер там второй)
    leg = await db.get(BetLeg, world.bet_leg)
    assert leg is not None and (leg.match_id, leg.selection) == (world.archive_match, 2)
    prediction = await db.get(Prediction, world.prediction)
    assert prediction is not None
    assert (prediction.match_id, prediction.selection) == (world.archive_match, 2)
    odds = await db.execute(
        select(OddsSnapshot.bookmaker, OddsSnapshot.kind, OddsSnapshot.selection, OddsSnapshot.odds)
        .where(OddsSnapshot.match_id == world.archive_match)
        .order_by(OddsSnapshot.bookmaker, OddsSnapshot.selection)
    )
    assert odds.all() == [
        ("fonbet", "user", 1, Decimal("4.000")),
        ("fonbet", "user", 2, Decimal("1.250")),
        ("pinnacle", "archive", 1, Decimal("3.600")),
        ("pinnacle", "archive", 2, Decimal("1.300")),
    ]
    # Матч архива не тронут, матч и турнир старого бота удалены
    match = await db.get(Match, world.archive_match)
    assert match is not None
    assert (match.player1_id, match.player2_id, match.round) == (world.medvedev, world.sinner, "QF")
    assert await db.get(Match, world.legacy_match) is None
    assert await db.get(Tournament, world.legacy_tournament) is None
    assert await db.get(Match, world.stray_match) is not None
    # Заготовки слиты в игроков архива, их имена — у игроков архива
    assert await db.get(Player, world.legacy_sinner) is None
    assert await db.get(Player, world.legacy_medvedev) is None
    sinner = await db.get(Player, world.sinner)
    medvedev = await db.get(Player, world.medvedev)
    assert sinner is not None and medvedev is not None
    assert (sinner.name, sinner.name_ru, sinner.sackmann_id) == ("Jannik Sinner", "Синнер", 206173)
    assert medvedev.name_ru == "Медведев"

    # Журнал загрузок есть, журнала администратора нет
    run = await db.scalar(select(IngestionRun).where(IngestionRun.source == "players_link"))
    assert run is not None and run.status == "ok" and run.rows == 3
    assert run.details["counts"]["linked.matches"] == 1
    assert run.details["unmatched"][0]["kind"] == "legacy_match_not_found"
    assert await audit_entries(db) == []

    # Повторный запуск ничего не меняет
    again = await link_legacy(db_factory=factory)
    assert again.rows_read == 1 and again.updated == 0
    assert again.counts["unmatched.legacy_match_not_found"] == 1


async def test_link_legacy_skips_ambiguous_and_kept_players(
    db: AsyncSession, engine: AsyncEngine, world: World
) -> None:
    # Та же пара в том же окне еще раз (например, круговой этап и финал): не угадываем
    ao = await db.scalar(select(Tournament.id).where(Tournament.source_ref == "2025-580"))
    assert ao is not None
    await _archive_match(db, ao, "F", world.sinner, world.medvedev, date(2025, 1, 22))
    await db.commit()
    report = await link_legacy(db_factory=create_sessionmaker(engine))
    assert report.counts["linked.matches"] == 0
    assert report.counts["unmatched.legacy_match_ambiguous"] == 1
    ambiguous = next(row for row in report.unmatched if row["kind"] == "legacy_match_ambiguous")
    assert len(ambiguous["archive_matches"]) == 2
    db.expire_all()
    assert await db.get(Match, world.legacy_match) is not None
    assert await db.get(Player, world.legacy_sinner) is not None


async def test_link_legacy_does_not_merge_real_players(
    db: AsyncSession, engine: AsyncEngine, world: World
) -> None:
    """Игрок старого бота с матчами архива — не заготовка: матч привязывается, а игрок
    остается и попадает в отчет."""
    tennis_data = await db.scalar(select(Tournament.id).where(Tournament.source_ref == "2025-580"))
    assert tennis_data is not None
    rival = await _player(db, "Some Rival")
    await _archive_match(db, tennis_data, "R128", world.legacy_sinner, rival, date(2025, 1, 13))
    await db.commit()
    report = await link_legacy(db_factory=create_sessionmaker(engine))
    assert report.counts["linked.matches"] == 1
    assert report.counts["merged.players"] == 1
    [kept] = [row for row in report.unmatched if row["kind"] == "legacy_player_kept"]
    assert kept["player_id"] == world.legacy_sinner and kept["archive_player_id"] == world.sinner
    db.expire_all()
    assert await db.get(Player, world.legacy_sinner) is not None


async def test_link_without_legacy_matches(db: AsyncSession, engine: AsyncEngine) -> None:
    db.add(Tournament(name="Пустой", source="legacy"))
    await db.commit()
    report = await link_legacy(db_factory=create_sessionmaker(engine))
    assert report.rows_read == 0 and report.counts["deleted.tournaments"] == 1
    assert players_link.SOURCE == "players_link"


# --- сходство фамилий ---


def test_surname_forms() -> None:
    assert surname_forms("Juan Martin del Potro", given_first=True) == {
        "martin del potro",
        "martindelpotro",
        "del potro",
        "delpotro",
        "potro",
    }
    # Имя игрока архива в формы не входит, у «Фамилия И.» — только фамилия
    assert surname_forms("Tim van Rijthoven", given_first=True) == {
        "van rijthoven",
        "vanrijthoven",
        "rijthoven",
    }
    assert surname_forms("Sinner J.", given_first=True) == {"sinner"}
    assert surname_forms("J. Sinner", given_first=True) == {"sinner"}
    assert surname_forms("Медведев Д.", given_first=False) == {"медведев"}
    assert surname_forms("Дель Потро", given_first=False) == {"дель потро", "дельпотро", "потро"}


async def test_trigram_similarity_as_pg_trgm(db: AsyncSession) -> None:
    pairs = [
        ("sinner", "jannik sinner"),
        ("oje aliassim", "auger aliassime"),
        ("pol", "popyrin"),
        ("del potro", "potro"),
        ("medvedev", "medvedev"),
        ("abc", ""),
    ]
    for first, second in pairs:
        expected = await db.scalar(
            text("SELECT similarity(:first, :second)"), {"first": first, "second": second}
        )
        assert trigram_similarity(first, second) == pytest.approx(expected, abs=1e-6)


@pytest.mark.parametrize(
    ("legacy", "archive"),
    [
        ("Синнер", "Jannik Sinner"),
        ("Синнер Я.", "Sinner J."),
        ("Медведев Д.", "Daniil Medvedev"),
        ("Оже-Альяссим", "Felix Auger-Aliassime"),
        ("Дель Потро", "Juan Martin del Potro"),
        ("Хуркач", "Hubert Hurkacz"),
        ("Рууд", "Casper Ruud"),
        ("Фриц", "Taylor Fritz"),
    ],
)
def test_name_score_same_player(legacy: str, archive: str) -> None:
    assert name_score([legacy], [archive]) >= NAME_THRESHOLD


@pytest.mark.parametrize(
    ("legacy", "archive"),
    [
        # Общее начало и совпадение с именем, а не с фамилией
        ("Пол", "Alexei Popyrin"),
        ("Пол", "Lucas Pouille"),
        ("Тим", "Tim van Rijthoven"),
        ("Тим", "Timofey Skatov"),
        ("Иванов", "Ivan Dodig"),
        ("Кин", "Marin Cilic"),
        ("Сок", "Lorenzo Sonego"),
        ("Кирьос", "Zsombor Piros"),
        ("Чорич", "Federico Coria"),
        ("Сафиуллин", "Marat Safin"),
        # Короткая фамилия без полного совпадения не засчитывается, даже настоящая
        ("Пол", "Tommy Paul"),
        ("Фис", "Arthur Fils"),
    ],
)
def test_name_score_other_player(legacy: str, archive: str) -> None:
    assert name_score([legacy], [archive]) < NAME_THRESHOLD


# --- сходство в привязке ---


async def test_link_ignores_short_name_of_other_player(
    db: AsyncSession, engine: AsyncEngine, make_user: UserFactory
) -> None:
    """Ставка на «Пола» в матче с «Фисом»: Фис в соседний день играл с Попыриным, у
    которого с «Пол» общее начало. Матч не привязывается к чужому, а идет в отчет."""
    user = await make_user()
    paul_stub = await _stub(db, "Пол")
    fils_stub = await _stub(db, "Фис")
    legacy_ao = Tournament(name="AO", start_date=date(2025, 1, 20), source="legacy")
    db.add(legacy_ao)
    await db.flush()
    legacy_match = await _legacy_match(db, date(2025, 1, 20), paul_stub, fils_stub, legacy_ao.id)
    bet = Bet(
        user_id=user.id,
        placed_at=PLACED,
        bookmaker="fonbet",
        stake=Decimal("100"),
        currency="RUB",
        total_odds=Decimal("1.80"),
        source="legacy",
        source_ref="1",
    )
    db.add(bet)
    await db.flush()
    leg = BetLeg(
        bet_id=bet.id,
        match_id=legacy_match,
        market="ML",
        selection=1,
        odds_taken=Decimal("1.80"),
    )
    db.add(leg)
    await db.flush()
    leg_id = leg.id
    paul = await _player(db, "Tommy Paul", sackmann_id=1)
    fils = await _player(db, "Arthur Fils", sackmann_id=2)
    popyrin = await _player(db, "Alexei Popyrin", sackmann_id=3)
    ao = Tournament(name="AO", start_date=date(2025, 1, 12), source="sackmann", source_ref="ao")
    db.add(ao)
    await db.flush()
    await _archive_match(db, ao.id, "R32", fils, paul, date(2025, 1, 20))
    await _archive_match(db, ao.id, "R16", popyrin, fils, date(2025, 1, 22))
    await db.commit()

    report = await link_legacy(db_factory=create_sessionmaker(engine))
    assert report.counts["linked.matches"] == 0
    assert report.counts["merged.players"] == 0
    [row] = report.unmatched
    assert (row["kind"], row["match_id"], row["candidates"]) == (
        "legacy_match_not_found",
        legacy_match,
        2,
    )
    db.expire_all()
    moved = await db.get(BetLeg, leg_id)
    assert moved is not None and (moved.match_id, moved.selection) == (legacy_match, 1)
    found = await db.get(Player, popyrin)
    assert found is not None and (found.name_ru, found.aliases) == (None, [])
    assert await db.get(Player, paul_stub) is not None


async def test_link_needs_clear_leader_when_partner_played_twice(
    db: AsyncSession, engine: AsyncEngine
) -> None:
    """Соперник по ставке играл в окне два матча: второй игрок должен явно выделяться.
    «Синнер» (1,0 против 0) выделяется, «Оже-Альяссим» (0,73) — нет: неоднозначно."""
    auger_stub = await _stub(db, "Оже-Альяссим")
    medvedev_stub = await _stub(db, "Медведев")
    sinner_stub = await _stub(db, "Синнер")
    rublev_stub = await _stub(db, "Рублев")
    legacy_tour = Tournament(name="Турнир", start_date=date(2025, 1, 20), source="legacy")
    db.add(legacy_tour)
    await db.flush()
    weak = await _legacy_match(db, date(2025, 1, 20), auger_stub, medvedev_stub, legacy_tour.id)
    strong = await _legacy_match(db, date(2025, 3, 10), sinner_stub, rublev_stub, legacy_tour.id)
    auger = await _player(db, "Felix Auger-Aliassime", sackmann_id=1)
    medvedev = await _player(db, "Daniil Medvedev", sackmann_id=2)
    sinner = await _player(db, "Jannik Sinner", sackmann_id=3)
    rublev = await _player(db, "Andrey Rublev", sackmann_id=4)
    popyrin = await _player(db, "Alexei Popyrin", sackmann_id=5)
    tour = Tournament(name="Tour", start_date=date(2025, 1, 1), source="sackmann", source_ref="t")
    db.add(tour)
    await db.flush()
    first = await _archive_match(db, tour.id, "R32", medvedev, auger, date(2025, 1, 20))
    second = await _archive_match(db, tour.id, "R16", medvedev, popyrin, date(2025, 1, 22))
    linked = await _archive_match(db, tour.id, "QF", rublev, sinner, date(2025, 3, 10))
    await _archive_match(db, tour.id, "SF", rublev, popyrin, date(2025, 3, 11))
    await db.commit()
    assert name_score(["Оже-Альяссим"], ["Felix Auger-Aliassime"]) == pytest.approx(0.73, abs=0.01)

    report = await link_legacy(db_factory=create_sessionmaker(engine))
    assert report.counts["linked.matches"] == 1
    [row] = report.unmatched
    assert row["kind"] == "legacy_match_ambiguous" and row["match_id"] == weak
    assert row["archive_matches"] == sorted([first, second])
    db.expire_all()
    assert await db.get(Match, weak) is not None
    assert await db.get(Match, strong) is None
    found = await db.get(Player, sinner)
    assert found is not None and found.name_ru == "Синнер"
    assert linked in set(await db.scalars(select(Match.id)))


# --- профили заготовок ---


async def test_link_keeps_both_profiles(db: AsyncSession, engine: AsyncEngine) -> None:
    """Две заготовки одного игрока с профилями: первая сливается (профиль переходит к
    игроку архива), матч второй не привязывается, ее профиль цел. Строка в отчете
    повторяется в каждом запуске, пока человек не решит сам."""
    first_stub = await _stub(db, "Синнер")
    second_stub = await _stub(db, "Янник Синнер")
    medvedev_stub = await _stub(db, "Медведев")
    alcaraz_stub = await _stub(db, "Алькарас")
    db.add_all(
        [
            PlayerProfile(player_id=first_stub, profile={"01": "first"}, source="legacy_llm"),
            PlayerProfile(player_id=second_stub, profile={"01": "second"}, source="legacy_llm"),
        ]
    )
    legacy_ao = Tournament(name="AO", start_date=date(2025, 1, 15), source="legacy")
    db.add(legacy_ao)
    await db.flush()
    linked = await _legacy_match(db, date(2025, 1, 20), first_stub, medvedev_stub, legacy_ao.id)
    kept = await _legacy_match(db, date(2025, 1, 24), second_stub, alcaraz_stub, legacy_ao.id)
    sinner = await _player(db, "Jannik Sinner", sackmann_id=1)
    medvedev = await _player(db, "Daniil Medvedev", sackmann_id=2)
    alcaraz = await _player(db, "Carlos Alcaraz", sackmann_id=3)
    ao = Tournament(name="AO", start_date=date(2025, 1, 12), source="sackmann", source_ref="ao")
    db.add(ao)
    await db.flush()
    await _archive_match(db, ao.id, "QF", sinner, medvedev, date(2025, 1, 21))
    await _archive_match(db, ao.id, "F", sinner, alcaraz, date(2025, 1, 25))
    await db.commit()

    factory = create_sessionmaker(engine)
    for _ in range(2):
        report = await link_legacy(db_factory=factory)
        [row] = report.unmatched
        assert row == {
            "kind": "legacy_player_profile_conflict",
            "player_id": second_stub,
            "name": "Янник Синнер",
            "archive_player_id": sinner,
            "archive_name": "Jannik Sinner",
            "match_ids": [kept],
        }
    db.expire_all()
    profiles = await db.execute(
        select(PlayerProfile.player_id, PlayerProfile.profile).order_by(PlayerProfile.player_id)
    )
    assert profiles.all() == [(second_stub, {"01": "second"}), (sinner, {"01": "first"})]
    assert await db.get(Match, linked) is None
    assert await db.get(Match, kept) is not None
    assert await db.get(Player, first_stub) is None
    # Матч второй заготовки не привязан: ее соперник тоже остается заготовкой
    assert await db.get(Player, second_stub) is not None
    assert await db.get(Player, alcaraz_stub) is not None
