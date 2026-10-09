"""Рейтинг Эло по покрытиям (LLM_LEARNING.md, 1.4, шаг 1).

У игрока два рейтинга: общий (surface = all) и по покрытию (hard, clay, grass). Ковер
(carpet) считается хардом: в основном туре ATP ковра нет с конца 2000-х, это быстрый
зальный корт, ближе всего к харду, а отдельный рейтинг на горстке старых матчей был бы шумом.

K игрока убывает с числом его матчей m: K = k_num / (m + k_offset)^k_shape (подход
FiveThirtyEight, Kovalchik 2016); m считается отдельно для общего рейтинга и для покрытия.
Каждый рейтинг обновляется своим ожиданием: общий — по разнице общих рейтингов, рейтинг
покрытия — по разнице рейтингов покрытия. Поэтому вес покрытия w влияет только на прогноз
p1 = 1 / (1 + 10^((R2 − R1)/400)), R = (1 − w)·общий + w·покрытие, и подбирается по
одному прогону истории (PreMatch.probability), без пересчета.

Учитываются матчи finished и retired (снявшийся проиграл), walkover — нет. Порядок:
день (match_date, а без него — дата начала турнира), дата начала турнира, id турнира,
раунд (rounds.round_order), id матча. Матч без дня (ни даты, ни турнира) пропускается.
Матч без даты в турнире, где у других матчей дата есть, получает день по соседним
раундам (fill_days): иначе он обсчитывался бы раньше сыгранных до него кругов.

В player_ratings строка матча без даты стоит не раньше последнего дня, когда матч мог
быть сыгран (reveal_days): current_elo(before=день) не видит ни сам матч, ни
следующие круги. День матча без даты известен только приблизительно, поэтому его
исход показывается с запасом, позже, но не раньше времени.

    rebuild_ratings()  — пересчет по всей истории из БД в player_ratings;
    current_elo(...)   — рейтинг игрока на дату (для анализа матча, этап 3);
    EloEngine          — расчет без БД (бэктест, тесты).
"""

import argparse
import asyncio
import sys
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import asdict, dataclass, field, replace
from datetime import date
from typing import Any

from sqlalchemy import delete, func, insert, literal, select, text
from sqlalchemy.dialects.postgresql import JSONB, distinct_on
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.db.models import Match, MlModel, PlayerRating, Tournament
from app.db.session import create_engine, create_sessionmaker
from app.ingest.rounds import round_order
from app.ingest.runs import ingestion_run
from app.ingest.sackmann import PROMOTE_AFTER

ALL = "all"
ELO_SURFACES = ("hard", "clay", "grass")
# Ковер — как хард (см. docstring модуля)
_SURFACE_OF = {"hard": "hard", "clay": "clay", "grass": "grass", "carpet": "hard"}
RESULT_STATUSES = ("finished", "retired")
MODEL_ID = "elo-v1"
MODEL_KIND = "elo"
INGEST_SOURCE = "elo"
BATCH = 5000
# Ключ pg_advisory_xact_lock: два пересчета одновременно не идут
LOCK_KEY = 0x656C6F0000000001


def rating_surface(surface: str | None) -> str | None:
    """Покрытие рейтинга: hard, clay, grass; carpet → hard; неизвестное — None (тогда
    прогноз только по общему рейтингу)."""
    return _SURFACE_OF.get((surface or "").strip().lower())


def win_probability(rating1: float, rating2: float) -> float:
    """Вероятность победы первого: 1 / (1 + 10^((R2 − R1)/400))."""
    return float(1.0 / (1.0 + 10.0 ** ((rating2 - rating1) / 400.0)))


@dataclass(frozen=True)
class EloParams:
    """Параметры Эло. surface_weight — вес рейтинга покрытия в прогнозе (0 — только
    общий, 1 — только покрытие)."""

    initial: float = 1500.0
    k_num: float = 250.0
    k_offset: float = 5.0
    k_shape: float = 0.4
    surface_weight: float = 0.5

    def k_factor(self, matches: int) -> float:
        """K игрока с matches матчами до этого: k_num / (m + k_offset)^k_shape."""
        return float(self.k_num / (matches + self.k_offset) ** self.k_shape)

    def blend(self, overall: float, surface: float | None, weight: float | None = None) -> float:
        """Рейтинг для прогноза: (1 − w)·общий + w·покрытие; без покрытия — общий."""
        if surface is None:
            return overall
        w = self.surface_weight if weight is None else weight
        return (1.0 - w) * overall + w * surface

    def as_dict(self) -> dict[str, float]:
        return {key: float(value) for key, value in asdict(self).items()}


