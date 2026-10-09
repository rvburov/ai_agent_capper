"""Загрузчик tennis-data.co.uk (app/ingest/tennis_data.py).

Файлы xlsx тест создает сам через openpyxl (бинарники в git не кладем), турниры и матчи
Сакманна — прямо через ORM. Мир теста (sackmann_world):
- турнир Сакманна «Rotterdam» (категория atp, без зала и города): R32 Синнер — Оже-Альяссим,
  QF Медведев — дель Потро (игроки записаны в обратном порядке: победил дель Потро),
  F Синнер — дель Потро;
- итоговый турнир: круговой этап и финал одной пары Синнер — А. Зверев;
- игрок старого бота «Медведев Д.» с матчем из его истории: в поиске не участвует.
В файле 2024 года кроме них — турнир Монпелье, которого у Сакманна нет: свои матчи,
новый игрок, отказ, неявка, дисквалификация, несыгранный матч.
"""

import asyncio
from collections.abc import Callable
from datetime import UTC, date, datetime
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import Any

import httpx
import pytest
from openpyxl import Workbook
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.i18n import has_key, t
from app.db.base import Base
from app.db.models import IngestionRun, Match, OddsSnapshot, Player, Tournament
from app.db.session import create_sessionmaker
from app.ingest import tennis_data as td
from app.ingest.fetch import DataSource
from app.ingest.runs import UPDATE_LOCK_KEY, IngestError, IngestReport

HEADER = [
    "ATP",
    "Location",
    "Tournament",
    "Date",
    "Series",
    "Court",
    "Surface",
    "Round",
    "Best of",
    "Winner",
    "Loser",
    "WRank",
    "LRank",
    "WPts",
    "LPts",
    "W1",
    "L1",
    "W2",
    "L2",
    "W3",
    "L3",
    "W4",
    "L4",
    "W5",
    "L5",
    "Wsets",
    "Lsets",
    "Comment",
    "B365W",
    "B365L",
    "PSW",
    "PSL",
    "MaxW",
    "MaxL",
    "AvgW",
    "AvgL",
]
# Год без колонок Pinnacle, с лишними пробелами в заголовках и колонкой Betfair
HEADER_NO_PS = [
    " ATP",
    "Location",
    "Tournament",
    "Date",
    "Series",
    "Court",
    "Surface",
    "Round",
    "Best of ",
    "Winner",
    "Loser",
    "W1",
    "L1",
    "W2",
    "L2",
    "W3",
    "L3",
    " Comment ",
    "B365W",
    "B365L",
    "BFEW",
    "BFEL",
    "EXW",
    "EXL",
]
ODDS = {"B365W": 1.5, "B365L": 2.5, "PSW": 1.52, "PSL": 2.61, "MaxW": 1.6, "MaxL": 2.75}

Factory = Callable[[], AsyncSession]


def make_row(
    atp: int,
    tournament: str,
    day: datetime | date | int | str,
    winner: str,
    loser: str,
    *,
    round_label: str = "1st Round",
    series: str = "ATP250",
    court: str = "Outdoor",
    surface: str = "Hard",
    location: str = "City",
    best_of: int = 3,
    sets: tuple[tuple[int, int], ...] = ((6, 4), (6, 4)),
    comment: str = "Completed",
    odds: dict[str, Any] | None = None,
) -> dict[str, Any]:
    row: dict[str, Any] = {
        "ATP": atp,
        "Location": location,
        "Tournament": tournament,
        "Date": day,
        "Series": series,
        "Court": court,
        "Surface": surface,
        "Round": round_label,
        "Best of": best_of,
        "Winner": winner,
        "Loser": loser,
        "Comment": comment,
    }
    for number, (won, lost) in enumerate(sets, start=1):
        row[f"W{number}"], row[f"L{number}"] = won, lost
    row.update(ODDS if odds is None else odds)
    return row


def xlsx(rows: list[dict[str, Any]], header: list[str] = HEADER) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    assert sheet is not None
    sheet.append(header)
    for row in rows:
        sheet.append([row.get(name.strip()) for name in header])
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def write_year(
    folder: Path, year: int, rows: list[dict[str, Any]], header: list[str] = HEADER
) -> Path:
    path = folder / str(year) / f"{year}.xlsx"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(xlsx(rows, header))
    return path


def d(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day)


# --- мир Сакманна ---


async def add_player(db: AsyncSession, name: str, sackmann_id: int | None = None) -> Player:
    player = Player(name=name, sackmann_id=sackmann_id)
    db.add(player)
    await db.flush()
    return player


async def add_tournament(
    db: AsyncSession,
    ref: str,
    name: str,
    start: date,
    *,
    category: str | None = "atp",
    city: str | None = None,
    indoor: bool | None = None,
) -> Tournament:
    tournament = Tournament(
        name=name,
        source="sackmann",
        source_ref=ref,
        start_date=start,
        category=category,
        surface="hard",
        city=city,
        indoor=indoor,
        best_of=3,
    )
    db.add(tournament)
    await db.flush()
    return tournament


async def add_match(
    db: AsyncSession,
    tournament: Tournament,
    number: int,
    round_code: str,
    player1: Player,
    player2: Player,
    winner: Player,
) -> Match:
    match = Match(
        tournament_id=tournament.id,
        round=round_code,
        player1_id=player1.id,
        player2_id=player2.id,
        winner_id=winner.id,
        score="6-4 6-4",
        status="finished",
        best_of=3,
        source="sackmann",
        source_ref=f"{tournament.source_ref}-{number}",
    )
    db.add(match)
    await db.flush()
    return match


