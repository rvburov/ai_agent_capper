"""Загрузчик архива Джеффа Сакманна (tennis_atp): игроки, турниры, матчи и статистика
подачи основного тура ATP. Данные: Jeff Sackmann / Tennis Abstract, CC BY-NC-SA 4.0.

    python -m app.ingest.sackmann --years 2000-2026 [--dir PATH] [--force]

- atp_matches_{год}.csv разбирается по году за раз, одна транзакция на файл. Файл, sha256
  которого совпал с успешным запуском, не разбирается заново (кроме --force). Файла
  текущего года может еще не быть: это отметка свежести, а не ошибка. Нет справочника
  или файла прошлого года в архиве по HTTP — неверный адрес, запуск неудачный.
- atp_players.csv — справочник: в players попадают только игроки загружаемых матчей.
  Поля, которые правят люди (name_ru, aliases), не затираются, старое имя при
  переименовании уходит в aliases. Игрок, которого раньше создал загрузчик tennis-data
  (без sackmann_id), «усыновляется»: ему ставится sackmann_id вместо создания нового.
- Турнир узнается по (sackmann, tourney_id), матч — по (sackmann, «tourney_id-match_num»)
  вместе с парой игроков, а после перенумерации у Сакманна — по турниру, раунду и паре
  (_assign_existing). player1 — победитель. Дат матчей у Сакманна нет: match_date ставит
  tennis-data.
- Матч tennis-data той же пары в окне турнира «повышается» до матча Сакманна: его id,
  дата и кэфы остаются, а пустой турнир tennis-data удаляется. Турнир tennis-data отдает
  матчи только одному турниру Сакманна (_owners), спорное — в отчет.

Журнал — ingestion_runs (source = sackmann): файлы с sha256, счетчики, пропуски с файлом
и строкой, несопоставленные строки, свежесть. Аудит администратора загрузка не пишет.
"""

import argparse
import asyncio
import copy
import csv
import io
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field, fields
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, cast

from sqlalchemy import Boolean, Table, and_, delete, exists, func, or_, select, text, tuple_, update
from sqlalchemy import literal_column as sql_literal
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.i18n import t
from app.db.base import Base
from app.db.models import (
    SURFACES,
    BetLeg,
    Match,
    MatchStat,
    OddsSnapshot,
    Player,
    Prediction,
    Tournament,
)
from app.db.models.tennis import HANDS
from app.db.session import create_engine, create_sessionmaker
from app.ingest.fetch import DataSource, FetchedFile
from app.ingest.names import name_keys, parse_tennis_data_name
from app.ingest.rounds import ROUNDS
from app.ingest.runs import (
    IngestError,
    IngestReport,
    ingestion_run,
    last_ok_file_hashes,
    update_lock,
)

SOURCE = "sackmann"
TENNIS_DATA = "tennis_data"
PLAYERS_FILE = "atp_players.csv"
# Источники матчей, чьих игроков можно «усыновить»: у них нет sackmann_id
ADOPT_FROM = ("tennis_data", "web")
# Строк в одной вставке: в пределах 32 767 параметров запроса asyncpg
BATCH = 2000
SCORE_LIMIT = 64
REF_LIMIT = 64
NAME_LIMIT = 200
MIN_YEAR = 1968
MAX_YEAR = 2100
# Окно поиска матча tennis-data вокруг tourney_date (у Сакманна это дата начала турнира):
# Большой шлем идет больше двух недель, а первые матчи бывают на пару дней раньше этой даты
PROMOTE_BEFORE = timedelta(days=3)
PROMOTE_AFTER = timedelta(days=16)
# Ключ pg_advisory_xact_lock: две загрузки архива не пишут один файл одновременно
LOCK_KEY = 0x73616B6D616E6E01
# Предупреждений в выводе команды; все — в ingestion_runs.details
WARNINGS_SHOWN = 20

# tourney_level → tournaments.category. Прочих уровней (челленджеры и т. п.) в файлах
# основного тура нет, а если появятся — строка пропускается: грузим только основной тур
CATEGORIES = {
    "G": "grand_slam",
    "M": "masters",
    "A": "atp",
    "F": "finals",
    "D": "davis_cup",
    "O": "olympics",
}
# Общая категория Сакманна: tennis-data уточняет ее до 250/500, и уточнение не затирается
GENERIC_CATEGORY = "atp"
# Колонка Сакманна (после w_ / l_) → поле match_stats
STAT_COLUMNS = {
    "ace": "aces",
    "df": "double_faults",
    "svpt": "serve_points",
    "1stIn": "first_in",
    "1stWon": "first_won",
    "2ndWon": "second_won",
    "SvGms": "serve_games",
    "bpSaved": "bp_saved",
    "bpFaced": "bp_faced",
}
MATCH_COLUMNS = (
    "tourney_id",
    "tourney_name",
    "surface",
    "tourney_level",
    "tourney_date",
    "match_num",
    "winner_id",
    "loser_id",
    "score",
    "best_of",
    "round",
)
PLAYER_COLUMNS = ("player_id", "name_first", "name_last")
# Круги квалификации: решение владельца — грузим только основную сетку
QUALIFYING = ("Q1", "Q2", "Q3", "Q4")
# Метка временного значения при обмене: рынок прогноза (см. _flip_sides), round и
# source_ref матча (см. _sync_matches)
_SWAP_MARK = "~"
_SET_SCORE = re.compile(r"\d+-\d+")
# Ключ names.name_keys вида «фамилия + один инициал»: «sinner j», «del potro j»
_INITIAL_KEY = re.compile(r".+ [a-z]")
_COUNTRY = re.compile(r"[A-Z]{3}")
_YEARS_PART = re.compile(r"(\d{4})(?:\s*-\s*(\d{4}))?")

# Почему строка матча не загружена (тексты — ingest_sackmann.skip.*)
SkipReason = Literal[
    "abandoned",
    "no_score",
    "bad_score",
    "bad_row",
    "other_level",
    "qualifying",
    "unknown_round",
    "same_player",
    "unknown_player",
    "duplicate",
    "conflict",
]


def current_year() -> int:
    return datetime.now(UTC).year


def parse_years(value: str) -> list[int]:
    """«2000-2026», «2024», «2019,2021-2023» → годы по возрастанию. Неверно — ValueError."""
    years: set[int] = set()
    for part in value.split(","):
        found = _YEARS_PART.fullmatch(part.strip())
        if found is None:
            raise ValueError(t("ingest_sackmann.errors.bad_years", value=value))
        first = int(found.group(1))
        last = int(found.group(2) or first)
        if first > last or first < MIN_YEAR or last > MAX_YEAR:
            raise ValueError(t("ingest_sackmann.errors.bad_years", value=value))
        years.update(range(first, last + 1))
    return sorted(years)


# --- разбор файлов ---


@dataclass(frozen=True)
class PlayerInfo:
    """Игрок из atp_players.csv, а если его там нет — из строки матча."""

    sackmann_id: int
    name: str
    hand: str | None = None
    country: str | None = None
    birth_date: date | None = None


@dataclass(frozen=True)
class MatchRow:
    """Строка atp_matches_{год}.csv после разбора. winner и loser — id Сакманна и данные
    игрока из самой строки (запасной вариант, если игрока нет в справочнике)."""

    line: int
    tourney_id: str
    tourney_name: str
    surface: str | None
    category: str
    tourney_date: date
    match_num: str
    round: str
    winner: PlayerInfo
    loser: PlayerInfo
    score: str
    status: str
    best_of: int | None
    stats: tuple[dict[str, int | None], dict[str, int | None]] | None

    @property
    def source_ref(self) -> str:
        return f"{self.tourney_id}-{self.match_num}"

    @property
    def pair(self) -> frozenset[int]:
        return frozenset((self.winner.sackmann_id, self.loser.sackmann_id))

    def describe(self) -> str:
        """Матч для текста отчета: «2024-580 Jannik Sinner – Daniil Medvedev 6-3 6-4»."""
        winner = self.winner.name or self.winner.sackmann_id
        loser = self.loser.name or self.loser.sackmann_id
        return f"{self.tourney_id} {winner} – {loser} {self.score}".strip()


@dataclass
class ParsedFile:
    """Разобранный файл матчей: годные строки, сколько строк прочитано, последняя
    дата начала турнира (свежесть)."""

    rows: list[MatchRow]
    read: int
    last_date: date | None


class _BadValue(ValueError):
    """Битое значение поля строки."""


