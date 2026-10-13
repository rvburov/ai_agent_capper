"""Карточка игрока (этап 4): шапка и «Обзор», матчи страницами, новости, личные встречи;
и общие части списка «Игроки»: свежесть архива, форма и последний матч, «сегодня».

Запросы о матчах — те же, что у досье матча (app/services/dossier.py), но на сейчас:
без момента анализа (dossier.visible(None) — все матчи в базе с известным днем). Текущее
Эло, место по Эло и последний матч — из player_elo_current (его пишет шаг elo обновления
данных, app/ml/elo.py).

Личное в карточке — только «сегодня»: свои открытые ставки и сегодняшние анализы
(app/services/dashboard.my_matches по user_id сеанса). Остальное общее для всех
участников.

Окна (сегодня — по UTC, матчи сегодняшнего дня входят, как в анализе на завтра):
форма — последние 10 матчей; нагрузка — 14 дней по сегодня включительно; ключевые матчи —
364 дня по сегодня включительно (то же окно, что у места по Эло и matches_52w); результаты
по покрытиям и итоги вкладки «Матчи» — 2 сезона (с 1 января прошлого года); подача и
прием — 52 недели до последнего дня со статистикой в архиве (она есть только у Сакманна)
против суммы первых TOUR_TOP игроков по месту по Эло за то же окно.
"""

import time
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, fields
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import exists, func, select, text, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.core.errors import AppError
from app.db.models import (
    Analysis,
    Bet,
    Match,
    MatchStat,
    Player,
    PlayerEloCurrent,
    PlayerNews,
    PlayerProfile,
    Tournament,
    User,
)
from app.ingest.rounds import round_order
from app.ml.elo import (
    CURRENT_DAYS,
    ELO_SURFACES,
    EloParams,
    current_since,
    rating_surface,
    win_probability,
)
from app.ml.sets import parse_sets, score_for
from app.schemas.bets import PlayerRefOut
from app.schemas.dashboard import ArchiveSourceOut, MyMatchOut
from app.schemas.players import (
    ArchiveInfoOut,
    EloOut,
    FormMatchOut,
    H2HMatchOut,
    H2HOut,
    KeyMatchesOut,
    LastMatchOut,
    LegacyProfileOut,
    NewsStatusOut,
    PlayerCardOut,
    PlayerFormOut,
    PlayerMatchesOut,
    PlayerMatchesSummaryOut,
    PlayerMatchOut,
    PlayerNewsItemOut,
    PlayerNewsOut,
    ResultsOut,
    ServeMetricsOut,
    ServeOut,
    SurfaceEloOut,
    SurfaceResultOut,
    TodayH2HOut,
    TodayOut,
    WinLossOut,
)
from app.services import dossier
from app.services.bank import local_today, user_zone
from app.services.data_status import STALE_AFTER, is_stale, last_ok_loads
from app.services.sessions import utcnow

FORM_SIZE = dossier.FORM_SIZE
# Сколько матчей формы читать на игрока списка: у матчей без даты один день на весь
# турнир, порядок внутри него дает раунд (как dossier.FORM_FETCH)
FORM_FETCH = dossier.FORM_FETCH
TOP = 10
TOUR_TOP = 50
# Окно поиска последнего дня со статистикой: турниры Сакманна, начатые не раньше месяца
# до самого позднего турнира со статистикой (Большой шлем идет две недели)
STATS_LOOKBACK = timedelta(days=31)
MATCHES_LIMIT = 20
MATCHES_LIMIT_MAX = 100
NEWS_LIMIT = 20
NEWS_LIMIT_MAX = 100
PROFILE_SOURCE = "legacy_llm"
RESULT_STATUSES = ("finished", "retired")
LISTED_STATUSES = (*RESULT_STATUSES, "walkover")
_SHARE_DIGITS = 4


def age_on(birth: date | None, day: date) -> int | None:
    """Полных лет на день day."""
    if birth is None:
        return None
    return day.year - birth.year - ((day.month, day.day) < (birth.month, birth.day))


def elo_int(value: float | None) -> int | None:
    return round(value) if value is not None else None


def elo_delta(surface: float | None, overall: float | None) -> int | None:
    """Эло на покрытии минус общий — разница показанных целых чисел (как в макете), а не
    округленная разница: иначе «1447 (−66)» при общем 1512."""
    shown, base = elo_int(surface), elo_int(overall)
    return shown - base if shown is not None and base is not None else None


def _round_rank(code: str | None) -> int:
    try:
        return round_order(code or "")
    except ValueError:
        return 0