async def sackmann_world(db: AsyncSession) -> dict[str, Any]:
    world: dict[str, Any] = {}
    for key, name, sid in [
        ("sinner", "Jannik Sinner", 206173),
        ("medvedev", "Daniil Medvedev", 106421),
        ("alcaraz", "Carlos Alcaraz", 207989),
        ("delpotro", "Juan Martin del Potro", 105223),
        ("felix", "Felix Auger Aliassime", 200000),
        ("sascha", "Alexander Zverev", 100644),
        ("mischa", "Mischa Zverev", 104022),
        ("ramos", "Albert Ramos", 104925),
    ]:
        world[key] = await add_player(db, name, sid)
    rotterdam = await add_tournament(db, "2024-407", "Rotterdam", date(2024, 2, 12))
    finals = await add_tournament(
        db, "2024-605", "Tour Finals", date(2024, 11, 10), category="finals", city="Turin"
    )
    world["rotterdam"], world["finals"] = rotterdam, finals
    p = world
    world["m_r32"] = await add_match(db, rotterdam, 1, "R32", p["sinner"], p["felix"], p["sinner"])
    # Порядок игроков обратный: победил дель Потро, записанный вторым
    world["m_qf"] = await add_match(
        db, rotterdam, 2, "QF", p["medvedev"], p["delpotro"], p["delpotro"]
    )
    world["m_f"] = await add_match(db, rotterdam, 3, "F", p["sinner"], p["delpotro"], p["sinner"])
    world["m_rr"] = await add_match(db, finals, 1, "RR", p["sinner"], p["sascha"], p["sinner"])
    world["m_final"] = await add_match(db, finals, 2, "F", p["sinner"], p["sascha"], p["sinner"])
    # Игроки старого бота: «Медведев Д.» по ключам похож на «Medvedev D.», но в поиске
    # не участвует — его сольет с Даниилом привязка старого бота
    legacy_medvedev = await add_player(db, "Медведев Д.")
    legacy_sinner = await add_player(db, "Синнер Я.")
    db.add(
        Match(
            player1_id=legacy_sinner.id,
            player2_id=legacy_medvedev.id,
            status="scheduled",
            source="legacy",
            source_ref="2024-02-08:1:1",
            scheduled_at=datetime(2024, 2, 8, 12, tzinfo=UTC),
        )
    )
    world["legacy_medvedev"] = legacy_medvedev
    await db.commit()
    return world


ROTTERDAM: dict[str, Any] = dict(series="ATP500", court="Indoor", location="Rotterdam")
FINALS: dict[str, Any] = dict(series="Masters Cup", court="Indoor", location="Turin")
MONTPELLIER: dict[str, Any] = dict(series="ATP250", court="Indoor", location="Montpellier")


def rows_2024() -> list[dict[str, Any]]:
    rotterdam = "ABN AMRO World Tennis Tournament"
    montpellier = "Open Sud de France"
    return [
        make_row(10, rotterdam, d(2024, 2, 13), "Sinner J.", "Auger-Aliassime F.", **ROTTERDAM),
        make_row(
            10,
            rotterdam,
            d(2024, 2, 16),
            "Del Potro J.M.",
            "Medvedev D.",
            round_label="Quarterfinals",
            odds={"PSW": 2.1, "PSL": 1.8},
            **ROTTERDAM,
        ),
        make_row(
            10,
            rotterdam,
            d(2024, 2, 18),
            "  Sinner   J. ",
            "Del Potro  J.M.",
            round_label="The Final",
            **ROTTERDAM,
        ),
        make_row(20, montpellier, d(2024, 2, 5), "Alcaraz C.", "Newguy X.", **MONTPELLIER),
        make_row(
            20,
            montpellier,
            d(2024, 2, 6),
            "Zverev M.",
            "Ramos-Vinolas A.",
            sets=((6, 3), (2, 0)),
            comment="Retired",
            odds={"B365W": 1.0, "B365L": 3.0, "MaxW": "n/a", "MaxL": 3.2},
            **MONTPELLIER,
        ),
        make_row(
            20,
            montpellier,
            d(2024, 2, 7),
            "Alcaraz C.",
            "Zverev M.",
            round_label="2nd Round",
            sets=(),
            comment="Walkover",
            odds={},
            **MONTPELLIER,
        ),
        make_row(
            20,
            montpellier,
            d(2024, 2, 8),
            "Medvedev D.",
            "Newguy X.",
            round_label="Quarterfinals",
            sets=((7, 6), (6, 7), (7, 6)),
            **MONTPELLIER,
        ),
        make_row(
            20,
            montpellier,
            d(2024, 2, 9),
            "Medvedev D.",
            "Alcaraz C.",
            round_label="Semifinals",
            sets=((6, 4), (3, 2)),
            comment="Disqualified",
            **MONTPELLIER,
        ),
        make_row(
            20,
            montpellier,
            d(2024, 2, 10),
            "Medvedev D.",
            "Zverev M.",
            round_label="The Final",
            sets=(),
            comment=" Sched ",
            **MONTPELLIER,
        ),
        make_row(
            66,
            "Masters Cup",
            d(2024, 11, 12),
            "Sinner J.",
            "Zverev A.",
            round_label="Round Robin",
            **FINALS,
        ),
        make_row(
            66,
            "Masters Cup",
            d(2024, 11, 17),
            "Sinner J.",
            "Zverev A.",
            round_label="The Final",
            odds={"PSW": 1.3, "PSL": 3.6},
            **FINALS,
        ),
    ]


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> Factory:
    return create_sessionmaker(engine)


async def load(
    folder: Path, factory: Factory, years: list[int], *, force: bool = False
) -> IngestReport:
    async with DataSource.local(folder) as source:
        return await td.load_tennis_data(
            years=years, source=source, force=force, db_factory=factory
        )


async def count(db: AsyncSession, model: type[Base]) -> int:
    return int(await db.scalar(select(func.count()).select_from(model)) or 0)


async def counts(db: AsyncSession) -> dict[str, int]:
    return {
        model.__tablename__: await count(db, model)
        for model in (Player, Tournament, Match, OddsSnapshot)
    }


async def odds_of(db: AsyncSession, match_id: int) -> dict[tuple[str, int], Decimal]:
    rows = await db.execute(
        select(OddsSnapshot.bookmaker, OddsSnapshot.selection, OddsSnapshot.odds).where(
            OddsSnapshot.match_id == match_id, OddsSnapshot.kind == "archive"
        )
    )
    return {(bookmaker, selection): odds for bookmaker, selection, odds in rows}


async def own_matches(db: AsyncSession) -> dict[str, Match]:
    """Свои матчи tennis-data: «Победитель — Проигравший» → матч."""
    names = {pid: name for pid, name in await db.execute(select(Player.id, Player.name))}
    found = await db.scalars(select(Match).where(Match.source == "tennis_data"))
    return {f"{names[m.player1_id]} — {names[m.player2_id]}": m for m in found}


