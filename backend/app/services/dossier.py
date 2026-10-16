"""Досье матча для анализа Claude: считает код, 0 токенов (TOKEN_ECONOMY.md, 4.1;
PLAN.md, разделы 3 и 5).

Досье общее для всех участников: в нем нет кэфов и банка. Одинаковые входные данные дают
одинаковый текст и sha256, поэтому досье пишется в dossiers один раз (ON CONFLICT
(sha256) DO NOTHING), а по его id переиспользуется оценка Claude (match_assessments).

Утечки будущего нет: матчи видны, только если сыграны строго раньше дня as_of (дата
матча — день as_of по UTC). Матч без даты (только из архива Сакманна) считается
сыгранным не позже начала турнира + UNDATED_DAYS и до этого не виден. Эло — из
player_ratings строго до дня as_of (elo.current_elo). Новости — опубликованные за
NEWS_DAYS до as_of и полученные не позже as_of (as_of — момент сборки: шаг новостей идет
раньше).

Формат (TOKEN_ECONOMY.md, 4.1): JSON с короткими английскими ключами, числа округлены,
json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":")). Ключи верхнего
уровня: v (версия формата), as_of, data_to (последний день матча в базе — свежесть
архива), match, p_base (три числа матча, elo_p — Эло без калибровки, cal — есть ли
калибровка Платта), p1 и p2 (игроки), h2h, refs (id фактов, на которые ссылается ответ
Claude: elo, form, h2h, serve, load, news:<id>).
Игрок: id, name, country, age, hand, last (день последнего матча в базе), elo {all, n,
surf, n_surf, use}, form {w5, l5, w10, l10, m[] {d, r, opp, opp_elo, surf, sc, t, rd}},
serve за 52 недели {m, first_in, first_won, second_won, return_won, tb_w, tb_l}, load
{m14, s14, rest}, news[] {id, kind, d, text, src, url} и results[] — то же плюс det
{opp, sc, t, d, won} из player_news.details (RESULT_DETAILS; нет подробностей — null).
Счет в форме — со стороны игрока, в h2h — со стороны победителя.
"""

import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import ColumnElement, and_, case, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.db.models import (
    Dossier,
    Match,
    MatchStat,
    Player,
    PlayerNews,
    PlayerRating,
    Tournament,
)
from app.ingest.rounds import round_order
from app.ml import model_versions
from app.ml.backtest import PlattScaling
from app.ml.elo import (
    ALL,
    RESULT_STATUSES,
    EloParams,
    current_elo,
    rating_surface,
    win_probability,
)
from app.ml.sets import SHOWN_DIGITS, Probs3, base_probs, parse_sets, score_for

FEATURE_SET = "d1"
FORM_SIZE = 10
# Строк формы из базы с запасом: у матчей без даты один день на весь турнир, порядок
# внутри него дает раунд (сортировка в коде)
FORM_FETCH = 20
H2H_LAST = 5
NEWS_DAYS = 30
NEWS_PER_PLAYER = 10
LOAD_DAYS = 14
SERVE_DAYS = 364
# Матч без даты виден через столько дней после начала турнира (как TOURNAMENT_DAYS Эло)
UNDATED_DAYS = timedelta(days=16)
# Название турнира в досье и запросе новостей
TOUR_NAME_MAX = 80

# Подробности свежего результата из поиска (player_news.details, kind='result'): ключ
# details → короткий ключ досье. Другие ключи в досье не попадают
RESULT_DETAILS = {
    "opponent": "opp",
    "score": "sc",
    "tournament": "t",
    "date": "d",
    "won": "won",
}
# Длина строки подробностей в досье (защита от длинного текста в details)
DETAIL_MAX = 80


