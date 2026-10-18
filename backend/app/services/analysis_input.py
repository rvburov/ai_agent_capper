"""Ввод анализа без Claude: черновик по ответу разбора, проверка подтвержденных
событий, матчи и турниры из ввода, кэфы участника, сведения об игроках для экрана.

Игроки ищутся в базе (search_players, кириллица и латиница): сходство ≥ 0,9 — найден,
0,7–0,9 — «проверьте», ниже — нет в базе (анализ с ним не запускается: сбора профиля на
этапе 3 нет). Турнир — турнир текущего года из базы по названию или городу; иначе —
последний известный выпуск этого турнира (покрытие, категория, формат); иначе — только
название и покрытие из текста.

Матч: сначала существующий (те же игроки, дата ±3 дня, любой источник), иначе новый
matches.source = 'user' с source_ref «user:<дата>:<min id>:<max id>»: два участника,
которые ввели один матч, получат одну строку. Порядок игроков события подстраивается
под матч: прогнозы считаются со стороны matches.player1_id (кэфы переставляются).

Кэфы (OddsMap) — рынок → [сторона 1, сторона 2] для любых рынков Р28: ML и форы ±1.5
(прежние поля формы) и «Другие рынки» (extra, app/ml/markets.py: фора ±2.5, тоталы сетов,
форы и тоталы геймов). В analyses.confirmed (format 2) прежние рынки лежат в odds, новые —
списком extra строками формы (у jsonb нет порядка ключей); анализы без format читаются как
раньше. При перемене игроков местами у фор меняется сторона, у тоталов — нет.
"""

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy import ColumnElement, and_, case, func, or_, select, text, union_all
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.schemas import ParsedInput
from app.core.errors import AppError
from app.db.models import Match, OddsSnapshot, Player, PlayerEloCurrent, Tournament
from app.ingest.names import fold
from app.ingest.rounds import ROUNDS
from app.ml.elo import RESULT_STATUSES
from app.ml.markets import (
    ExtraLine,
    extra_into,
    extra_lines,
    fits_format,
    is_market,
    swapped_side,
    to_line,
)
from app.ml.sets import MARKETS
from app.services.dossier import UNDATED_DAYS
from app.services.players import PlayerError, search_players

MATCH_SCORE = 0.9
CHECK_SCORE = 0.7
# Два кандидата ближе друг к другу — даже высокое сходство требует проверки (Зверевы)
AMBIGUOUS_GAP = 0.05
# Игрок без матчей в базе дольше этого — не действующий: уступает тезке (resolve_player)
INACTIVE_DAYS = 3 * 365
CANDIDATES = 3
MAX_EVENTS = 5
ODDS_MIN = Decimal("1.01")
ODDS_MAX = Decimal("50")
ODDS_STEP = Decimal("0.001")
MONEY_STEP = Decimal("0.01")
MATCH_WINDOW_DAYS = 3
# Сходство отличительной части названия (без общих слов): «Test Open 9» и «Test Open 5»
# дают 0,71 — это разные турниры
TOURNAMENT_SCORE = 0.75
# Разница сходства, при которой турниры считаются одинаково похожими на запрос
TOURNAMENT_TIE = 0.01
# Общие слова названий турниров: по ним турниры не различить
GENERIC_WORDS = frozenset(
    {
        "open",
        "opens",
        "masters",
        "master",
        "cup",
        "finals",
        "championships",
        "championship",
        "international",
        "internationals",
        "atp",
        "tennis",
        "tour",
        "tournament",
        "250",
        "500",
        "1000",
    }
)
GENERIC_SQL = r"\m(" + "|".join(sorted(GENERIC_WORDS)) + r")\M"
# Название турнира из ввода: одна строка (как NameText в app/schemas/analyses.py)
NAME_MAX = 200
ELO_RANK_DAYS = 364
DEFAULT_BEST_OF = 3
SLAMS = ("australian open", "roland garros", "french open", "wimbledon", "us open")
SLUG_MAX = 50
_SLUG = re.compile(r"[^a-z0-9]+")


# --- сведения об игроках ---


async def last_match_days(db: AsyncSession, player_ids: Iterable[int]) -> dict[int, date]:
    """День последнего сыгранного матча каждого игрока в базе (у матча без даты — начало
    турнира)."""
    ids = sorted(set(player_ids))
    if not ids:
        return {}
    day = func.coalesce(Match.match_date, Tournament.start_date)
    parts = [
        select(column.label("pid"), day.label("day"))
        .select_from(Match)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(column.in_(ids), Match.status.in_(RESULT_STATUSES))
        for column in (Match.player1_id, Match.player2_id)
    ]
    played = union_all(*parts).subquery()
    rows = await db.execute(select(played.c.pid, func.max(played.c.day)).group_by(played.c.pid))
    return {int(pid): value for pid, value in rows if value is not None}