# --- чистые функции ---


def test_cell_values() -> None:
    assert td.to_date(datetime(2024, 2, 13, 0, 0)) == date(2024, 2, 13)
    assert td.to_date(45306) == date(2024, 1, 15)
    assert td.to_date(45306.0) == date(2024, 1, 15)
    assert td.to_date("15/01/2024") == date(2024, 1, 15)
    assert td.to_date("2024-01-15") == date(2024, 1, 15)
    for bad in (None, "", "завтра", 0, -5, True, float("nan")):
        assert td.to_date(bad) is None
    assert td.to_int(6) == 6 and td.to_int(6.0) == 6 and td.to_int(" 7 ") == 7
    assert td.to_int(6.5) is None and td.to_int("x") is None and td.to_int(None) is None
    assert td.clean_text("  Del   Potro  J.M. ") == "Del Potro J.M."
    assert td.clean_text(10.0) == "10" and td.clean_text("  ") is None


def test_odds_values() -> None:
    assert td.to_odds(1.83) == Decimal("1.830")
    assert td.to_odds("2,5") == Decimal("2.500")
    assert td.to_odds(1.0125) == Decimal("1.013")
    assert td.to_odds(None) is None and td.to_odds(" ") is None
    for bad in (1.0, 1.009, "n/a", 1000, float("inf"), True, datetime(2024, 1, 1)):
        with pytest.raises(ValueError):
            td.to_odds(bad)


@pytest.mark.parametrize(
    ("series", "category"),
    [
        ("Grand Slam", "grand_slam"),
        ("Masters 1000", "masters"),
        ("ATP500", "500"),
        ("ATP250", "250"),
        ("Masters Cup", "finals"),
        (" masters  cup ", "finals"),
        ("International Gold", "500"),
        ("International", "250"),
        ("Masters", "masters"),
        ("ATP Cup", None),
        (None, None),
    ],
)
def test_series_category(series: str | None, category: str | None) -> None:
    assert td.series_category(series) == category


def test_status_and_score() -> None:
    assert td.match_status("Completed") == "finished"
    assert td.match_status(" Retired ") == "retired"
    assert td.match_status("Disqualified") == "retired"
    assert td.match_status("Walkover") == "walkover"
    for other in ("Sched", "", None, "Awarded"):
        assert td.match_status(other) is None
    assert td.build_score([(6, 4), (3, 6), (7, 6)], "Completed") == "6-4 3-6 7-6"
    assert td.build_score([(6, 3), (2, 0)], "Retired") == "6-3 2-0 RET"
    assert td.build_score([], "Retired") == "RET"
    assert td.build_score([(6, 4)], "Disqualified") == "6-4 DEF"
    assert td.build_score([], "Walkover") == "W/O"
    assert td.build_score([], "Completed") is None


def test_names_and_refs() -> None:
    assert td.player_display_name("Del Potro J.M.") == "J.M. Del Potro"
    assert td.player_display_name("Sinner J.") == "J. Sinner"
    assert td.player_display_name("Auger-Aliassime F.") == "F. Auger-Aliassime"
    assert td.player_display_name("Sinner") == "Sinner"
    # В ключе — номер круга из метки, а не код R32/R64: код зависит от размера сетки
    assert td.round_key("1st Round") == "1" and td.round_key("4th Round") == "4"
    assert td.round_key("Quarterfinals") == td.round_key(" Quarter-finals") == "QF"
    assert td.round_key("The Final") == "F" and td.round_key("Round Robin") == "RR"
    assert td.round_key("Bronze") == "bronze"
    ref = td.own_match_ref(2024, 20, "1st Round", "Alcaraz C.", "Newguy X.")
    assert len(ref) == 32
    # Регистр и лишние пробелы в именах ключ не меняют, раунд и номер турнира — меняют
    assert ref == td.own_match_ref(2024, 20, "1st  round", "  alcaraz   c. ", "NEWGUY X.")
    assert ref != td.own_match_ref(2024, 20, "2nd Round", "Alcaraz C.", "Newguy X.")
    assert ref != td.own_match_ref(2024, 21, "1st Round", "Alcaraz C.", "Newguy X.")
    assert ref != td.own_match_ref(2024, 20, "1st Round", "Newguy X.", "Alcaraz C.")


def test_name_levels() -> None:
    index = td.PlayerIndex()
    index.add(1, ["Juan Martin del Potro"], searchable=True)
    index.add(2, ["Alexander Zverev"], searchable=True)
    index.add(3, ["Mischa Zverev"], searchable=True)
    index.add(4, ["Albert Ramos"], searchable=True)
    index.add(5, ["Felix Auger Aliassime"], searchable=True)
    index.add(6, ["Андрей Кузнецов"], searchable=False)
    assert index.name("Del Potro J.M.").level(index.player_keys(1)) == 2
    assert index.name("Zverev A.").level(index.player_keys(2)) == 2
    assert index.name("Zverev A.").level(index.player_keys(3)) == 1
    assert index.name("Sinner J.").level(index.player_keys(2)) == 0
    assert index.candidates(index.name("Del Potro J.M.")) == {1}
    assert index.candidates(index.name("Zverev A.")) == {2}
    assert index.candidates(index.name("Zverev M.")) == {3}
    assert index.candidates(index.name("Ramos-Vinolas A.")) == {4}
    assert index.candidates(index.name("Auger-Aliassime F.")) == {5}
    # Игрок вне поиска (старый бот) не находится
    assert index.candidates(index.name("Kuznetsov An.")) == set()