@dataclass(frozen=True)
class EloMatch:
    """Сыгранный матч для расчета. day — день матча (match_date или дата начала
    турнира). Остальные поля нужны порядку матчей и бэктесту."""

    match_id: int
    day: date
    player1_id: int
    player2_id: int
    winner_id: int
    surface: str | None = None
    status: str = "finished"
    match_date: date | None = None
    tournament_id: int | None = None
    start_date: date | None = None
    round: str = ""
    level: str | None = None


def _round_rank(code: str) -> int:
    """Порядок раунда; у матчей без раунда (старый бот, ввод вручную) — 0."""
    try:
        return round_order(code)
    except ValueError:
        return 0


def order_key(match: EloMatch) -> tuple[date, date, int, int, int]:
    """Ключ сортировки истории (см. docstring модуля)."""
    return (
        match.day,
        match.start_date or match.day,
        match.tournament_id or 0,
        _round_rank(match.round),
        match.match_id,
    )


# Окно турнира после даты начала (как у повышения матчей tennis-data и привязки к
# турниру Сакманна): Большой шлем идет больше двух недель
TOURNAMENT_DAYS = PROMOTE_AFTER


class _Dated:
    """Матчи с датой по турнирам: самая поздняя дата каждого раунда, даты матчей
    каждого игрока по раундам и дата финала."""

    def __init__(self, matches: Iterable[EloMatch]) -> None:
        # турнир → раунд → самая поздняя дата матча этого раунда
        self.latest: dict[int, dict[int, date]] = defaultdict(dict)
        # (турнир, игрок) → [(раунд, дата)]
        self.by_player: dict[tuple[int, int], list[tuple[int, date]]] = defaultdict(list)
        self.final: dict[int, date] = {}
        for match in matches:
            rank = _round_rank(match.round)
            day, tour = match.match_date, match.tournament_id
            if day is None or tour is None or rank == 0:
                continue
            rounds = self.latest[tour]
            rounds[rank] = max(rounds.get(rank, day), day)
            for player in (match.player1_id, match.player2_id):
                self.by_player[(tour, player)].append((rank, day))
            if match.round == "F":
                self.final[tour] = max(self.final.get(tour, day), day)

    def next_round_day(self, match: EloMatch) -> date | None:
        """Самая ранняя дата матча любого из двух игроков в более позднем круге того же
        турнира: этот матч сыгран не позже нее."""
        if match.tournament_id is None:
            return None
        rank = _round_rank(match.round)
        days = [
            day
            for player in (match.player1_id, match.player2_id)
            for code, day in self.by_player.get((match.tournament_id, player), ())
            if code > rank
        ]
        return min(days, default=None)


def fill_days(matches: Iterable[EloMatch]) -> list[EloMatch]:
    """День матча без даты в турнире, где у части матчей дата есть (строку tennis-data
    не сопоставили с матчем Сакманна): самая поздняя дата матчей того же и более ранних
    раундов турнира, но не раньше прежнего дня. С днем начала турнира такой матч шел бы
    раньше сыгранных до него кругов с датой, и их прогноз «до матча» видел бы его исход.
    В одном дне порядок дает раунд. Свой раунд учитывается ради кругового этапа: там у
    игрока несколько матчей одного раунда, и матчи с датой (с кэфами) не должны видеть
    исход матча без даты.

    Сверху день ограничен следующим кругом его игроков: не позже самой ранней даты
    матча любого из них в более позднем круге (матч ставится в тот же день, перед ним).
    Иначе круг, доигранный позже в другой половине сетки (дождь, половины сетки Шлема
    играют через день), увел бы матч за следующий матч того же игрока. Матчи с датой и
    без раунда не меняются."""
    items = list(matches)
    dated = _Dated(items)
    result: list[EloMatch] = []
    for match in items:
        rank = _round_rank(match.round)
        rounds = dated.latest.get(match.tournament_id) if match.tournament_id is not None else None
        if match.match_date is None and rounds and rank > 0:
            day = match.day
            known = [value for code, value in rounds.items() if code <= rank]
            if known and max(known) > day:
                day = max(known)
            later = dated.next_round_day(match)
            if later is not None and later < day:
                day = later
            if day != match.day:
                match = replace(match, day=day)
        result.append(match)
    return result


