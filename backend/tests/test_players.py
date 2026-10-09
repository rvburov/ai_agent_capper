"""Игроки: поиск по имени, слияние игроков и матчей, правка (app/services/players.py)."""

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import has_key
from app.db.base import Base
from app.db.models import (
    Analysis,
    Bet,
    BetLeg,
    Dossier,
    IngestionRun,
    Match,
    MatchStat,
    OddsSnapshot,
    Player,
    PlayerNews,
    PlayerProfile,
    PlayerRating,
    Prediction,
    Tournament,
)
from app.services import players
from app.services.players import PlayerError, query_variants, skeletons
from tests.helpers_admin import audit_entries
from tests.support import UserFactory

NOW = datetime(2025, 1, 20, 12, tzinfo=UTC)


async def make_player(db: AsyncSession, name: str, **fields: Any) -> Player:
    player = Player(name=name, **fields)
    db.add(player)
    await db.flush()
    return player


async def make_tournament(db: AsyncSession, name: str = "Australian Open", **fields: Any) -> int:
    fields.setdefault("source", "sackmann")
    fields.setdefault("source_ref", f"2025-{name}")
    fields.setdefault("start_date", date(2025, 1, 12))
    tournament = Tournament(name=name, **fields)
    db.add(tournament)
    await db.flush()
    return tournament.id


async def make_match(
    db: AsyncSession,
    player1: Player,
    player2: Player,
    *,
    tournament_id: int | None,
    round_: str = "R32",
    source: str = "sackmann",
    **fields: Any,
) -> Match:
    match = Match(
        tournament_id=tournament_id,
        round=round_,
        player1_id=player1.id,
        player2_id=player2.id,
        winner_id=fields.pop("winner_id", player1.id),
        status=fields.pop("status", "finished"),
        source=source,
        source_ref=fields.pop("source_ref", f"{source}-{player1.id}-{player2.id}-{round_}"),
        **fields,
    )
    db.add(match)
    await db.flush()
    return match


async def fresh(db: AsyncSession, model: type[Any], ident: Any) -> Any:
    return await db.get(model, ident, populate_existing=True)


async def count_refs(
    db: AsyncSession, table_name: str, columns: tuple[str, ...], ident: int
) -> int:
    table = Base.metadata.tables[table_name]
    query = select(func.count()).select_from(table)
    query = query.where(or_(*(table.c[name] == ident for name in columns)))
    return int(await db.scalar(query) or 0)


# --- поиск ---


@pytest.fixture
async def roster(db: AsyncSession) -> dict[str, Player]:
    names = {
        "sinner": "Jannik Sinner",
        "medvedev": "Daniil Medvedev",
        "alcaraz": "Carlos Alcaraz",
        "faa": "Felix Auger-Aliassime",
        "delpo": "Juan Martin del Potro",
        "djokovic": "Novak Djokovic",
        "rublev": "Andrey Rublev",
        "zverev": "Alexander Zverev",
        "mischa": "Mischa Zverev",
        "khachanov": "Karen Khachanov",
        "sonego": "Lorenzo Sonego",
        "deminaur": "Alex de Minaur",
        "fokina": "Alejandro Davidovich Fokina",
        "alexandrova": "Ekaterina Alexandrova",
        "cilic": "Marin Cilic",
        "cobolli": "Flavio Cobolli",
        "wawrinka": "Stan Wawrinka",
        "baez": "Sebastian Baez",
    }
    made = {key: await make_player(db, name) for key, name in names.items()}
    made["tennis_data"] = await make_player(db, "C. Ruud", aliases=["Ruud C.", "Ruud Casper"])
    await db.commit()
    return made


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("Синнер", "sinner"),
        ("медведев", "medvedev"),
        ("Alcarz", "alcaraz"),
        ("Оже-Альяссим", "faa"),
        ("Del Potro", "delpo"),
        ("Джокович", "djokovic"),
        ("Хачанов", "khachanov"),
        ("Цилич", "cilic"),
        ("Алькарас", "alcaraz"),
        ("Кобболи", "cobolli"),
        ("Вавринка", "wawrinka"),
        ("Баэс", "baez"),
        ("Рубл\u0451в", "rublev"),
        ("  sinner  ", "sinner"),
        ("Ruud C.", "tennis_data"),
    ],
)
async def test_search_examples(
    db: AsyncSession, roster: dict[str, Player], query: str, expected: str
) -> None:
    hits = await players.search_players(db, query)
    assert hits, query
    assert hits[0].player.id == roster[expected].id, [(h.player.name, h.score) for h in hits]
    assert 0 < hits[0].score <= 1