@dataclass(frozen=True)
class DossierResult:
    """Досье матча. text — канонический JSON (его видит Claude), content — он же
    словарем, p_base — три числа без округления (для predictions.p_base и Р22),
    features — признаки модели для predictions.features. created — строка в dossiers
    новая (иначе такое досье уже было)."""

    dossier_id: int
    sha256: str
    text: str
    content: dict[str, Any]
    p_base: Probs3
    p_raw: float
    calibrated: bool
    news_ids: tuple[int, ...]
    news_version: str | None
    features: dict[str, Any]
    created: bool


def canonical_json(content: dict[str, Any]) -> str:
    """Канонический текст досье: одинаковое содержание — одинаковый текст и sha256."""
    return json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def dossier_flipped(content: Any, player1_id: int, player2_id: int) -> bool | None:
    """Порядок игроков досье относительно матча по id игроков p1 и p2 досье: False —
    игрок 1 досье — игрок 1 матча, True — игрок 2 (матч анализа слит с матчем архива
    в обратном порядке, или стороны досье проверки назначены side_flip). None — по id не
    понять: игроков досье с тех пор слили с другими (id в досье не меняются)."""
    if not isinstance(content, dict):
        return None
    first, second = content.get("p1"), content.get("p2")
    ids = (
        first.get("id") if isinstance(first, dict) else None,
        second.get("id") if isinstance(second, dict) else None,
    )
    if ids[0] == player1_id or ids[1] == player2_id:
        return False
    if ids[0] == player2_id or ids[1] == player1_id:
        return True
    return None


# Путь к данным стороны в refs: «p1.news», «p2.serve»
_SIDE_PATH = re.compile(r"\bp([12])\.")


def _swap_sides(block: Any) -> Any:
    """Пара по сторонам {p1, p2, ...}: значения p1 и p2 меняются местами."""
    if not isinstance(block, dict):
        return block
    out = dict(block)
    if "p1" in block or "p2" in block:
        out["p1"], out["p2"] = block.get("p2"), block.get("p1")
    return out


def _flip_p(value: Any) -> Any:
    return round(1.0 - float(value), SHOWN_DIGITS) if isinstance(value, int | float) else value


def flip_dossier(content: dict[str, Any]) -> dict[str, Any]:
    """Досье в обратном порядке игроков (p1 ↔ p2): блоки игроков; p_base — p1_win и elo_p
    как 1 − p, p1_cover ↔ p2_cover; личные встречи — победы сторон (всего и на покрытии)
    и победитель каждой встречи (счет — со стороны победителя, не меняется); refs —
    пути p1.… ↔ p2.…. Остальное (матч, формат, свежесть данных) от порядка не зависит.
    Нужно, когда досье анализа читается по матчу архива с другим порядком игроков
    (dossier_flipped): весь факт для Claude — в одном порядке."""
    out: dict[str, Any] = {**content, "p1": content.get("p2"), "p2": content.get("p1")}
    shown = content.get("p_base")
    if isinstance(shown, dict):
        base = dict(shown)
        for name in ("p1_win", "elo_p"):
            if name in shown:
                base[name] = _flip_p(shown[name])
        if "p1_cover" in shown or "p2_cover" in shown:
            base["p1_cover"], base["p2_cover"] = shown.get("p2_cover"), shown.get("p1_cover")
        out["p_base"] = base
    meetings_block = content.get("h2h")
    if isinstance(meetings_block, dict):
        flipped = _swap_sides(meetings_block)
        if "surf" in meetings_block:
            flipped["surf"] = _swap_sides(meetings_block["surf"])
        last = meetings_block.get("last")
        if isinstance(last, list):
            flipped["last"] = [
                {**item, "w": 3 - item["w"]}
                if isinstance(item, dict) and item.get("w") in (1, 2)
                else item
                for item in last
            ]
        out["h2h"] = flipped
    refs = content.get("refs")
    if isinstance(refs, dict):
        out["refs"] = {
            key: _SIDE_PATH.sub(lambda m: f"p{3 - int(m.group(1))}.", value)
            if isinstance(value, str)
            else value
            for key, value in refs.items()
        }
    return out