def _share(part: int | float, whole: int | float) -> float | None:
    return round(part / whole, _SHARE_DIGITS) if whole else None


def seasons_since(today: date) -> date:
    """Начало окна «2 сезона»: 1 января прошлого года."""
    return date(today.year - 1, 1, 1)


async def player_or_404(db: AsyncSession, player_id: int) -> Player:
    player = await db.get(Player, player_id)
    if player is None:
        raise AppError(404, "player.not_found", id=player_id)
    return player


async def current_rows(db: AsyncSession, player_ids: Iterable[int]) -> dict[int, PlayerEloCurrent]:
    ids = sorted(set(player_ids))
    if not ids:
        return {}
    rows = await db.scalars(select(PlayerEloCurrent).where(PlayerEloCurrent.player_id.in_(ids)))
    return {row.player_id: row for row in rows}


async def player_refs(db: AsyncSession, player_ids: Iterable[int]) -> dict[int, PlayerRefOut]:
    ids = sorted(set(player_ids))
    if not ids:
        return {}
    rows = await db.execute(
        select(Player.id, Player.name, Player.name_ru).where(Player.id.in_(ids))
    )
    return {pid: PlayerRefOut(id=pid, name=name, name_ru=name_ru) for pid, name, name_ru in rows}


def _ref(refs: dict[int, PlayerRefOut], player_id: int) -> PlayerRefOut:
    return refs.get(player_id) or PlayerRefOut(id=player_id, name=str(player_id), name_ru=None)


def _tournament_name(name: str | None, source: str | None) -> str | None:
    """Турнир из ввода участника — его свободный текст: другим участникам не показываем
    (как dossier.archive_tournament). У матчей с результатом таких почти не бывает."""
    return None if source == "user" else name


# --- свежесть архива ---


async def archive_info(db: AsyncSession, now: datetime) -> ArchiveInfoOut:
    """Последний день матча в базе и загрузки архивов (правило data_stale). День — по
    самим матчам, как в досье, а не по player_elo_current: обновление без шага elo (или
    со сбоем в нем) не оставляет в шапке старую дату. Сегодняшние матчи учитываются."""
    loads = await last_ok_loads(db)
    known = [when for when in loads.values() if when is not None]
    stale = is_stale(loads, now)
    oldest = min(known) if len(known) == len(loads) else None
    data_to = await dossier.data_to_on(db, now.date() + timedelta(days=1))
    return ArchiveInfoOut(
        data_to=data_to,
        last_load=max(known) if known else None,
        stale=stale,
        stale_days=(now - oldest).days if stale and oldest is not None else None,
        stale_after_days=STALE_AFTER.days,
        sources=[
            ArchiveSourceOut(source=source, last_load=when)  # type: ignore[arg-type]
            for source, when in loads.items()
        ],
    )


# --- форма и последний матч для списка ---


@dataclass(frozen=True)
class RecentForm:
    """Последние матчи игрока списка: исходы (сначала последний) и последний матч."""

    results: list[bool]
    last: LastMatchOut | None


# Последние FORM_FETCH матчей с результатом каждого игрока (день, затем id); точный
# порядок внутри дня (раунд) и обрезку до FORM_SIZE делает код, как dossier.form_rows
_RECENT_SQL = text(
    """
SELECT p.pid, f.id, f.day, f.won, f.round, f.tname, f.category, f.tsource
FROM unnest(CAST(:ids AS bigint[])) AS p(pid)
CROSS JOIN LATERAL (
    SELECT m.id, coalesce(m.match_date, t.start_date) AS day, m.winner_id = p.pid AS won,
           m.round, t.name AS tname, t.category, t.source AS tsource
    FROM matches m LEFT JOIN tournaments t ON t.id = m.tournament_id
    WHERE (m.player1_id = p.pid OR m.player2_id = p.pid)
      AND m.status IN ('finished', 'retired') AND m.winner_id IS NOT NULL
      AND coalesce(m.match_date, t.start_date) IS NOT NULL
    ORDER BY coalesce(m.match_date, t.start_date) DESC, m.id DESC
    LIMIT :fetch
) AS f
"""
)


async def recent_forms(db: AsyncSession, player_ids: Sequence[int]) -> dict[int, RecentForm]:
    """Форма (последние FORM_SIZE матчей) и последний матч игроков страницы списка."""
    if not player_ids:
        return {}
    rows = await db.execute(_RECENT_SQL, {"ids": list(player_ids), "fetch": FORM_FETCH})
    found: dict[int, list[Any]] = defaultdict(list)
    for row in rows:
        found[int(row.pid)].append(row)
    out: dict[int, RecentForm] = {}
    for pid, items in found.items():
        items.sort(key=lambda row: (row.day, _round_rank(row.round), row.id), reverse=True)
        top = items[:FORM_SIZE]
        first = top[0]
        out[pid] = RecentForm(
            results=[bool(row.won) for row in top],
            last=LastMatchOut(
                match_id=first.id,
                day=first.day,
                tournament=_tournament_name(first.tname, first.tsource),
                category=first.category,
                round=first.round or "",
            ),
        )
    return out