async def test_search_reports_matched_field_and_counts(
    db: AsyncSession, roster: dict[str, Player]
) -> None:
    stub = await make_player(db, "Медведев Д.", name_ru="Медведев Д.", aliases=["Медведев Д."])
    tournament = await make_tournament(db)
    await make_match(db, roster["medvedev"], roster["sinner"], tournament_id=tournament)
    await db.commit()
    hits = await players.search_players(db, "Медведев")
    # Заготовка старого бота совпала по имени как есть, игрок архива — транслитерацией;
    # оба с оценкой 1, заготовка выше: ее имя совпало целиком
    assert [(hit.player.id, hit.score, hit.matched) for hit in hits[:2]] == [
        (stub.id, 1.0, "name"),
        (roster["medvedev"].id, 1.0, "name"),
    ]
    assert [hit.matches for hit in hits[:2]] == [0, 1]
    # Псевдоним
    [hit, *_] = await players.search_players(db, "Casper")
    assert hit.matched == "alias: Ruud Casper"
    # Однофамильцы: оба в выдаче, с равной оценкой по фамилии
    zverevs = {hit.player.name for hit in await players.search_players(db, "Зверев")}
    assert {"Alexander Zverev", "Mischa Zverev"} <= zverevs


async def test_search_limit_and_variants(db: AsyncSession, roster: dict[str, Player]) -> None:
    assert len(await players.search_players(db, "a", limit=3)) <= 3
    assert len(await players.search_players(db, "Alex", limit=500)) <= players.SEARCH_LIMIT_MAX
    assert query_variants("Оже-Альяссим") == [
        "оже альяссим",
        "оже-альяссим",
        "ozhe alyassim",
        "oje aliassim",
    ]
    assert query_variants("Рубл\u0451в")[0] == "рублев"
    assert query_variants("Félix") == ["felix", "félix"]
    assert skeletons(["alkaras", "алькарас", "alcaraz", "wawrinka"]) == ["alkaras", "vavrinka"]


@pytest.mark.parametrize(
    ("query", "key"),
    [
        ("", "players.errors.query_empty"),
        ("   ", "players.errors.query_empty"),
        ("...", "players.errors.query_empty"),
        ("a" * 101, "players.errors.query_too_long"),
    ],
)
async def test_search_rejects_bad_query(db: AsyncSession, query: str, key: str) -> None:
    with pytest.raises(PlayerError) as caught:
        await players.search_players(db, query)
    assert caught.value.code == key
    assert caught.value.message != key and has_key(key)


# --- слияние игроков ---

EXPECTED_PLAYER_REFS = {
    "matches": ("player1_id", "player2_id", "winner_id"),
    "match_stats": ("player_id",),
    "player_news": ("player_id",),
    "player_profiles": ("player_id",),
    "player_ratings": ("player_id",),
}


def test_player_references_come_from_metadata() -> None:
    """Каждая ссылка на players.id учтена: новая таблица уронит этот тест, и ее нужно
    добавить в сценарий test_merge_players_moves_every_reference."""
    assert players.references_to("players") == EXPECTED_PLAYER_REFS


async def test_merge_players_moves_every_reference(db: AsyncSession) -> None:
    source = await make_player(
        db,
        "Синнер",
        name_ru="Синнер",
        aliases=["Синнер", "Синнер Я."],
        country="ITA",
        hand="R",
    )
    target = await make_player(
        db, "Jannik Sinner", sackmann_id=206173, birth_date=date(2001, 8, 16), aliases=[]
    )
    rival = await make_player(db, "Daniil Medvedev")
    other = await make_player(db, "Carlos Alcaraz")
    tournament = await make_tournament(db)
    won = await make_match(db, source, rival, tournament_id=tournament, round_="R32")
    lost = await make_match(db, other, source, tournament_id=tournament, round_="QF")
    kept = await make_match(db, target, rival, tournament_id=tournament, round_="SF")
    db.add_all(
        [
            MatchStat(match_id=won.id, player_id=source.id, aces=5, source="sackmann"),
            MatchStat(match_id=won.id, player_id=rival.id, aces=3, source="sackmann"),
            PlayerNews(
                player_id=source.id,
                published_at=NOW,
                kind="injury",
                summary="a",
                source_url="https://news.example/1",
            ),
            PlayerNews(
                player_id=source.id,
                published_at=NOW,
                kind="other",
                summary="b",
                source_url="https://news.example/2",
            ),
            PlayerNews(
                player_id=target.id,
                published_at=NOW,
                kind="injury",
                summary="a",
                source_url="https://news.example/1",
            ),
            PlayerProfile(player_id=source.id, profile={"01": "style"}, source="legacy_llm"),
            PlayerRating(player_id=source.id, surface="all", as_of=date(2025, 1, 1), elo=1700),
            PlayerRating(player_id=source.id, surface="hard", as_of=date(2025, 1, 1), elo=1710),
            PlayerRating(player_id=target.id, surface="all", as_of=date(2025, 1, 1), elo=2100),
        ]
    )
    await db.commit()
    source_id, target_id = source.id, target.id

    report = await players.merge_players(
        db, source_id=source_id, target_id=target_id, actor_id=None
    )

    assert report.moved == {
        "matches.player1_id": 1,
        "matches.player2_id": 1,
        "matches.winner_id": 1,
        "match_stats.player_id": 1,
        "player_news.player_id": 1,
        "player_profiles.player_id": 1,
    }
    assert report.removed == {"player_news": 1, "player_ratings": 2}
    assert report.filled == ["hand", "country", "name_ru"]
    assert report.aliases_added == ["Синнер Я."]
    assert not report.profile_kept_target
    # Ни одной ссылки на источник не осталось ни в одной таблице
    for table_name, columns in players.references_to("players").items():
        assert await count_refs(db, table_name, columns, source_id) == 0, table_name
    assert await fresh(db, Player, source_id) is None
    merged = await fresh(db, Player, target_id)
    assert merged.name == "Jannik Sinner" and merged.name_ru == "Синнер"
    assert merged.sackmann_id == 206173 and merged.birth_date == date(2001, 8, 16)
    assert (merged.country, merged.hand) == ("ITA", "R")
    assert merged.aliases == ["Синнер Я."]
    for match_id, pair in ((won.id, (target_id, rival.id)), (lost.id, (other.id, target_id))):
        match = await fresh(db, Match, match_id)
        assert (match.player1_id, match.player2_id) == pair
        assert match.winner_id == pair[0]
    assert (await fresh(db, Match, kept.id)).player1_id == target_id
    assert (await fresh(db, PlayerProfile, target_id)).profile == {"01": "style"}
    ratings = await db.scalars(select(PlayerRating.elo).where(PlayerRating.player_id == target_id))
    assert list(ratings) == [2100]

    [entry] = await audit_entries(db, "player_merge")
    assert entry.actor_id is None and entry.details["source"] == "terminal"
    assert entry.details["source_id"] == source_id and entry.details["target_id"] == target_id
    assert entry.details["source_name"] == "Синнер"
    assert entry.details["moved"]["matches.player1_id"] == 1