def _ratio(part: int | None, whole: int | None) -> float | None:
    if part is None or not whole:
        return None
    return round(part / whole, 2)


def _round_rank(code: str | None) -> int:
    try:
        return round_order(code or "")
    except ValueError:
        return 0


def match_day() -> ColumnElement[date]:
    return func.coalesce(Match.match_date, Tournament.start_date)


def visible(day: date | None) -> ColumnElement[bool]:
    """Матч сыгран строго раньше дня day (матч без даты — см. docstring модуля). None —
    все матчи в базе с днем (карточка игрока: состояние на сейчас, без момента
    анализа)."""
    if day is None:
        return match_day().is_not(None)
    return or_(
        and_(Match.match_date.is_not(None), Match.match_date < day),
        and_(Match.match_date.is_(None), Tournament.start_date < day - UNDATED_DAYS),
    )


def plays(player_ids: Sequence[int]) -> ColumnElement[bool]:
    return or_(Match.player1_id.in_(player_ids), Match.player2_id.in_(player_ids))


def with_result() -> ColumnElement[bool]:
    return and_(Match.status.in_(RESULT_STATUSES), Match.winner_id.is_not(None))


@dataclass(frozen=True)
class Played:
    """Сыгранный матч игрока (строка формы или нагрузки)."""

    match_id: int
    day: date
    opponent: int
    won: bool
    score: str | None
    surface: str | None
    tournament: str | None
    round: str
    opp_elo: float | None = None


def sort_played(rows: Iterable[Played]) -> list[Played]:
    """От последнего матча к первому: день, раунд, id."""
    return sorted(
        rows, key=lambda row: (row.day, _round_rank(row.round), row.match_id), reverse=True
    )


async def form_rows(db: AsyncSession, player_id: int, day: date | None) -> list[Played]:
    """Последние FORM_SIZE матчей игрока, видимых на день day (None — все в базе), от
    последнего; у соперника — его общее Эло до матча."""
    day_expr = match_day()
    opponent = case((Match.player1_id == player_id, Match.player2_id), else_=Match.player1_id)
    opp_elo = (
        select(PlayerRating.elo)
        .where(
            PlayerRating.player_id == opponent,
            PlayerRating.surface == ALL,
            PlayerRating.as_of < day_expr,
        )
        .order_by(PlayerRating.as_of.desc())
        .limit(1)
        .correlate(Match, Tournament)
        .scalar_subquery()
    )
    rows = await db.execute(
        select(
            Match.id,
            day_expr,
            opponent,
            Match.winner_id,
            Match.score,
            Tournament.surface,
            Tournament.name,
            Match.round,
            opp_elo,
        )
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(plays([player_id]), with_result(), visible(day))
        .order_by(day_expr.desc(), Match.id.desc())
        .limit(FORM_FETCH)
    )
    played = [
        Played(
            match_id=match_id,
            day=played_day,
            opponent=opp,
            won=winner == player_id,
            score=score,
            surface=surface,
            tournament=tournament,
            round=round_code or "",
            opp_elo=elo,
        )
        for match_id, played_day, opp, winner, score, surface, tournament, round_code, elo in rows
    ]
    return sort_played(played)[:FORM_SIZE]


async def recent_rows(
    db: AsyncSession, player_ids: Sequence[int], day: date, *, cutoff: bool = True
) -> dict[int, list[Played]]:
    """Матчи игроков за SERVE_DAYS до дня day: тай-брейки и нагрузка. cutoff=False —
    без отсечки по дню (карточка игрока: и матчи, сыгранные в день day и позже)."""
    day_expr = match_day()
    rows = await db.execute(
        select(
            Match.id,
            day_expr,
            Match.player1_id,
            Match.player2_id,
            Match.winner_id,
            Match.score,
            Match.round,
        )
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(
            plays(player_ids),
            with_result(),
            visible(day if cutoff else None),
            day_expr >= day - timedelta(days=SERVE_DAYS),
        )
    )
    found: dict[int, list[Played]] = defaultdict(list)
    for match_id, played_day, player1, player2, winner, score, round_code in rows:
        for player, opponent in ((player1, player2), (player2, player1)):
            if player in player_ids:
                found[player].append(
                    Played(
                        match_id=match_id,
                        day=played_day,
                        opponent=opponent,
                        won=winner == player,
                        score=score,
                        surface=None,
                        tournament=None,
                        round=round_code or "",
                    )
                )
    return found