class _Skip(Exception):
    def __init__(self, reason: SkipReason) -> None:
        super().__init__(reason)
        self.reason: SkipReason = reason


def _int(value: str) -> int | None:
    """Целое из CSV: «12», «12.0» (так пишет pandas). Пусто — None, иначе _BadValue."""
    if not value:
        return None
    try:
        number = float(value)
    except ValueError:
        raise _BadValue(value) from None
    if not number.is_integer():
        raise _BadValue(value)
    return int(number)


def _date(value: str) -> date | None:
    """Дата YYYYMMDD. Пусто — None, иначе _BadValue."""
    if not value:
        return None
    try:
        return datetime.strptime(value.removesuffix(".0"), "%Y%m%d").date()
    except ValueError:
        raise _BadValue(value) from None


def _hand(value: str) -> str | None:
    hand = value.upper()
    return hand if hand in HANDS else None


def _country(value: str) -> str | None:
    country = value.upper()
    return country if _COUNTRY.fullmatch(country) else None


def _status(score: str) -> str:
    """Статус матча по счету: finished, retired или walkover. Недоигранный (ABD), пустой
    и непонятный счет — _Skip: такой матч не грузится."""
    words = set(re.split(r"[\s.]+", score.upper())) - {""}
    if not words:
        raise _Skip("no_score")
    if "ABD" in words:
        raise _Skip("abandoned")
    if words & {"W/O", "WALKOVER"}:
        return "walkover"
    if words & {"RET", "DEF", "DEFAULT", "DISQ"}:
        return "retired"
    if not _SET_SCORE.search(score):
        raise _Skip("bad_score")
    return "finished"


def _decode(file: FetchedFile, report: IngestReport | None) -> str:
    try:
        return file.content.decode("utf-8-sig")
    except UnicodeDecodeError:
        if report is not None:
            report.add_warning("ingest_sackmann.warnings.not_utf8", file=file.path)
        return file.content.decode("latin-1")


def _reader(path: str, content: str, required: Sequence[str]) -> csv.DictReader[str]:
    reader = csv.DictReader(io.StringIO(content, newline=""))
    present = {name.strip() for name in reader.fieldnames or ()}
    missing = [name for name in required if name not in present]
    if missing:
        raise IngestError(
            "ingest_sackmann.errors.bad_header", file=path, columns=", ".join(missing)
        )
    reader.fieldnames = [name.strip() for name in reader.fieldnames or ()]
    return reader


def parse_players(path: str, content: str) -> dict[int, PlayerInfo]:
    """atp_players.csv → справочник по id Сакманна. Строки без id или без имени
    пропускаются: такой игрок возьмется из строки матча."""
    players: dict[int, PlayerInfo] = {}
    for raw in _reader(path, content, PLAYER_COLUMNS):
        cell = {key: (value or "").strip() for key, value in raw.items() if key is not None}
        name = " ".join(f"{cell.get('name_first', '')} {cell.get('name_last', '')}".split())
        try:
            sackmann_id = _int(cell["player_id"])
        except _BadValue:
            continue
        if sackmann_id is None or not name:
            continue
        try:
            birth_date = _date(cell.get("dob", ""))
        except _BadValue:
            birth_date = None
        players[sackmann_id] = PlayerInfo(
            sackmann_id=sackmann_id,
            name=name[:NAME_LIMIT],
            hand=_hand(cell.get("hand", "")),
            country=_country(cell.get("ioc", "")),
            birth_date=birth_date,
        )
    return players


def _row_player(cell: dict[str, str], side: str, sackmann_id: int) -> PlayerInfo:
    return PlayerInfo(
        sackmann_id=sackmann_id,
        name=" ".join(cell.get(f"{side}_name", "").split())[:NAME_LIMIT],
        hand=_hand(cell.get(f"{side}_hand", "")),
        country=_country(cell.get(f"{side}_ioc", "")),
    )


def _stats(
    cell: dict[str, str], bad: list[tuple[str, str]]
) -> tuple[dict[str, int | None], dict[str, int | None]] | None:
    """Статистика подачи победителя (w_*) и проигравшего (l_*). Нет ни одного числа — None.
    Битое или отрицательное число — None в поле и запись в bad."""
    sides: list[dict[str, int | None]] = []
    for prefix in ("w_", "l_"):
        values: dict[str, int | None] = {}
        for column, field_name in STAT_COLUMNS.items():
            raw = cell.get(prefix + column, "")
            try:
                number = _int(raw)
            except _BadValue:
                bad.append((prefix + column, raw))
                number = None
            if number is not None and number < 0:
                bad.append((prefix + column, raw))
                number = None
            values[field_name] = number
        sides.append(values)
    if all(value is None for side in sides for value in side.values()):
        return None
    return sides[0], sides[1]


def _match_row(cell: dict[str, str], line: int, bad: list[tuple[str, str]]) -> MatchRow:
    """Строка файла матчей → MatchRow или _Skip с причиной."""
    tourney_id = cell.get("tourney_id", "")
    match_num = cell.get("match_num", "")
    try:
        tourney_date = _date(cell.get("tourney_date", ""))
        winner_id = _int(cell.get("winner_id", ""))
        loser_id = _int(cell.get("loser_id", ""))
    except _BadValue:
        raise _Skip("bad_row") from None
    if (
        not tourney_id
        or not match_num
        or tourney_date is None
        or winner_id is None
        or loser_id is None
        or len(f"{tourney_id}-{match_num}") > REF_LIMIT
    ):
        raise _Skip("bad_row")
    category = CATEGORIES.get(cell.get("tourney_level", "").upper())
    if category is None:
        raise _Skip("other_level")
    round_code = cell.get("round", "").upper()
    if round_code not in ROUNDS:
        raise _Skip("unknown_round")
    if round_code in QUALIFYING:
        raise _Skip("qualifying")
    if winner_id == loser_id:
        raise _Skip("same_player")
    score = " ".join(cell.get("score", "").split())
    status = _status(score)
    try:
        best_of = _int(cell.get("best_of", ""))
    except _BadValue:
        bad.append(("best_of", cell.get("best_of", "")))
        best_of = None
    if best_of not in (None, 3, 5):
        bad.append(("best_of", cell.get("best_of", "")))
        best_of = None
    surface: str | None = cell.get("surface", "").lower() or None
    if surface is not None and surface not in SURFACES:
        bad.append(("surface", cell.get("surface", "")))
        surface = None
    return MatchRow(
        line=line,
        tourney_id=tourney_id,
        tourney_name=cell.get("tourney_name", "")[:NAME_LIMIT] or tourney_id,
        surface=surface,
        category=category,
        tourney_date=tourney_date,
        match_num=match_num,
        round=round_code,
        winner=_row_player(cell, "winner", winner_id),
        loser=_row_player(cell, "loser", loser_id),
        score=score[:SCORE_LIMIT],
        status=status,
        best_of=best_of,
        stats=_stats(cell, bad),
    )


def parse_matches(path: str, content: str, report: IngestReport | None = None) -> ParsedFile:
    """atp_matches_{год}.csv → годные строки. Пропуски и битые значения пишутся в report
    с файлом и номером строки (report = None — молча, только для свежести)."""
    reader = _reader(path, content, MATCH_COLUMNS)
    rows: list[MatchRow] = []
    read = 0
    last: date | None = None
    for raw in reader:
        read += 1
        cell = {key: (value or "").strip() for key, value in raw.items() if key is not None}
        bad: list[tuple[str, str]] = []
        try:
            row = _match_row(cell, reader.line_num, bad)
        except _Skip as skip:
            if report is not None:
                _report_skip(report, skip.reason, path, reader.line_num, _describe_raw(cell))
            continue
        if report is not None:
            for column, value in bad:
                report.add_warning(
                    "ingest_sackmann.warnings.bad_value",
                    file=path,
                    line=reader.line_num,
                    column=column,
                    value=value,
                )
        rows.append(row)
        last = row.tourney_date if last is None else max(last, row.tourney_date)
    return ParsedFile(rows=rows, read=read, last_date=last)


def _describe_raw(cell: dict[str, str]) -> str:
    parts = (cell.get(key, "") for key in ("tourney_id", "winner_name", "loser_name", "score"))
    return " ".join(part for part in parts if part)


def _report_skip(
    report: IngestReport, reason: SkipReason, path: str, line: int, match: str
) -> None:
    report.skip(reason)
    report.add_warning(
        "ingest_sackmann.warnings.row_skipped",
        file=path,
        line=line,
        reason=t(f"ingest_sackmann.skip.{reason}"),
        match=match,
    )