async def test_merge_players_takes_sackmann_id_and_keeps_target_profile(
    db: AsyncSession, make_user: UserFactory
) -> None:
    admin = await make_user(role="admin")
    source = await make_player(db, "J. Sinner", sackmann_id=206173, aliases=["Sinner J."])
    target = await make_player(db, "Синнер", name_ru="Sinner J.")
    db.add_all(
        [
            PlayerProfile(player_id=source.id, profile={"a": 1}, source="llm"),
            PlayerProfile(player_id=target.id, profile={"b": 2}, source="manual"),
        ]
    )
    await db.commit()
    report = await players.merge_players(
        db, source_id=source.id, target_id=target.id, actor_id=admin.id
    )
    assert report.filled == ["sackmann_id"]
    assert report.profile_kept_target and report.removed == {"player_profiles": 1}
    # «Sinner J.» уже есть у цели (name_ru), повторно в псевдонимы не идет
    assert report.aliases_added == ["J. Sinner"]
    merged = await fresh(db, Player, target.id)
    assert merged.sackmann_id == 206173
    assert (await fresh(db, PlayerProfile, target.id)).profile == {"b": 2}
    [entry] = await audit_entries(db, "player_merge")
    assert entry.actor_id == admin.id and "source" not in entry.details


async def _assert_nothing_merged(db: AsyncSession, *ids: int) -> None:
    for ident in ids:
        assert await fresh(db, Player, ident) is not None
    assert await audit_entries(db, "player_merge") == []


async def test_merge_players_refuses_players_of_one_match(db: AsyncSession) -> None:
    source = await make_player(db, "Синнер")
    target = await make_player(db, "Jannik Sinner")
    tournament = await make_tournament(db)
    match = await make_match(db, target, source, tournament_id=tournament)
    await db.commit()
    source_id, target_id, match_id = source.id, target.id, match.id
    with pytest.raises(PlayerError) as caught:
        await players.merge_players(db, source_id=source_id, target_id=target_id, actor_id=None)
    assert caught.value.code == "players.errors.merge_played_each_other"
    assert str(match_id) in caught.value.message
    await _assert_nothing_merged(db, source_id, target_id)


async def test_merge_players_refuses_duplicate_match(db: AsyncSession) -> None:
    source = await make_player(db, "Синнер")
    target = await make_player(db, "Jannik Sinner")
    rival = await make_player(db, "Daniil Medvedev")
    tournament = await make_tournament(db)
    first = await make_match(db, source, rival, tournament_id=tournament, round_="F")
    second = await make_match(db, target, rival, tournament_id=tournament, round_="F")
    await db.commit()
    source_id, target_id, first_id, second_id = source.id, target.id, first.id, second.id
    with pytest.raises(PlayerError) as caught:
        await players.merge_players(db, source_id=source_id, target_id=target_id, actor_id=None)
    assert caught.value.code == "players.errors.merge_duplicate_match"
    assert f"{first_id}/{second_id}" in caught.value.message
    await _assert_nothing_merged(db, source_id, target_id)
    assert (await fresh(db, Match, first_id)).player1_id == source_id