@dataclass(frozen=True)
class ServeSums:
    """Суммы match_stats игрока за окно: свои (подача) и соперников (прием) по матчам,
    где у обоих есть очки на подаче, первые и выигранные первые и вторые. aces, df,
    bp_* и *_n (сколько матчей с этим полем) — по тем же матчам, где поле заполнено."""

    matches: int
    svpt: int
    first_in: int
    first_won: int
    second_won: int
    opp_svpt: int
    opp_first_won: int
    opp_second_won: int
    opp_first_in: int
    opp_first_in_n: int
    aces: int
    aces_n: int
    double_faults: int
    double_faults_n: int
    bp_saved: int
    bp_faced: int
    opp_bp_saved: int
    opp_bp_faced: int


async def serve_sums(
    db: AsyncSession, player_ids: Sequence[int], day: date, *, cutoff: bool = True
) -> dict[int, ServeSums]:
    """Суммы подачи и приема каждого игрока за SERVE_DAYS до дня day (только матчи, где у
    обоих полная статистика очков подачи). cutoff=False — без отсечки по дню."""
    own = aliased(MatchStat)
    opp = aliased(MatchStat)
    columns = (
        own.serve_points,
        own.first_in,
        own.first_won,
        own.second_won,
        opp.serve_points,
        opp.first_won,
        opp.second_won,
    )
    extra = (
        func.coalesce(func.sum(opp.first_in), 0),
        func.count(opp.first_in),
        func.coalesce(func.sum(own.aces), 0),
        func.count(own.aces),
        func.coalesce(func.sum(own.double_faults), 0),
        func.count(own.double_faults),
        func.coalesce(func.sum(own.bp_saved), 0),
        func.coalesce(func.sum(own.bp_faced), 0),
        func.coalesce(func.sum(opp.bp_saved), 0),
        func.coalesce(func.sum(opp.bp_faced), 0),
    )
    rows = await db.execute(
        select(
            own.player_id,
            func.count(),
            *(func.sum(column) for column in columns),
            *extra,
        )
        .select_from(Match)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .join(own, and_(own.match_id == Match.id, own.player_id.in_(player_ids)))
        .join(opp, and_(opp.match_id == Match.id, opp.player_id != own.player_id))
        .where(
            plays(player_ids),
            with_result(),
            visible(day if cutoff else None),
            match_day() >= day - timedelta(days=SERVE_DAYS),
            *(column.is_not(None) for column in columns),
            own.serve_points > 0,
            opp.serve_points > 0,
        )
        .group_by(own.player_id)
    )
    return {int(row[0]): ServeSums(*(int(value or 0) for value in row[1:])) for row in rows}


async def _serve_stats(
    db: AsyncSession, player_ids: Sequence[int], day: date
) -> dict[int, dict[str, Any]]:
    """Подача и прием за 52 недели для досье (доли с округлением до сотых)."""
    stats: dict[int, dict[str, Any]] = {}
    for player_id, sums in (await serve_sums(db, player_ids, day)).items():
        stats[player_id] = {
            "m": sums.matches,
            "first_in": _ratio(sums.first_in, sums.svpt),
            "first_won": _ratio(sums.first_won, sums.first_in),
            "second_won": _ratio(sums.second_won, sums.svpt - sums.first_in),
            "return_won": _ratio(
                sums.opp_svpt - sums.opp_first_won - sums.opp_second_won, sums.opp_svpt
            ),
        }
    return stats