def reveal_days(matches: Sequence[EloMatch]) -> list[date]:
    """С какого дня исход каждого матча можно показывать в player_ratings (as_of), в
    порядке matches. Матч с датой — его день. Матч без даты — последний день, когда он
    мог быть сыгран: самая ранняя дата следующего круга любого из игроков в турнире; без
    нее — дата финала турнира; без нее — начало турнира + TOURNAMENT_DAYS. Не раньше дня
    расчета (match.day)."""
    dated = _Dated(matches)
    out: list[date] = []
    for match in matches:
        if match.match_date is not None or match.tournament_id is None:
            out.append(match.day)
            continue
        latest = dated.next_round_day(match) or dated.final.get(match.tournament_id)
        if latest is None:
            latest = (match.start_date or match.day) + TOURNAMENT_DAYS
        out.append(max(latest, match.day))
    return out


def sort_history(matches: Iterable[EloMatch]) -> list[EloMatch]:
    """Матчи в порядке расчета: дни по fill_days, затем order_key."""
    return sorted(fill_days(matches), key=order_key)


@dataclass(frozen=True)
class PreMatch:
    """Рейтинги игроков ДО матча (без утечки его исхода) и прогноз p1 с весом движка.
    surface1/surface2 — None, если покрытие неизвестно."""

    match_id: int
    overall1: float
    overall2: float
    surface1: float | None
    surface2: float | None
    matches1: int
    matches2: int
    p1: float

    def probability(self, weight: float) -> float:
        """Вероятность победы игрока 1 при весе покрытия weight."""
        if self.surface1 is None or self.surface2 is None:
            return win_probability(self.overall1, self.overall2)
        rating1 = (1.0 - weight) * self.overall1 + weight * self.surface1
        rating2 = (1.0 - weight) * self.overall2 + weight * self.surface2
        return win_probability(rating1, rating2)


class EloEngine:
    """Расчет Эло в памяти, без БД: predict — прогноз, update — учесть исход,
    run — прогнать историю и получить прогнозы до каждого матча."""

    def __init__(self, params: EloParams | None = None) -> None:
        self.params = params or EloParams()
        self._ratings: dict[tuple[int, str], float] = {}
        self._matches: dict[tuple[int, str], int] = {}

    def rating(self, player_id: int, surface: str = ALL) -> float:
        return self._ratings.get((player_id, surface), self.params.initial)

    def matches(self, player_id: int, surface: str = ALL) -> int:
        return self._matches.get((player_id, surface), 0)

    def players(self) -> set[int]:
        return {player for player, _ in self._matches}

    def _surface_ratings(
        self, player1_id: int, player2_id: int, surface: str | None
    ) -> tuple[float | None, float | None]:
        if surface is None:
            return None, None
        return self.rating(player1_id, surface), self.rating(player2_id, surface)

    def pre_match(
        self, match_id: int, player1_id: int, player2_id: int, surface: str | None
    ) -> PreMatch:
        """Состояние до матча; surface — уже покрытие рейтинга (rating_surface)."""
        overall1, overall2 = self.rating(player1_id), self.rating(player2_id)
        surface1, surface2 = self._surface_ratings(player1_id, player2_id, surface)
        if surface1 is None or surface2 is None:
            p1 = win_probability(overall1, overall2)
        else:
            p1 = win_probability(
                self.params.blend(overall1, surface1), self.params.blend(overall2, surface2)
            )
        return PreMatch(
            match_id=match_id,
            overall1=overall1,
            overall2=overall2,
            surface1=surface1,
            surface2=surface2,
            matches1=self.matches(player1_id),
            matches2=self.matches(player2_id),
            p1=p1,
        )

    def predict(self, player1_id: int, player2_id: int, surface: str | None) -> float:
        """Вероятность победы игрока 1 по текущим рейтингам."""
        return self.pre_match(0, player1_id, player2_id, rating_surface(surface)).p1

    def _apply(self, player1_id: int, player2_id: int, won1: float, surface: str) -> None:
        key1, key2 = (player1_id, surface), (player2_id, surface)
        rating1, rating2 = self.rating(player1_id, surface), self.rating(player2_id, surface)
        expected1 = win_probability(rating1, rating2)
        k1 = self.params.k_factor(self.matches(player1_id, surface))
        k2 = self.params.k_factor(self.matches(player2_id, surface))
        self._ratings[key1] = rating1 + k1 * (won1 - expected1)
        self._ratings[key2] = rating2 - k2 * (won1 - expected1)
        self._matches[key1] = self.matches(player1_id, surface) + 1
        self._matches[key2] = self.matches(player2_id, surface) + 1

    def update(self, player1_id: int, player2_id: int, winner_id: int, surface: str | None) -> None:
        """Учесть исход матча: общий рейтинг и рейтинг покрытия (если оно известно)."""
        if player1_id == player2_id:
            raise ValueError(t("ml.elo.same_player", player_id=player1_id))
        if winner_id not in (player1_id, player2_id):
            raise ValueError(
                t("ml.elo.bad_winner", winner_id=winner_id, player1=player1_id, player2=player2_id)
            )
        won1 = 1.0 if winner_id == player1_id else 0.0
        self._apply(player1_id, player2_id, won1, ALL)
        court = rating_surface(surface)
        if court is not None:
            self._apply(player1_id, player2_id, won1, court)

    def run(self, matches: Iterable[EloMatch]) -> list[PreMatch]:
        """Прогнать матчи по порядку (вызывающий их уже отсортировал, order_key): для
        каждого — прогноз до матча, затем обновление рейтингов."""
        result: list[PreMatch] = []
        for match in matches:
            court = rating_surface(match.surface)
            result.append(self.pre_match(match.match_id, match.player1_id, match.player2_id, court))
            self.update(match.player1_id, match.player2_id, match.winner_id, match.surface)
        return result