async def test_merge_players_other_errors(db: AsyncSession) -> None:
    first = await make_player(db, "Jannik Sinner", sackmann_id=1)
    second = await make_player(db, "J. Sinner", sackmann_id=2)
    await db.commit()
    first_id, second_id = first.id, second.id
    cases = [
        (first_id, first_id, "players.errors.merge_same"),
        (first_id, 999_999, "players.errors.not_found"),
        (999_999, first_id, "players.errors.not_found"),
        (second_id, first_id, "players.errors.merge_both_sackmann"),
    ]
    for source_id, target_id, key in cases:
        with pytest.raises(PlayerError) as caught:
            await players.merge_players(db, source_id=source_id, target_id=target_id, actor_id=None)
        assert caught.value.code == key
    await _assert_nothing_merged(db, first_id, second_id)


async def test_merge_without_commit_rolls_back_only_itself(db: AsyncSession) -> None:
    """commit=False: конфликт откатывает только свою точку сохранения."""
    keep = await make_player(db, "Keep Me")
    source = await make_player(db, "Синнер")
    target = await make_player(db, "Jannik Sinner")
    tournament = await make_tournament(db)
    await make_match(db, source, target, tournament_id=tournament)
    await db.commit()
    keep_id, source_id, target_id = keep.id, source.id, target.id
    keep.name_ru = "Оставить"
    await db.flush()
    with pytest.raises(PlayerError):
        await players.merge_players(
            db, source_id=source_id, target_id=target_id, actor_id=None, commit=False
        )
    await db.commit()
    assert (await fresh(db, Player, keep_id)).name_ru == "Оставить"
    assert await fresh(db, Player, source_id) is not None


# --- правка ---


async def test_edit_player_and_audit(db: AsyncSession) -> None:
    player = await make_player(db, "Andrey Rublev", aliases=["Rublev A."])
    await db.commit()
    edited = await players.edit_player(
        db, player.id, name_ru="  Рубл\u0451в  ", add_alias="Рубл\u0451в А.", actor_id=None
    )
    assert edited.name_ru == "Рублев"
    assert edited.aliases == ["Rublev A.", "Рублев А."]
    edited = await players.edit_player(
        db, player.id, remove_alias="rublev a", add_alias="Rublev An.", actor_id=None
    )
    assert edited.aliases == ["Рублев А.", "Rublev An."]
    # Без изменений — без записи в журнале
    await players.edit_player(db, player.id, name_ru="Рублев", actor_id=None)
    # Пустая строка стирает имя по-русски
    edited = await players.edit_player(db, player.id, name_ru="", actor_id=None)
    assert edited.name_ru is None
    stored = await fresh(db, Player, player.id)
    assert stored.aliases == ["Рублев А.", "Rublev An."] and stored.name_ru is None

    entries = await audit_entries(db, "player_edit")
    assert [entry.details.get("name_ru") for entry in entries] == [
        {"old": None, "new": "Рублев"},
        None,
        {"old": "Рублев", "new": None},
    ]
    assert entries[0].details["aliases_added"] == ["Рублев А."]
    assert entries[1].details["aliases_removed"] == ["Rublev A."]
    assert entries[1].details["aliases_added"] == ["Rublev An."]
    assert all(entry.details["source"] == "terminal" for entry in entries)
    assert all(entry.details["player_id"] == player.id for entry in entries)


@pytest.mark.parametrize(
    ("fields", "key"),
    [
        ({}, "players.errors.edit_nothing"),
        ({"remove_alias": "nope"}, "players.errors.alias_not_found"),
        ({"add_alias": "   "}, "players.errors.alias_empty"),
        ({"name_ru": "я" * 201}, "players.errors.name_too_long"),
    ],
)
async def test_edit_player_errors(db: AsyncSession, fields: dict[str, Any], key: str) -> None:
    player = await make_player(db, "Andrey Rublev")
    await db.commit()
    with pytest.raises(PlayerError) as caught:
        await players.edit_player(db, player.id, actor_id=None, **fields)
    assert caught.value.code == key
    assert await audit_entries(db, "player_edit") == []


async def test_edit_unknown_player(db: AsyncSession) -> None:
    with pytest.raises(PlayerError) as caught:
        await players.edit_player(db, 12345, name_ru="Кто-то", actor_id=None)
    assert caught.value.code == "players.errors.not_found"


# --- слияние матчей ---

EXPECTED_MATCH_REFS = {
    "match_stats": ("match_id",),
    "odds_snapshots": ("match_id",),
    "dossiers": ("match_id",),
    "predictions": ("match_id",),
    "bet_legs": ("match_id",),
}


def test_match_references_have_rules() -> None:
    """Каждая ссылка на matches.id учтена: новая таблица уронит тест (и слияние матчей
    тоже, пока для нее не будет правила)."""
    assert players.references_to("matches") == EXPECTED_MATCH_REFS