# --- состояние базы ---


@dataclass
class _PlayerState:
    id: int
    sackmann_id: int | None
    name: str
    aliases: list[str]
    hand: str | None
    country: str | None
    birth_date: date | None


_PLAYER_COLUMNS = (
    Player.id,
    Player.sackmann_id,
    Player.name,
    Player.aliases,
    Player.hand,
    Player.country,
    Player.birth_date,
)


def _player_state(row: Any) -> _PlayerState:
    return _PlayerState(
        id=row.id,
        sackmann_id=row.sackmann_id,
        name=row.name,
        aliases=list(row.aliases or []),
        hand=row.hand,
        country=row.country,
        birth_date=row.birth_date,
    )


@dataclass
class _TourState:
    id: int
    name: str
    category: str | None
    surface: str | None
    best_of: int | None
    start_date: date | None
    indoor: bool | None
    city: str | None


_TOUR_COLUMNS = (
    Tournament.id,
    Tournament.source_ref,
    Tournament.name,
    Tournament.category,
    Tournament.surface,
    Tournament.best_of,
    Tournament.start_date,
    Tournament.indoor,
    Tournament.city,
)


@dataclass
class _MatchState:
    id: int
    tournament_id: int | None
    round: str
    player1_id: int
    player2_id: int
    winner_id: int | None
    score: str | None
    status: str
    best_of: int | None
    source: str
    source_ref: str | None
    match_date: date | None

    @property
    def pair(self) -> frozenset[int]:
        return frozenset((self.player1_id, self.player2_id))

    @property
    def key(self) -> tuple[int | None, str, frozenset[int]]:
        return (self.tournament_id, self.round, self.pair)


# Поля уникальных ключей матча: UNIQUE(tournament_id, round, player1_id, player2_id) и
# UNIQUE(source, source_ref)
_MATCH_KEY_FIELDS = ("tournament_id", "round", "player1_id", "player2_id", "source", "source_ref")

_MATCH_COLUMNS = (
    Match.id,
    Match.tournament_id,
    Match.round,
    Match.player1_id,
    Match.player2_id,
    Match.winner_id,
    Match.score,
    Match.status,
    Match.best_of,
    Match.source,
    Match.source_ref,
    Match.match_date,
)


def _match_state(row: Any) -> _MatchState:
    return _MatchState(**row._mapping)


@dataclass(frozen=True)
class _Target:
    """Строка файла матчей с id базы: турнир, победитель, проигравший."""

    row: MatchRow
    tour_id: int
    winner: int
    loser: int

    @property
    def ref(self) -> str:
        return self.row.source_ref

    @property
    def pair(self) -> frozenset[int]:
        return frozenset((self.winner, self.loser))

    @property
    def key(self) -> tuple[int | None, str, frozenset[int]]:
        return (self.tour_id, self.row.round, self.pair)

    def values(self) -> dict[str, Any]:
        """Поля матча из строки: player1 — победитель. match_date не трогаем (tennis-data)."""
        return {
            "tournament_id": self.tour_id,
            "round": self.row.round,
            "player1_id": self.winner,
            "player2_id": self.loser,
            "winner_id": self.winner,
            "score": self.row.score,
            "status": self.row.status,
            "best_of": self.row.best_of,
            "source": SOURCE,
            "source_ref": self.ref,
        }


@dataclass
class _Assigned:
    """Матчи базы для строк файла (по source_ref строки)."""

    matches: dict[str, _MatchState]
    # Строки, у чьего матча Сакманн сменил игрока
    corrected: set[str]
    # Строки, чей source_ref занят матчем, который не достался ни одной строке: запись
    # нарушила бы UNIQUE(source, source_ref), разбирает человек
    conflicts: set[str]


def _assign_existing(targets: Sequence[_Target], existing: Sequence[_MatchState]) -> _Assigned:
    """Сопоставить строки файла с матчами базы. Результат не зависит от порядка строк.

    Шаги идут от точного к менее точному, и каждый шаг проходит все строки, прежде чем
    начнется следующий. На каждом шаге у матча не больше одного претендента: номера
    матчей и тройки (турнир, раунд, пара) в файле уже без повторов.
    1. Тот же source_ref, тот же турнир, раунд и пара.
    2. Тот же турнир, раунд и пара: Сакманн перенумеровал матчи турнира.
    3. Тот же source_ref и та же пара: Сакманн исправил раунд.
    4. Единственный матч Сакманна этой пары в турнире, если пара в турнире файла одна.
    5. Тот же source_ref, но другая пара — Сакманн исправил игрока. Только если прежней
       пары в этом турнире файла нет: иначе это сдвиг номеров, и матч со своими датой и
       кэфами не должен уйти к чужой паре.
    """
    ordered = sorted(existing, key=lambda match: match.id)
    by_ref = {m.source_ref: m for m in ordered if m.source == SOURCE and m.source_ref}
    by_key: dict[tuple[int | None, str, frozenset[int]], _MatchState] = {}
    by_pair: defaultdict[tuple[int | None, frozenset[int]], list[_MatchState]] = defaultdict(list)
    for match in ordered:
        by_key.setdefault(match.key, match)
        if match.source == SOURCE:
            by_pair[(match.tournament_id, match.pair)].append(match)
    in_file = Counter((target.tour_id, target.pair) for target in targets)
    out = _Assigned(matches={}, corrected=set(), conflicts=set())
    claimed: set[int] = set()

    def same_ref(target: _Target) -> _MatchState | None:
        match = by_ref.get(target.ref)
        return match if match is not None and match.key == target.key else None

    def same_key(target: _Target) -> _MatchState | None:
        return by_key.get(target.key)

    def same_ref_pair(target: _Target) -> _MatchState | None:
        match = by_ref.get(target.ref)
        return match if match is not None and match.pair == target.pair else None

    def only_pair(target: _Target) -> _MatchState | None:
        if in_file[(target.tour_id, target.pair)] > 1:
            return None
        free = [m for m in by_pair[(target.tour_id, target.pair)] if m.id not in claimed]
        return free[0] if len(free) == 1 else None

    def corrected(target: _Target) -> _MatchState | None:
        match = by_ref.get(target.ref)
        if match is None or match.tournament_id != target.tour_id:
            return None
        return None if in_file[(target.tour_id, match.pair)] else match

    for step in (same_ref, same_key, same_ref_pair, only_pair, corrected):
        for target in targets:
            if target.ref in out.matches:
                continue
            found = step(target)
            if found is not None and found.id not in claimed:
                out.matches[target.ref] = found
                claimed.add(found.id)
                if step is corrected:
                    out.corrected.add(target.ref)
    # source_ref строки занят матчем, который никому не достался: строку не пишем. Ее
    # матч освобождается — и его source_ref может оказаться занятым для другой строки
    while True:
        held = {ref for ref, match in by_ref.items() if match.id not in claimed}
        lost = [t for t in targets if t.ref in held and t.ref not in out.conflicts]
        if not lost:
            return out
        for target in lost:
            out.conflicts.add(target.ref)
            out.corrected.discard(target.ref)
            released = out.matches.pop(target.ref, None)
            if released is not None:
                claimed.discard(released.id)


@dataclass
class _Ownership:
    """Турниры tennis-data при повышении (_owners): кому отдан каждый и кто за него
    голосовал."""

    # Турнир tennis-data → id турнира Сакманна (tourney_id), с чьими строками общие пары
    # → id матчей tennis-data этих пар
    voters: Mapping[int, Mapping[str, set[int]]]
    # source_ref строки → матчи tennis-data той же пары в окне турнира
    edges: dict[str, list[_MatchState]]
    # Турнир tennis-data → турниры Сакманна, которым он отдан (большинство общих пар)
    owners: dict[int, set[str]] = field(default_factory=dict)
    # Турнир tennis-data → число его матчей
    sizes: dict[int, int] = field(default_factory=dict)
    # Даты начала: турнира tennis-data (по id) и турнира Сакманна (по tourney_id)
    td_starts: dict[int, date] = field(default_factory=dict)
    starts: dict[str, date] = field(default_factory=dict)
    # Матчи tennis-data, уже записанные в отчет как неоднозначные
    ambiguous: set[int] = field(default_factory=set)