# --- «сегодня» (только свое) ---


async def today_matches(db: AsyncSession, user: User, now: datetime) -> list[MyMatchOut]:
    """Свои матчи сегодня (открытые ставки и сегодняшние анализы), как на главной."""
    # Импорт здесь: главная тянет ставки и анализы, а они — список игроков
    # (app.services.players импортирует этот модуль)
    from app.services.dashboard import my_matches

    zone = user_zone(user.tz)
    return await my_matches(db, user, zone, local_today(zone, now), now)


def today_players(items: Sequence[MyMatchOut]) -> set[int]:
    return {player.id for item in items for player in (item.player1, item.player2)}


def _input_surface(confirmed: Any, match_id: int) -> str | None:
    """Покрытие события матча match_id в подтвержденном вводе анализа."""
    events = confirmed.get("events") if isinstance(confirmed, dict) else None
    for event in events if isinstance(events, list) else []:
        if not isinstance(event, dict) or event.get("match_id") != match_id:
            continue
        surface = event.get("surface")
        if isinstance(surface, str) and surface.strip():
            return surface.strip().lower()
    return None


async def _today_surfaces(
    db: AsyncSession, user: User, items: Sequence[MyMatchOut]
) -> dict[int, str | None]:
    """Покрытие своих сегодняшних матчей — как у ноги ставки (bets.LegContext.surface):
    турнир архива, иначе свой подтвержденный ввод этого матча — анализ своей ставки на
    него, затем сегодняшние анализы. Турнир и матч из ввода участника общие для всех (их
    создает тот, кто ввел матч первым), поэтому их покрытие не берется: это мог быть
    чужой ввод (Т29)."""
    if not items:
        return {}
    rows = await db.execute(
        select(Match.id, Tournament.surface, Tournament.source)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.id.in_([item.match_id for item in items]))
    )
    surfaces: dict[int, str | None] = {
        match_id: surface if source != "user" and surface else None
        for match_id, surface, source in rows
    }
    missing = [item for item in items if surfaces.get(item.match_id) is None]
    if not missing:
        return surfaces
    bet_ids = {bet.bet_id for item in missing for bet in item.bets}
    by_bet: dict[int, int] = {}
    if bet_ids:
        by_bet = {
            int(bet_id): int(analysis_id)
            for bet_id, analysis_id in await db.execute(
                select(Bet.id, Bet.analysis_id).where(Bet.id.in_(bet_ids), Bet.user_id == user.id)
            )
            if analysis_id is not None
        }
    order = {
        item.match_id: list(
            dict.fromkeys(
                [*(by_bet[bet.bet_id] for bet in item.bets if bet.bet_id in by_bet), *item.analyses]
            )
        )
        for item in missing
    }
    wanted = {analysis_id for ids in order.values() for analysis_id in ids}
    confirmed: dict[int, Any] = {}
    if wanted:
        confirmed = {
            int(analysis_id): data
            for analysis_id, data in await db.execute(
                select(Analysis.id, Analysis.confirmed).where(
                    Analysis.id.in_(wanted), Analysis.user_id == user.id
                )
            )
        }
    for match_id, ids in order.items():
        surfaces[match_id] = next(
            (
                found
                for analysis_id in ids
                if (found := _input_surface(confirmed.get(analysis_id), match_id)) is not None
            ),
            None,
        )
    return surfaces


def _elo_rating(row: PlayerEloCurrent | None, court: str | None, params: EloParams) -> float:
    """Рейтинг для прогноза по текущему Эло (как EloSnapshot.rating): без рейтинга —
    начальный, без матчей на покрытии — начальный рейтинг покрытия."""
    overall = row.elo_all if row is not None and row.elo_all is not None else params.initial
    if court is None:
        return overall
    surface = getattr(row, f"elo_{court}", None) if row is not None else None
    return params.blend(overall, surface if surface is not None else params.initial)