async def _bet(
    db: AsyncSession, user_id: int, match: Match, selection: int, *, analysis_id: int
) -> tuple[Prediction, BetLeg]:
    bet = Bet(
        user_id=user_id,
        placed_at=NOW,
        bookmaker="fonbet",
        stake=Decimal("100"),
        currency="RUB",
        total_odds=Decimal("1.25"),
        source="legacy",
        source_ref=f"bet-{match.id}-{selection}",
    )
    db.add(bet)
    await db.flush()
    prediction = Prediction(
        user_id=user_id,
        analysis_id=analysis_id,
        match_id=match.id,
        market="ML",
        selection=selection,
        as_of=NOW,
        p_claude=0.8,
    )
    db.add(prediction)
    await db.flush()
    leg = BetLeg(
        bet_id=bet.id,
        match_id=match.id,
        market="ML",
        selection=selection,
        odds_taken=Decimal("1.25"),
        prediction_id=prediction.id,
    )
    db.add(leg)
    await db.flush()
    return prediction, leg


def _odds(match: Match, selection: int, bookmaker: str, kind: str, odds: str) -> OddsSnapshot:
    return OddsSnapshot(
        match_id=match.id,
        market="ML",
        selection=selection,
        bookmaker=bookmaker,
        odds=Decimal(odds),
        kind=kind,
        taken_at=NOW,
    )


async def test_merge_matches_moves_everything_and_flips_sides(
    db: AsyncSession, make_user: UserFactory
) -> None:
    user = await make_user()
    sinner = await make_player(db, "Jannik Sinner")
    medvedev = await make_player(db, "Daniil Medvedev")
    tournament = await make_tournament(db)
    # Копия с обратным порядком игроков и днем матча, цель — без дня
    source = await make_match(
        db,
        sinner,
        medvedev,
        tournament_id=None,
        round_="",
        source="legacy",
        source_ref="2025-01-20:1:2",
        status="scheduled",
        winner_id=None,
        match_date=date(2025, 1, 21),
    )
    target = await make_match(db, medvedev, sinner, tournament_id=tournament, round_="QF")
    analysis = Analysis(user_id=user.id, input_text="x")
    db.add(analysis)
    await db.flush()
    prediction, leg = await _bet(db, user.id, source, 1, analysis_id=analysis.id)
    db.add_all(
        [
            _odds(source, 1, "fonbet", "user", "1.25"),
            _odds(source, 2, "fonbet", "user", "4.00"),
            # Тот же кэф архива есть у цели (у нее это сторона 2) — копия удаляется
            _odds(source, 1, "pinnacle", "archive", "1.31"),
            _odds(target, 2, "pinnacle", "archive", "1.30"),
            _odds(target, 1, "pinnacle", "archive", "3.60"),
            Dossier(match_id=source.id, as_of=NOW, content={}, sha256="a" * 64, feature_set="v1"),
            MatchStat(match_id=source.id, player_id=sinner.id, aces=7, source="web"),
            MatchStat(match_id=target.id, player_id=medvedev.id, aces=9, source="sackmann"),
        ]
    )
    await db.commit()
    source_id, target_id = source.id, target.id

    report = await players.merge_matches(db, source_match_id=source_id, target_match_id=target_id)

    assert report.flipped
    assert report.moved == {
        "match_stats": 1,
        "odds_snapshots": 2,
        "dossiers": 1,
        "predictions": 1,
        "bet_legs": 1,
    }
    assert report.removed == {"odds_snapshots": 1}
    assert report.filled == ["match_date"]
    for table_name, columns in players.references_to("matches").items():
        assert await count_refs(db, table_name, columns, source_id) == 0, table_name
    assert await fresh(db, Match, source_id) is None
    merged = await fresh(db, Match, target_id)
    assert merged.match_date == date(2025, 1, 21) and merged.round == "QF"
    assert (await fresh(db, BetLeg, leg.id)).selection == 2
    moved = await fresh(db, Prediction, prediction.id)
    assert (moved.match_id, moved.selection) == (target_id, 2)
    odds = await db.execute(
        select(OddsSnapshot.selection, OddsSnapshot.bookmaker, OddsSnapshot.kind, OddsSnapshot.odds)
        .where(OddsSnapshot.match_id == target_id)
        .order_by(OddsSnapshot.bookmaker, OddsSnapshot.selection)
    )
    assert odds.all() == [
        (1, "fonbet", "user", Decimal("4.000")),
        (2, "fonbet", "user", Decimal("1.250")),
        (1, "pinnacle", "archive", Decimal("3.600")),
        (2, "pinnacle", "archive", Decimal("1.300")),
    ]
    stats = await db.scalars(select(MatchStat.player_id).where(MatchStat.match_id == target_id))
    assert sorted(stats) == sorted([sinner.id, medvedev.id])