@dataclass
class _Candidate:
    """Игрок без sackmann_id с матчами tennis-data или web: его можно «усыновить»."""

    state: _PlayerState
    # Ключи «фамилия + первый инициал»: «sinner j», «del potro j»
    initial_keys: set[str]
    # Полные инициалы tennis-data, если их больше одной буквы: «del potro jm»,
    # «kuznetsov an». У игрока Сакманна такой ключ должен быть, иначе это тезка
    strict_keys: set[str]


def _initial_keys(name: str) -> set[str]:
    return {key for key in name_keys(name) if _INITIAL_KEY.fullmatch(key)}


def _strict_keys(name: str) -> set[str]:
    surname, initials = parse_tennis_data_name(name)
    return {f"{surname} {initials}"} if len(initials) > 1 else set()


def _chunks[T](items: Sequence[T], size: int = BATCH) -> Iterator[Sequence[T]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


async def _bulk_update(db: AsyncSession, model: type[Base], rows: list[dict[str, Any]]) -> None:
    """UPDATE по первичному ключу пачками: id есть в каждом словаре (ORM bulk update)."""
    for chunk in _chunks(rows):
        await db.execute(update(model), list(chunk))


def _player_changes(state: _PlayerState, info: PlayerInfo) -> dict[str, Any] | None:
    """Новые значения игрока из Сакманна или None, если менять нечего. name_ru и aliases
    люди правят сами: имя только добавляется в aliases (старое — при переименовании).
    Пустые и «U» (рука неизвестна) у Сакманна не затирают известное значение."""
    aliases = list(state.aliases)
    if state.name and state.name != info.name and state.name not in aliases:
        aliases.append(state.name)
    hand = info.hand if info.hand not in (None, "U") else (state.hand or info.hand)
    want: dict[str, Any] = {
        "sackmann_id": info.sackmann_id,
        "name": info.name,
        "aliases": aliases,
        "hand": hand,
        "country": info.country or state.country,
        "birth_date": info.birth_date or state.birth_date,
    }
    if all(getattr(state, key) == value for key, value in want.items()):
        return None
    return want


async def _flip_sides(db: AsyncSession, match_ids: Sequence[int]) -> None:
    """Игроки матча меняются местами: исход 1 ↔ 2 у кэфов, прогнозов и событий ставок.

    Обмен одним UPDATE нарушил бы уникальные индексы (PostgreSQL проверяет их построчно,
    и строка «1 → 2» сталкивается с еще не обновленной «2»). Поэтому кэфы удаляются и
    вставляются заново с теми же id (на них никто не ссылается), а у прогнозов (на них
    ссылаются ставки) к рынку на время обмена добавляется метка.
    """
    if not match_ids:
        return
    ids = list(match_ids)
    odds = cast(Table, OddsSnapshot.__table__)
    old = (
        (await db.execute(delete(odds).where(odds.c.match_id.in_(ids)).returning(*odds.c)))
        .mappings()
        .all()
    )
    if old:
        flipped = [{**row, "selection": 3 - row["selection"]} for row in old]
        await db.execute(insert(odds), flipped)
    no_sync = {"synchronize_session": False}
    await db.execute(
        update(BetLeg)
        .where(BetLeg.match_id.in_(ids))
        .values(selection=3 - BetLeg.selection)
        .execution_options(**no_sync)
    )
    await db.execute(
        update(Prediction)
        .where(Prediction.match_id.in_(ids))
        .values(market=Prediction.market + _SWAP_MARK, selection=3 - Prediction.selection)
        .execution_options(**no_sync)
    )
    await db.execute(
        update(Prediction)
        .where(Prediction.match_id.in_(ids), Prediction.market.endswith(_SWAP_MARK))
        .values(market=func.left(Prediction.market, -len(_SWAP_MARK)))
        .execution_options(**no_sync)
    )


# --- загрузка ---


class _Loader:
    def __init__(
        self,
        *,
        source: DataSource,
        factory: Callable[[], AsyncSession],
        report: IngestReport,
        force: bool,
    ) -> None:
        self.source = source
        self.factory = factory
        self.report = report
        self.force = force
        self.hashes: dict[str, str] = {}
        self.players_file: FetchedFile | None = None
        self._players: dict[int, PlayerInfo] | None = None
        self.failed: list[str] = []
        self.years: dict[str, dict[str, Any]] = {}
        self.missing: list[str] = []
        # Файлы прошлых лет, которых нет в HTTP-источнике: адрес архива, скорее всего, неверен
        self.absent: list[str] = []
        # Источник — архив по HTTP (не папка --dir): там справочник и прошлые годы есть всегда
        self.remote = source.directory is None
        # Турнир tennis-data, чей матч повышен, → турнир Сакманна (в пределах файла)
        self.moved: dict[int, int] = {}
        self.tours: dict[int, _TourState] = {}

    @property
    def counts(self) -> Counter[str]:
        return self.report.counts

    def _created(self, entity: str, count: int) -> None:
        self.report.created += count
        self.counts[f"{entity}.created"] += count

    def _updated(self, entity: str, count: int) -> None:
        self.report.updated += count
        self.counts[f"{entity}.updated"] += count

    def players_info(self) -> dict[int, PlayerInfo]:
        if self._players is None:
            file = self.players_file
            self._players = (
                parse_players(file.path, _decode(file, self.report)) if file is not None else {}
            )
        return self._players

    async def run(self, years: Sequence[int]) -> None:
        async with self.factory() as db:
            self.hashes = await last_ok_file_hashes(db, SOURCE)
        try:
            self.players_file = await self.source.fetch(PLAYERS_FILE)
            players_changed = False
            if self.players_file is None:
                if self.remote:
                    # Справочник в архиве есть всегда: 404 — сменился адрес, ветка или
                    # репозиторий. Иначе ночная загрузка шла бы «успешно» с нулем строк
                    raise IngestError(
                        "ingest_sackmann.errors.players_missing",
                        file=PLAYERS_FILE,
                        location=self.source.location,
                    )
                self.report.add_warning(
                    "ingest_sackmann.warnings.players_missing", file=PLAYERS_FILE
                )
            else:
                self.report.add_file(self.players_file)
                players_changed = self.force or (
                    self.hashes.get(self.players_file.path) != self.players_file.sha256
                )
            for year in sorted(set(years)):
                await self._year(year)
            if players_changed:
                await self._in_transaction(PLAYERS_FILE, self._refresh_players)
        finally:
            # Свежесть — и в отчете упавшего запуска: видно, до какого года дошли
            dates = [item["last_tourney_date"] for item in self.years.values() if "matches" in item]
            self.report.freshness = {
                "source": self.source.location,
                "years": dict(sorted(self.years.items())),
                "missing_files": list(self.missing),
                "last_tourney_date": max((d for d in dates if d is not None), default=None),
            }
        if self.failed:
            # Причины (конфликт в базе, нет файла) — в предупреждениях отчета
            files = ", ".join([*self.failed, *self.absent])
            raise IngestError("ingest_sackmann.errors.files_failed", files=files)
        if self.absent:
            raise IngestError(
                "ingest_sackmann.errors.files_missing",
                files=", ".join(self.absent),
                location=self.source.location,
            )
        if self.players_file is None and not any("matches" in item for item in self.years.values()):
            # Папка без единого файла архива: скорее всего, указана не та
            raise IngestError("ingest_sackmann.errors.nothing_found", location=self.source.location)

    async def _year(self, year: int) -> None:
        name = f"atp_matches_{year}.csv"
        file = await self.source.fetch(name)
        if file is None:
            self.years[str(year)] = {"missing": True}
            self.missing.append(name)
            self.counts["files.missing"] += 1
            # Файла текущего года может еще не быть — это свежесть, а не ошибка
            if year < current_year():
                self.report.add_warning("ingest_sackmann.warnings.file_missing", file=name)
                if self.remote:
                    self.absent.append(name)
            return
        self.report.add_file(file)
        unchanged = not self.force and self.hashes.get(file.path) == file.sha256
        # Неизменившийся файл разбирается молча, только ради свежести в отчете
        report = None if unchanged else self.report
        parsed = parse_matches(file.path, _decode(file, report), report)
        self.years[str(year)] = {"last_tourney_date": parsed.last_date, "matches": len(parsed.rows)}
        if unchanged:
            self.counts["files.unchanged"] += 1
            return
        self.report.rows_read += parsed.read

        async def load(db: AsyncSession) -> None:
            await self._load_rows(db, file.path, parsed.rows)

        if await self._in_transaction(file.path, load):
            self.counts["files.processed"] += 1

    async def _in_transaction(self, path: str, work: Callable[[AsyncSession], Any]) -> bool:
        """Одна транзакция на файл. Конфликт в базе откатывает только этот файл: отчет
        возвращается к состоянию до файла, sha256 файла не запоминается (он будет разобран
        заново), а запуск в конце помечается неудачным."""
        snapshot = copy.deepcopy(self.report)
        try:
            async with self.factory() as db:
                await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})
                self.moved = {}
                self.tours = {}
                await work(db)
                await db.commit()
        except IntegrityError as exc:
            for item in fields(IngestReport):
                setattr(self.report, item.name, getattr(snapshot, item.name))
            self.report.files.pop(path, None)
            cause = getattr(exc.orig, "__cause__", None)
            constraint = getattr(cause, "constraint_name", None) or type(exc.orig).__name__
            self.report.add_warning(
                "ingest_sackmann.warnings.file_failed", file=path, constraint=constraint
            )
            self.failed.append(path)
            return False
        return True

    # --- игроки ---

    def _resolve_players(self, path: str, rows: list[MatchRow]) -> dict[int, PlayerInfo]:
        """Данные игроков файла: из справочника, а если там нет — из строки матча."""
        known = self.players_info()
        infos: dict[int, PlayerInfo] = {}
        for row in rows:
            for side in (row.winner, row.loser):
                sackmann_id = side.sackmann_id
                if sackmann_id in infos:
                    continue
                info = known.get(sackmann_id)
                if info is None and side.name:
                    info = side
                    self.report.add_warning(
                        "ingest_sackmann.warnings.player_from_match",
                        sackmann_id=sackmann_id,
                        name=side.name,
                        file=path,
                        line=row.line,
                    )
                if info is not None:
                    infos[sackmann_id] = info
        return infos

    async def _sync_players(
        self, db: AsyncSession, infos: dict[int, PlayerInfo], *, path: str, adopt: bool
    ) -> dict[int, int]:
        """Игроки по id Сакманна: найти, «усыновить» или создать, обновить. → id в базе."""
        existing: dict[int, _PlayerState] = {}
        for part in _chunks(sorted(infos)):
            result = await db.execute(select(*_PLAYER_COLUMNS).where(Player.sackmann_id.in_(part)))
            for row in result:
                state = _player_state(row)
                assert state.sackmann_id is not None
                existing[state.sackmann_id] = state
        new = {sid: info for sid, info in infos.items() if sid not in existing}
        if adopt and new:
            adopted = await self._adopt(db, new, path)
            self.counts["players.adopted"] += len(adopted)
            existing.update(adopted)
            for sid in adopted:
                del new[sid]
        updates: list[dict[str, Any]] = []
        for sid, state in existing.items():
            changes = _player_changes(state, infos[sid])
            if changes is not None:
                updates.append({"id": state.id, **changes})
        await _bulk_update(db, Player, updates)
        self._updated("players", len(updates))
        ids = {sid: state.id for sid, state in existing.items()}
        values = [
            {
                "sackmann_id": info.sackmann_id,
                "name": info.name,
                "hand": info.hand,
                "country": info.country,
                "birth_date": info.birth_date,
            }
            for info in new.values()
        ]
        for chunk in _chunks(values):
            stmt = (
                insert(Player)
                .values(list(chunk))
                .on_conflict_do_nothing(index_elements=[Player.sackmann_id])
                .returning(Player.id, Player.sackmann_id)
            )
            for player_id, sackmann_id in await db.execute(stmt):
                assert sackmann_id is not None
                ids[sackmann_id] = player_id
                self._created("players", 1)
        return ids

    async def _adopt(
        self, db: AsyncSession, new: dict[int, PlayerInfo], path: str
    ) -> dict[int, _PlayerState]:
        """Игроки, созданные загрузчиком tennis-data (без sackmann_id, с матчами
        tennis-data или web), которых можно взять вместо создания нового.

        Кандидат — общий ключ «фамилия + первый инициал» (names.name_keys) и нет
        противоречия в полных инициалах («Kuznetsov An.» — не Alex Kuznetsov). Берется,
        только если кандидат ровно один и на него не претендует другой новый игрок файла;
        иначе создается новый игрок, а в отчет идет «возможный дубль» (слить командой
        players-merge). Кандидат с тем же ключом, но другими полными инициалами не
        берется, но тоже идет в отчет: «Kwon S.W.» у tennis-data и «Soonwoo Kwon» у
        Сакманна — один человек, и без отчета его матчи tennis-data остались бы дублями."""
        has_matches = exists().where(
            Match.source.in_(ADOPT_FROM),
            or_(Match.player1_id == Player.id, Match.player2_id == Player.id),
        )
        result = await db.execute(
            select(*_PLAYER_COLUMNS)
            .where(Player.sackmann_id.is_(None), has_matches)
            .order_by(Player.id)
        )
        candidates: list[_Candidate] = []
        for row in result:
            state = _player_state(row)
            names = [state.name, *state.aliases]
            candidates.append(
                _Candidate(
                    state=state,
                    initial_keys={key for name in names for key in _initial_keys(name)},
                    strict_keys={key for name in names for key in _strict_keys(name)},
                )
            )
        if not candidates:
            return {}
        # id Сакманна → (кандидаты, кандидаты с другими полными инициалами)
        found: dict[int, tuple[list[_Candidate], list[_Candidate]]] = {}
        claims: dict[int, int] = Counter()
        for sid, info in new.items():
            keys = name_keys(info.name)
            initials = {key for key in keys if _INITIAL_KEY.fullmatch(key)}
            near = [cand for cand in candidates if cand.initial_keys & initials]
            matched = [cand for cand in near if cand.strict_keys <= keys]
            if near:
                found[sid] = (matched, [cand for cand in near if not cand.strict_keys <= keys])
                for cand in matched:
                    claims[cand.state.id] += 1
        adopted: dict[int, _PlayerState] = {}
        for sid, (matched, differ) in found.items():
            if len(matched) == 1 and claims[matched[0].state.id] == 1:
                adopted[sid] = matched[0].state
                continue
            # Усыновлять некого: в отчет все похожие, с пометкой о других инициалах
            self.report.add_unmatched(
                "possible_duplicate",
                file=path,
                sackmann_id=sid,
                name=new[sid].name,
                candidates=[
                    *({"id": c.state.id, "name": c.state.name} for c in matched),
                    *(
                        {"id": c.state.id, "name": c.state.name, "initials_differ": True}
                        for c in differ
                    ),
                ],
            )
            listed = ", ".join(f"{c.state.name} (id {c.state.id})" for c in matched + differ)
            if matched:
                self.report.add_warning(
                    "ingest_sackmann.warnings.possible_duplicate",
                    name=new[sid].name,
                    sackmann_id=sid,
                    candidates=listed,
                )
            else:
                self.report.add_warning(
                    "ingest_sackmann.warnings.possible_duplicate_initials",
                    name=new[sid].name,
                    sackmann_id=sid,
                    candidates=listed,
                )
        return adopted

    async def _refresh_players(self, db: AsyncSession) -> None:
        """Справочник изменился: обновить всех игроков базы с sackmann_id, а не только
        игроков разобранных файлов (имя, рука, страна, дата рождения)."""
        known = self.players_info()
        result = await db.scalars(select(Player.sackmann_id).where(Player.sackmann_id.is_not(None)))
        infos = {sid: known[sid] for sid in result if sid is not None and sid in known}
        await self._sync_players(db, infos, path=PLAYERS_FILE, adopt=False)

    # --- турниры, матчи, статистика ---

    async def _load_rows(self, db: AsyncSession, path: str, rows: list[MatchRow]) -> None:
        rows = self._dedupe(path, rows)
        infos = self._resolve_players(path, rows)
        known: list[MatchRow] = []
        for row in rows:
            missing = [side for side in (row.winner, row.loser) if side.sackmann_id not in infos]
            if not missing:
                known.append(row)
                continue
            _report_skip(self.report, "unknown_player", path, row.line, row.describe())
            for side in missing:
                self.report.add_unmatched(
                    "player", file=path, line=row.line, sackmann_id=side.sackmann_id
                )
        if not known:
            return
        needed = {side.sackmann_id for row in known for side in (row.winner, row.loser)}
        player_ids = await self._sync_players(
            db, {sid: infos[sid] for sid in needed}, path=path, adopt=True
        )
        tour_ids = await self._sync_tournaments(db, known)
        match_ids = await self._sync_matches(db, path, known, player_ids, tour_ids)
        await self._sync_stats(db, known, player_ids, match_ids)
        await self._absorb_tennis_data_tournaments(db)

    def _dedupe(self, path: str, rows: list[MatchRow]) -> list[MatchRow]:
        """Повтор строки в файле (тот же match_num или та же пара в том же раунде
        турнира) — пропуск: в базе ему соответствует одна строка."""
        seen_refs: set[str] = set()
        seen_keys: set[tuple[str, str, frozenset[int]]] = set()
        out: list[MatchRow] = []
        for row in rows:
            key = (row.tourney_id, row.round, row.pair)
            if row.source_ref in seen_refs or key in seen_keys:
                _report_skip(self.report, "duplicate", path, row.line, row.describe())
                continue
            seen_refs.add(row.source_ref)
            seen_keys.add(key)
            out.append(row)
        return out

    async def _sync_tournaments(self, db: AsyncSession, rows: list[MatchRow]) -> dict[str, int]:
        """Турниры файла по (sackmann, tourney_id) → id в базе. Зал, город и уточненную
        категорию (250/500) заполняет tennis-data: здесь они не затираются."""
        wanted: dict[str, dict[str, Any]] = {}
        for row in rows:
            item = wanted.get(row.tourney_id)
            if item is None:
                wanted[row.tourney_id] = {
                    "name": row.tourney_name,
                    "category": row.category,
                    "surface": row.surface,
                    "best_of": row.best_of,
                    "start_date": row.tourney_date,
                }
                continue
            if row.best_of is not None:
                item["best_of"] = max(item["best_of"] or 0, row.best_of)
            item["start_date"] = min(item["start_date"], row.tourney_date)
            item["surface"] = item["surface"] or row.surface
        existing: dict[str, _TourState] = {}
        for part in _chunks(sorted(wanted)):
            result = await db.execute(
                select(*_TOUR_COLUMNS).where(
                    Tournament.source == SOURCE, Tournament.source_ref.in_(part)
                )
            )
            for found in result:
                existing[found.source_ref] = _TourState(
                    id=found.id,
                    name=found.name,
                    category=found.category,
                    surface=found.surface,
                    best_of=found.best_of,
                    start_date=found.start_date,
                    indoor=found.indoor,
                    city=found.city,
                )
        ids: dict[str, int] = {}
        updates: list[dict[str, Any]] = []
        inserts: list[dict[str, Any]] = []
        for ref, want in wanted.items():
            current = existing.get(ref)
            if current is None:
                inserts.append({"source": SOURCE, "source_ref": ref, **want})
                continue
            ids[ref] = current.id
            self.tours[current.id] = current
            if want["category"] == GENERIC_CATEGORY and current.category is not None:
                want["category"] = current.category
            if any(getattr(current, key) != value for key, value in want.items()):
                updates.append({"id": current.id, **want})
                for key, value in want.items():
                    setattr(current, key, value)
        await _bulk_update(db, Tournament, updates)
        self._updated("tournaments", len(updates))
        for chunk in _chunks(inserts):
            stmt = (
                insert(Tournament)
                .values(list(chunk))
                .on_conflict_do_nothing(index_elements=[Tournament.source, Tournament.source_ref])
                .returning(Tournament.id, Tournament.source_ref)
            )
            for tour_id, created_ref in await db.execute(stmt):
                assert created_ref is not None
                ids[created_ref] = tour_id
                self.tours[tour_id] = _TourState(
                    id=tour_id, indoor=None, city=None, **wanted[created_ref]
                )
                self._created("tournaments", 1)
        return ids

    async def _existing_matches(
        self, db: AsyncSession, tour_ids: Sequence[int], refs: Sequence[str]
    ) -> list[_MatchState]:
        """Матчи турниров файла и матчи Сакманна с теми же source_ref."""
        out: dict[int, _MatchState] = {}
        for chunk in _chunks(refs):
            result = await db.execute(
                select(*_MATCH_COLUMNS).where(
                    or_(
                        Match.tournament_id.in_(tour_ids),
                        and_(Match.source == SOURCE, Match.source_ref.in_(chunk)),
                    )
                )
            )
            for row in result:
                state = _match_state(row)
                out[state.id] = state
        return list(out.values())

    async def _tennis_data_matches(
        self, db: AsyncSession, targets: Sequence[_Target]
    ) -> dict[str, list[_MatchState]]:
        """Матчи tennis-data той же пары с датой в окне турнира строки → по source_ref."""
        first = min(t.row.tourney_date for t in targets) - PROMOTE_BEFORE
        last = max(t.row.tourney_date for t in targets) + PROMOTE_AFTER
        result = await db.execute(
            select(*_MATCH_COLUMNS).where(
                Match.source == TENNIS_DATA, Match.match_date.between(first, last)
            )
        )
        by_pair: dict[frozenset[int], list[_MatchState]] = defaultdict(list)
        for row in result:
            state = _match_state(row)
            by_pair[state.pair].append(state)
        edges: dict[str, list[_MatchState]] = {}
        for target in targets:
            start = target.row.tourney_date - PROMOTE_BEFORE
            end = target.row.tourney_date + PROMOTE_AFTER
            found = [
                match
                for match in by_pair.get(target.pair, ())
                if match.tournament_id is not None
                and match.match_date is not None
                and start <= match.match_date <= end
            ]
            if found:
                edges[target.ref] = found
        return edges

    async def _owners(
        self, db: AsyncSession, targets: Sequence[_Target], edges: dict[str, list[_MatchState]]
    ) -> _Ownership:
        """Турнир tennis-data → турнир Сакманна (tourney_id), чьи матчи он может отдать.

        Окно дат захватывает и соседние недели, а одна пара может встретиться в двух
        турнирах подряд. Поэтому турнир tennis-data отдается одному турниру Сакманна: тому, с кем у
        него общих пар больше всего (не меньше половины его матчей), при равенстве —
        тому, кто начался ближе по дате. Совсем поровну — всем равным, и тогда спорные
        матчи уходят в отчет. Ни одного подходящего (турнира Сакманна еще нет в архиве) —
        турнир tennis-data остается как есть."""
        voters: defaultdict[int, defaultdict[str, set[int]]] = defaultdict(lambda: defaultdict(set))
        starts: dict[str, date] = {}
        for target in targets:
            tourney = target.row.tourney_id
            day = target.row.tourney_date
            starts[tourney] = min(starts.get(tourney, day), day)
            for match in edges.get(target.ref, ()):
                assert match.tournament_id is not None
                voters[match.tournament_id][tourney].add(match.id)
        result = await db.execute(
            select(Tournament.id, Tournament.start_date, func.count(), func.min(Match.match_date))
            .join(Match, Match.tournament_id == Tournament.id)
            .where(Tournament.id.in_(list(voters)))
            .group_by(Tournament.id)
        )
        ownership = _Ownership(voters=voters, edges=edges, starts=starts)
        for td_id, start_date, size, first_day in result:
            ownership.sizes[td_id] = size
            start: date | None = start_date or first_day
            if start is not None:
                ownership.td_starts[td_id] = start
            # (общих матчей, -разница дат начала) у турниров Сакманна с большинством
            rank = {
                tourney: (
                    len(found),
                    -abs((start - starts[tourney]).days) if start is not None else 0,
                )
                for tourney, found in voters[td_id].items()
                if 2 * len(found) >= size
            }
            if rank:
                best = max(rank.values())
                ownership.owners[td_id] = {
                    tourney for tourney, value in rank.items() if value == best
                }
        return ownership

    async def _promote(
        self,
        db: AsyncSession,
        path: str,
        targets: Sequence[_Target],
        free: Sequence[_Target],
        in_file: Counter[tuple[int, frozenset[int]]],
    ) -> tuple[dict[str, _MatchState], _Ownership | None]:
        """Матчи tennis-data, которые становятся матчами Сакманна (по source_ref строки).

        Кандидат — матч tennis-data той же пары с датой в окне турнира, из турнира
        tennis-data, который отдан турниру строки (_owners). Если пара встречается в
        турнире дважды (круговой этап и финал) или кандидатов несколько — нужен тот же
        раунд. Матч берется, только если он у строки единственный и не нужен другой
        строке; иначе строка — в отчет, а ей создается новый матч. От порядка строк в
        файле результат не зависит. Повышаются только строки free (без своего матча в
        базе), а владельцы турниров tennis-data считаются по всем строкам файла: по ним
        _report_leftovers находит копии, оставшиеся с прошлых запусков."""
        if not targets:
            return {}, None
        edges = await self._tennis_data_matches(db, targets)
        if not edges:
            return {}, None
        ownership = await self._owners(db, targets, edges)
        owners = ownership.owners
        options: dict[str, list[_MatchState]] = {}
        for target in free:
            found = [
                match
                for match in edges.get(target.ref, ())
                if match.tournament_id is not None
                and target.row.tourney_id in owners.get(match.tournament_id, ())
            ]
            if len(found) > 1 or in_file[(target.tour_id, target.pair)] > 1:
                found = [match for match in found if match.round == target.row.round]
            if found:
                options[target.ref] = found
        wanted = Counter(match.id for found in options.values() for match in found)
        out: dict[str, _MatchState] = {}
        for target in free:
            found = options.get(target.ref, [])
            if len(found) == 1 and wanted[found[0].id] == 1:
                out[target.ref] = found[0]
                continue
            if not found:
                continue
            ids = sorted(match.id for match in found)
            ownership.ambiguous.update(ids)
            self.report.add_unmatched(
                "match",
                file=path,
                line=target.row.line,
                source_ref=target.ref,
                match=target.row.describe(),
                tennis_data_ids=ids,
            )
            self.report.add_warning(
                "ingest_sackmann.warnings.promotion_ambiguous",
                file=path,
                line=target.row.line,
                match=target.row.describe(),
                ids=", ".join(str(match_id) for match_id in ids),
            )
        return out, ownership

    async def _report_leftovers(
        self,
        db: AsyncSession,
        path: str,
        targets: Sequence[_Target],
        ids: dict[str, int],
        ownership: _Ownership,
    ) -> None:
        """Турниры tennis-data, которые повышение не забрало целиком: без отчета их
        матчи остались бы молча копиями матчей Сакманна (Эло и бэктест считали бы матч
        дважды). Так бывает, когда игрок записан в двух источниках по-разному и не
        усыновлен («Barrios M.» и «Marcelo Tomas Barrios Vera»: общего ключа нет).

        - Турнир tennis-data, похожий на турнир Сакманна (есть общие пары и начался не
          дальше PROMOTE_BEFORE от него), но общих пар меньше половины: его матчи не
          повышаются совсем. В отчет — пары «копия → матч Сакманна». Турнир следующей
          недели (та же пара сыграла и там, а Сакманн его еще не догнал) — не в отчет.
        - Турнир tennis-data отдан турниру Сакманна, но в нем остались матчи без пары."""
        by_ref = {target.ref: target for target in targets}
        for td_id, votes in sorted(ownership.voters.items()):
            if td_id in ownership.owners:
                continue
            size = ownership.sizes.get(td_id, 0)
            td_start = ownership.td_starts.get(td_id)
            for tourney, found in sorted(votes.items()):
                if td_start is None or abs(td_start - ownership.starts[tourney]) > PROMOTE_BEFORE:
                    continue
                copies = {
                    match.id: ids[ref]
                    for ref, matches in ownership.edges.items()
                    if ref in ids and by_ref[ref].row.tourney_id == tourney
                    for match in matches
                    if match.tournament_id == td_id
                }
                self.report.add_unmatched(
                    "tournament",
                    file=path,
                    tennis_data_tournament=td_id,
                    tourney_id=tourney,
                    common=len(found),
                    size=size,
                    copies={str(copy): match for copy, match in sorted(copies.items())},
                )
                self.report.add_warning(
                    "ingest_sackmann.warnings.tournament_not_owned",
                    file=path,
                    tournament_id=td_id,
                    tourney=tourney,
                    common=len(found),
                    size=size,
                    copies=", ".join(f"{copy} → {match}" for copy, match in sorted(copies.items())),
                )
        owned = sorted(ownership.owners)
        if not owned:
            return
        result = await db.execute(
            select(Match.id, Match.tournament_id)
            .where(Match.tournament_id.in_(owned), Match.source == TENNIS_DATA)
            .order_by(Match.id)
        )
        left: defaultdict[int, list[int]] = defaultdict(list)
        for match_id, tour_id in result:
            if tour_id is not None and match_id not in ownership.ambiguous:
                left[tour_id].append(match_id)
        for td_id, match_ids in sorted(left.items()):
            tourneys = ", ".join(sorted(ownership.owners[td_id]))
            self.report.add_unmatched(
                "match", file=path, tourney_id=tourneys, tennis_data_ids=match_ids
            )
            self.report.add_warning(
                "ingest_sackmann.warnings.tournament_leftovers",
                file=path,
                tournament_id=td_id,
                tourney=tourneys,
                ids=", ".join(str(match_id) for match_id in match_ids),
            )

    def _conflict(self, path: str, row: MatchRow) -> None:
        """Строку не записать, не нарушив уникальность матчей: разбирает человек."""
        _report_skip(self.report, "conflict", path, row.line, row.describe())
        self.report.add_unmatched("match", file=path, line=row.line, source_ref=row.source_ref)

    async def _sync_matches(
        self,
        db: AsyncSession,
        path: str,
        rows: list[MatchRow],
        player_ids: dict[int, int],
        tour_ids: dict[str, int],
    ) -> dict[str, int]:
        targets = [
            _Target(
                row=row,
                tour_id=tour_ids[row.tourney_id],
                winner=player_ids[row.winner.sackmann_id],
                loser=player_ids[row.loser.sackmann_id],
            )
            for row in rows
        ]
        existing = await self._existing_matches(
            db, sorted(set(tour_ids.values())), [target.ref for target in targets]
        )
        assigned = _assign_existing(targets, existing)
        in_file = Counter((target.tour_id, target.pair) for target in targets)
        free = [
            target
            for target in targets
            if target.ref not in assigned.matches and target.ref not in assigned.conflicts
        ]
        promoted, ownership = await self._promote(db, path, targets, free, in_file)
        ids: dict[str, int] = {}
        updates: list[dict[str, Any]] = []
        moving: list[int] = []
        flips: list[int] = []
        new: list[_Target] = []
        for target in targets:
            if target.ref in assigned.conflicts:
                self._conflict(path, target.row)
                continue
            current = assigned.matches.get(target.ref) or promoted.get(target.ref)
            if current is None:
                new.append(target)
                continue
            ids[target.ref] = current.id
            if target.ref in promoted and current.tournament_id is not None:
                self.moved[current.tournament_id] = target.tour_id
            if (current.player1_id, current.player2_id) == (target.loser, target.winner):
                flips.append(current.id)
            elif current.pair != target.pair:
                # Сакманн исправил игрока: статистика прежнего игрока больше не нужна, а
                # дату и кэфы матча (если были) проверяет человек
                await db.execute(
                    delete(MatchStat).where(
                        MatchStat.match_id == current.id, MatchStat.player_id.not_in(target.pair)
                    )
                )
                self.counts["matches.players_changed"] += 1
                self.report.add_warning(
                    "ingest_sackmann.warnings.players_changed",
                    file=path,
                    line=target.row.line,
                    match_id=current.id,
                    match=target.row.describe(),
                )
            want = target.values()
            if any(getattr(current, key) != value for key, value in want.items()):
                updates.append({"id": current.id, **want})
                if any(getattr(current, key) != want[key] for key in _MATCH_KEY_FIELDS):
                    moving.append(current.id)
        await _flip_sides(db, flips)
        if len(moving) > 1:
            # Матчи обмениваются номерами или местами в турнире: сначала каждому —
            # временные round и source_ref со своим id, иначе UPDATE по одному
            # столкнулся бы с еще не обновленным соседом на уникальном ключе
            await _bulk_update(
                db,
                Match,
                [
                    {"id": mid, "round": f"{_SWAP_MARK}{mid}", "source_ref": f"{_SWAP_MARK}{mid}"}
                    for mid in moving
                ],
            )
        await _bulk_update(db, Match, updates)
        self._updated("matches", len(updates))
        self.counts["matches.promoted"] += len(promoted)
        for batch in _chunks(new):
            stmt = (
                insert(Match)
                .values([target.values() for target in batch])
                .on_conflict_do_nothing()
                .returning(Match.id, Match.source_ref)
            )
            created = {
                created_ref: match_id
                for match_id, created_ref in await db.execute(stmt)
                if created_ref is not None
            }
            for target in batch:
                match_id = created.get(target.ref)
                if match_id is None:
                    # Пара уже есть в этом раунде турнира под другим id
                    self._conflict(path, target.row)
                    continue
                ids[target.ref] = match_id
            self._created("matches", len(created))
        if ownership is not None:
            await self._report_leftovers(db, path, targets, ids, ownership)
        return ids

    async def _sync_stats(
        self,
        db: AsyncSession,
        rows: list[MatchRow],
        player_ids: dict[int, int],
        match_ids: dict[str, int],
    ) -> None:
        values: list[dict[str, Any]] = []
        for row in rows:
            match_id = match_ids.get(row.source_ref)
            if row.stats is None or match_id is None:
                continue
            for side, stats in zip((row.winner, row.loser), row.stats, strict=True):
                values.append(
                    {
                        "match_id": match_id,
                        "player_id": player_ids[side.sackmann_id],
                        **stats,
                        "source": SOURCE,
                    }
                )
        columns = [*STAT_COLUMNS.values(), "source"]
        table = MatchStat.__table__
        for chunk in _chunks(values):
            base = insert(MatchStat).values(list(chunk))
            stmt = base.on_conflict_do_update(
                index_elements=[MatchStat.match_id, MatchStat.player_id],
                set_={column: base.excluded[column] for column in columns},
                # Не изменилось — не трогать: повторный запуск дает «обновлено 0»
                where=tuple_(*(table.c[column] for column in columns)).is_distinct_from(
                    tuple_(*(base.excluded[column] for column in columns))
                ),
            )
            returning = stmt.returning(sql_literal("xmax = 0", Boolean).label("inserted"))
            inserted = [bool(flag) for flag in (await db.execute(returning)).scalars()]
            self._created("stats", sum(inserted))
            self._updated("stats", len(inserted) - sum(inserted))

    async def _absorb_tennis_data_tournaments(self, db: AsyncSession) -> None:
        """Турниры tennis-data, чьи матчи стали матчами Сакманна: зал, город и уточненная
        категория переходят в турнир Сакманна, если там пусто; пустой турнир удаляется."""
        if not self.moved:
            return
        result = await db.execute(
            select(Tournament.id, Tournament.indoor, Tournament.city, Tournament.category).where(
                Tournament.id.in_(list(self.moved)), Tournament.source == TENNIS_DATA
            )
        )
        updates: list[dict[str, Any]] = []
        for td_id, indoor, city, category in result:
            target = self.tours.get(self.moved[td_id])
            if target is None:
                continue
            want = {
                "indoor": target.indoor if target.indoor is not None else indoor,
                "city": target.city or city,
                "category": (
                    category
                    if category and target.category in (None, GENERIC_CATEGORY)
                    else target.category
                ),
            }
            if any(getattr(target, key) != value for key, value in want.items()):
                for key, value in want.items():
                    setattr(target, key, value)
                updates.append({"id": target.id, **want})
        await _bulk_update(db, Tournament, updates)
        self._updated("tournaments", len(updates))
        empty = (
            await db.scalars(
                delete(Tournament)
                .where(
                    Tournament.id.in_(list(self.moved)),
                    Tournament.source == TENNIS_DATA,
                    ~exists().where(Match.tournament_id == Tournament.id),
                )
                .returning(Tournament.id)
            )
        ).all()
        self.counts["tournaments.deleted"] += len(empty)