async def _today(db: AsyncSession, user: User, player: Player, now: datetime) -> list[TodayOut]:
    items = [
        item
        for item in await today_matches(db, user, now)
        if player.id in (item.player1.id, item.player2.id)
    ]
    if not items:
        return []
    surfaces = await _today_surfaces(db, user, items)
    opponents = {
        item.match_id: item.player2 if item.player1.id == player.id else item.player1
        for item in items
    }
    current = await current_rows(db, [player.id, *(ref.id for ref in opponents.values())])
    model = await dossier.model_params(db)
    params = EloParams(
        initial=float(model.get("initial", EloParams.initial)),
        surface_weight=float(model.get("surface_weight", EloParams.surface_weight)),
    )
    out: list[TodayOut] = []
    for item in items:
        opponent = opponents[item.match_id]
        surface = surfaces.get(item.match_id)
        court = rating_surface(surface)
        known = current.get(player.id) is not None and current.get(opponent.id) is not None
        elo_prob = (
            round(
                win_probability(
                    _elo_rating(current.get(player.id), court, params),
                    _elo_rating(current.get(opponent.id), court, params),
                ),
                _SHARE_DIGITS,
            )
            if known
            else None
        )
        meetings = await dossier.meetings(db, player.id, opponent.id, None)
        same = [m for m in meetings if court is not None and rating_surface(m.surface) == court]
        last = meetings[0] if meetings else None
        out.append(
            TodayOut(
                match_id=item.match_id,
                opponent=opponent,
                opponent_rank=current[opponent.id].rank_all if opponent.id in current else None,
                tournament=item.tournament,
                round=item.round,
                scheduled_at=item.scheduled_at,
                surface=surface,
                bets=item.bets,
                analyses=item.analyses,
                elo_prob=elo_prob,
                h2h=TodayH2HOut(
                    wins=sum(1 for m in meetings if m.winner_id == player.id),
                    losses=sum(1 for m in meetings if m.winner_id != player.id),
                    surface_wins=sum(1 for m in same if m.winner_id == player.id),
                    surface_losses=sum(1 for m in same if m.winner_id != player.id),
                    last_day=last.day if last is not None else None,
                    last_won=last.winner_id == player.id if last is not None else None,
                ),
            )
        )
    return out


# --- матчи игрока за окно ---


@dataclass(frozen=True)
class _Game:
    """Матч игрока (сыгранный или неявка) со стороны игрока."""

    match_id: int
    day: date
    opponent: int
    won: bool
    score: str | None
    status: str
    round: str
    best_of: int | None
    surface: str | None

    @property
    def played(self) -> bool:
        return self.status != "walkover"

    @property
    def decider(self) -> bool:
        """Матч дошел до последнего сета формата."""
        return self.best_of is not None and len(parse_sets(self.score)) == self.best_of

    def as_played(self) -> dossier.Played:
        return dossier.Played(
            match_id=self.match_id,
            day=self.day,
            opponent=self.opponent,
            won=self.won,
            score=self.score,
            surface=self.surface,
            tournament=None,
            round=self.round,
        )


async def _games(db: AsyncSession, player_id: int, since: date) -> list[_Game]:
    """Матчи игрока с днем не раньше since (с неявками), от последнего."""
    day = dossier.match_day()
    rows = await db.execute(
        select(
            Match.id,
            day,
            Match.player1_id,
            Match.player2_id,
            Match.winner_id,
            Match.score,
            Match.status,
            Match.round,
            func.coalesce(Match.best_of, Tournament.best_of),
            Tournament.surface,
        )
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(
            dossier.plays([player_id]),
            Match.status.in_(LISTED_STATUSES),
            Match.winner_id.is_not(None),
            day >= since,
        )
    )
    games = [
        _Game(
            match_id=match_id,
            day=played_day,
            opponent=second if first == player_id else first,
            won=winner == player_id,
            score=score,
            status=status,
            round=round_code or "",
            best_of=best_of,
            surface=surface,
        )
        for (
            match_id,
            played_day,
            first,
            second,
            winner,
            score,
            status,
            round_code,
            best_of,
            surface,
        ) in rows
    ]
    games.sort(key=lambda game: (game.day, _round_rank(game.round), game.match_id), reverse=True)
    return games


def _win_loss(games: Iterable[_Game]) -> WinLossOut:
    items = list(games)
    wins = sum(1 for game in items if game.won)
    return WinLossOut(wins=wins, losses=len(items) - wins)


def _tiebreaks(games: Iterable[_Game]) -> WinLossOut:
    won, lost = dossier.tiebreaks([game.as_played() for game in games])
    return WinLossOut(wins=won, losses=lost)


def _surface_key(surface: str | None) -> str:
    """Покрытие для итогов: ковер — как хард (как рейтинг), неизвестное — unknown."""
    return rating_surface(surface) or "unknown"