async def test_merge_matches_conflict_rolls_back(db: AsyncSession, make_user: UserFactory) -> None:
    user = await make_user()
    sinner = await make_player(db, "Jannik Sinner")
    medvedev = await make_player(db, "Daniil Medvedev")
    tournament = await make_tournament(db)
    source = await make_match(db, sinner, medvedev, tournament_id=tournament, round_="QF")
    target = await make_match(db, sinner, medvedev, tournament_id=tournament, round_="SF")
    analysis = Analysis(user_id=user.id, input_text="x")
    db.add(analysis)
    await db.flush()
    # Один анализ дал прогноз на один исход обоих матчей
    await _bet(db, user.id, source, 1, analysis_id=analysis.id)
    await _bet(db, user.id, target, 1, analysis_id=analysis.id)
    db.add(_odds(source, 1, "fonbet", "user", "1.25"))
    await db.commit()
    source_id, target_id = source.id, target.id
    with pytest.raises(PlayerError) as caught:
        await players.merge_matches(db, source_match_id=source_id, target_match_id=target_id)
    assert caught.value.code == "players.errors.match_merge_conflict"
    assert "predictions" in caught.value.message
    assert await fresh(db, Match, source_id) is not None
    assert await count_refs(db, "odds_snapshots", ("match_id",), source_id) == 1


async def test_merge_matches_errors(db: AsyncSession) -> None:
    sinner = await make_player(db, "Jannik Sinner")
    medvedev = await make_player(db, "Daniil Medvedev")
    alcaraz = await make_player(db, "Carlos Alcaraz")
    tournament = await make_tournament(db)
    first = await make_match(db, sinner, medvedev, tournament_id=tournament)
    second = await make_match(db, sinner, alcaraz, tournament_id=tournament)
    await db.commit()
    first_id, second_id = first.id, second.id
    cases = [
        (first_id, second_id, "players.errors.match_players_differ"),
        (first_id, first_id, "players.errors.match_merge_same"),
        (first_id, 999_999, "players.errors.match_not_found"),
    ]
    for source_id, target_id, key in cases:
        with pytest.raises(PlayerError) as caught:
            await players.merge_matches(db, source_match_id=source_id, target_match_id=target_id)
        assert caught.value.code == key
    # Явная сторона: игроки еще не слиты, но известно, кто есть кто
    report = await players.merge_matches(
        db, source_match_id=first_id, target_match_id=second_id, flip=False
    )
    assert not report.flipped
    assert await fresh(db, Match, first_id) is None


# --- копии матчей после слияния игроков ---


async def _copy_world(db: AsyncSession) -> dict[str, Any]:
    """Сакманн догнал турнир, но не усыновил игрока tennis-data «Kwon S.W.» (другие
    инициалы): у Soonwoo Kwon свои матчи Сакманна, а у «S.W. Kwon» — копии tennis-data
    с днем, кэфами и ставкой старого бота."""
    sinner = await make_player(db, "Jannik Sinner", sackmann_id=1)
    fritz = await make_player(db, "Taylor Fritz", sackmann_id=6)
    soonwoo = await make_player(db, "Soonwoo Kwon", sackmann_id=5)
    td_kwon = await make_player(db, "S.W. Kwon", aliases=["Kwon S.W."])
    doha = await make_tournament(
        db, "Doha", source_ref="2026-451", start_date=date(2026, 2, 16), category="atp"
    )
    td_doha = await make_tournament(
        db,
        "Doha",
        source="tennis_data",
        source_ref="2026-7",
        start_date=date(2026, 2, 17),
        category="250",
        city="Doha",
        indoor=False,
    )
    copy_r32 = await make_match(
        db,
        sinner,
        td_kwon,
        tournament_id=td_doha,
        source="tennis_data",
        match_date=date(2026, 2, 17),
    )
    # У Сакманна в R16 другой победитель: порядок игроков обратный
    copy_r16 = await make_match(
        db,
        td_kwon,
        fritz,
        tournament_id=td_doha,
        round_="R16",
        source="tennis_data",
        match_date=date(2026, 2, 19),
    )
    # Матч той же пары месяцем позже: не в окне турнира Сакманна, не копия
    later = await make_match(
        db,
        td_kwon,
        sinner,
        tournament_id=td_doha,
        round_="F",
        source="tennis_data",
        match_date=date(2026, 3, 20),
    )
    sk_r32 = await make_match(db, sinner, soonwoo, tournament_id=doha)
    sk_r16 = await make_match(db, fritz, soonwoo, tournament_id=doha, round_="R16")
    db.add_all(
        [
            _odds(copy_r32, 1, "pinnacle", "archive", "1.10"),
            _odds(copy_r32, 2, "pinnacle", "archive", "7.50"),
            _odds(copy_r16, 1, "pinnacle", "archive", "2.40"),
        ]
    )
    await db.flush()
    return {
        "sinner": sinner.id,
        "soonwoo": soonwoo.id,
        "td_kwon": td_kwon.id,
        "doha": doha,
        "td_doha": td_doha,
        "copy_r32": copy_r32.id,
        "copy_r16": copy_r16.id,
        "later": later.id,
        "sk_r32": sk_r32.id,
        "sk_r16": sk_r16.id,
    }