_ELO_RANKS_SQL = text(
    """
WITH active AS (
    SELECT m.player1_id AS pid FROM matches m
    LEFT JOIN tournaments t ON t.id = m.tournament_id
    WHERE m.status IN ('finished', 'retired')
      AND coalesce(m.match_date, t.start_date) >= :since
      AND coalesce(m.match_date, t.start_date) < :today
    UNION
    SELECT m.player2_id FROM matches m
    LEFT JOIN tournaments t ON t.id = m.tournament_id
    WHERE m.status IN ('finished', 'retired')
      AND coalesce(m.match_date, t.start_date) >= :since
      AND coalesce(m.match_date, t.start_date) < :today
),
latest AS (
    SELECT DISTINCT ON (r.player_id) r.player_id, r.elo
    FROM player_ratings r JOIN active a ON a.pid = r.player_id
    WHERE r.surface = 'all' AND r.as_of < :today
    ORDER BY r.player_id, r.as_of DESC
),
ranked AS (SELECT player_id, rank() OVER (ORDER BY elo DESC) AS place FROM latest)
SELECT player_id, place FROM ranked WHERE player_id = ANY(CAST(:ids AS bigint[]))
"""
)


def _utc_today() -> date:
    return datetime.now(UTC).date()


async def _ranks_by_matches(db: AsyncSession, ids: Sequence[int], day: date) -> dict[int, int]:
    """Место на начало дня day: матчи и рейтинги строго до него."""
    rows = await db.execute(
        _ELO_RANKS_SQL,
        {"ids": list(ids), "today": day, "since": day - timedelta(days=ELO_RANK_DAYS)},
    )
    return {int(pid): int(place) for pid, place in rows}


async def _current_ranks(db: AsyncSession, ids: Sequence[int], day: date) -> dict[int, int] | None:
    """Место из player_elo_current (пишет шаг elo). Таблица на день as_of — место на конец
    этого дня, то есть _ranks_by_matches на as_of + 1 (окно 52 недель по день расчета
    включительно, app/ml/elo.py), то же, что в списке «Игроки» и карточке игрока. Годится,
    если ее посчитали вчера (место на начало сегодня) или сегодня (на конец сегодня: ночное
    обновление около 05:25 UTC); иначе (шаг elo не шел) — None, и место считается по матчам."""
    as_of = await db.scalar(select(func.max(PlayerEloCurrent.as_of)))
    if as_of is None or as_of < day - timedelta(days=1):
        return None
    rows = await db.execute(
        select(PlayerEloCurrent.player_id, PlayerEloCurrent.rank_all).where(
            PlayerEloCurrent.player_id.in_(ids), PlayerEloCurrent.rank_all.is_not(None)
        )
    )
    return {int(pid): int(place) for pid, place in rows if place is not None}


async def elo_ranks(
    db: AsyncSession, player_ids: Iterable[int], *, today: date | None = None
) -> dict[int, int]:
    """Место по общему Эло среди игроков с матчами за 52 недели (рейтинга ATP в базе
    нет). Игрока без матчей за 52 недели в списке нет. На сегодня — из player_elo_current,
    как в карточке игрока (около 1 мс вместо 120 мс пересчета по матчам): до ночного
    обновления — место на начало сегодня, после — на конец сегодня (с матчами, сыгранными
    к обновлению; окно 52 недель сдвигается на день). На прошлый день — по матчам и
    рейтингам до этого дня, как раньше: история анализов воспроизводима."""
    ids = sorted(set(player_ids))
    if not ids:
        return {}
    actual = _utc_today()
    day = today or actual
    if day == actual:
        current = await _current_ranks(db, ids, day)
        if current is not None:
            return current
    return await _ranks_by_matches(db, ids, day)


@dataclass(frozen=True)
class PlayerFacts:
    """Игрок для карточек: имя, страна, место по Эло, последний матч, новости."""

    id: int
    name: str
    name_ru: str | None
    country: str | None
    elo_rank: int | None
    last_match: date | None
    news_checked_at: datetime | None


async def player_facts(
    db: AsyncSession, player_ids: Iterable[int], *, today: date | None = None
) -> dict[int, PlayerFacts]:
    ids = sorted(set(player_ids))
    if not ids:
        return {}
    players = {
        player.id: player for player in await db.scalars(select(Player).where(Player.id.in_(ids)))
    }
    ranks = await elo_ranks(db, players, today=today)
    last = await last_match_days(db, players)
    return {
        pid: PlayerFacts(
            id=pid,
            name=player.name,
            name_ru=player.name_ru,
            country=player.country,
            elo_rank=ranks.get(pid),
            last_match=last.get(pid),
            news_checked_at=player.news_checked_at,
        )
        for pid, player in players.items()
    }