def _results(games: Sequence[_Game], since: date) -> ResultsOut:
    played = [game for game in games if game.played and game.day >= since]
    by_surface: dict[str, list[_Game]] = defaultdict(list)
    for game in played:
        by_surface[_surface_key(game.surface)].append(game)
    order = [*ELO_SURFACES, "unknown"]
    return ResultsOut(
        since=since,
        surfaces=[
            SurfaceResultOut(surface=key, **_win_loss(by_surface[key]).model_dump())
            for key in order
            if by_surface.get(key)
        ],
        total=_win_loss(played),
    )


def _matches_summary(games: Sequence[_Game], since: date) -> PlayerMatchesSummaryOut:
    played = [game for game in games if game.played and game.day >= since]
    return PlayerMatchesSummaryOut(
        since=since,
        played=len(played),
        wins=sum(1 for game in played if game.won),
        tiebreaks=_tiebreaks(played),
        deciders=_win_loss(game for game in played if game.decider),
        best_of_5=sum(1 for game in played if game.best_of == 5),
    )


# --- подача и прием ---


async def stats_to(db: AsyncSession) -> date | None:
    """Последний день матча со статистикой подачи в архиве (только у Сакманна)."""
    has_stats = exists().where(MatchStat.match_id == Match.id)
    latest = await db.scalar(
        select(Tournament.start_date)
        .where(
            Tournament.source == "sackmann",
            Tournament.start_date.is_not(None),
            exists().where(Match.tournament_id == Tournament.id, has_stats).correlate(Tournament),
        )
        .order_by(Tournament.start_date.desc())
        .limit(1)
    )
    if latest is None:
        return None
    found: date | None = await db.scalar(
        select(func.max(dossier.match_day()))
        .select_from(Match)
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(Tournament.start_date >= latest - STATS_LOOKBACK, has_stats)
    )
    return found


def _serve_metrics(sums: dossier.ServeSums) -> ServeMetricsOut:
    """Доли подачи и приема по суммам (сумма в числителе и знаменателе, а не среднее
    долей по матчам). Прием первой подачи — только если первая подача соперника есть у
    всех матчей окна."""
    full = sums.opp_first_in_n == sums.matches
    return ServeMetricsOut(
        matches=sums.matches,
        first_in=_share(sums.first_in, sums.svpt),
        first_won=_share(sums.first_won, sums.first_in),
        second_won=_share(sums.second_won, sums.svpt - sums.first_in),
        aces_per_match=_share(sums.aces, sums.aces_n),
        double_faults_per_match=_share(sums.double_faults, sums.double_faults_n),
        first_return_won=(
            _share(sums.opp_first_in - sums.opp_first_won, sums.opp_first_in) if full else None
        ),
        second_return_won=(
            _share(
                sums.opp_svpt - sums.opp_first_in - sums.opp_second_won,
                sums.opp_svpt - sums.opp_first_in,
            )
            if full
            else None
        ),
        bp_converted=_share(sums.opp_bp_faced - sums.opp_bp_saved, sums.opp_bp_faced),
        bp_saved=_share(sums.bp_saved, sums.bp_faced),
    )


def _total(items: Iterable[dossier.ServeSums]) -> dossier.ServeSums | None:
    rows = list(items)
    if not rows:
        return None
    return dossier.ServeSums(
        *(sum(getattr(row, item.name) for row in rows) for item in fields(dossier.ServeSums))
    )


# Средний по туру одинаков для всех карточек. Ключ — база, окно (последний день
# статистики), первые TOUR_TOP по месту по Эло и версия данных: последняя успешная
# загрузка (перезагрузка архива с исправлениями) и последняя запись журнала
# администратора (слияние игроков). Что меняет статистику мимо них (matches-merge, правка
# базы руками), держится в памяти не дольше TOUR_CACHE_TTL
TOUR_CACHE_TTL = 600.0
_clock = time.monotonic
_TOUR_CACHE: dict[tuple[Any, ...], tuple[float, ServeMetricsOut | None]] = {}
_DATA_VERSION_SQL = text(
    """
SELECT current_database(),
       (SELECT max(id) FROM ingestion_runs WHERE status = 'ok'),
       (SELECT max(id) FROM admin_audit_log)
"""
)