async def load_sackmann(
    *,
    years: Sequence[int],
    source: DataSource,
    force: bool = False,
    db_factory: Callable[[], AsyncSession] | None = None,
) -> IngestReport:
    """Загрузить годы архива Сакманна из source; журнал — ingestion_runs (sackmann).

    db_factory — фабрика сеансов (async_sessionmaker); без нее загрузчик открывает свой
    движок по настройкам. Конфликт в базе при записи файла не останавливает остальные
    годы, но в конце дает IngestError (запуск failed, подробности — в отчете).
    """
    if db_factory is None:
        engine = create_engine()
        try:
            return await load_sackmann(
                years=years, source=source, force=force, db_factory=create_sessionmaker(engine)
            )
        finally:
            await engine.dispose()
    async with ingestion_run(db_factory, SOURCE) as run:
        loader = _Loader(source=source, factory=db_factory, report=run.report, force=force)
        await loader.run(years)
    return run.report


def summary_lines(report: IngestReport) -> list[str]:
    """Отчет загрузки для терминала."""
    counts = report.counts
    fresh = report.freshness
    out = [
        t("ingest_sackmann.report.title", location=fresh.get("source", "")),
        t(
            "ingest_sackmann.report.files",
            processed=counts["files.processed"],
            unchanged=counts["files.unchanged"],
            missing=counts["files.missing"],
        ),
        t(
            "ingest_sackmann.report.players",
            created=counts["players.created"],
            updated=counts["players.updated"],
            adopted=counts["players.adopted"],
        ),
        t(
            "ingest_sackmann.report.tournaments",
            created=counts["tournaments.created"],
            updated=counts["tournaments.updated"],
            deleted=counts["tournaments.deleted"],
        ),
        t(
            "ingest_sackmann.report.matches",
            created=counts["matches.created"],
            updated=counts["matches.updated"],
            promoted=counts["matches.promoted"],
        ),
        t(
            "ingest_sackmann.report.stats",
            created=counts["stats.created"],
            updated=counts["stats.updated"],
        ),
        t(
            "ingest_sackmann.report.totals",
            read=report.rows_read,
            created=report.created,
            updated=report.updated,
            skipped=report.skipped,
        ),
    ]
    for key, count in sorted(counts.items()):
        if key.startswith("skipped."):
            reason = t(f"ingest_sackmann.skip.{key.removeprefix('skipped.')}")
            out.append(t("ingest_sackmann.report.skip_line", reason=reason, count=count))
    unmatched = sum(count for key, count in counts.items() if key.startswith("unmatched."))
    if unmatched:
        out.append(t("ingest_sackmann.report.unmatched", count=unmatched))
    for year, item in fresh.get("years", {}).items():
        if item.get("missing"):
            out.append(t("ingest_sackmann.report.freshness_missing", year=year))
        else:
            out.append(
                t(
                    "ingest_sackmann.report.freshness",
                    year=year,
                    date=item.get("last_tourney_date") or "-",
                    matches=item.get("matches", 0),
                )
            )
    total = sum(count for key, count in counts.items() if key.startswith("warnings."))
    if total:
        out.append(t("ingest_sackmann.report.warnings_title", count=total))
        out += [f"  {warning}" for warning in report.warnings[:WARNINGS_SHOWN]]
        if total > WARNINGS_SHOWN:
            out.append(t("ingest_sackmann.report.warnings_more", count=total - WARNINGS_SHOWN))
    out.append(t("ingest_sackmann.report.license"))
    return out