async def archive_date(db: AsyncSession, *, today: date) -> date | None:
    """Последний день матчей в базе, который видит досье (матч без даты — через
    UNDATED_DAYS после начала турнира): свежесть архива для «Перед запуском»."""
    dated = await db.scalar(
        select(func.max(Match.match_date)).where(
            Match.match_date < today, Match.status.in_(RESULT_STATUSES)
        )
    )
    undated = await db.scalar(
        select(func.max(Tournament.start_date)).where(
            Tournament.start_date < today - UNDATED_DAYS,
            select(Match.id)
            .where(
                Match.tournament_id == Tournament.id,
                Match.match_date.is_(None),
                Match.status.in_(RESULT_STATUSES),
            )
            .exists(),
        )
    )
    days = [value for value in (dated, undated) if value is not None]
    return max(days) if days else None


# --- игроки из текста ---


@dataclass(frozen=True)
class Candidate:
    player_id: int
    name: str
    country: str | None
    score: float


@dataclass(frozen=True)
class Pick:
    """Игрок из текста: status matched / check / missing, лучший кандидат и до 3 похожих."""

    status: str
    raw: str
    best: Candidate | None
    candidates: tuple[Candidate, ...]


async def _by_activity(db: AsyncSession, found: list[Candidate]) -> list[Candidate]:
    """Кандидаты по сходству, а при равном — по свежести последнего матча. Игрок без
    матчей за INACTIVE_DAYS уступает действующему с почти тем же сходством (на
    AMBIGUOUS_GAP): у старых тезок id меньше, и раньше фамилия из линии букмекера
    («Medvedev», «Зверев», «Ruud») предлагала Андрея Медведева вместо Даниила."""
    last = await last_match_days(db, [item.player_id for item in found])
    since = datetime.now(UTC).date() - timedelta(days=INACTIVE_DAYS)

    def key(item: Candidate) -> tuple[float, int, int]:
        day = last.get(item.player_id)
        inactive = day is None or day < since
        adjusted = item.score - (AMBIGUOUS_GAP if inactive else 0.0)
        return (-adjusted, -(day.toordinal() if day else 0), item.player_id)

    return sorted(found, key=key)


async def resolve_player(db: AsyncSession, raw: str, latin: str | None) -> Pick:
    """Игрок по имени из текста: поиск по написанию в тексте и латиницей разбора."""
    found: dict[int, Candidate] = {}
    for query in (raw, latin):
        if not query or not query.strip():
            continue
        try:
            hits = await search_players(db, query, limit=CANDIDATES + 2)
        except PlayerError:
            continue
        for hit in hits:
            current = found.get(hit.player.id)
            if current is None or hit.score > current.score:
                found[hit.player.id] = Candidate(
                    hit.player.id, hit.player.name, hit.player.country, float(hit.score)
                )
    ranked = await _by_activity(db, list(found.values()))
    candidates = tuple(ranked[:CANDIDATES])
    if not ranked or ranked[0].score < CHECK_SCORE:
        return Pick("missing", raw, None, candidates)
    best = ranked[0]
    close = len(ranked) > 1 and best.score - ranked[1].score < AMBIGUOUS_GAP
    status = "matched" if best.score >= MATCH_SCORE and not close else "check"
    return Pick(status, raw, best, candidates)


# --- турниры ---


@dataclass(frozen=True)
class TournamentGuess:
    """Турнир события: id — турнир текущего года в базе (None — будет создан)."""

    id: int | None
    name: str
    category: str | None
    surface: str | None
    best_of: int | None


def _is_slam(name: str) -> bool:
    folded = fold(name)
    return any(slam in folded for slam in SLAMS)


def one_line(value: str, limit: int) -> str:
    """Текст одной строкой: без управляющих символов, пробелы схлопнуты, не длиннее
    limit. Название из ввода и из ответа разбора идет в черновик и обратно в запрос."""
    printable = "".join(" " if ord(char) < 32 or ord(char) == 127 else char for char in value)
    return " ".join(printable.split())[:limit]


def _core(folded: str) -> str:
    """Отличительная часть названия: без общих слов (open, masters, cup…)."""
    return " ".join(word for word in folded.split() if word not in GENERIC_WORDS)