@dataclass(frozen=True)
class Meeting:
    """Личная встреча: день, победитель, счет (со стороны победителя), турнир."""

    match_id: int
    day: date
    winner_id: int
    score: str | None
    surface: str | None
    tournament: str | None
    category: str | None
    round: str
    best_of: int | None


async def meetings(db: AsyncSession, player1: int, player2: int, day: date | None) -> list[Meeting]:
    """Личные встречи двух игроков с результатом, видимые на день day (None — все), от
    последней."""
    day_expr = match_day()
    rows = await db.execute(
        select(
            Match.id,
            day_expr,
            Match.winner_id,
            Match.score,
            Tournament.surface,
            Tournament.name,
            Tournament.category,
            Match.round,
            func.coalesce(Match.best_of, Tournament.best_of),
        )
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(
            or_(
                and_(Match.player1_id == player1, Match.player2_id == player2),
                and_(Match.player1_id == player2, Match.player2_id == player1),
            ),
            with_result(),
            visible(day),
        )
        .order_by(day_expr.desc(), Match.id.desc())
    )
    return [
        Meeting(
            match_id=match_id,
            day=played_day,
            # with_result: победитель есть всегда
            winner_id=winner if winner is not None else 0,
            score=score,
            surface=surface,
            tournament=tournament,
            category=category,
            round=round_code or "",
            best_of=best_of,
        )
        for (
            match_id,
            played_day,
            winner,
            score,
            surface,
            tournament,
            category,
            round_code,
            best_of,
        ) in rows
    ]


async def h2h(
    db: AsyncSession, player1: int, player2: int, day: date, surface: str | None
) -> dict[str, Any]:
    found = await meetings(db, player1, player2, day)
    court = rating_surface(surface)
    same = [item for item in found if court is not None and rating_surface(item.surface) == court]

    def wins(items: Sequence[Meeting], player: int) -> int:
        return sum(1 for item in items if item.winner_id == player)

    return {
        "n": len(found),
        "p1": wins(found, player1),
        "p2": wins(found, player2),
        "surf": {"n": len(same), "p1": wins(same, player1), "p2": wins(same, player2)},
        "last": [
            {
                "d": item.day.isoformat(),
                "w": 1 if item.winner_id == player1 else 2,
                "surf": item.surface,
                "sc": item.score,
                "t": item.tournament,
            }
            for item in found[:H2H_LAST]
        ],
    }


def result_details(details: Any) -> dict[str, Any] | None:
    """Подробности результата для досье: только ключи RESULT_DETAILS, строки (до
    DETAIL_MAX символов) и won — да/нет. Нечего показать — None."""
    if not isinstance(details, dict):
        return None
    out: dict[str, Any] = {}
    for key, short in RESULT_DETAILS.items():
        value = details.get(key)
        if key == "won":
            if isinstance(value, bool):
                out[short] = value
        elif isinstance(value, str) and value.strip():
            out[short] = value.strip()[:DETAIL_MAX]
    return out or None


async def _news(
    db: AsyncSession, player_ids: Sequence[int], as_of: datetime
) -> dict[int, list[dict[str, Any]]]:
    rows = await db.execute(
        select(
            PlayerNews.id,
            PlayerNews.player_id,
            PlayerNews.published_at,
            PlayerNews.kind,
            PlayerNews.summary,
            PlayerNews.source_url,
            PlayerNews.source_name,
            PlayerNews.details,
        )
        .where(
            PlayerNews.player_id.in_(player_ids),
            PlayerNews.published_at >= as_of - timedelta(days=NEWS_DAYS),
            PlayerNews.published_at < as_of,
            PlayerNews.fetched_at <= as_of,
        )
        .order_by(PlayerNews.published_at.desc(), PlayerNews.id.desc())
    )
    found: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for news_id, player_id, published, kind, summary, url, source, details in rows:
        if len(found[player_id]) >= NEWS_PER_PLAYER:
            continue
        item: dict[str, Any] = {
            "id": news_id,
            "kind": kind,
            "d": published.astimezone(UTC).date().isoformat(),
            "text": summary,
            "src": source,
            "url": url,
        }
        if kind == "result":
            item["det"] = result_details(details)
        found[player_id].append(item)
    return found