# --- команда терминала ---


def _years_arg(value: str) -> list[int]:
    try:
        return parse_years(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.ingest.sackmann", description=t("ingest_sackmann.description")
    )
    parser.add_argument(
        "--years",
        type=_years_arg,
        help=t("ingest_sackmann.help.years", first=get_settings().data_first_year),
    )
    parser.add_argument("--dir", help=t("ingest_sackmann.help.dir"))
    parser.add_argument("--force", action="store_true", help=t("ingest_sackmann.help.force"))
    return parser


async def _main(years: list[int], directory: str | None, force: bool) -> IngestReport:
    if directory is not None:
        source = DataSource.local(directory)
    else:
        source = DataSource.http(get_settings().sackmann_base_url)
    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        # Не одновременно с ночным обновлением и другими командами шагов (runs.update_lock)
        async with update_lock(factory), source:
            return await load_sackmann(years=years, source=source, force=force, db_factory=factory)
    finally:
        await engine.dispose()


def main(argv: Sequence[str] | None = None) -> int:
    """Код возврата: 0 — загрузка прошла (возможно, с замечаниями), 1 — ошибка."""
    args = build_parser().parse_args(argv)
    years: list[int] = args.years or list(range(get_settings().data_first_year, current_year() + 1))
    if args.dir is not None and not Path(args.dir).is_dir():
        print(t("ingest_sackmann.errors.dir_not_found", path=args.dir), file=sys.stderr)
        return 1
    try:
        report = asyncio.run(_main(years, args.dir, args.force))
    except IngestError as exc:
        print(exc.message, file=sys.stderr)
        return 1
    except (DBAPIError, OSError):
        # DBAPIError — общий класс ошибок драйвера: нет связи, неверный пароль, нет базы
        # или таблиц. Текст исключения не печатаем: в нем бывает адрес базы с паролем
        print(t("ingest_sackmann.errors.db_unavailable"), file=sys.stderr)
        return 1
    print("\n".join(summary_lines(report)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