def test_namesakes_by_first_letters() -> None:
    """«Kuznetsov An.» и «Kuznetsov Al.»: tennis-data различает тезок двумя буквами имени.
    Тезка с другим началом имени не подходит, даже если других игроков нет."""
    index = td.PlayerIndex()
    index.add(1, ["Andrey Kuznetsov"], searchable=True)
    andrey = index.player_keys(1)
    assert index.candidates(index.name("Kuznetsov An.")) == {1}
    assert index.candidates(index.name("Kuznetsov Al.")) == set()
    assert index.name("Kuznetsov Al.").level(andrey) == 0
    assert index.name("Kuznetsov An.").level(andrey) == 2
    # Один инициал ничему не противоречит
    assert index.candidates(index.name("Kuznetsov A.")) == {1}
    index.add(2, ["Alex Kuznetsov"], searchable=True)
    assert index.candidates(index.name("Kuznetsov Al.")) == {2}
    assert index.candidates(index.name("Kuznetsov An.")) == {1}
    assert index.candidates(index.name("Kuznetsov A.")) == {1, 2}
    # Игрок, созданный из имени tennis-data с одним инициалом, подходит обоим
    index.add(3, ["A. Popov", "Popov A."], searchable=True)
    assert index.candidates(index.name("Popov Al.")) == {3}
    # «S.W.» и «D.H.» — инициалы двух имен, а не начало одного: Soonwoo Kwon подходит
    index.add(4, ["Soonwoo Kwon"], searchable=True)
    assert index.candidates(index.name("Kwon S.W.")) == {4}
    assert index.name("Kwon S.W.").level(index.player_keys(4)) == 2
    index.add(5, ["Juan Martin del Potro"], searchable=True)
    assert index.name("Del Potro Ju.").level(index.player_keys(5)) == 2
    assert index.name("Del Potro Jo.").level(index.player_keys(5)) == 0


# --- загрузка ---