async def test_merge_players_merges_match_copies(db: AsyncSession, make_user: UserFactory) -> None:
    """После players-merge у игрока не остается двух записей одного матча: копия
    tennis-data сливается в матч Сакманна, ставка старого бота — на прежнем игроке."""
    user = await make_user()
    w = await _copy_world(db)
    analysis = Analysis(user_id=user.id, input_text="x")
    db.add(analysis)
    await db.flush()
    copy = await fresh(db, Match, w["copy_r32"])
    # Ставка на Квона: в копии он второй
    _, leg = await _bet(db, user.id, copy, 2, analysis_id=analysis.id)
    await db.commit()

    report = await players.merge_players(
        db, source_id=w["td_kwon"], target_id=w["soonwoo"], actor_id=None
    )

    assert report.copies_merged == {w["copy_r32"]: w["sk_r32"], w["copy_r16"]: w["sk_r16"]}
    assert report.copies_left == {}
    for copy_id in (w["copy_r32"], w["copy_r16"]):
        assert await fresh(db, Match, copy_id) is None
    assert await fresh(db, Match, w["later"]) is not None
    leg = await fresh(db, BetLeg, leg.id)
    match = await fresh(db, Match, leg.match_id)
    assert match.id == w["sk_r32"] and match.match_date == date(2026, 2, 17)
    assert (match.player1_id, match.player2_id)[leg.selection - 1] == w["soonwoo"]
    odds = await db.execute(
        select(OddsSnapshot.match_id, OddsSnapshot.selection, OddsSnapshot.odds)
        .where(OddsSnapshot.match_id.in_((w["sk_r32"], w["sk_r16"])))
        .order_by(OddsSnapshot.match_id, OddsSnapshot.selection)
    )
    # У R16 игроки в обратном порядке: кэф Квона (был стороной 1) теперь сторона 2
    assert odds.all() == [
        (w["sk_r32"], 1, Decimal("1.100")),
        (w["sk_r32"], 2, Decimal("7.500")),
        (w["sk_r16"], 2, Decimal("2.400")),
    ]
    # Дублей пар в окне турнира нет; турнир tennis-data остался только с поздним матчем
    pairs = await db.execute(
        select(Match.player1_id, Match.player2_id).where(
            Match.match_date.between(date(2026, 2, 1), date(2026, 2, 28))
            | (Match.tournament_id == w["doha"])
        )
    )
    keys = [frozenset(pair) for pair in pairs.all()]
    assert len(keys) == len(set(keys)) == 2
    [entry] = await audit_entries(db, "player_merge")
    assert entry.details["copies_merged"] == {
        str(w["copy_r32"]): w["sk_r32"],
        str(w["copy_r16"]): w["sk_r16"],
    }


async def test_merge_copies_drops_empty_tennis_data_tournament(db: AsyncSession) -> None:
    w = await _copy_world(db)
    await db.delete(await fresh(db, Match, w["later"]))
    await db.commit()
    report = await players.merge_players(
        db, source_id=w["td_kwon"], target_id=w["soonwoo"], actor_id=None
    )
    assert len(report.copies_merged) == 2
    assert await fresh(db, Tournament, w["td_doha"]) is None
    doha = await fresh(db, Tournament, w["doha"])
    # Город, зал и уточненная категория tennis-data перешли к турниру Сакманна
    assert (doha.city, doha.indoor, doha.category) == ("Doha", False, "250")


async def test_merge_copies_ambiguous_go_to_report(db: AsyncSession) -> None:
    """Пара дважды в окне (круговой этап и финал): копия с тем же раундом сливается,
    копия, чей раунд не совпал ни с одним, остается и попадает в отчет."""
    sinner = await make_player(db, "Jannik Sinner", sackmann_id=1)
    soonwoo = await make_player(db, "Soonwoo Kwon", sackmann_id=5)
    td_kwon = await make_player(db, "S.W. Kwon")
    finals = await make_tournament(db, "Finals", start_date=date(2026, 11, 9))
    td_finals = await make_tournament(
        db, "Finals", source="tennis_data", source_ref="2026-67", start_date=date(2026, 11, 9)
    )
    rr = await make_match(db, sinner, soonwoo, tournament_id=finals, round_="RR")
    final = await make_match(db, soonwoo, sinner, tournament_id=finals, round_="F")
    copy_final = await make_match(
        db,
        td_kwon,
        sinner,
        tournament_id=td_finals,
        round_="F",
        source="tennis_data",
        match_date=date(2026, 11, 16),
    )
    copy_sf = await make_match(
        db,
        sinner,
        td_kwon,
        tournament_id=td_finals,
        round_="SF",
        source="tennis_data",
        match_date=date(2026, 11, 15),
    )
    await db.commit()
    report = await players.merge_players(
        db, source_id=td_kwon.id, target_id=soonwoo.id, actor_id=None
    )
    assert report.copies_merged == {copy_final.id: final.id}
    assert report.copies_left == {copy_sf.id: sorted([rr.id, final.id])}
    assert await fresh(db, Match, copy_sf.id) is not None
    assert await fresh(db, Tournament, td_finals) is not None