async def data_to_on(db: AsyncSession, day: date) -> date | None:
    """Последний день матча с результатом в базе, видимый на день day (раньше day; матч
    без даты — через UNDATED_DAYS после начала турнира). Им же «архив до» в «Игроках»."""
    dated = (
        select(func.max(Match.match_date))
        .where(Match.match_date < day, Match.status.in_(RESULT_STATUSES))
        .scalar_subquery()
    )
    undated = (
        select(Tournament.start_date)
        .where(
            Tournament.start_date < day - UNDATED_DAYS,
            select(Match.id)
            .where(
                Match.tournament_id == Tournament.id,
                Match.match_date.is_(None),
                Match.status.in_(RESULT_STATUSES),
            )
            .exists(),
        )
        .order_by(Tournament.start_date.desc())
        .limit(1)
        .scalar_subquery()
    )
    value: date | None = await db.scalar(select(func.greatest(dated, undated)))
    return value


async def model_params(db: AsyncSession) -> dict[str, Any]:
    """elo-v1 и калибровка активной версии базовой модели (app/ml/model_versions.py)."""
    return await model_versions.model_params(db)


def _platt(params: dict[str, Any]) -> PlattScaling | None:
    platt = params.get("platt")
    if not isinstance(platt, dict):
        return None
    try:
        return PlattScaling(a=float(platt["a"]), b=float(platt["b"]))
    except (KeyError, TypeError, ValueError):
        return None


def calibrated_p1(p_raw: float, platt: PlattScaling | None) -> float:
    """Калибровка Платта для игрока 1, симметричная по сторонам: (cal(p) + 1 − cal(1 −
    p)) / 2. Так досье с переставленными игроками дает дополнение до 1 (калибровку
    подбирали на сторонах, назначенных случайно, сдвиг a — шум около 0). От cal(p)
    бэктеста отличается не больше чем на |a|/4: при a = 0,009 — 0,0022."""
    if platt is None:
        return p_raw
    first, second = (float(value) for value in platt.apply([p_raw, 1.0 - p_raw]))
    return (first + 1.0 - second) / 2.0


def _age(birth: date | None, day: date) -> float | None:
    return round((day - birth).days / 365.25, 1) if birth else None


def _form_block(rows: Sequence[Played], names: dict[int, str]) -> dict[str, Any]:
    last5 = rows[:5]
    return {
        "w5": sum(1 for row in last5 if row.won),
        "l5": sum(1 for row in last5 if not row.won),
        "w10": sum(1 for row in rows if row.won),
        "l10": sum(1 for row in rows if not row.won),
        "m": [
            {
                "d": row.day.isoformat(),
                "r": "W" if row.won else "L",
                "opp": names.get(row.opponent),
                "opp_elo": round(row.opp_elo) if row.opp_elo is not None else None,
                "surf": row.surface,
                "sc": score_for(row.score, row.won),
                "t": row.tournament,
                "rd": row.round,
            }
            for row in rows
        ],
    }


def tiebreaks(rows: Sequence[Played]) -> tuple[int, int]:
    won = lost = 0
    for row in rows:
        for winner_games, loser_games, _ in parse_sets(row.score):
            if {winner_games, loser_games} == {6, 7}:
                set_won = winner_games > loser_games
                if set_won == row.won:
                    won += 1
                else:
                    lost += 1
    return won, lost


def load_block(rows: Sequence[Played], day: date, last: date | None) -> dict[str, Any]:
    since = day - timedelta(days=LOAD_DAYS)
    recent = [row for row in rows if row.day >= since]
    return {
        "m14": len(recent),
        "s14": sum(len(parse_sets(row.score)) for row in recent),
        "rest": (day - last).days if last is not None else None,
    }