async def test_links_to_sackmann_and_creates_own(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    world = await sackmann_world(db)
    write_year(tmp_path, 2024, rows_2024())
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()

    # Привязка к Сакманну: день матча и кэфы, стороны — по игрокам матча в базе
    m_r32 = await db.get_one(Match, world["m_r32"].id)
    assert m_r32.match_date == date(2024, 2, 13)
    assert m_r32.source == "sackmann" and m_r32.score == "6-4 6-4"
    assert await odds_of(db, m_r32.id) == {
        ("bet365", 1): Decimal("1.500"),
        ("bet365", 2): Decimal("2.500"),
        ("pinnacle", 1): Decimal("1.520"),
        ("pinnacle", 2): Decimal("2.610"),
        ("max", 1): Decimal("1.600"),
        ("max", 2): Decimal("2.750"),
    }
    # Победитель дель Потро записан вторым: его кэф (PSW) — selection 2
    m_qf = await db.get_one(Match, world["m_qf"].id)
    assert m_qf.match_date == date(2024, 2, 16)
    assert await odds_of(db, m_qf.id) == {
        ("pinnacle", 2): Decimal("2.100"),
        ("pinnacle", 1): Decimal("1.800"),
    }
    # Лишние пробелы в именах не мешают
    assert (await db.get_one(Match, world["m_f"].id)).match_date == date(2024, 2, 18)
    # Пара сыграла дважды (круговой этап и финал): различаются по раунду
    assert (await db.get_one(Match, world["m_rr"].id)).match_date == date(2024, 11, 12)
    m_final = await db.get_one(Match, world["m_final"].id)
    assert m_final.match_date == date(2024, 11, 17)
    assert (await odds_of(db, m_final.id))[("pinnacle", 1)] == Decimal("1.300")
    taken = (
        await db.scalars(select(OddsSnapshot.taken_at).where(OddsSnapshot.match_id == m_final.id))
    ).all()
    assert set(taken) == {datetime(2024, 11, 17, tzinfo=UTC)}

    # Турнир Сакманна дополнен залом, городом и категорией (atp → 500);
    # у итогового категория и город уже были — не тронуты
    rotterdam = await db.get_one(Tournament, world["rotterdam"].id)
    assert (rotterdam.indoor, rotterdam.city, rotterdam.category) == (True, "Rotterdam", "500")
    assert rotterdam.name == "Rotterdam"
    finals = await db.get_one(Tournament, world["finals"].id)
    assert (finals.indoor, finals.city, finals.category) == (True, "Turin", "finals")

    # Монпелье у Сакманна нет: свой турнир и свои матчи
    own_tournaments = (
        await db.scalars(select(Tournament).where(Tournament.source == "tennis_data"))
    ).all()
    assert len(own_tournaments) == 1
    montpellier = own_tournaments[0]
    assert montpellier.source_ref == "2024-20"
    assert (montpellier.name, montpellier.city, montpellier.category) == (
        "Open Sud de France",
        "Montpellier",
        "250",
    )
    assert (montpellier.surface, montpellier.indoor, montpellier.best_of) == ("hard", True, 3)
    assert montpellier.start_date == date(2024, 2, 5)

    newguys = (await db.scalars(select(Player).where(Player.name == "X. Newguy"))).all()
    assert len(newguys) == 1 and newguys[0].aliases == ["Newguy X."]
    assert newguys[0].sackmann_id is None

    matches = await own_matches(db)
    assert set(matches) == {
        "Carlos Alcaraz — X. Newguy",
        "Mischa Zverev — Albert Ramos",
        "Carlos Alcaraz — Mischa Zverev",
        "Daniil Medvedev — X. Newguy",
        "Daniil Medvedev — Carlos Alcaraz",
    }
    first = matches["Carlos Alcaraz — X. Newguy"]
    assert (first.round, first.status, first.score) == ("R32", "finished", "6-4 6-4")
    assert first.winner_id == first.player1_id == world["alcaraz"].id
    assert first.match_date == date(2024, 2, 5) and first.tournament_id == montpellier.id
    assert first.best_of == 3 and first.source_ref is not None and len(first.source_ref) == 32
    retired = matches["Mischa Zverev — Albert Ramos"]
    assert (retired.status, retired.score) == ("retired", "6-3 2-0 RET")
    # Негодные кэфы (1.0 и «n/a») пропущены, остальные записаны
    assert await odds_of(db, retired.id) == {
        ("bet365", 2): Decimal("3.000"),
        ("max", 2): Decimal("3.200"),
    }
    walkover = matches["Carlos Alcaraz — Mischa Zverev"]
    assert (walkover.round, walkover.status, walkover.score) == ("R16", "walkover", "W/O")
    quarter = matches["Daniil Medvedev — X. Newguy"]
    assert (quarter.round, quarter.score) == ("QF", "7-6 6-7 7-6")
    # «Medvedev D.» — Даниил, а не игрок старого бота «Медведев Д.»
    assert quarter.player1_id == world["medvedev"].id
    semi = matches["Daniil Medvedev — Carlos Alcaraz"]
    assert (semi.round, semi.status, semi.score) == ("SF", "retired", "6-4 3-2 DEF")

    # Отчет: строки, файлы, свежесть и доля строк с кэфами Pinnacle
    assert report.rows_read == 11
    assert report.counts["rows.linked"] == 5 and report.counts["rows.own"] == 5
    assert report.counts["skipped.status"] == 1 and report.skipped == 1
    assert report.counts["odds.invalid"] == 2
    assert report.counts["players.created"] == 1
    assert report.counts["tournaments.created"] == 1
    assert report.counts["tournaments.updated"] == 2
    assert report.counts["matches.created"] == 5 and report.counts["matches.dated"] == 5
    assert not report.unmatched
    assert report.files == {"2024/2024.xlsx": report.files["2024/2024.xlsx"]}
    year = report.freshness["years"]["2024"]
    assert year["status"] == "loaded" and year["rows"] == 10
    assert year["last_date"] == date(2024, 11, 17)
    assert year["pinnacle_share"] == 0.8
    assert (year["linked"], year["own"], year["unmatched"]) == (5, 5, 0)
    assert any("Newguy" in warning for warning in report.warnings)

    run = (await db.scalars(select(IngestionRun))).one()
    assert (run.source, run.status, run.error) == ("tennis_data", "ok", None)
    assert run.rows == report.created + report.updated
    assert run.details["files"] == report.files
    assert run.details["freshness"]["years"]["2024"]["last_date"] == "2024-11-17"


async def test_repeat_run_no_duplicates_and_odds_update(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    world = await sackmann_world(db)
    rows = rows_2024()
    write_year(tmp_path, 2024, rows)
    first = await load(tmp_path, factory, [2024])
    before = await counts(db)
    assert first.created > 0

    # Файл не изменился: не разбирается
    again = await load(tmp_path, factory, [2024])
    assert again.counts["files.unchanged"] == 1 and again.counts["files.loaded"] == 0
    assert (again.rows_read, again.created, again.updated) == (0, 0, 0)
    assert again.files == first.files
    assert again.freshness["years"]["2024"] == {
        "status": "unchanged",
        "last_date": date(2024, 11, 17),
    }
    assert await counts(db) == before

    # --force: разбирается заново, но в базе ничего не меняется
    forced = await load(tmp_path, factory, [2024], force=True)
    assert forced.counts["files.loaded"] == 1 and forced.rows_read == 11
    assert (forced.created, forced.updated) == (0, 0)
    assert await counts(db) == before

    # Кэф изменился: строка кэфа обновлена, а не добавлена
    rows[-1]["PSW"] = 1.35
    write_year(tmp_path, 2024, rows)
    changed = await load(tmp_path, factory, [2024])
    assert (changed.created, changed.updated) == (0, 1)
    assert changed.counts["odds.updated"] == 1
    assert await counts(db) == before
    db.expunge_all()
    assert (await odds_of(db, world["m_final"].id))[("pinnacle", 1)] == Decimal("1.350")


async def test_year_without_pinnacle_and_excel_number_date(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    world = await sackmann_world(db)
    rows = [
        make_row(
            5,
            "Doha",
            45000,  # 15 марта 2023 года числом Excel
            "Medvedev D.",
            "Sinner J.",
            series="ATP250",
            odds={"B365W": 1.9, "B365L": 1.9, "BFEW": 2.02, "BFEL": 1.98, "EXW": 1.5},
        ),
        make_row(
            5,
            "Doha",
            d(2023, 3, 16),
            "Medvedev D.",
            "Alcaraz C.",
            round_label="2nd Round",
            odds={"B365W": 2.2},
        ),
    ]
    write_year(tmp_path, 2023, rows, HEADER_NO_PS)
    report = await load(tmp_path, factory, [2023])
    db.expunge_all()
    matches = await own_matches(db)
    first = matches["Daniil Medvedev — Jannik Sinner"]
    assert first.match_date == date(2023, 3, 15)
    # Колонки Betfair (BFE*) — betfair_ex, неизвестные (EX*) пропущены
    assert await odds_of(db, first.id) == {
        ("bet365", 1): Decimal("1.900"),
        ("bet365", 2): Decimal("1.900"),
        ("betfair_ex", 1): Decimal("2.020"),
        ("betfair_ex", 2): Decimal("1.980"),
    }
    assert first.player2_id == world["sinner"].id
    year = report.freshness["years"]["2023"]
    assert year["pinnacle_share"] == 0.0 and year["rows"] == 2
    assert year["first_date"] == date(2023, 3, 15)


async def test_ambiguous_player_goes_to_report(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    world = await sackmann_world(db)
    # Второй «Zverev A.», игравший в 2023 году: при матче 2024 года неясно, кто из двоих
    alexey = await add_player(db, "Alexey Zverev", 999001)
    old = await add_tournament(db, "2023-999", "Old Open", date(2023, 5, 1))
    await add_match(db, old, 1, "R32", alexey, world["ramos"], alexey)
    await db.commit()
    rows = [
        make_row(30, "Dubai", d(2024, 2, 26), "Zverev A.", "Medvedev D."),
        make_row(30, "Dubai", d(2024, 2, 27), "Zverev M.", "Alcaraz C."),
    ]
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    assert list(await own_matches(db)) == ["Mischa Zverev — Carlos Alcaraz"]
    assert report.counts["unmatched.player_ambiguous"] == 1
    example = report.unmatched[0]
    assert example["kind"] == "player_ambiguous" and example["winner"] == "Zverev A."
    assert example["candidates"] == [sorted([world["sascha"].id, alexey.id])]
    assert example["file"] == "2024/2024.xlsx" and example["line"] == 2
    assert report.counts["players.created"] == 0


async def test_old_namesake_does_not_block(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    world = await sackmann_world(db)
    # Тезка играл в 2015 году — дальше двух лет от матча 2024 года: выбран Александр
    alexey = await add_player(db, "Alexey Zverev", 999001)
    old = await add_tournament(db, "2015-999", "Old Open", date(2015, 5, 1))
    await add_match(db, old, 1, "R32", alexey, world["ramos"], alexey)
    await db.commit()
    write_year(tmp_path, 2024, [make_row(30, "Dubai", d(2024, 2, 26), "Zverev A.", "Medvedev D.")])
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    assert list(await own_matches(db)) == ["Alexander Zverev — Daniil Medvedev"]
    assert not report.unmatched


async def test_same_pair_next_week(db: AsyncSession, factory: Factory, tmp_path: Path) -> None:
    """Пара, сыгравшая и на прошлой неделе, не привязывается к прошлому турниру; пара,
    которая есть у Сакманна, когда турнир группы не выбран, идет в отчет, а не в дубль."""
    world = await sackmann_world(db)
    p = world
    week1 = await add_tournament(db, "2024-500", "Marseille", date(2024, 2, 19))
    m_week1 = await add_match(db, week1, 1, "F", p["sinner"], p["medvedev"], p["sinner"])
    m_other = await add_match(db, week1, 2, "SF", p["alcaraz"], p["felix"], p["alcaraz"])
    await db.commit()
    rows = [
        make_row(
            40, "Marseille", d(2024, 2, 25), "Sinner J.", "Medvedev D.", round_label="The Final"
        ),
        make_row(
            41, "Acapulco", d(2024, 3, 2), "Sinner J.", "Medvedev D.", round_label="The Final"
        ),
        make_row(41, "Acapulco", d(2024, 2, 28), "Alcaraz C.", "Auger-Aliassime F."),
        make_row(41, "Acapulco", d(2024, 2, 27), "Ruud C.", "Fritz T."),
        make_row(41, "Acapulco", d(2024, 2, 27), "Rune H.", "Tsitsipas S."),
    ]
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    assert (await db.get_one(Match, m_week1.id)).match_date == date(2024, 2, 25)
    assert (await db.get_one(Match, m_other.id)).match_date is None
    assert set(await own_matches(db)) == {
        "Jannik Sinner — Daniil Medvedev",
        "C. Ruud — T. Fritz",
        "H. Rune — S. Tsitsipas",
    }
    assert report.counts["unmatched.in_sackmann"] == 1
    assert report.unmatched[0]["match_ids"] == [m_other.id]
    assert report.counts["players.created"] == 4


async def own_rounds(db: AsyncSession) -> dict[str, str]:
    """Свои матчи: «Победитель — Проигравший» → раунд."""
    return {pair: match.round for pair, match in (await own_matches(db)).items()}


async def test_tournament_in_progress_then_complete(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """Файл текущего года растет, пока турнир идет: оценка сетки меняется, а с ней код
    раунда. Матчи не дублируются, код раунда исправляется."""
    first_round = [(f"Aaa{n} A.", f"Bbb{n} B.") for n in range(3)]
    rows = [make_row(70, "Atlanta", d(2024, 7, 22), win, lose) for win, lose in first_round]
    write_year(tmp_path, 2024, rows)
    await load(tmp_path, factory, [2024])
    db.expunge_all()
    # По трем матчам первого круга сетка выглядит как 16
    assert set((await own_rounds(db)).values()) == {"R16"}

    rows += [make_row(70, "Atlanta", d(2024, 7, 23), f"Ccc{n} C.", f"Ddd{n} D.") for n in range(9)]
    rows += [
        make_row(70, "Atlanta", d(2024, 7, 24), "Aaa0 A.", "Aaa1 A.", round_label="2nd Round"),
        make_row(70, "Atlanta", d(2024, 7, 24), "Aaa2 A.", "Ccc0 C.", round_label="2nd Round"),
    ]
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    found = await own_rounds(db)
    assert len(found) == await count(db, Match) == 14
    assert found["A. Aaa0 — B. Bbb0"] == "R32" and found["A. Aaa0 — A. Aaa1"] == "R16"
    assert list(found.values()).count("R32") == 12
    assert report.counts["matches.created"] == 11 and report.counts["matches.updated"] == 3
    assert report.counts["odds.created"] == 11 * 6 and report.counts["odds.updated"] == 0
    assert await count(db, OddsSnapshot) == 14 * 6
    assert report.counts["matches.deleted"] == 0


async def test_corrected_row_replaces_own_match(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """tennis-data исправил строку (перепутал победителя): прежний свой матч удален вместе
    с кэфами, а не остался дублем."""
    rows = [
        make_row(70, "Atlanta", d(2024, 7, 22), "Aaa A.", "Bbb B."),
        make_row(70, "Atlanta", d(2024, 7, 22), "Ccc C.", "Ddd D."),
    ]
    write_year(tmp_path, 2024, rows)
    await load(tmp_path, factory, [2024])
    old = (await own_matches(db))["A. Aaa — B. Bbb"]
    rows[0] = make_row(70, "Atlanta", d(2024, 7, 22), "Bbb B.", "Aaa A.")
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    assert set(await own_matches(db)) == {"B. Bbb — A. Aaa", "C. Ccc — D. Ddd"}
    assert await db.get(Match, old.id) is None
    assert await odds_of(db, old.id) == {}
    assert await count(db, OddsSnapshot) == 2 * 6
    assert report.counts["matches.deleted"] == 1 and report.counts["matches.created"] == 1
    assert any(f"матч {old.id})" in warning for warning in report.warnings)
    assert not report.unmatched

    # Повтор без изменений: ничего не удаляется и не создается
    again = await load(tmp_path, factory, [2024], force=True)
    assert (again.created, again.updated) == (0, 0)


async def test_orphan_with_user_data_is_kept(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """Матч, которого нет в файле, но на который ссылаются данные участника (здесь кэф
    user), не удаляется: предупреждение о возможном дубле."""
    rows = [make_row(70, "Atlanta", d(2024, 7, 22), "Aaa A.", "Bbb B.")]
    write_year(tmp_path, 2024, rows)
    await load(tmp_path, factory, [2024])
    old = (await own_matches(db))["A. Aaa — B. Bbb"]
    db.add(
        OddsSnapshot(
            match_id=old.id,
            market="ML",
            selection=1,
            bookmaker="user",
            odds=Decimal("1.9"),
            kind="user",
        )
    )
    await db.commit()
    write_year(tmp_path, 2024, [make_row(70, "Atlanta", d(2024, 7, 22), "Bbb B.", "Aaa A.")])
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    assert set(await own_matches(db)) == {"A. Aaa — B. Bbb", "B. Bbb — A. Aaa"}
    assert report.counts["matches.deleted"] == 0
    assert report.counts["warnings.ingest_tennis_data.warnings.own_match_kept"] == 1


async def test_orphan_of_unmatched_row_is_kept(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """Строка, которая раньше стала матчем, теперь неоднозначна (появился тезка): матч
    остается, строка — в отчете."""
    world = await sackmann_world(db)
    write_year(tmp_path, 2024, [make_row(30, "Dubai", d(2024, 2, 26), "Zverev A.", "Medvedev D.")])
    await load(tmp_path, factory, [2024])
    assert list(await own_matches(db)) == ["Alexander Zverev — Daniil Medvedev"]
    alexey = await add_player(db, "Alexey Zverev", 999001)
    old = await add_tournament(db, "2023-999", "Old Open", date(2023, 5, 1))
    await add_match(db, old, 1, "R32", alexey, world["ramos"], alexey)
    await db.commit()
    report = await load(tmp_path, factory, [2024], force=True)
    db.expunge_all()
    assert list(await own_matches(db)) == ["Alexander Zverev — Daniil Medvedev"]
    assert report.counts["unmatched.player_ambiguous"] == 1
    assert report.counts["matches.deleted"] == 0
    assert report.counts["warnings.ingest_tennis_data.warnings.own_match_kept"] == 1


async def test_own_match_found_by_pair(db: AsyncSession, factory: Factory, tmp_path: Path) -> None:
    """source_ref прежнего вида или исправленная метка раунда: матч находится по паре
    игроков в турнире и обновляется, а не дублируется."""
    rows = [make_row(70, "Atlanta", d(2024, 7, 22), "Aaa A.", "Bbb B.")]
    write_year(tmp_path, 2024, rows)
    await load(tmp_path, factory, [2024])
    match = (await own_matches(db))["A. Aaa — B. Bbb"]
    match.source_ref = "0" * 32
    await db.commit()
    rows[0]["Round"] = "Quarterfinals"
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    found = await own_matches(db)
    assert list(found) == ["A. Aaa — B. Bbb"] and found["A. Aaa — B. Bbb"].id == match.id
    assert found["A. Aaa — B. Bbb"].round == "QF"
    assert found["A. Aaa — B. Bbb"].source_ref == td.own_match_ref(
        2024, 70, "Quarterfinals", "Aaa A.", "Bbb B."
    )
    assert report.counts["matches.updated"] == 1 and report.counts["matches.created"] == 0


async def test_namesake_with_other_first_letters(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """В базе только Andrey Kuznetsov: строка «Kuznetsov Al.» ему не приписывается, а
    создает нового игрока."""
    world = await sackmann_world(db)
    andrey = await add_player(db, "Andrey Kuznetsov", 105000)
    await db.commit()
    rows = [
        make_row(30, "Dubai", d(2024, 2, 26), "Kuznetsov Al.", "Medvedev D."),
        make_row(30, "Dubai", d(2024, 2, 26), "Kuznetsov An.", "Alcaraz C."),
    ]
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    db.expunge_all()
    found = await own_matches(db)
    assert set(found) == {"Al. Kuznetsov — Daniil Medvedev", "Andrey Kuznetsov — Carlos Alcaraz"}
    assert found["Andrey Kuznetsov — Carlos Alcaraz"].player1_id == andrey.id
    assert found["Al. Kuznetsov — Daniil Medvedev"].player2_id == world["medvedev"].id
    assert report.counts["players.created"] == 1


async def test_missing_files_and_unsupported_years(db: AsyncSession, factory: Factory) -> None:
    this_year = datetime.now(UTC).year
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.path)
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    # Только текущий год (ночной запуск): файла еще может не быть — не ошибка
    async with DataSource.http("http://td.test", transport=transport) as source:
        report = await td.load_tennis_data(years=[this_year], source=source, db_factory=factory)
    assert report.freshness["years"][str(this_year)] == {"status": "missing"}
    assert report.freshness["current_year_last_date"] is None
    assert report.warnings == [] and report.files == {}
    requested.clear()
    # Прошлого года на сайте нет — адрес неверен: запуск неудачный (иначе «ok» с нулем
    # строк, и уведомление о старых данных не пришло бы никогда)
    async with DataSource.http("http://td.test", transport=transport) as source:
        with pytest.raises(IngestError) as caught:
            await td.load_tennis_data(
                years=[2012, this_year - 1, this_year, this_year + 1],
                source=source,
                db_factory=factory,
            )
    assert caught.value.key == "ingest_tennis_data.errors.files_missing"
    assert requested == [f"/{this_year - 1}/{this_year - 1}.xlsx", f"/{this_year}/{this_year}.xlsx"]
    runs = list(await db.scalars(select(IngestionRun).order_by(IngestionRun.id)))
    assert [run.status for run in runs] == ["ok", "failed"]
    details = runs[1].details
    assert details["freshness"]["missing_files"] == [
        f"{this_year - 1}/{this_year - 1}.xlsx",
        f"{this_year}/{this_year}.xlsx",
    ]
    # Файла текущего года нет — не замечание; прошлого года — замечание
    counts = details["counts"]
    assert counts["warnings.ingest_tennis_data.warnings.file_missing"] == 1
    assert counts["warnings.ingest_tennis_data.warnings.year_unsupported"] == 2


async def test_empty_folder_is_an_error(db: AsyncSession, factory: Factory, tmp_path: Path) -> None:
    """Пустая или не та папка: ни одного файла из запрошенных — запуск неудачный. Нет
    только файла текущего года — не ошибка (его может еще не быть)."""
    this_year = datetime.now(UTC).year
    async with DataSource.local(tmp_path) as source:
        with pytest.raises(IngestError) as caught:
            await td.load_tennis_data(
                years=[this_year - 2, this_year - 1, this_year], source=source, db_factory=factory
            )
        assert caught.value.key == "ingest_tennis_data.errors.nothing_found"
        report = await td.load_tennis_data(years=[this_year], source=source, db_factory=factory)
    assert report.counts["files.missing"] == 1
    lines = td.summary_lines(report, str(tmp_path))
    assert f"{this_year}: файла пока нет" in lines
    write_year(tmp_path, this_year - 1, [])
    async with DataSource.local(tmp_path) as source:
        report = await td.load_tennis_data(
            years=[this_year - 2, this_year - 1], source=source, db_factory=factory
        )
    # В папке часть лет: остальные — замечание, без «пока»
    assert f"{this_year - 2}: файла нет" in td.summary_lines(report, str(tmp_path))
    statuses = list(await db.scalars(select(IngestionRun.status).order_by(IngestionRun.id)))
    assert statuses == ["failed", "ok", "ok"]


@pytest.mark.parametrize(
    ("response", "key"),
    [
        (httpx.Response(403, text="You are unable to access"), "ingest_tennis_data.errors.blocked"),
        (
            httpx.Response(200, text="<!DOCTYPE html><html><title>Just a moment...</title>"),
            "ingest_tennis_data.errors.not_xlsx",
        ),
        (httpx.Response(200, content=b"not a table"), "ingest_tennis_data.errors.bad_file"),
        (httpx.Response(200, content=b"PK\x03\x04broken"), "ingest_tennis_data.errors.bad_file"),
    ],
)
async def test_blocked_or_bad_file(
    db: AsyncSession, factory: Factory, response: httpx.Response, key: str
) -> None:
    transport = httpx.MockTransport(lambda request: response)
    async with DataSource.http("http://td.test", transport=transport) as source:
        with pytest.raises(IngestError) as caught:
            await td.load_tennis_data(years=[2024], source=source, db_factory=factory)
    assert caught.value.key == key
    run = (await db.scalars(select(IngestionRun))).one()
    assert run.status == "failed" and run.error == caught.value.message
    if key != "ingest_tennis_data.errors.bad_file":
        assert td.MANUAL_PAGE in caught.value.message
        assert "--tennis-data-dir" in caught.value.message


async def test_missing_columns(db: AsyncSession, factory: Factory, tmp_path: Path) -> None:
    write_year(tmp_path, 2024, [], header=["ATP", "Winner", "Loser", "Date"])
    with pytest.raises(IngestError) as caught:
        await load(tmp_path, factory, [2024])
    assert caught.value.key == "ingest_tennis_data.errors.missing_columns"
    assert "tournament, round, comment" in caught.value.message
    write_year(tmp_path, 2024, [], header=["Something", "Else"])
    with pytest.raises(IngestError) as caught:
        await load(tmp_path, factory, [2024])
    assert caught.value.key == "ingest_tennis_data.errors.no_header"


async def test_bad_rows_are_reported(db: AsyncSession, factory: Factory, tmp_path: Path) -> None:
    await sackmann_world(db)
    rows = [
        make_row(50, "Halle", d(2024, 6, 17), "Sinner J.", "Medvedev D."),
        make_row(50, "Halle", "когда-то", "Sinner J.", "Medvedev D."),
        make_row(50, "Halle", d(2024, 6, 18), "", "Medvedev D."),
        make_row(50, "Halle", d(2024, 6, 19), "Sinner J.", "Medvedev D.", round_label="Bronze"),
    ]
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    assert report.counts["skipped.bad_date"] == 1
    assert report.counts["skipped.bad_row"] == 1
    assert report.counts["skipped.bad_round"] == 1
    assert report.counts["rows.own"] == 1
    assert any("Bronze" in warning for warning in report.warnings)


def test_unmatched_kinds_have_texts() -> None:
    for kind in td.UNMATCHED_KINDS:
        assert has_key(f"ingest_tennis_data.unmatched.{kind}"), kind


def test_parse_years() -> None:
    assert td.parse_years("2024", first=2013, last=2026) == [2024]
    assert td.parse_years("2019,2024-2026", first=2013, last=2026) == [2019, 2024, 2025, 2026]
    for bad in ("2012", "2025-2024", "abc", "2024-2027", ""):
        with pytest.raises(ValueError):
            td.parse_years(bad, first=2013, last=2026)


# --- команда терминала ---


async def run_main(*argv: str) -> int:
    return await asyncio.to_thread(td.main, list(argv))


async def test_main_with_dir(
    db: AsyncSession, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    world = await sackmann_world(db)
    write_year(tmp_path, 2024, rows_2024())
    assert await run_main("--years", "2024", "--dir", str(tmp_path)) == 0
    out = capsys.readouterr().out
    assert "tennis-data.co.uk" in out and str(tmp_path) in out
    assert "2024: строк 10, последний день 2024-11-17, кэфы Pinnacle у 80% строк" in out
    assert "X. Newguy" in out
    db.expunge_all()
    assert (await db.get_one(Match, world["m_r32"].id)).match_date == date(2024, 2, 13)
    # Повтор: файл без изменений
    assert await run_main("--years", "2024", "--dir", str(tmp_path)) == 0
    assert "без изменений 1" in capsys.readouterr().out


async def test_main_waits_for_update_lock(
    db: AsyncSession, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пока идет обновление данных, отдельная загрузка не начинается (runs.update_lock)."""
    await sackmann_world(db)
    write_year(tmp_path, 2024, rows_2024())
    await db.execute(text("SELECT pg_advisory_lock(:key)"), {"key": UPDATE_LOCK_KEY})
    try:
        assert await run_main("--years", "2024", "--dir", str(tmp_path)) == 1
    finally:
        await db.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": UPDATE_LOCK_KEY})
        await db.commit()
    assert t("ingest_update.errors.busy") in capsys.readouterr().err
    assert await db.scalar(select(func.count()).select_from(IngestionRun)) == 0


def test_main_bad_arguments(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # До подключения к базе: в этом же потоке
    assert td.main(["--dir", str(tmp_path / "nope")]) == 1
    assert "Папка не найдена" in capsys.readouterr().err
    with pytest.raises(SystemExit) as caught:
        td.main(["--years", "1999"])
    assert caught.value.code == 2
    assert "Неверные годы" in capsys.readouterr().err


async def test_main_error_exit_code(
    db: AsyncSession, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # Вместо таблицы — веб-страница: понятная ошибка, код 1
    (tmp_path / "2024.xlsx").write_bytes(b"<html><body>Just a moment</body></html>")
    assert await run_main("--years", "2024", "--dir", str(tmp_path)) == 1
    assert "веб-страница" in capsys.readouterr().err