async def _tour_metrics(db: AsyncSession, last: date) -> ServeMetricsOut | None:
    top = tuple(
        await db.scalars(
            select(PlayerEloCurrent.player_id)
            .where(PlayerEloCurrent.rank_all.is_not(None))
            .order_by(PlayerEloCurrent.rank_all, PlayerEloCurrent.player_id)
            .limit(TOUR_TOP)
        )
    )
    version = tuple((await db.execute(_DATA_VERSION_SQL)).one())
    key = (*version, last, top)
    cached = _TOUR_CACHE.get(key)
    if cached is not None and _clock() - cached[0] < TOUR_CACHE_TTL:
        return cached[1]
    sums = await dossier.serve_sums(db, top, last + timedelta(days=1), cutoff=False)
    total = _total(sums.values())
    metrics = _serve_metrics(total) if total is not None else None
    _TOUR_CACHE.clear()
    _TOUR_CACHE[key] = (_clock(), metrics)
    return metrics


async def _serve(db: AsyncSession, player_id: int) -> ServeOut | None:
    last = await stats_to(db)
    if last is None:
        return None
    sums = await dossier.serve_sums(db, [player_id], last + timedelta(days=1), cutoff=False)
    own = sums.get(player_id)
    return ServeOut(
        period_from=last - timedelta(days=dossier.SERVE_DAYS - 1),
        period_to=last,
        player=_serve_metrics(own) if own is not None else None,
        tour=await _tour_metrics(db, last),
        tour_players=TOUR_TOP,
    )


# --- карточка ---


def _elo(row: PlayerEloCurrent | None) -> EloOut:
    overall = row.elo_all if row is not None else None
    surfaces: list[SurfaceEloOut] = []
    best: tuple[float, str] | None = None
    for court in ELO_SURFACES:
        value = getattr(row, f"elo_{court}") if row is not None else None
        matches = int(getattr(row, f"n_{court}")) if row is not None else 0
        surfaces.append(
            SurfaceEloOut(
                surface=court,  # type: ignore[arg-type]
                elo=elo_int(value),
                matches=matches,
                delta=elo_delta(value, overall),
            )
        )
        if value is not None and (best is None or value > best[0]):
            best = (value, court)
    return EloOut(
        all=elo_int(overall),
        matches=row.n_all if row is not None else 0,
        surfaces=surfaces,
        best_surface=best[1] if best is not None else None,  # type: ignore[arg-type]
    )


async def _news_status(
    db: AsyncSession, player: Player, now: datetime, ttl_hours: int, lookback_days: int
) -> NewsStatusOut:
    count = await db.scalar(
        select(func.count())
        .select_from(PlayerNews)
        .where(
            PlayerNews.player_id == player.id,
            PlayerNews.published_at >= now - timedelta(days=lookback_days),
        )
    )
    checked = player.news_checked_at
    return NewsStatusOut(
        checked_at=checked,
        fresh=checked is not None and checked >= now - timedelta(hours=ttl_hours),
        ttl_hours=ttl_hours,
        lookback_days=lookback_days,
        count=int(count or 0),
    )