async def archive_tournament(
    db: AsyncSession, tournament_id: int | None
) -> tuple[str | None, str | None]:
    """Название и категория турнира для запросов Claude (досье, сообщение шага новостей)
    и для экрана других участников: только из архивов. Турнир из ввода участника
    (source = 'user') — его свободный текст (до 200 символов): название берется, только
    если такое же есть у турнира из архива (новый выпуск известного турнира). Иначе текст
    одного участника попадал бы в досье, промпт и экран другого и через общий кэш
    новостей и повтор оценки влиял бы на анализы всех."""
    if tournament_id is None:
        return None, None
    row = (
        await db.execute(
            select(Tournament.name, Tournament.category, Tournament.source).where(
                Tournament.id == tournament_id
            )
        )
    ).first()
    if row is None:
        return None, None
    name, category, source = row
    if source == "user":
        known = await db.scalar(
            select(Tournament.id)
            .where(Tournament.source != "user", func.lower(Tournament.name) == name.lower())
            .limit(1)
        )
        if known is None:
            return None, None
    return " ".join(name.split())[:TOUR_NAME_MAX], category


async def build_dossier(
    db: AsyncSession,
    match: Match,
    *,
    as_of: datetime,
    best_of: int,
    surface: str,
    with_news: bool = True,
    swap: bool = False,
    model: model_versions.ModelSnapshot | None = None,
) -> DossierResult:
    """Досье матча на момент as_of (aware datetime): собрать, записать в dossiers (новая
    строка или уже существующая с тем же sha256) и вернуть. surface и best_of — из
    подтвержденного ввода (у матча из ввода турнира может не быть). Коммит — за
    вызывающим.

    Для проверки на архиве (команда smoke-eval): with_news=False — досье без новостей
    (срез «Claude без новостей»), swap=True — игрок 2 матча становится p1 досье (в архиве
    игрок 1 — победитель, стороны назначает проверка). model — снимок базовой модели
    (один на анализ или закрепленный за набором); нет — активная версия. Id версии идет в
    features.ml_model_id: прогноз помечается той версией, что дала p_base."""
    if as_of.tzinfo is None:
        raise ValueError("build_dossier: as_of без часового пояса")
    day = as_of.astimezone(UTC).date()
    surface = surface.strip().lower()
    player_ids = (
        (match.player2_id, match.player1_id) if swap else (match.player1_id, match.player2_id)
    )
    model = model or await model_versions.snapshot(db)
    params = model.params
    weight = float(params.get("surface_weight", EloParams.surface_weight))
    initial = float(params.get("initial", EloParams.initial))
    platt = _platt(params)

    elo: dict[int, dict[str, Any]] = {}
    for player_id in player_ids:
        snapshot = await current_elo(db, player_id, surface, before=day)
        rating = snapshot.rating(weight, initial) if snapshot is not None else initial
        elo[player_id] = {
            "all": round(snapshot.overall) if snapshot else round(initial),
            "n": snapshot.overall_matches if snapshot else 0,
            "surf": round(snapshot.surface_elo)
            if snapshot and snapshot.surface_elo is not None
            else None,
            "n_surf": snapshot.surface_matches if snapshot else 0,
            "use": round(rating),
            "use_exact": rating,
        }
    p_raw = win_probability(elo[player_ids[0]]["use_exact"], elo[player_ids[1]]["use_exact"])
    p_base = base_probs(calibrated_p1(p_raw, platt), best_of)

    form = {player_id: await form_rows(db, player_id, day) for player_id in player_ids}
    recent = await recent_rows(db, player_ids, day)
    serve = await _serve_stats(db, player_ids, day)
    news = await _news(db, player_ids, as_of) if with_news else {}
    data_to = await data_to_on(db, day)
    head_to_head = await h2h(db, *player_ids, day, surface)

    people = {
        row.id: row
        for row in await db.execute(
            select(Player.id, Player.name, Player.country, Player.hand, Player.birth_date).where(
                Player.id.in_(
                    {*player_ids, *(item.opponent for rows in form.values() for item in rows)}
                )
            )
        )
    }
    names = {player_id: row.name for player_id, row in people.items()}

    tour, level = await archive_tournament(db, match.tournament_id)

    refs: dict[str, str] = {"elo": "p1.elo p2.elo p_base", "h2h": "h2h"}
    blocks: dict[str, dict[str, Any]] = {}
    news_ids: list[int] = []
    for position, player_id in enumerate(player_ids, start=1):
        key = f"p{position}"
        person = people.get(player_id)
        rows = form[player_id]
        last = rows[0].day if rows else None
        tb_won, tb_lost = tiebreaks(recent.get(player_id, []))
        serve_block = serve.get(player_id)
        if serve_block is not None or tb_won or tb_lost:
            serve_block = {**(serve_block or {"m": 0}), "tb_w": tb_won, "tb_l": tb_lost}
            refs["serve"] = "p1.serve p2.serve"
        items = news.get(player_id, [])
        fresh = [item for item in items if item["kind"] != "result"]
        results = [item for item in items if item["kind"] == "result"]
        for item in items:
            where = "results" if item["kind"] == "result" else "news"
            refs[f"news:{item['id']}"] = f"{key}.{where}"
            news_ids.append(int(item["id"]))
        elo_block = {name: value for name, value in elo[player_id].items() if name != "use_exact"}
        blocks[key] = {
            "id": player_id,
            "name": person.name if person else None,
            "country": person.country if person else None,
            "age": _age(person.birth_date, day) if person else None,
            "hand": person.hand if person else None,
            "last": last.isoformat() if last else None,
            "elo": elo_block,
            "form": _form_block(rows, names),
            "serve": serve_block,
            "load": load_block(recent.get(player_id, []), day, last),
            "news": fresh,
            "results": results,
        }
        if rows:
            refs["form"] = "p1.form p2.form"
        refs["load"] = "p1.load p2.load"

    content: dict[str, Any] = {
        "v": FEATURE_SET,
        "as_of": day.isoformat(),
        "data_to": data_to.isoformat() if data_to else None,
        "match": {
            "id": match.id,
            "surface": surface,
            "bo": best_of,
            "tour": tour,
            "level": level,
            "round": match.round or "",
        },
        "p_base": {
            **p_base.shown().as_dict(),
            "elo_p": round(p_raw, 3),
            "cal": platt is not None,
        },
        **blocks,
        "h2h": head_to_head,
        "refs": refs,
    }
    text = canonical_json(content)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    news_ids.sort()
    news_version = (
        hashlib.sha256(",".join(map(str, news_ids)).encode()).hexdigest() if news_ids else None
    )
    new_id = await db.scalar(
        pg_insert(Dossier)
        .values(
            match_id=match.id,
            as_of=as_of,
            content=content,
            sha256=digest,
            feature_set=FEATURE_SET,
            news_version=news_version,
        )
        .on_conflict_do_nothing(index_elements=[Dossier.sha256])
        .returning(Dossier.id)
    )
    dossier_id = new_id
    if dossier_id is None:
        dossier_id = await db.scalar(select(Dossier.id).where(Dossier.sha256 == digest))
    assert dossier_id is not None
    features = {
        "elo1": elo[player_ids[0]]["use_exact"],
        "elo2": elo[player_ids[1]]["use_exact"],
        "surface_weight": weight,
        "p_raw": p_raw,
        "platt": {"a": platt.a, "b": platt.b} if platt is not None else None,
        "best_of": best_of,
        "surface": surface,
        "ml_model_id": model.model_id,
    }
    return DossierResult(
        dossier_id=dossier_id,
        sha256=digest,
        text=text,
        content=content,
        p_base=p_base,
        p_raw=p_raw,
        calibrated=platt is not None,
        news_ids=tuple(news_ids),
        news_version=news_version,
        features=features,
        created=new_id is not None,
    )