async def resolve_tournament(
    db: AsyncSession, name: str | None, *, today: date
) -> TournamentGuess | None:
    """Турнир по названию или городу: текущего года — найден; иначе последний выпуск
    дает покрытие, категорию и формат; иначе — только название.

    Сходство считается без общих слов (Open, Masters, Cup…): иначе «Japan Open» (у
    Сакманна — Tokyo) находил Australian Open текущего года и матч получал формат до трех
    побед, а «Davis Cup» — один из матчей Кубка Дэвиса на грунте. Турнир годится, только
    если его отличительная часть почти целиком есть в запросе (или совпадает город).
    Турниры из ввода участников (source = 'user') не подставляются: это свободный текст
    другого участника."""
    if not name or not name.strip():
        return None
    title = one_line(name, NAME_MAX)
    best_of_guess = 5 if _is_slam(title) else None
    query = _core(fold(title))
    if not query:
        return TournamentGuess(None, title, None, None, best_of_guess) if title else None
    core = func.regexp_replace(func.lower(Tournament.name), GENERIC_SQL, " ", "g")
    score = func.greatest(
        func.similarity(core, query),
        func.word_similarity(core, query),
        func.similarity(func.lower(func.coalesce(Tournament.city, "")), query),
    ).label("score")
    rows = (
        await db.execute(
            select(Tournament, score)
            .where(score >= TOURNAMENT_SCORE, Tournament.source != "user")
            .order_by(score.desc(), Tournament.start_date.desc().nulls_last(), Tournament.id)
            .limit(30)
        )
    ).all()
    # Выпуск текущего года берем, только если это тот же турнир, что и лучший по сходству:
    # иначе «Shanghai Masters» без выпуска этого года нашел бы другой турнир этого года
    best = rows[0][1] if rows else 0.0
    current = [
        (tournament, value)
        for tournament, value in rows
        if value >= best - TOURNAMENT_TIE
        and tournament.start_date is not None
        and tournament.start_date.year == today.year
        and tournament.start_date <= today + timedelta(days=7)
    ]
    if current:
        top = max(value for _, value in current)
        tournament = max(
            (item for item, value in current if value >= top - TOURNAMENT_TIE),
            key=lambda item: (item.start_date or date.min, -item.id),
        )
        return TournamentGuess(
            tournament.id,
            tournament.name,
            tournament.category,
            tournament.surface,
            tournament.best_of or best_of_guess,
        )
    if rows:
        tournament = rows[0][0]
        return TournamentGuess(
            None,
            tournament.name,
            tournament.category,
            tournament.surface,
            tournament.best_of or best_of_guess,
        )
    return TournamentGuess(None, title, None, None, best_of_guess)


# --- кэфы ---