# --- история из БД ---


@dataclass
class History:
    """Сыгранные матчи в порядке расчета и счетчики пропущенных."""

    matches: list[EloMatch] = field(default_factory=list)
    skipped: Counter[str] = field(default_factory=Counter)


async def load_history(db: AsyncSession) -> History:
    """Матчи с результатом из БД в порядке расчета (sort_history). Пропуски: walkover,
    нет победителя, нет дня."""
    day = func.coalesce(Match.match_date, Tournament.start_date)
    rows = await db.execute(
        select(
            Match.id,
            day,
            Match.player1_id,
            Match.player2_id,
            Match.winner_id,
            Tournament.surface,
            Match.status,
            Match.match_date,
            Match.tournament_id,
            Tournament.start_date,
            Match.round,
            Tournament.category,
        )
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.status.in_((*RESULT_STATUSES, "walkover")))
    )
    history = History()
    for row in rows:
        (match_id, match_day, player1, player2, winner, surface, status, *rest) = row
        if status == "walkover":
            history.skipped["walkover"] += 1
        elif winner is None:
            history.skipped["no_winner"] += 1
        elif match_day is None:
            history.skipped["no_date"] += 1
        else:
            match_date, tournament_id, start_date, round_code, level = rest
            history.matches.append(
                EloMatch(
                    match_id=match_id,
                    day=match_day,
                    player1_id=player1,
                    player2_id=player2,
                    winner_id=winner,
                    surface=surface,
                    status=status,
                    match_date=match_date,
                    tournament_id=tournament_id,
                    start_date=start_date,
                    round=round_code or "",
                    level=level,
                )
            )
    history.matches = sort_history(history.matches)
    return history


# --- пересчет рейтингов в БД ---


@dataclass(frozen=True)
class EloSummary:
    """Итог пересчета: сколько матчей учтено и пропущено, игроков, строк player_ratings."""

    run_id: int
    matches: int
    skipped: dict[str, int]
    players: int
    rows: int
    train_from: date | None
    train_to: date | None