# --- несопоставленные строки загрузок ---

_RUN_AT = datetime(2026, 10, 1, 5, tzinfo=UTC)


def _run(day: int, details: dict[str, Any], status: str = "ok") -> IngestionRun:
    at = _RUN_AT.replace(day=day)
    return IngestionRun(
        source="tennis_data", status=status, started_at=at, finished_at=at, details=details
    )


def _row(name: str, file: str) -> dict[str, Any]:
    return {"kind": "player", "name": name, "file": file}


async def _unmatched(db: AsyncSession, *runs: IngestionRun) -> players.UnmatchedRun:
    db.add_all(runs)
    await db.commit()
    [found] = await players.recent_unmatched(db, sources=("tennis_data",))
    return found


async def test_unmatched_keeps_rows_of_skipped_files(db: AsyncSession) -> None:
    """Ночной запуск пропустил неизменившиеся файлы прошлых лет по sha256: их строки
    берутся из полной загрузки, а строки файла текущего года — из ночного запуска."""
    full = _run(
        1,
        {
            "files": {"2024/2024.xlsx": "a", "2025/2025.xlsx": "b", "2026/2026.xlsx": "c"},
            "unmatched": [
                _row("Zverev A.", "2024/2024.xlsx"),
                # В старом отчете бывает только имя файла
                _row("Kim S.", "2025.xlsx"),
                _row("Old R.", "2026/2026.xlsx"),
            ],
            "counts": {"unmatched.player": 3, "files.loaded": 3},
        },
    )
    nightly = _run(
        2,
        {
            "files": {"2024/2024.xlsx": "a", "2025/2025.xlsx": "b", "2026/2026.xlsx": "d"},
            "unmatched": [_row("New N.", "2026/2026.xlsx")],
            "counts": {"unmatched.player": 1, "files.unchanged": 2},
        },
    )
    found = await _unmatched(db, full, nightly, _run(3, {"unmatched": []}, status="failed"))
    assert (found.run_id, found.finished_at) == (nightly.id, _RUN_AT.replace(day=2))
    assert found.run_ids == [nightly.id, full.id]
    assert [row["name"] for row in found.rows] == ["New N.", "Zverev A.", "Kim S."]
    assert found.counts == {"player": 3} and found.exact


async def test_unmatched_after_forced_reload(db: AsyncSession) -> None:
    """Повторный разбор всех файлов (--force) без несопоставленных строк: старые строки
    больше не показываются."""
    files = {"2024/2024.xlsx": "a", "2025/2025.xlsx": "b"}
    found = await _unmatched(
        db,
        _run(
            1,
            {
                "files": files,
                "unmatched": [_row("Zverev A.", "2024/2024.xlsx")],
                "counts": {"unmatched.player": 1},
            },
        ),
        _run(2, {"files": files, "unmatched": [], "counts": {"files.loaded": 2}}),
    )
    assert (found.counts, found.rows, found.run_ids) == ({}, [], [])


async def test_unmatched_counts_from_examples(db: AsyncSession) -> None:
    """Файл старого запуска разобран заново: числа старого запуска считаются по его
    примерам, а примеров в журнале меньше, чем строк, — числа не точные (не меньше)."""
    full = _run(
        1,
        {
            "files": {"2024/2024.xlsx": "a", "2026/2026.xlsx": "c"},
            "unmatched": [_row("Zverev A.", "2024/2024.xlsx"), _row("Old R.", "2026/2026.xlsx")],
            "counts": {"unmatched.player": 500},
        },
    )
    nightly = _run(
        2,
        {
            "files": {"2024/2024.xlsx": "a", "2026/2026.xlsx": "d"},
            "unmatched": [],
            "counts": {"files.unchanged": 1},
        },
    )
    found = await _unmatched(db, full, nightly)
    assert found.run_ids == [full.id]
    assert [row["name"] for row in found.rows] == ["Zverev A."]
    assert found.counts == {"player": 1} and not found.exact


# --- тексты ---


def test_player_texts_exist() -> None:
    """Ключи players.* из кода есть в локали (общий тест локали видит только t(...))."""
    import ast
    from pathlib import Path

    app_dir = Path(__file__).resolve().parent.parent / "app"
    found: set[str] = set()
    for path in (app_dir / "services" / "players.py", app_dir / "ingest" / "players_link.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value.startswith("players.")
                and " " not in node.value
            ):
                found.add(node.value)
    assert len(found) > 10
    assert sorted(key for key in found if not has_key(key)) == []
