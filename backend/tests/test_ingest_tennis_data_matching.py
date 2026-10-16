"""Сопоставление строк tennis-data с матчами Сакманна на настоящих турнирах и именах.

Случаи из прогона у владельца (11 октября 2026): турниры, игроки и матчи — как их создает
загрузчик Сакманна по копии архива (имя — «name_first name_last» из atp_players.csv, а у
кого там нет — имя из строки матча, например «Bu Yunchaokete»; player1 — победитель),
строки tennis-data — с именами в стиле сайта («Barrios M.», «Hernandez A.», «Bu Y.»).
Файлы xlsx тест собирает сам (бинарники в git не кладем).
"""

import re
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.i18n import t
from app.db.models import Match, Player, Tournament
from app.db.session import create_sessionmaker
from app.ingest import tennis_data as td
from app.ingest.fetch import DataSource
from app.services import players as players_service
from tests.tennis_data_files import make_row, write_year
from tests.test_ingest_tennis_data import Factory, count, d, load, odds_of, own_matches

# Игрок Сакманна: (имя, как его пишет загрузчик Сакманна, id Сакманна)
SackPlayer = tuple[str, int]


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> Factory:
    return create_sessionmaker(engine)


class Archive:
    """Турниры, игроки и матчи Сакманна в базе, как их пишет загрузчик Сакманна."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db
        self.players: dict[int, Player] = {}
        self.tournaments: dict[str, Tournament] = {}
        # (tourney_id, раунд, победитель, проигравший) → матч
        self.matches: dict[tuple[str, str, str, str], Match] = {}

    async def player(self, name: str, sackmann_id: int) -> Player:
        if sackmann_id not in self.players:
            player = Player(name=name, sackmann_id=sackmann_id)
            self.db.add(player)
            await self.db.flush()
            self.players[sackmann_id] = player
        return self.players[sackmann_id]

    async def tournament(
        self,
        tourney_id: str,
        name: str,
        start: date,
        matches: list[tuple[str, SackPlayer, SackPlayer]],
        *,
        category: str = "atp",
    ) -> Tournament:
        tournament = Tournament(
            name=name,
            source="sackmann",
            source_ref=tourney_id,
            start_date=start,
            category=category,
            surface="hard",
            best_of=3,
        )
        self.db.add(tournament)
        await self.db.flush()
        self.tournaments[tourney_id] = tournament
        for number, (round_code, (winner_name, winner_id), (loser_name, loser_id)) in enumerate(
            matches, start=1
        ):
            winner = await self.player(winner_name, winner_id)
            loser = await self.player(loser_name, loser_id)
            match = Match(
                tournament_id=tournament.id,
                round=round_code,
                player1_id=winner.id,
                player2_id=loser.id,
                winner_id=winner.id,
                score="6-4 6-4",
                status="finished",
                best_of=3,
                source="sackmann",
                source_ref=f"{tourney_id}-{300 - number}",
            )
            self.db.add(match)
            await self.db.flush()
            self.matches[(tourney_id, round_code, winner_name, loser_name)] = match
        return tournament

    def match(self, tourney_id: str, round_code: str, winner: str, loser: str) -> Match:
        return self.matches[(tourney_id, round_code, winner, loser)]


async def dates_of(db: AsyncSession, matches: list[Match]) -> list[date | None]:
    db.expunge_all()
    return [(await db.get_one(Match, match.id)).match_date for match in matches]


# --- игроки турнира: фамилия среди слов полного имени ---

BARRIOS = ("Tomas Barrios Vera", 144642)
GALAN = ("Daniel Elahi Galan", 123755)
ZAPATA = ("Bernabe Zapata Miralles", 126523)
BAEZ = ("Sebastian Baez", 202104)
HERNANDEZ = ("Juan Alejandro Hernandez Serrano", 207834)
ANDUJAR = ("Pablo Andujar", 104665)
BU = ("Bu Yunchaokete", 207352)
KECMANOVIC = ("Miomir Kecmanovic", 200175)
KORDA = ("Sebastian Korda", 200624)


def candidate(index: td.PlayerIndex, players: dict[int, str]) -> td._Candidate:
    """Турнир Сакманна, где каждый игрок сыграл один матч с соседом по списку."""
    for player_id, name in players.items():
        index.add(player_id, [name], searchable=True)
    ids = sorted(players)
    matches = [
        td._SackMatch(number, "R32", first, second, first, None)
        for number, (first, second) in enumerate(zip(ids, ids[1:] + ids[:1], strict=True))
    ]
    tournament = Tournament(name="Test", source="sackmann", source_ref="T", start_date=date.today())
    return td._Candidate.build(tournament, matches, index)


def test_surname_inside_full_name() -> None:
    index = td.PlayerIndex()
    name = index.name
    assert name("Barrios M.").inside([("tomas", "barrios", "vera")]) == 1
    assert name("Hernandez A.").inside([("juan", "alejandro", "hernandez", "serrano")]) == 2
    assert name("Bu Y.").inside([("bu", "yunchaokete")]) == 2
    assert name("Zapata Miralles B.").inside([("bernabe", "zapata", "miralles")]) == 2
    # Фамилия — только целыми словами: «Bu» не часть «Bublik»
    assert name("Bu Y.").inside([("alexander", "bublik")]) == 0
    # Слитно и раздельно — одна фамилия
    assert name("Delpotro J.M.").inside([("juan", "martin", "del", "potro")]) == 2
    # Первое слово — имя: фамилией оно считается только с инициалом
    assert name("Daniel T.").inside([("daniel", "evans")]) == 0
    assert name("Bu Q.").inside([("bu", "yunchaokete")]) == 0


def test_tournament_levels() -> None:
    index = td.PlayerIndex()
    cand = candidate(
        index,
        {
            1: "Tomas Barrios Vera",
            2: "Juan Alejandro Hernandez Serrano",
            3: "Bu Yunchaokete",
            4: "Andres Martin",
            5: "Juan Martin del Potro",
            6: "Mikael Ymer",
            7: "Elias Ymer",
            8: "Andrey Kuznetsov",
        },
    )
    levels = cand.levels
    # Единственный игрок турнира с такой фамилией — он, даже при другом инициале
    assert levels(index.name("Barrios M."), index) == {1: 1}
    assert levels(index.name("Hernandez A."), index) == {2: 2}
    assert levels(index.name("Bu Y."), index) == {3: 2}
    # Из нескольких выбирают инициалы: Andres Martin, а не Juan Martin del Potro
    assert levels(index.name("Martin A."), index) == {4: 2}
    # По ключам все как раньше: тезки остаются, выбор — по паре и раунду
    assert levels(index.name("Ymer E."), index) == {6: 1, 7: 2}
    assert levels(index.name("Del Potro J.M."), index) == {5: 2}
    # Тезка с другим началом имени не подходит и по фамилии внутри имени
    assert levels(index.name("Kuznetsov Al."), index) == {}
    assert levels(index.name("Newman Q."), index) == {}


def test_tournament_levels_initials_choose() -> None:
    """Двое с фамилией внутри полного имени: берется тот, чей инициал совпал; не совпал
    ни у кого — никто (дальше причина «игрок не найден среди игроков турнира»)."""
    index = td.PlayerIndex()
    cand = candidate(index, {1: "Tomas Barrios Vera", 2: "Marcelo Barrios Lopez"})
    assert cand.levels(index.name("Barrios M."), index) == {2: 2}
    assert cand.levels(index.name("Barrios T."), index) == {1: 2}
    assert cand.levels(index.name("Barrios X."), index) == {}


def test_tournament_levels_given_name_is_not_surname() -> None:
    """Фамилия tennis-data бывает именем другого игрока турнира: «Novak D.» (Dennis Novak)
    и Novak Djokovic, «Daniel T.» (Taro Daniel) и Daniel Gimeno Traver, Daniel Evans.
    Нашелся по ключам игрок с фамилией и инициалом — по словам имени не ищется."""
    index = td.PlayerIndex()
    cand = candidate(
        index,
        {1: "Dennis Novak", 2: "Novak Djokovic", 3: "Taro Daniel", 4: "Daniel Gimeno Traver"},
    )
    assert cand.levels(index.name("Novak D."), index) == {1: 2}
    assert cand.levels(index.name("Djokovic N."), index) == {2: 2}
    assert cand.levels(index.name("Daniel T."), index) == {3: 2}
    # Taro Daniel в турнире нет: Daniel Evans — не он, хоть и единственный «Daniel»
    index = td.PlayerIndex()
    alone = candidate(index, {1: "Daniel Evans", 2: "Radu Albot"})
    assert alone.levels(index.name("Daniel T."), index) == {}
    assert alone.find(index.name("Albot R."), index.name("Daniel T."), index, set()) == []


def test_global_search_stays_strict_and_alias_wins() -> None:
    index = td.PlayerIndex()
    index.add(1, ["Tomas Barrios Vera"], searchable=True)
    # По всей базе фамилия внутри имени не ищется: игроков много
    assert index.candidates(index.name("Barrios M.")) == set()
    for player_id, name in [
        (2, "Chun Hun Wong"),
        (3, "Coleman Wong"),
        (4, "Chak Lam Coleman Wong"),
    ]:
        index.add(player_id, [name], searchable=True)
    assert index.candidates(index.name("Wong C.")) == {2, 3, 4}
    # Алиас, который дал человек (players-edit --add-alias), важнее ключей
    index.add(5, ["Coleman Wong Jr", "Wong C."], searchable=True, aliases=["Wong C."])
    assert index.candidates(index.name(" Wong  C. ")) == {5}
    # Игрок вне поиска (старый бот) по алиасу тоже не находится
    index.add(6, ["Иванов И.", "Ivanov I."], searchable=False, aliases=["Ivanov I."])
    assert index.candidates(index.name("Ivanov I.")) == set()


async def test_surname_inside_full_name_links(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """«Barrios M.», «Hernandez A.», «Bu Y.» (и их соперники «Galan D.E.»,
    «Zapata Miralles B.») находятся в своих турнирах Сакманна. Свой матч tennis-data
    (турнира у Сакманна нет) ищет игрока по всей базе строго: «Barrios M.» — новый игрок."""
    archive = Archive(db)
    await archive.tournament(
        "2023-9158",
        "Cordoba",
        date(2023, 2, 6),
        [("R32", BARRIOS, GALAN), ("R16", BARRIOS, ZAPATA), ("QF", BAEZ, BARRIOS)],
    )
    await archive.tournament(
        "2022-0807", "Acapulco", date(2022, 2, 21), [("R32", ANDUJAR, HERNANDEZ)]
    )
    await archive.tournament(
        "2023-5014",
        "Shanghai Masters",
        date(2023, 10, 2),
        [("R128", BU, KECMANOVIC), ("R64", KORDA, BU)],
        category="masters",
    )
    await db.commit()
    cordoba: dict[str, Any] = dict(location="Cordoba", surface="Clay")
    write_year(
        tmp_path,
        2023,
        [
            make_row(6, "Cordoba Open", d(2023, 2, 7), "Barrios M.", "Galan D.E.", **cordoba),
            make_row(
                6,
                "Cordoba Open",
                d(2023, 2, 9),
                "Barrios M.",
                "Zapata Miralles B.",
                round_label="2nd Round",
                **cordoba,
            ),
            make_row(
                6,
                "Cordoba Open",
                d(2023, 2, 10),
                "Baez S.",
                "Barrios M.",
                round_label="Quarterfinals",
                **cordoba,
            ),
            make_row(
                55,
                "Shanghai Rolex Masters",
                d(2023, 10, 4),
                "Bu Y.",
                "Kecmanovic M.",
                series="Masters 1000",
            ),
            make_row(
                55,
                "Shanghai Rolex Masters",
                d(2023, 10, 6),
                "Korda S.",
                "Bu Y.",
                round_label="2nd Round",
                series="Masters 1000",
            ),
            # Турнира у Сакманна нет: игрок ищется по всей базе строго
            make_row(90, "Exhibition Open", d(2023, 12, 4), "Barrios M.", "Baez S."),
        ],
    )
    write_year(
        tmp_path,
        2022,
        [make_row(8, "Abierto Mexicano", d(2022, 2, 22), "Andujar P.", "Hernandez A.")],
    )
    report = await load(tmp_path, factory, [2022, 2023])
    assert not report.unmatched, report.unmatched
    assert report.counts["rows.linked"] == 6 and report.counts["rows.own"] == 1
    linked = [
        archive.match("2023-9158", "R32", BARRIOS[0], GALAN[0]),
        archive.match("2023-9158", "R16", BARRIOS[0], ZAPATA[0]),
        archive.match("2023-9158", "QF", BAEZ[0], BARRIOS[0]),
        archive.match("2023-5014", "R128", BU[0], KECMANOVIC[0]),
        archive.match("2023-5014", "R64", KORDA[0], BU[0]),
        archive.match("2022-0807", "R32", ANDUJAR[0], HERNANDEZ[0]),
    ]
    assert await dates_of(db, linked) == [
        date(2023, 2, 7),
        date(2023, 2, 9),
        date(2023, 2, 10),
        date(2023, 10, 4),
        date(2023, 10, 6),
        date(2022, 2, 22),
    ]
    assert (await odds_of(db, linked[0].id))[("pinnacle", 1)] == td.to_odds(1.52)
    assert list(await own_matches(db)) == ["M. Barrios — Sebastian Baez"]
    assert report.counts["players.created"] == 1


# Dubai 2020: Dennis Novak и Novak Djokovic, общий соперник Karen Khachanov
DJOKOVIC = ("Novak Djokovic", 104925)
DENNIS_NOVAK = ("Dennis Novak", 110602)
KHACHANOV = ("Karen Khachanov", 111575)
DUBAI = [
    ("R32", DJOKOVIC, ("Malek Jaziri", 104291)),
    ("R32", DENNIS_NOVAK, ("Prajnesh Gunneswaran", 105432)),
    ("R16", DJOKOVIC, ("Philipp Kohlschreiber", 104259)),
    ("R16", KHACHANOV, DENNIS_NOVAK),
    ("QF", DJOKOVIC, KHACHANOV),
]


async def test_given_name_namesakes_link(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """«Novak D.» — Dennis Novak, а не еще и Novak Djokovic: раньше строка R16
    «Khachanov K. — Novak D.» с неверной меткой «Quarterfinals» уходила в QF Djokovic —
    Khachanov с переворотом сторон, а строка этого QF — в отчет. «Daniel T.» — не Daniel
    Evans: строка Los Cabos 2019 (у Сакманна турнира нет) — свой матч, а не R16 Evans —
    Albot в Atlanta тех же дней."""
    archive = Archive(db)
    await archive.tournament("2020-0495", "Dubai", date(2020, 2, 24), DUBAI)
    albot, taro = ("Radu Albot", 105430), ("Taro Daniel", 106121)
    await archive.tournament(
        "2019-0439", "Umag", date(2019, 7, 15), [("R32", ("Filip Krajinovic", 105936), taro)]
    )
    evans = ("Daniel Evans", 105554)
    await archive.tournament(
        "2019-6116",
        "Atlanta",
        date(2019, 7, 22),
        [("R32", evans, ("Jason Jung", 105359)), ("R16", evans, albot)],
    )
    await db.commit()
    dubai: dict[str, Any] = dict(location="Dubai", series="ATP500")
    second, quarter = "2nd Round", "Quarterfinals"
    write_year(
        tmp_path,
        2020,
        [
            make_row(12, "Dubai", d(2020, 2, 24), "Djokovic N.", "Jaziri M.", **dubai),
            make_row(12, "Dubai", d(2020, 2, 24), "Novak D.", "Gunneswaran P.", **dubai),
            make_row(
                12,
                "Dubai",
                d(2020, 2, 26),
                "Djokovic N.",
                "Kohlschreiber P.",
                round_label=second,
                **dubai,
            ),
            # Ошибка файла: R16 с меткой четвертьфинала
            make_row(
                12,
                "Dubai",
                d(2020, 2, 26),
                "Khachanov K.",
                "Novak D.",
                round_label=quarter,
                **dubai,
            ),
            make_row(
                12,
                "Dubai",
                d(2020, 2, 27),
                "Djokovic N.",
                "Khachanov K.",
                round_label=quarter,
                **dubai,
            ),
        ],
    )
    write_year(
        tmp_path,
        2019,
        [
            make_row(
                41,
                "Los Cabos",
                d(2019, 8, 1),
                "Albot R.",
                "Daniel T.",
                round_label=second,
                location="Los Cabos",
            )
        ],
    )
    report = await load(tmp_path, factory, [2019, 2020])
    assert not report.unmatched, report.unmatched
    assert not report.warnings, report.warnings
    assert report.counts["rows.linked"] == len(DUBAI) and report.counts["rows.own"] == 1
    linked = [archive.match("2020-0495", code, win[0], lose[0]) for code, win, lose in DUBAI]
    assert await dates_of(db, linked) == [
        date(2020, 2, 24),
        date(2020, 2, 24),
        date(2020, 2, 26),
        date(2020, 2, 26),
        date(2020, 2, 27),
    ]
    # Победитель строки — первый игрок матча: стороны не перевернуты
    for match in linked:
        assert (await odds_of(db, match.id))[("pinnacle", 1)] == td.to_odds(1.52)
    assert list(await own_matches(db)) == ["Radu Albot — Taro Daniel"]
    assert await dates_of(db, [archive.match("2019-6116", "R16", evans[0], albot[0])]) == [None]


# --- номер ATP у двух турниров ---

STOCKHOLM = [
    ("R32", ("Lorenzo Sonego", 132283), ("Dusan Lajovic", 105583)),
    ("R32", ("Dino Prizmic", 209976), ("Jiri Lehecka", 208103)),
    ("R32", ("Miomir Kecmanovic", 200175), ("Karl Friberg", 200418)),
    ("R32", ("Elias Ymer", 111200), ("Roberto Bautista Agut", 105138)),
    ("F", ("Gael Monfils", 104792), ("Pavel Kotov", 200303)),
]
TOKYO = [
    ("R32", ("Taylor Fritz", 126203), ("Cameron Norrie", 111815)),
    ("R32", ("Shintaro Mochizuki", 208278), ("Tomas Martin Etcheverry", 144869)),
    ("R32", ("Cristian Garin", 106426), ("Sho Shimabukuro", 200647)),
    ("R32", ("Alexei Popyrin", 200615), ("Karen Khachanov", 111575)),
    ("R32", ("Alex De Minaur", 200282), ("Jack Draper", 207733)),
    ("R32", ("Ben Shelton", 210097), ("Taro Daniel", 106121)),
    ("F", ("Ben Shelton", 210097), ("Aslan Karatsev", 106234)),
]
ANTWERP = [
    ("SF", ("Arthur Fils", 209950), ("Stefanos Tsitsipas", 126774)),
    ("F", ("Alexander Bublik", 122330), ("Arthur Fils", 209950)),
]
TD_NAMES = {
    "Dusan Lajovic": "Lajovic D.",
    "Roberto Bautista Agut": "Bautista Agut R.",
    "Tomas Martin Etcheverry": "Etcheverry T.M.",
    "Alex De Minaur": "De Minaur A.",
}


def td_name(name: str) -> str:
    """Имя в стиле tennis-data: «Lorenzo Sonego» → «Sonego L.»."""
    if name in TD_NAMES:
        return TD_NAMES[name]
    first, last = name.rsplit(" ", 1)
    return f"{last} {first[0]}."


def td_rows(
    atp: int, tournament: str, location: str, start: date, matches: list[Any]
) -> list[dict[str, Any]]:
    labels = {
        "R32": "1st Round",
        "R16": "2nd Round",
        "QF": "Quarterfinals",
        "SF": "Semifinals",
        "F": "The Final",
    }
    offsets = {"R32": 0, "R16": 2, "QF": 4, "SF": 5, "F": 6}
    return [
        make_row(
            atp,
            tournament,
            d(start.year, start.month, start.day + offsets[code]),
            td_name(winner[0]),
            td_name(loser[0]),
            round_label=labels[code],
            location=location,
            court="Indoor",
        )
        for code, winner, loser in matches
    ]


async def test_two_tournaments_under_one_atp_number(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """Stockholm 2023 (Nordic Open) и Tokyo 2023 в файле под одним номером ATP: раньше
    весь номер доставался Tokyo (строк больше), а 27 строк Stockholm уходили в отчет
    «нет матча этой пары». Теперь турнир выбирается для каждого названия."""
    archive = Archive(db)
    week = date(2023, 10, 16)
    stockholm = await archive.tournament("2023-0429", "Stockholm", week, STOCKHOLM)
    tokyo = await archive.tournament("2023-0329", "Tokyo", week, TOKYO)
    await archive.tournament("2023-7485", "Antwerp", week, ANTWERP)
    await db.commit()
    rows = (
        td_rows(60, "Nordic Open", "Stockholm", week, STOCKHOLM)
        + td_rows(60, "Japan Open Tennis Championships", "Tokyo", week, TOKYO)
        + td_rows(61, "European Open", "Antwerp", week, ANTWERP)
    )
    write_year(tmp_path, 2023, rows)
    report = await load(tmp_path, factory, [2023])
    assert not report.unmatched, report.unmatched
    assert report.counts["rows.linked"] == len(rows)
    assert report.counts["rows.linked_elsewhere"] == 0
    matches = [archive.match("2023-0429", code, win[0], lose[0]) for code, win, lose in STOCKHOLM]
    assert await dates_of(db, matches) == [
        date(2023, 10, 16),
        date(2023, 10, 16),
        date(2023, 10, 16),
        date(2023, 10, 16),
        date(2023, 10, 22),
    ]
    # Каждый турнир Сакманна дополнен сведениями своих строк
    assert (await db.get_one(Tournament, stockholm.id)).city == "Stockholm"
    assert (await db.get_one(Tournament, tokyo.id)).city == "Tokyo"
    assert await own_matches(db) == {}
    # Повтор: ничего не меняется
    again = await load(tmp_path, factory, [2023], force=True)
    assert (again.created, again.updated) == (0, 0) and not again.unmatched


MONTPELLIER = [
    ("R32", ("Mikael Ymer", 144707), ("Jannik Sinner", 206173)),
    ("R16", ("Gael Monfils", 104792), ("Adrian Mannarino", 105173)),
    ("QF", ("Gael Monfils", 104792), ("Norbert Gombos", 105613)),
    ("SF", ("Gael Monfils", 104792), ("Filip Krajinovic", 105936)),
    ("F", ("Gael Monfils", 104792), ("Vasek Pospisil", 105577)),
]
PUNE = [
    ("R32", ("Jiri Vesely", 106210), ("Arjun Kadhe", 111459)),
    ("QF", ("Jiri Vesely", 106210), ("Ilya Ivashka", 125802)),
    ("SF", ("Jiri Vesely", 106210), ("Ricardas Berankis", 105575)),
    ("F", ("Jiri Vesely", 106210), ("Egor Gerasimov", 106078)),
]


@pytest.mark.parametrize("foreign_name", [False, True])
async def test_row_with_number_of_other_tournament(
    db: AsyncSession, factory: Factory, tmp_path: Path, foreign_name: bool
) -> None:
    """Финал Montpellier 2020 в файле под номером Pune той же недели: раньше строка
    уходила в турнир Pune и в отчет. С названием Montpellier она — своя часть номера;
    с чужим названием ее находит поиск по турнирам дня с тем же раундом."""
    archive = Archive(db)
    week = date(2020, 2, 3)
    await archive.tournament("2020-0375", "Montpellier", week, MONTPELLIER)
    pune = await archive.tournament("2020-0891", "Pune", week, PUNE)
    await db.commit()
    montpellier_rows = td_rows(6, "Open Sud de France", "Montpellier", week, MONTPELLIER)
    final = montpellier_rows.pop()
    # R16 Monfils — Mannarino в файле нет: проверка раунда при поиске по другим турнирам
    montpellier_rows.pop(1)
    final["ATP"] = 7
    extra: list[dict[str, Any]] = []
    if foreign_name:
        final["Tournament"], final["Location"] = "Maharashtra Open", "Pune"
        # Чужой номер и раунд не тот (у Сакманна R16): строку не привязать
        extra = [
            make_row(
                7,
                "Maharashtra Open",
                d(2020, 2, 7),
                "Monfils G.",
                "Mannarino A.",
                round_label="Quarterfinals",
                location="Pune",
            )
        ]
    rows = montpellier_rows + td_rows(7, "Maharashtra Open", "Pune", week, PUNE) + [final] + extra
    write_year(tmp_path, 2020, rows)
    report = await load(tmp_path, factory, [2020])
    final_match = archive.match("2020-0375", "F", "Gael Monfils", "Vasek Pospisil")
    assert await dates_of(db, [final_match]) == [date(2020, 2, 9)]
    assert (await odds_of(db, final_match.id))[("pinnacle", 1)] == td.to_odds(1.52)
    assert report.counts["rows.linked"] == len(montpellier_rows) + len(PUNE) + 1
    if not foreign_name:
        assert not report.unmatched and report.counts["rows.linked_elsewhere"] == 0
        return
    assert report.counts["rows.linked_elsewhere"] == 1
    warning = t(
        "ingest_tennis_data.warnings.row_elsewhere",
        path="2020/2020.xlsx",
        line=rows.index(final) + 2,
        winner="Monfils G.",
        loser="Pospisil V.",
        tournament="Pune",
        ref="2020-0891",
        other="Montpellier",
        other_ref="2020-0375",
    )
    assert warning in report.warnings
    lines = td.summary_lines(report, str(tmp_path))
    assert t("ingest_tennis_data.summary.elsewhere", count=1) in lines
    # Пара есть в Montpellier, но в другом раунде: строка не привязана, причина точная
    assert [row["kind"] for row in report.unmatched] == ["player_not_in_tournament"]
    example = report.unmatched[0]
    assert example["missing"] == "Monfils G., Mannarino A."
    assert (example["sackmann_tournament"], example["sackmann_ref"]) == (pune.id, "2020-0891")
    mannarino = archive.match("2020-0375", "R16", "Gael Monfils", "Adrian Mannarino")
    assert await dates_of(db, [mannarino]) == [None]


async def test_unlinked_part_of_linked_number_is_reported(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """Часть номера, которой нет у Сакманна, рядом с привязанной частью — только в отчет
    («турнир Сакманна не найден»): своего турнира и матча нет, как и раньше у строки без
    пары в привязанном номере."""
    archive = Archive(db)
    await archive.tournament("2020-0891", "Pune", date(2020, 2, 3), PUNE)
    await db.commit()
    rows = [
        *td_rows(7, "Maharashtra Open", "Pune", date(2020, 2, 3), PUNE),
        make_row(
            7,
            "Open Sud de France",
            d(2020, 2, 9),
            "Monfils G.",
            "Newman Q.",
            round_label="The Final",
        ),
    ]
    write_year(tmp_path, 2020, rows)
    report = await load(tmp_path, factory, [2020])
    assert report.counts["rows.linked"] == len(PUNE) and report.counts["rows.own"] == 0
    assert [row["kind"] for row in report.unmatched] == ["tournament_not_found"]
    assert report.unmatched[0]["linked"] == "2020-0891"
    assert await own_matches(db) == {}
    assert await db.scalar(select(Tournament).where(Tournament.source == "tennis_data")) is None


async def test_shared_number_without_sackmann_is_one_own_tournament(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """Два турнира под одним номером, обоих у Сакманна нет: как и раньше, один свой
    турнир «год-номер», и повторный разбор ничего не меняет."""
    rows = [
        make_row(70, "Atlanta Open", d(2025, 7, 21), "Aaa A.", "Bbb B.", location="Atlanta"),
        make_row(70, "Generali Open", d(2025, 7, 21), "Ccc C.", "Ddd D.", location="Kitzbuhel"),
        make_row(70, "Atlanta Open", d(2025, 7, 22), "Eee E.", "Fff F.", location="Atlanta"),
        make_row(70, "Generali Open", d(2025, 7, 22), "Ggg G.", "Hhh H.", location="Kitzbuhel"),
    ]
    write_year(tmp_path, 2025, rows)
    first = await load(tmp_path, factory, [2025])
    assert first.counts["tournaments.created"] == 1 and first.counts["rows.own"] == 4
    tournaments = list(await db.scalars(select(Tournament)))
    assert [(tour.source_ref, tour.name) for tour in tournaments] == [("2025-70", "Atlanta Open")]
    again = await load(tmp_path, factory, [2025], force=True)
    assert (again.created, again.updated) == (0, 0)
    assert await count(db, Match) == 4


# --- причины в отчете ---


async def test_unmatched_reasons(db: AsyncSession, factory: Factory, tmp_path: Path) -> None:
    """Строка без матча — в отчет с точной причиной и турниром Сакманна."""
    archive = Archive(db)
    sinner, medvedev = ("Jannik Sinner", 206173), ("Daniil Medvedev", 106421)
    felix, sascha = ("Felix Auger Aliassime", 200000), ("Alexander Zverev", 100644)
    await archive.tournament(
        "2024-407",
        "Rotterdam",
        date(2024, 2, 12),
        [("R32", sinner, felix), ("QF", medvedev, ("Juan Martin del Potro", 105223))],
    )
    await archive.tournament(
        "2024-605",
        "Tour Finals",
        date(2024, 11, 10),
        [("RR", sinner, sascha), ("F", sinner, sascha)],
        category="finals",
    )
    await db.commit()
    rotterdam = "ABN AMRO World Tennis Tournament"
    rows = [
        make_row(10, rotterdam, d(2024, 2, 13), "Sinner J.", "Auger-Aliassime F."),
        make_row(
            10,
            rotterdam,
            d(2024, 2, 16),
            "Medvedev D.",
            "Del Potro J.M.",
            round_label="Quarterfinals",
        ),
        # Игрока нет среди игроков турнира
        make_row(10, rotterdam, d(2024, 2, 14), "Sinner J.", "Newman Q.", round_label="2nd Round"),
        # Оба игрока есть, матча между ними нет
        make_row(
            10,
            rotterdam,
            d(2024, 2, 14),
            "Medvedev D.",
            "Auger-Aliassime F.",
            round_label="2nd Round",
        ),
        # Повтор строки: матч уже привязан
        make_row(10, rotterdam, d(2024, 2, 13), "Sinner J.", "Auger-Aliassime F."),
        # Пара сыграла дважды (круговой этап и финал), а раунд в строке другой
        make_row(
            66, "Masters Cup", d(2024, 11, 16), "Sinner J.", "Zverev A.", round_label="Semifinals"
        ),
    ]
    write_year(tmp_path, 2024, rows)
    report = await load(tmp_path, factory, [2024])
    by_kind = {row["kind"]: row for row in report.unmatched}
    assert sorted(by_kind) == [
        "match_ambiguous",
        "match_not_found",
        "match_taken",
        "player_not_in_tournament",
    ]
    rotterdam_ref = {
        "sackmann_tournament": archive.tournaments["2024-407"].id,
        "sackmann_ref": "2024-407",
        "sackmann_name": "Rotterdam",
    }
    missing = by_kind["player_not_in_tournament"]
    assert missing["missing"] == "Newman Q." and missing["line"] == 4
    assert missing.items() >= rotterdam_ref.items()
    assert by_kind["match_not_found"].items() >= rotterdam_ref.items()
    taken = by_kind["match_taken"]
    assert taken["match_ids"] == [archive.match("2024-407", "R32", sinner[0], felix[0]).id]
    ambiguous = by_kind["match_ambiguous"]
    assert ambiguous["sackmann_ref"] == "2024-605"
    assert ambiguous["match_ids"] == sorted(
        archive.match("2024-605", code, sinner[0], sascha[0]).id for code in ("RR", "F")
    )
    lines = td.summary_lines(report, str(tmp_path))
    reason = t(
        "ingest_tennis_data.unmatched.player_not_in_tournament",
        missing="Newman Q.",
        sackmann_name="Rotterdam",
        sackmann_ref="2024-407",
    )
    assert (
        reason == "игрок «Newman Q.» не найден среди игроков турнира Сакманна Rotterdam (2024-407)"
    )
    assert any(line.endswith(reason) for line in lines)
    assert not any("{" in line for line in lines)


async def test_alias_resolves_ambiguous_player(
    db: AsyncSession, factory: Factory, tmp_path: Path
) -> None:
    """«Wong C.» подходит трем игрокам базы: строка своего матча — в отчет с подсказкой.
    Владелец дает нужному игроку алиас «Wong C.» (players-edit --add-alias), и следующая
    загрузка берет его."""
    archive = Archive(db)
    wongs = [("Chun Hun Wong", 124022), ("Coleman Wong", 209409), ("Chak Lam Coleman Wong", 208597)]
    opponent = ("Giovanni Mpetshi Perricard", 208659)
    await archive.tournament(
        "2025-0303",
        "Hong Kong",
        date(2025, 3, 3),
        [("R32", wong, ("Some Player", 900000 + n)) for n, wong in enumerate(wongs)],
    )
    await archive.player(*opponent)
    await db.commit()
    rows = [make_row(80, "Chengdu Open", d(2025, 9, 20), "Wong C.", "Mpetshi Perricard G.")]
    write_year(tmp_path, 2025, rows)
    report = await load(tmp_path, factory, [2025])
    assert [row["kind"] for row in report.unmatched] == ["player_ambiguous"]
    example = report.unmatched[0]
    ids = sorted(archive.players[sid].id for _, sid in wongs)
    assert example["name"] == "Wong C." and example["candidates"] == [ids]
    lines = td.summary_lines(report, str(tmp_path))
    assert any('players-edit ID --add-alias "Wong C."' in line for line in lines)

    coleman = archive.players[209409]
    await players_service.edit_player(db, coleman.id, add_alias="Wong C.", actor_id=None)
    again = await load(tmp_path, factory, [2025], force=True)
    assert not again.unmatched
    assert list(await own_matches(db)) == ["Coleman Wong — Giovanni Mpetshi Perricard"]


# --- ход работы ---


async def test_progress_messages(db: AsyncSession, factory: Factory, tmp_path: Path) -> None:
    rows = [
        make_row(70, "Atlanta", d(2024, 7, 22), "Aaa A.", "Bbb B."),
        make_row(70, "Atlanta", d(2024, 7, 22), "Ccc C.", "Ddd D."),
    ]
    path = write_year(tmp_path, 2024, rows)
    said: list[str] = []
    async with DataSource.local(tmp_path) as source:
        await td.load_tennis_data(
            years=[2023, 2024], source=source, db_factory=factory, progress=said.append
        )
    assert said[0] == t("ingest_tennis_data.progress.missing", path="2023/2023.xlsx")
    size = max(1, round(path.stat().st_size / 1024))
    assert said[1] == t("ingest_tennis_data.progress.fetched", path="2024/2024.xlsx", size=size)
    loaded = t(
        "ingest_tennis_data.progress.loaded",
        path="2024/2024.xlsx",
        rows=2,
        linked=0,
        own=2,
        unmatched=0,
        # Создано: игроков 4, турнир, 2 матча и 12 кэфов
        created=4 + 1 + 2 + 12,
        updated=0,
        seconds="X",
    )
    assert re.sub(r"за \d+,\d с$", "за X с", said[2]) == loaded
    assert len(said) == 3
    said.clear()
    async with DataSource.local(tmp_path) as source:
        await td.load_tennis_data(
            years=[2024], source=source, db_factory=factory, progress=said.append
        )
    assert said == [t("ingest_tennis_data.progress.unchanged", path="2024/2024.xlsx")]