async def card(
    db: AsyncSession, user: User, player_id: int, *, now: datetime | None = None
) -> PlayerCardOut:
    """Карточка игрока; «сегодня» — только из своих ставок и анализов (user)."""
    now = now or utcnow()
    today = now.date()
    player = await player_or_404(db, player_id)
    current = (await current_rows(db, [player.id])).get(player.id)
    since = seasons_since(today)
    key_since = current_since(today)
    games = await _games(db, player.id, min(since, key_since))
    form = await dossier.form_rows(db, player.id, None)
    last_form = form[0] if form else None
    load_since = today - timedelta(days=dossier.LOAD_DAYS - 1)
    recent = [game for game in games if game.played and key_since <= game.day <= today]
    top_ids = set(
        await db.scalars(select(PlayerEloCurrent.player_id).where(PlayerEloCurrent.rank_all <= TOP))
    )
    opponents = {row.opponent for row in form}
    refs = await player_refs(db, opponents)
    ranks = await current_rows(db, opponents)
    # Турнир последнего матча: категория и источник (свой ввод участника не показываем)
    last_info = (
        (
            await db.execute(
                select(Tournament.name, Tournament.category, Tournament.source)
                .join(Match, Match.tournament_id == Tournament.id)
                .where(Match.id == last_form.match_id)
            )
        ).first()
        if last_form is not None
        else None
    )
    config = await load_agent_config(db)
    profile = await db.scalar(
        select(PlayerProfile).where(
            PlayerProfile.player_id == player.id, PlayerProfile.source == PROFILE_SOURCE
        )
    )
    return PlayerCardOut(
        id=player.id,
        name=player.name,
        name_ru=player.name_ru,
        country=player.country,
        birth_date=player.birth_date,
        age=age_on(player.birth_date, today),
        hand=player.hand,
        backhand=player.backhand,
        rank=current.rank_all if current is not None else None,
        matches_52w=current.matches_52w if current is not None else 0,
        rank_days=CURRENT_DAYS,
        elo=_elo(current),
        form=PlayerFormOut(
            matches=[
                FormMatchOut(
                    match_id=row.match_id,
                    day=row.day,
                    won=row.won,
                    opponent=_ref(refs, row.opponent),
                    opponent_rank=ranks[row.opponent].rank_all if row.opponent in ranks else None,
                    score=score_for(row.score, row.won),
                    surface=row.surface,
                    tournament=row.tournament,
                    round=row.round,
                )
                for row in form
            ],
            wins=sum(1 for row in form if row.won),
            losses=sum(1 for row in form if not row.won),
            matches_14d=sum(1 for game in games if game.played and load_since <= game.day <= today),
            rest_days=(today - last_form.day).days if last_form is not None else None,
        ),
        last_match=(
            LastMatchOut(
                match_id=last_form.match_id,
                day=last_form.day,
                tournament=_tournament_name(last_info[0], last_info[2]) if last_info else None,
                category=last_info[1] if last_info else None,
                round=last_form.round,
            )
            if last_form is not None
            else None
        ),
        serve=await _serve(db, player.id),
        results=_results(games, since),
        key_matches=KeyMatchesOut(
            since=key_since,
            top10=_win_loss(game for game in recent if game.opponent in top_ids),
            deciders=_win_loss(game for game in recent if game.decider),
            tiebreaks=_tiebreaks(recent),
        ),
        news=await _news_status(db, player, now, config.news_ttl_hours, config.news_lookback_days),
        archive=await archive_info(db, now),
        sackmann=player.sackmann_id is not None,
        legacy_profile=(
            LegacyProfileOut(updated_at=profile.updated_at, profile=profile.profile)
            if profile is not None
            else None
        ),
        today=await _today(db, user, player, now),
    )


# --- матчи, новости, личные встречи ---


async def matches(
    db: AsyncSession,
    player_id: int,
    *,
    before: int | None = None,
    limit: int = MATCHES_LIMIT,
    now: datetime | None = None,
) -> PlayerMatchesOut:
    """Матчи игрока в базе (с неявками), сначала последние: по дню, затем по id.
    before — id последнего матча прошлой страницы (матч этого игрока, иначе 422)."""
    now = now or utcnow()
    player = await player_or_404(db, player_id)
    day = dossier.match_day()
    conds = [
        dossier.plays([player.id]),
        Match.status.in_(LISTED_STATUSES),
        Match.winner_id.is_not(None),
        day.is_not(None),
    ]
    total = await db.scalar(
        select(func.count())
        .select_from(Match)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(*conds)
    )
    page = list(conds)
    if before is not None:
        cursor = (
            await db.execute(
                select(day, Match.id)
                .outerjoin(Tournament, Tournament.id == Match.tournament_id)
                .where(Match.id == before, *conds)
            )
        ).first()
        if cursor is None:
            raise AppError(422, "player.bad_cursor")
        page.append(tuple_(day, Match.id) < tuple_(cursor[0], cursor[1]))
    rows = (
        await db.execute(
            select(
                Match.id,
                day,
                Match.player1_id,
                Match.player2_id,
                Match.winner_id,
                Match.score,
                Match.status,
                Match.round,
                func.coalesce(Match.best_of, Tournament.best_of),
                Tournament.name,
                Tournament.category,
                Tournament.surface,
                Tournament.source,
            )
            .outerjoin(Tournament, Tournament.id == Match.tournament_id)
            .where(*page)
            .order_by(day.desc(), Match.id.desc())
            .limit(limit + 1)
        )
    ).all()
    shown = rows[:limit]
    opponents = {row[3] if row[2] == player.id else row[2] for row in shown}
    refs = await player_refs(db, opponents)
    ranks = await current_rows(db, opponents)
    items: list[PlayerMatchOut] = []
    for (
        match_id,
        played_day,
        first,
        second,
        winner,
        score,
        status,
        round_code,
        best_of,
        tournament,
        category,
        surface,
        source,
    ) in shown:
        opponent = second if first == player.id else first
        won = winner == player.id
        items.append(
            PlayerMatchOut(
                match_id=match_id,
                day=played_day,
                tournament=_tournament_name(tournament, source),
                category=category,
                surface=surface,
                round=round_code or "",
                opponent=_ref(refs, opponent),
                opponent_rank=ranks[opponent].rank_all if opponent in ranks else None,
                score=score_for(score, won) if status != "walkover" else None,
                won=won,
                walkover=status == "walkover",
                best_of=best_of,
            )
        )
    summary = None
    if before is None:
        since = seasons_since(now.date())
        summary = _matches_summary(await _games(db, player.id, since), since)
    return PlayerMatchesOut(
        items=items,
        next_before=items[-1].match_id if len(rows) > limit else None,
        total=int(total or 0),
        summary=summary,
    )