def daily_states(
    matches: Sequence[EloMatch], params: EloParams
) -> tuple[dict[tuple[int, str, date], tuple[float, int]], EloEngine]:
    """Рейтинг и число матчей каждого игрока на конец дня: (игрок, покрытие, день) →
    (Эло, матчей). Покрытие — all и покрытие рейтинга. День строки — день показа
    (reveal_days), у одного игрока он не убывает: строка дня содержит все матчи, чей
    день показа не позже, поэтому строка раньше дня матча без даты его исхода не видит."""
    engine = EloEngine(params)
    states: dict[tuple[int, str, date], tuple[float, int]] = {}
    shown: dict[tuple[int, str], date] = {}
    for match, reveal in zip(matches, reveal_days(matches), strict=True):
        engine.update(match.player1_id, match.player2_id, match.winner_id, match.surface)
        court = rating_surface(match.surface)
        for player in (match.player1_id, match.player2_id):
            for surface in (ALL, court) if court else (ALL,):
                day = max(reveal, shown.get((player, surface), reveal))
                shown[(player, surface)] = day
                states[(player, surface, day)] = (
                    engine.rating(player, surface),
                    engine.matches(player, surface),
                )
    return states, engine


def _rating_rows(
    states: dict[tuple[int, str, date], tuple[float, int]],
) -> Iterator[list[dict[str, Any]]]:
    batch: list[dict[str, Any]] = []
    for (player, surface, day), (elo, matches) in states.items():
        batch.append(
            {"player_id": player, "surface": surface, "as_of": day, "elo": elo, "matches": matches}
        )
        if len(batch) >= BATCH:
            yield batch
            batch = []
    if batch:
        yield batch


async def upsert_model(
    db: AsyncSession,
    *,
    params: dict[str, Any],
    keep: Sequence[str] = (),
    metrics: dict[str, Any] | None = None,
    train_from: date | None,
    train_to: date | None,
) -> None:
    """Строка ml_models elo-v1. params дописываются к прежним (JSONB ||), кроме ключей
    keep: они берутся из params только у новой строки. Так пересчет рейтингов не
    затирает вес покрытия и калибровку, подобранные бэктестом. metrics — заменяются."""
    merged = {key: value for key, value in params.items() if key not in keep}
    stmt = pg_insert(MlModel).values(
        id=MODEL_ID,
        kind=MODEL_KIND,
        params=params,
        metrics=metrics or {},
        train_from=train_from,
        train_to=train_to,
    )
    updates: dict[str, Any] = {
        "kind": stmt.excluded.kind,
        "params": MlModel.params.op("||")(literal(merged, JSONB)),
        "train_from": stmt.excluded.train_from,
        "train_to": stmt.excluded.train_to,
    }
    if metrics is not None:
        updates["metrics"] = stmt.excluded.metrics
    await db.execute(stmt.on_conflict_do_update(index_elements=[MlModel.id], set_=updates))


async def rebuild_ratings(
    *,
    params: EloParams | None = None,
    db_factory: Callable[[], AsyncSession] | None = None,
) -> EloSummary:
    """Пересчитать Эло по всей истории из БД: в одной транзакции удалить player_ratings
    и записать по строке на (игрок, покрытие, день) с состоянием на конец дня; обновить
    ml_models elo-v1. Журнал — ingestion_runs (source = elo).

    db_factory — фабрика сеансов (async_sessionmaker); без нее открывается свой движок
    по настройкам.
    """
    if db_factory is None:
        db_engine = create_engine()
        try:
            return await rebuild_ratings(params=params, db_factory=create_sessionmaker(db_engine))
        finally:
            await db_engine.dispose()
    elo_params = params or EloParams()
    async with ingestion_run(db_factory, INGEST_SOURCE) as run:
        async with db_factory() as db:
            await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})
            history = await load_history(db)
            # Расчет по всей истории — CPU на секунду-другую: не держим цикл событий
            states, engine = await asyncio.to_thread(daily_states, history.matches, elo_params)
            await db.execute(delete(PlayerRating))
            for batch in _rating_rows(states):
                await db.execute(insert(PlayerRating), batch)
            first = history.matches[0].day if history.matches else None
            last = history.matches[-1].day if history.matches else None
            await upsert_model(
                db,
                params={**elo_params.as_dict(), "carpet_as": "hard"},
                keep=("surface_weight",),
                train_from=first,
                train_to=last,
            )
            await db.commit()
        report = run.report
        report.rows_read = len(history.matches) + sum(history.skipped.values())
        report.created = len(states)
        for reason, count in sorted(history.skipped.items()):
            report.skip(reason, count)
        report.counts["matches.used"] = len(history.matches)
        report.counts["players"] = len(engine.players())
        report.freshness = {"first_day": first, "last_day": last}
    return EloSummary(
        run_id=run.id,
        matches=len(history.matches),
        skipped=dict(sorted(history.skipped.items())),
        players=len(engine.players()),
        rows=len(states),
        train_from=first,
        train_to=last,
    )