def to_odds(value: Any) -> Decimal | None:
    """Кэф из ответа разбора или ввода: Decimal с 3 знаками; не число — None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite():
        return None
    return number.quantize(ODDS_STEP, rounding=ROUND_HALF_UP)


def odds_ok(value: Decimal) -> bool:
    return ODDS_MIN <= value <= ODDS_MAX


def short_odds(value: Decimal) -> Decimal:
    """Кэф для показа: 1.170 → 1.17, 1.625 остается."""
    two = value.quantize(MONEY_STEP)
    return two if two == value else value


OddsMap = dict[str, list[Decimal | None]]
# Версия формата analyses.confirmed: 2 — новые рынки Р28 списком extra
CONFIRMED_FORMAT = 2


def empty_odds() -> OddsMap:
    return {market: [None, None] for market in MARKETS}


def parsed_odds(odds: Any) -> OddsMap:
    """Кэфы ответа разбора → рынок: [на игрока 1, на игрока 2] (ML и форы ±1.5 по сетам;
    строки других рынков разбирает parsed_lines)."""
    return {
        "ML": [to_odds(odds.ml1), to_odds(odds.ml2)],
        "HCP_-1.5": [to_odds(odds.h1_minus), to_odds(odds.h2_minus)],
        "HCP_+1.5": [to_odds(odds.h1_plus), to_odds(odds.h2_plus)],
    }


def _pair(raw: Any) -> list[Decimal | None]:
    pair = list(raw or [None, None])
    return [
        to_odds(pair[0]) if len(pair) > 0 else None,
        to_odds(pair[1]) if len(pair) > 1 else None,
    ]


def extra_from_json(raw: Any) -> list[ExtraLine]:
    """Строки «Другие рынки» из analyses.confirmed; неверная строка пропускается."""
    found: list[ExtraLine] = []
    for item in raw or []:
        if not isinstance(item, Mapping):
            continue
        line = to_line(item.get("line"))
        if line is None:
            continue
        row = ExtraLine(
            str(item.get("market")), line, to_odds(item.get("o1")), to_odds(item.get("o2"))
        )
        try:
            row.codes()
        except ValueError:
            continue
        found.append(row)
    return found


def odds_from_json(raw: Mapping[str, Any], extra: Any = None) -> OddsMap:
    """Кэфы из analyses.confirmed (строки Decimal): прежние рынки из odds, новые — из
    extra (format 2)."""
    found = empty_odds()
    for market in MARKETS:
        found[market] = _pair(raw.get(market))
    extra_into(found, extra_from_json(extra))
    return found


def odds_to_json(odds: Mapping[str, Sequence[Decimal | None]]) -> dict[str, list[str | None]]:
    """Прежние рынки (ML, форы ±1.5) для analyses.confirmed.odds."""
    return {
        market: [str(value) if value is not None else None for value in odds.get(market, ())]
        for market in MARKETS
    }


def extra_to_json(odds: Mapping[str, Sequence[Decimal | None]]) -> list[dict[str, Any]]:
    """Новые рынки для analyses.confirmed.extra: строки формы по порядку ввода."""
    return [
        {
            "market": row.family,
            "line": str(row.line),
            "o1": str(row.o1) if row.o1 is not None else None,
            "o2": str(row.o2) if row.o2 is not None else None,
        }
        for row in extra_lines(odds)
    ]


def swapped_odds(odds: Mapping[str, Sequence[Decimal | None]]) -> OddsMap:
    """Кэфы со стороны другого игрока: у ML и фор пары переставлены (линия фор — у
    выбранной стороны, поэтому код рынка тот же), у тоталов — нет."""
    found: OddsMap = {}
    for market, pair in odds.items():
        values: list[Decimal | None] = list(pair) if pair else [None, None]
        if is_market(market) and swapped_side(market, 1) == 1:
            found[market] = values
        else:
            found[market] = list(reversed(values))
    for market in MARKETS:
        found.setdefault(market, [None, None])
    return found


def odds_problems(odds: Mapping[str, Sequence[Decimal | None]]) -> list[tuple[str, Decimal]]:
    """Кэфы вне 1.01–50: (рынок, кэф)."""
    return [
        (market, value)
        for market, pair in odds.items()
        for value in pair
        if value is not None and not odds_ok(value)
    ]


def extra_problems(
    rows: Sequence[Any], *, position: int
) -> tuple[list[ExtraLine], list["Problem"]]:
    """Строки «Другие рынки» из запроса (ExtraOddsIn): годные и ошибки. Четвертная
    линия — analysis.line_quarter, линия вне пределов семейства — analysis.market_line,
    строка без кэфов пропускается."""
    found: list[ExtraLine] = []
    problems: list[Problem] = []
    for item in rows:
        line = to_line(item.line)
        if line is None:
            problems.append(
                Problem("analysis.line_quarter", {"position": position, "line": str(item.line)})
            )
            continue
        row = ExtraLine(item.market, line, to_odds(item.o1), to_odds(item.o2))
        if row.o1 is None and row.o2 is None:
            continue
        try:
            row.codes()
        except ValueError:
            problems.append(
                Problem(
                    "analysis.market_line",
                    {"position": position, "market": item.market, "line": str(line)},
                )
            )
            continue
        found.append(row)
    return found, problems


# --- подтвержденные события ---


@dataclass(frozen=True)
class Problem:
    """Почему событие нельзя запустить: код ошибки errors.<code> и параметры."""

    code: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ConfirmedEvent:
    """Событие из analyses.confirmed (раздел 5.1 брифа): игроки, матч, турнир, кэфы."""

    position: int
    player1_id: int
    player2_id: int
    surface: str
    best_of: int
    round: str
    odds: OddsMap
    bookmaker: str | None
    match_id: int | None = None
    tournament_id: int | None = None
    tournament_name: str | None = None
    line_no: int | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "position": self.position,
            "player1_id": self.player1_id,
            "player2_id": self.player2_id,
            "match_id": self.match_id,
            "tournament_id": self.tournament_id,
            "tournament_name": self.tournament_name,
            "surface": self.surface,
            "best_of": self.best_of,
            "round": self.round,
            "odds": odds_to_json(self.odds),
            "extra": extra_to_json(self.odds),
            "bookmaker": self.bookmaker,
            "line_no": self.line_no,
        }

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> "ConfirmedEvent":
        return cls(
            position=int(raw["position"]),
            player1_id=int(raw["player1_id"]),
            player2_id=int(raw["player2_id"]),
            surface=str(raw["surface"]),
            best_of=int(raw["best_of"]),
            round=str(raw.get("round") or ""),
            odds=odds_from_json(raw.get("odds") or {}, raw.get("extra")),
            bookmaker=raw.get("bookmaker"),
            match_id=int(raw["match_id"]) if raw.get("match_id") is not None else None,
            tournament_id=(
                int(raw["tournament_id"]) if raw.get("tournament_id") is not None else None
            ),
            tournament_name=raw.get("tournament_name"),
            line_no=raw.get("line_no"),
        )


@dataclass(frozen=True)
class Confirmed:
    """Подтвержденный ввод анализа."""

    events: list[ConfirmedEvent]
    bank: Decimal | None
    bookmaker: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "format": CONFIRMED_FORMAT,
            "bank": str(self.bank) if self.bank is not None else None,
            "bookmaker": self.bookmaker,
            "events": [event.to_json() for event in self.events],
        }

    @classmethod
    def from_json(cls, raw: Mapping[str, Any] | None) -> "Confirmed":
        if not raw:
            return cls(events=[], bank=None, bookmaker=None)
        bank = raw.get("bank")
        return cls(
            events=[ConfirmedEvent.from_json(item) for item in raw.get("events") or []],
            bank=Decimal(str(bank)) if bank is not None else None,
            bookmaker=raw.get("bookmaker"),
        )


@dataclass(frozen=True)
class EventDraft:
    """Событие из запроса до проверки (поля EventIn)."""

    player1_id: int | None
    player2_id: int | None
    tournament_id: int | None
    tournament_name: str | None
    surface: str | None
    best_of: int | None
    round: str
    odds: OddsMap
    bookmaker: str | None
    line_no: int | None = None
    # Ошибки строк «Другие рынки» (extra_problems) и спорные форы без ответа
    extra_problems: tuple["Problem", ...] = ()
    disputed: int = 0


async def check_events(
    db: AsyncSession, events: Sequence[EventDraft], *, today: date
) -> tuple[list[ConfirmedEvent], list[Problem]]:
    """Проверка событий без записи: 1–5 событий, игроки есть в базе и разные, кэфы П1 и
    П2 есть, все кэфы 1.01–50, покрытие известно, пары игроков не повторяются. Годные
    события — с турниром и форматом матча."""
    problems: list[Problem] = []
    if not events:
        return [], [Problem("analysis.no_events")]
    if len(events) > MAX_EVENTS:
        problems.append(Problem("analysis.too_many_events", {"max": MAX_EVENTS}))
    ids = {pid for event in events for pid in (event.player1_id, event.player2_id) if pid}
    known = set(await db.scalars(select(Player.id).where(Player.id.in_(ids)))) if ids else set()
    tournament_ids = {event.tournament_id for event in events if event.tournament_id}
    # Турнир из ввода другого участника по id не подставляется: его название — чужой текст
    tournaments = (
        {
            row.id: row
            for row in await db.scalars(
                select(Tournament).where(
                    Tournament.id.in_(tournament_ids), Tournament.source != "user"
                )
            )
        }
        if tournament_ids
        else {}
    )
    confirmed: list[ConfirmedEvent] = []
    pairs: set[frozenset[int]] = set()
    for position, event in enumerate(events, start=1):
        bad = len(problems)
        for number, pid in ((1, event.player1_id), (2, event.player2_id)):
            if pid is None or pid not in known:
                problems.append(
                    Problem("analysis.player_missing", {"position": position, "player": number})
                )
        if event.player1_id is not None and event.player1_id == event.player2_id:
            problems.append(Problem("analysis.same_players", {"position": position}))
        if any(value is None for value in event.odds.get("ML", [None, None])):
            problems.append(Problem("analysis.odds_ml", {"position": position}))
        problems.extend(event.extra_problems)
        if event.disputed:
            problems.append(Problem("analysis.hcp_unit", {"position": position}))
        for market, value in odds_problems(event.odds):
            problems.append(
                Problem(
                    "analysis.odds_range",
                    {"position": position, "market": market, "odds": str(value)},
                )
            )
        tournament = tournaments.get(event.tournament_id) if event.tournament_id else None
        guess = None
        if tournament is None and event.tournament_name:
            guess = await resolve_tournament(db, event.tournament_name, today=today)
        surface = event.surface or (tournament.surface if tournament else None)
        if surface is None and guess is not None:
            surface = guess.surface
        if surface is None:
            problems.append(Problem("analysis.surface_missing", {"position": position}))
        if event.player1_id and event.player2_id:
            pair = frozenset((event.player1_id, event.player2_id))
            if pair in pairs:
                problems.append(Problem("analysis.duplicate_event", {"position": position}))
            pairs.add(pair)
        best_of = event.best_of or (tournament.best_of if tournament else None)
        if best_of is None and guess is not None:
            best_of = guess.best_of
        fmt = best_of if best_of in (3, 5) else DEFAULT_BEST_OF
        for market, prices in event.odds.items():
            if any(value is not None for value in prices) and not fits_format(market, fmt):
                problems.append(
                    Problem(
                        "analysis.market_format",
                        {"position": position, "market": market, "best_of": fmt},
                    )
                )
        if len(problems) > bad or surface is None:
            continue
        assert event.player1_id is not None and event.player2_id is not None
        name = tournament.name if tournament else (guess.name if guess else None)
        round_code = event.round.strip().upper()
        confirmed.append(
            ConfirmedEvent(
                position=position,
                player1_id=event.player1_id,
                player2_id=event.player2_id,
                surface=surface,
                best_of=best_of if best_of in (3, 5) else DEFAULT_BEST_OF,
                round=round_code if round_code in ROUNDS else "",
                odds=event.odds,
                bookmaker=event.bookmaker,
                tournament_id=tournament.id if tournament else (guess.id if guess else None),
                tournament_name=name,
                line_no=event.line_no,
            )
        )
    return confirmed, problems


def raise_problem(problems: Sequence[Problem]) -> None:
    """Первая проблема — ошибка 422 запуска."""
    if problems:
        first = problems[0]
        raise AppError(422, first.code, **first.params)


# --- матчи и турниры из ввода ---


def tournament_slug(name: str) -> str:
    """Часть source_ref турнира: латиница и цифры через дефис."""
    slug = _SLUG.sub("-", fold(name).lower()).strip("-")
    return slug[:SLUG_MAX] or "tournament"


async def _user_tournament(db: AsyncSession, event: ConfirmedEvent, *, today: date) -> int | None:
    """Турнир события: найденный в базе или новый tournaments.source = 'user'."""
    if event.tournament_id is not None:
        return event.tournament_id
    if not event.tournament_name:
        return None
    guess = await resolve_tournament(db, event.tournament_name, today=today)
    if guess is not None and guess.id is not None:
        return guess.id
    name = one_line(guess.name if guess else event.tournament_name, NAME_MAX)
    ref = f"user:{today.year}:{tournament_slug(name)}"
    await db.execute(
        pg_insert(Tournament)
        .values(
            name=name,
            category=guess.category if guess else None,
            surface=event.surface,
            best_of=event.best_of,
            source="user",
            source_ref=ref,
        )
        .on_conflict_do_nothing()
    )
    found: int | None = await db.scalar(
        select(Tournament.id).where(Tournament.source == "user", Tournament.source_ref == ref)
    )
    return found


async def find_match(
    db: AsyncSession, player1_id: int, player2_id: int, *, day: date
) -> Match | None:
    """Матч тех же игроков (в любом порядке) с датой ±3 дня, любого источника. День матча
    из ввода участника — день, когда его ввели."""
    when = case(
        (Match.source == "user", func.date(Match.created_at)),
        else_=func.coalesce(Match.match_date, func.date(Match.scheduled_at), Tournament.start_date),
    )
    low, high = day - timedelta(days=MATCH_WINDOW_DAYS), day + timedelta(days=MATCH_WINDOW_DAYS)
    found: Match | None = await db.scalar(
        select(Match)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(_same_players(player1_id, player2_id), when >= low, when <= high)
        .order_by((Match.source == "user").asc(), Match.id.desc())
        .limit(1)
    )
    return found


def _same_players(player1_id: int, player2_id: int) -> ColumnElement[bool]:
    return or_(
        and_(Match.player1_id == player1_id, Match.player2_id == player2_id),
        and_(Match.player1_id == player2_id, Match.player2_id == player1_id),
    )


async def _match_by_key(
    db: AsyncSession, event: ConfirmedEvent, *, ref: str, tournament_id: int | None
) -> Match | None:
    """Матч, с которым конфликтовала вставка: по source_ref или по турниру и раунду."""
    found: Match | None = await db.scalar(
        select(Match).where(Match.source == "user", Match.source_ref == ref)
    )
    if found is None and tournament_id is not None:
        found = await db.scalar(
            select(Match).where(
                Match.tournament_id == tournament_id,
                Match.round == event.round,
                _same_players(event.player1_id, event.player2_id),
            )
        )
    return found


async def attach_matches(
    db: AsyncSession, events: Sequence[ConfirmedEvent], *, day: date
) -> list[ConfirmedEvent]:
    """Матч каждого события (найденный или новый source = 'user'); события
    разворачиваются под порядок игроков матча. flush; commit — за вызывающим."""
    attached: list[ConfirmedEvent] = []
    for event in events:
        match = await find_match(db, event.player1_id, event.player2_id, day=day)
        if match is None:
            tournament_id = await _user_tournament(db, event, today=day)
            low, high = sorted((event.player1_id, event.player2_id))
            ref = f"user:{day.isoformat()}:{low}:{high}"
            await db.execute(
                pg_insert(Match)
                .values(
                    tournament_id=tournament_id,
                    round=event.round,
                    player1_id=event.player1_id,
                    player2_id=event.player2_id,
                    best_of=event.best_of,
                    status="scheduled",
                    source="user",
                    source_ref=ref,
                )
                .on_conflict_do_nothing()
            )
            match = await _match_by_key(db, event, ref=ref, tournament_id=tournament_id)
            if match is None:
                raise AppError(409, "analysis.match_conflict", position=event.position)
            event = replace(event, tournament_id=tournament_id)
        if match.player1_id != event.player1_id:
            event = replace(
                event,
                player1_id=match.player1_id,
                player2_id=match.player2_id,
                odds=swapped_odds(event.odds),
            )
        attached.append(replace(event, match_id=match.id, tournament_id=match.tournament_id))
    await db.flush()
    return attached


def odds_snapshots(
    events: Sequence[ConfirmedEvent], *, bookmaker: str | None, taken_at: datetime
) -> list[OddsSnapshot]:
    """Кэфы участника в odds_snapshots (kind = 'user'): по каждой стороне каждого рынка."""
    rows: list[OddsSnapshot] = []
    for event in events:
        assert event.match_id is not None
        for market, pair in event.odds.items():
            for selection, value in enumerate(pair, start=1):
                if value is None:
                    continue
                rows.append(
                    OddsSnapshot(
                        match_id=event.match_id,
                        market=market,
                        selection=selection,
                        bookmaker=(event.bookmaker or bookmaker or "")[:64],
                        odds=value,
                        kind="user",
                        taken_at=taken_at,
                    )
                )
    return rows


# --- черновик разбора ---


def parsed_input(raw: Mapping[str, Any] | None) -> ParsedInput | None:
    """Сырой ответ разбора из analyses.parsed. Ответ схемы p1 (до Р28) — без odds.lines."""
    if not raw:
        return None
    data = dict(raw)
    events = []
    for event in data.get("events") or []:
        if isinstance(event, Mapping) and isinstance(event.get("odds"), Mapping):
            odds = dict(event["odds"])
            odds.setdefault("lines", [])
            event = {**event, "odds": odds}
        events.append(event)
    data["events"] = events
    try:
        return ParsedInput.model_validate(data)
    except ValueError:
        return None


# Тотал без «сет» и «гейм»: до этой линии — сеты, от GAME_TOTAL_FROM — геймы (Р28)
SET_TOTAL_UPTO = Decimal("5")
GAME_TOTAL_FROM = Decimal("15")
# Спорная фора: кэф форы стороны с минусом к ее кэфу победы. Выше SETS_RATIO — похоже на
# сеты (2:0 намного реже победы), ниже GAMES_RATIO — на геймы
SETS_RATIO = Decimal("1.25")
GAMES_RATIO = Decimal("1.15")
_SET_HCP_DISPUTED = (Decimal("1.5"), Decimal("2.5"))


@dataclass(frozen=True)
class Disputed:
    """Фора без «сет» и «гейм» (±1.5 или ±2.5): по сетам или по геймам — решает участник.
    line — фора игрока 1, o1 и o2 — Ф1 и Ф2."""

    line: Decimal
    o1: Decimal | None
    o2: Decimal | None

    def hint(self, ml: Sequence[Decimal | None]) -> tuple[str, Decimal, Decimal] | None:
        """Подсказка по кэфу победы: (sets | games, кэф форы стороны с минусом, ее кэф
        победы); не сравнить — None."""
        own, win = (self.o1, ml[0]) if self.line < 0 else (self.o2, ml[1])
        if own is None or win is None or win <= 1:
            return None
        ratio = own / win
        if ratio >= SETS_RATIO:
            return "sets", own, win
        if ratio < GAMES_RATIO:
            return "games", own, win
        return None

    def sets_ok(self, best_of: int) -> bool:
        return abs(self.line) == Decimal("1.5") or best_of == 5


@dataclass(frozen=True)
class ParsedLines:
    """Строки форм и тоталов разбора: годные (extra), спорные форы и непонятые с причиной
    (line_no, текст, ключ причины)."""

    extra: list[ExtraLine]
    base: OddsMap
    disputed: list[Disputed]
    unknown: list[tuple[int, str, str]]


def _resolved_family(kind: str, line: Decimal) -> str | None:
    """Семейство строки разбора; None — спорная фора (hcp ±1.5 и ±2.5)."""
    if kind == "set_hcp":
        return "h15" if abs(line) == Decimal("1.5") else "shcp"
    if kind == "game_hcp":
        return "ghcp"
    if kind == "hcp":
        return None if abs(line) in _SET_HCP_DISPUTED else "ghcp"
    if kind == "set_total":
        return "stot"
    if kind == "game_total":
        return "gtot"
    if line <= SET_TOTAL_UPTO:
        return "stot"
    if line >= GAME_TOTAL_FROM:
        return "gtot"
    return "total_unit"


def parsed_lines(odds: Any) -> ParsedLines:
    """Форы и тоталы ответа разбора (схема p2, odds.lines). Четвертная линия и тотал между
    5 и 15 — в «Не понял» с причиной; линия вне пределов рынка — тоже."""
    extra: list[ExtraLine] = []
    base: OddsMap = {}
    disputed: list[Disputed] = []
    unknown: list[tuple[int, str, str]] = []
    for item in getattr(odds, "lines", None) or []:
        line = to_line(item.line)
        if line is None:
            unknown.append((item.line_no, item.text, "analysis.draft.unknown.quarter"))
            continue
        o1, o2 = to_odds(item.odds1), to_odds(item.odds2)
        family = _resolved_family(item.kind, line)
        if family is None:
            disputed.append(Disputed(line, o1, o2))
            continue
        if family == "total_unit":
            unknown.append((item.line_no, item.text, "analysis.draft.unknown.total_unit"))
            continue
        row = ExtraLine(family, line, o1, o2)
        try:
            row.codes()
        except ValueError:
            unknown.append((item.line_no, item.text, "analysis.draft.unknown.market_line"))
            continue
        if family == "h15":
            extra_into(base, [row])
        else:
            extra.append(row)
    return ParsedLines(extra, base, disputed, unknown)


def money(value: float | Decimal | None) -> Decimal | None:
    """Сумма банка из ввода: Decimal с копейками; не число или ≤ 0 — None."""
    if value is None:
        return None
    try:
        number = Decimal(str(value)).quantize(MONEY_STEP, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite() or number <= 0 or number >= Decimal("1e10"):
        return None
    return number