def _news_details(kind: str, details: Any) -> dict[str, Any] | None:
    """Подробности результата — только ключи dossier.RESULT_DETAILS, как в досье."""
    if kind != "result":
        return None
    short = dossier.result_details(details)
    if short is None:
        return None
    names = {value: key for key, value in dossier.RESULT_DETAILS.items()}
    return {names[key]: value for key, value in short.items()}


async def news(
    db: AsyncSession,
    player_id: int,
    *,
    before: int | None = None,
    limit: int = NEWS_LIMIT,
    now: datetime | None = None,
) -> PlayerNewsOut:
    """Новости игрока за окно новостей (news_lookback_days), новые сверху. before — id
    последней новости прошлой страницы (новость этого игрока, иначе 422)."""
    now = now or utcnow()
    player = await player_or_404(db, player_id)
    config = await load_agent_config(db)
    conds = [
        PlayerNews.player_id == player.id,
        PlayerNews.published_at >= now - timedelta(days=config.news_lookback_days),
    ]
    page = list(conds)
    if before is not None:
        cursor = (
            await db.execute(
                select(PlayerNews.published_at, PlayerNews.id).where(
                    PlayerNews.id == before, PlayerNews.player_id == player.id
                )
            )
        ).first()
        if cursor is None:
            raise AppError(422, "player.bad_cursor")
        page.append(tuple_(PlayerNews.published_at, PlayerNews.id) < tuple_(cursor[0], cursor[1]))
    rows = list(
        await db.scalars(
            select(PlayerNews)
            .where(*page)
            .order_by(PlayerNews.published_at.desc(), PlayerNews.id.desc())
            .limit(limit + 1)
        )
    )
    shown = rows[:limit]
    checked = player.news_checked_at
    return PlayerNewsOut(
        items=[
            PlayerNewsItemOut(
                id=row.id,
                kind=row.kind,  # type: ignore[arg-type]
                published_at=row.published_at,
                summary=row.summary,
                source_url=row.source_url,
                source_name=row.source_name,
                details=_news_details(row.kind, row.details),
            )
            for row in shown
        ],
        next_before=shown[-1].id if len(rows) > limit else None,
        checked_at=checked,
        fresh=checked is not None and checked >= now - timedelta(hours=config.news_ttl_hours),
        ttl_hours=config.news_ttl_hours,
        lookback_days=config.news_lookback_days,
    )


async def head_to_head(db: AsyncSession, player_id: int, opponent_id: int) -> H2HOut:
    """Все личные встречи двух игроков в базе (без неявок), сначала последняя."""
    player = await player_or_404(db, player_id)
    opponent = await player_or_404(db, opponent_id)
    if player.id == opponent.id:
        raise AppError(422, "player.h2h_same")
    found = await dossier.meetings(db, player.id, opponent.id, None)
    by_surface: dict[str, list[bool]] = defaultdict(list)
    for item in found:
        by_surface[_surface_key(item.surface)].append(item.winner_id == player.id)
    ranks = await current_rows(db, [player.id, opponent.id])
    order = [*ELO_SURFACES, "unknown"]
    return H2HOut(
        player=PlayerRefOut(id=player.id, name=player.name, name_ru=player.name_ru),
        opponent=PlayerRefOut(id=opponent.id, name=opponent.name, name_ru=opponent.name_ru),
        player_rank=ranks[player.id].rank_all if player.id in ranks else None,
        opponent_rank=ranks[opponent.id].rank_all if opponent.id in ranks else None,
        player_wins=sum(1 for item in found if item.winner_id == player.id),
        opponent_wins=sum(1 for item in found if item.winner_id == opponent.id),
        surfaces=[
            SurfaceResultOut(
                surface=key,
                wins=sum(by_surface[key]),
                losses=len(by_surface[key]) - sum(by_surface[key]),
            )
            for key in order
            if by_surface.get(key)
        ],
        matches=[
            H2HMatchOut(
                match_id=item.match_id,
                day=item.day,
                winner_id=item.winner_id,
                score=item.score,
                surface=item.surface,
                tournament=_tournament_name(item.tournament, None),
                category=item.category,
                round=item.round,
                best_of=item.best_of,
            )
            for item in found
        ],
    )