# --- рейтинг на дату ---


@dataclass(frozen=True)
class EloSnapshot:
    """Рейтинг игрока на дату: общий и по покрытию (None — на этом покрытии матчей еще
    не было). as_of — день последней учтенной строки."""

    player_id: int
    surface: str | None
    as_of: date
    overall: float
    overall_matches: int
    surface_elo: float | None
    surface_matches: int

    def rating(self, weight: float, initial: float = EloParams.initial) -> float:
        """Рейтинг для прогноза с весом покрытия weight. Без матчей на покрытии рейтинг
        покрытия — начальный, как в EloEngine."""
        if self.surface is None:
            return self.overall
        surface = self.surface_elo if self.surface_elo is not None else initial
        return (1.0 - weight) * self.overall + weight * surface


async def current_elo(
    db: AsyncSession, player_id: int, surface: str | None, before: date | None = None
) -> EloSnapshot | None:
    """Последний рейтинг игрока из player_ratings: общий и для покрытия матча (carpet →
    hard). before — учитывать только строки дней строго раньше (рейтинг до матча этого
    дня). Нет ни одной строки — None (новый игрок: начальный рейтинг).

    Матч без даты (только из архива Сакманна) стоит в player_ratings на последнем дне,
    когда он мог быть сыгран (reveal_days): before внутри такого турнира не видит ни
    этот матч, ни следующие круги. Цена — запаздывание: исход такого матча виден только
    со следующего круга игрока, с финала или через TOURNAMENT_DAYS после начала турнира.
    """
    court = rating_surface(surface)
    surfaces = (ALL, court) if court else (ALL,)
    stmt = (
        select(PlayerRating.surface, PlayerRating.as_of, PlayerRating.elo, PlayerRating.matches)
        .where(PlayerRating.player_id == player_id, PlayerRating.surface.in_(surfaces))
        .ext(distinct_on(PlayerRating.surface))
        .order_by(PlayerRating.surface, PlayerRating.as_of.desc())
    )
    if before is not None:
        stmt = stmt.where(PlayerRating.as_of < before)
    found = {row.surface: row for row in (await db.execute(stmt))}
    overall = found.get(ALL)
    if overall is None:
        return None
    on_surface = found.get(court) if court else None
    as_of = max(overall.as_of, on_surface.as_of) if on_surface is not None else overall.as_of
    return EloSnapshot(
        player_id=player_id,
        surface=court,
        as_of=as_of,
        overall=overall.elo,
        overall_matches=overall.matches,
        surface_elo=on_surface.elo if on_surface is not None else None,
        surface_matches=on_surface.matches if on_surface is not None else 0,
    )


# --- команда терминала ---


def summary_lines(summary: EloSummary) -> list[str]:
    """Итог пересчета для терминала."""
    lines = [
        t(
            "ml.elo.report.done",
            matches=summary.matches,
            players=summary.players,
            rows=summary.rows,
        ),
        t(
            "ml.elo.report.period",
            first=summary.train_from or "-",
            last=summary.train_to or "-",
        ),
    ]
    for reason, count in summary.skipped.items():
        lines.append(t("ml.elo.report.skipped", reason=_skip_text(reason), count=count))
    return lines


def _skip_text(reason: str) -> str:
    texts = {
        "walkover": t("ml.elo.skip.walkover"),
        "no_winner": t("ml.elo.skip.no_winner"),
        "no_date": t("ml.elo.skip.no_date"),
    }
    return texts.get(reason, reason)


def build_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(prog="python -m app.ml.elo", description=t("ml.elo.description"))


def main(argv: Sequence[str] | None = None) -> int:
    """Пересчет рейтингов из терминала. Код возврата: 0 — готово, 1 — ошибка."""
    build_parser().parse_args(argv)
    try:
        summary = asyncio.run(rebuild_ratings())
    except (DBAPIError, OSError):
        # DBAPIError — общий класс ошибок драйвера: нет связи, неверный пароль, нет базы
        # или таблиц. Текст исключения не печатаем: в нем бывает адрес базы с паролем
        print(t("ml.elo.errors.db_unavailable"), file=sys.stderr)
        return 1
    print("\n".join(summary_lines(summary)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
