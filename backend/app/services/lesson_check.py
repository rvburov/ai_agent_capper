"""Проверка урока кодом, бесплатно (этап 5, п. 8; LLM_LEARNING.md, 1.1 и раздел 5).

Случаи условия урока (app/ml/lesson_scope.py) берутся запросом только для чтения: точка
сохранения той же сессии в режиме READ ONLY (запись в нем база отвергает) с пределом
времени. SQL собирает код
из словаря, значения условия — параметры запроса.

Свои случаи — ноги рассчитанных ставок приложения под условием (считаются матчи). Проверка
на истории начинается с lesson_min_cases своих случаев (решает app/services/lessons.py).

История — сыгранные матчи архива за HISTORY_YEARS лет до сегодня, кроме матчей
замороженных eval-наборов (на них сравниваются версии инструкций). Вероятность случая —
прогноз базовой модели до матча (out-of-sample по времени: рейтинги Эло из player_ratings
строго до дня матча, вес покрытия и калибровка Платта — из ml_models, как в досье),
для фор — модель сетов. Семейство новых рынков (Р28) — его основная линия: фора ±2.5 —
3:0 стороны (только до 3 побед), тотал сетов — больше 2.5 до 2 побед и больше 3.5 до 3;
у фор и тоталов по геймам кэфов в архиве нет, поэтому линия — половинная, при которой
вероятность модели ближе всего к 50% (так ставит основную линию букмекер), а вероятность
— цепь модели геймов (app/ml/games.py) с темпом по подаче и приему обоих игроков за 52
недели до матча, как в досье. Тотал не зависит от стороны: случай — один на матч.
Случаи по дням делятся на историю и отложенную часть (последние HOLDOUT_SHARE).

На истории:
- остаток y − p и его 95% ДИ (бутстрэп с seed) — смещение модели в условии (effect);
- поправка с усадкой shift = effect · n / (n + k), n — случаев истории архива (n_shrink;
  свои случаи в формулу не входят: основание проверки одно для всех и не выдает, сколько
  ставок у других участников), k — lesson_shrink_k (effect_shrunk);
- лог-лосс без урока и с поправкой и парный бутстрэп-ДИ выигрыша
  (без − с; больше нуля — урок помогает).
На отложенной части — выигрыш лог-лосса от той же поправки (holdout_effect, ДИ).

Решение: ready — смещение в сторону урока и его ДИ не задевает ноль, ДИ выигрыша на
истории выше нуля и выигрыш на отложенной части больше нуля; rejected — иначе;
insufficient — случаев на истории или в отложенной части меньше MIN_HISTORY или
MIN_HOLDOUT (урок остается гипотезой). Бутстрэп детерминирован (seed в отчете).
"""

import asyncio
from bisect import bisect_left
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal
from typing import Any, Literal

import numpy as np
from sqlalchemy import RowMapping, and_, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select

from app.db.models import BetLeg, EvalSet, EvalSetItem, Match, MatchStat, Tournament
from app.ml.backtest import PlattScaling
from app.ml.elo import EloParams, win_probability
from app.ml.games import (
    GAMES_CAL,
    GamesCalibration,
    GamesDist,
    ServeRecord,
    decided_prob,
    decider_rule,
    games_calibration_of,
    games_dist,
    serve_mean,
)
from app.ml.lesson_scope import (
    FEATURES,
    RESULT_STATUSES,
    TOTAL_FAMILIES,
    EloModel,
    Scope,
    cases_select,
)
from app.ml.markets import (
    FAMILY_GHCP,
    FAMILY_GTOT,
    FAMILY_SHCP,
    FAMILY_STOT,
    GAME_FAMILIES,
    NEW_FAMILIES,
    RESULT_WIN,
    family_of,
    games_complete,
    games_leg_result,
    market_code,
)
from app.ml.metrics import (
    BOOTSTRAP_SAMPLES,
    Estimate,
    bootstrap_diff_ci,
    bootstrap_mean_ci,
    clip_probabilities,
    log_losses,
)
from app.ml.model_versions import GAMES_KEY, SETS_KEY
from app.ml.sets import (
    MARKET_MINUS,
    MARKET_ML,
    MARKET_PLUS,
    MARKETS,
    SETS_PLATT,
    SetsCalibration,
    archive_games,
    base_probs,
    leg_result,
    market_prob,
    set_count_from_score,
    sets_calibration_of,
)
from app.services.dossier import (
    SERVE_DAYS,
    UNDATED_DAYS,
    calibrated_p1,
    model_params,
)

METHOD = "elo_prematch"
HISTORY_YEARS = 8
HOLDOUT_SHARE = 0.25
MIN_HISTORY = 200
MIN_HOLDOUT = 50
SEED = 20261015
# Предел запроса случаев: признаки — подзапросы на каждую сторону матча
STATEMENT_TIMEOUT_MS = 120_000
Status = Literal["ready", "rejected", "insufficient"]


# --- запросы только для чтения ---


async def read_only(db: AsyncSession, stmt: Select[*tuple[Any, ...]]) -> list[RowMapping]:
    """Запрос в точке сохранения той же сессии, переведенной в READ ONLY с пределом времени:
    база сама отвергнет любую запись. Второе соединение пула не берется: вызывающий может
    держать блокировку, и ожидание соединения под ней исчерпало бы пул (замечание M6
    волны 2). После запроса точка сохранения откатывается: режим и предел снимаются."""
    nested = await db.begin_nested()
    try:
        await db.execute(text("SET LOCAL transaction_read_only = on"))
        await db.execute(text(f"SET LOCAL statement_timeout = {int(STATEMENT_TIMEOUT_MS)}"))
        rows = list((await db.execute(stmt)).mappings().all())
    finally:
        await nested.rollback()
    return rows


async def elo_model(db: AsyncSession) -> tuple[EloModel, PlattScaling | None]:
    """Вес покрытия, начальный рейтинг и калибровка базовой модели (как в досье)."""
    return elo_model_of(await model_params(db))


def elo_model_of(params: dict[str, Any]) -> tuple[EloModel, PlattScaling | None]:
    """То же по готовым параметрам (снимок модели, закрепленный за набором)."""
    weight = float(params.get("surface_weight", EloParams.surface_weight))
    initial = float(params.get("initial", EloParams.initial))
    platt: PlattScaling | None = None
    raw = params.get("platt")
    if isinstance(raw, dict):
        try:
            platt = PlattScaling(a=float(raw["a"]), b=float(raw["b"]))
        except (KeyError, TypeError, ValueError):
            platt = None
    return EloModel(weight=weight, initial=initial), platt


# --- случаи ---


@dataclass(frozen=True)
class Case:
    """Случай истории: исход (рынок, сторона) матча, прогноз модели до матча и исход."""

    match_id: int
    day: date
    p: float
    y: int


def selection_prob(
    p_side: float, best_of: int, market: str, calibration: SetsCalibration = SETS_PLATT
) -> float:
    """Вероятность исхода стороны по ее вероятности победы в матче (модель сетов с
    поправкой p(−1.5) по формату, как в досье)."""
    probs = base_probs(p_side, best_of if best_of in (3, 5) else 3, calibration)
    if market == MARKET_ML:
        return probs.p1_win
    if market == MARKET_MINUS:
        return probs.p1_cover
    if market == MARKET_PLUS:
        return 1.0 - probs.p2_cover
    raise ValueError(market)


def selection_outcome(row: RowMapping, market: str) -> int | None:
    """Исход стороны: 1 — сыграл. Форы — по счету архива; неполный счет — None."""
    won = row["winner_id"] == row["pid"]
    if market == MARKET_ML:
        return int(won)
    best_of = row["best_of"] if row["best_of"] in (3, 5) else 3
    count = set_count_from_score(row["score"], winner_is_first=won)
    result = leg_result(market, 1, count, best_of)
    if result is None:
        return None
    return int(result == "win")


# Основная линия тотала сетов по формату (случай семейства stot на архиве)
_SET_TOTAL_MAIN: dict[int, Decimal] = {3: Decimal("2.5"), 5: Decimal("3.5")}
# Поиск основной линии по геймам: половинные линии до этой величины
_GAME_LINE_MAX = 30


@dataclass(frozen=True)
class _Stat:
    """Матч игрока со статистикой подачи: с какого дня виден досье, день матча, очки на
    своей подаче и выигранные, очки на подаче соперника и выигранные игроком на приеме."""

    visible: date
    day: date
    serve_points: int
    serve_won: int
    return_points: int
    return_won: int


@dataclass(frozen=True)
class PlayerServe:
    """Матчи игрока со статистикой подачи по дню и префиксные суммы очков: окно в
    SERVE_DAYS считается за два поиска (bisect), а не перебором всей истории на каждый
    случай (M3 волны 3)."""

    days: tuple[date, ...]
    stats: tuple[_Stat, ...]
    # sums[i] — суммы очков (подача, выиграно на подаче, прием, выиграно на приеме) по
    # первым i матчам
    sums: tuple[tuple[int, int, int, int], ...]

    @classmethod
    def of(cls, items: Sequence[_Stat]) -> "PlayerServe":
        ordered = sorted(items, key=lambda item: item.day)
        sums = [(0, 0, 0, 0)]
        for item in ordered:
            a, b, c, d = sums[-1]
            sums.append(
                (
                    a + item.serve_points,
                    b + item.serve_won,
                    c + item.return_points,
                    d + item.return_won,
                )
            )
        return cls(tuple(item.day for item in ordered), tuple(ordered), tuple(sums))


ServeHistory = dict[int, PlayerServe]


def serve_index(items: Mapping[int, Sequence[_Stat]]) -> ServeHistory:
    """Матчи со статистикой по игрокам → история с префиксными суммами."""
    return {player_id: PlayerServe.of(stats) for player_id, stats in items.items()}


async def serve_history(
    db: AsyncSession, player_ids: Sequence[int], since: date, until: date
) -> ServeHistory:
    """Статистика подачи игроков по матчам с днем в [since, until) — для темпа модели
    геймов на дату случая (окно и видимость — как dossier.serve_sums)."""
    if not player_ids:
        return {}
    own, opp = aliased(MatchStat), aliased(MatchStat)
    day = func.coalesce(Match.match_date, Tournament.start_date)
    rows = await read_only(
        db,
        select(
            own.player_id.label("pid"),
            Match.match_date.label("match_date"),
            day.label("day"),
            own.serve_points.label("sv"),
            (own.first_won + own.second_won).label("sw"),
            opp.serve_points.label("rv"),
            (opp.serve_points - opp.first_won - opp.second_won).label("rw"),
        )
        .select_from(Match)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .join(own, and_(own.match_id == Match.id, own.player_id.in_(list(player_ids))))
        .join(opp, and_(opp.match_id == Match.id, opp.player_id != own.player_id))
        .where(
            Match.status.in_(RESULT_STATUSES),
            Match.winner_id.is_not(None),
            day >= since,
            day < until,
            own.serve_points > 0,
            opp.serve_points > 0,
            own.first_won.is_not(None),
            own.second_won.is_not(None),
            opp.first_won.is_not(None),
            opp.second_won.is_not(None),
        ),
    )
    found: dict[int, list[_Stat]] = {}
    for row in rows:
        found.setdefault(int(row["pid"]), []).append(
            _Stat(_visible(row["match_date"], row["day"]), row["day"], row["sv"], row["sw"],
                  row["rv"], row["rw"])
        )  # fmt: skip
    return serve_index(found)


def _visible(match_date: date | None, day: date) -> date:
    """С какого дня матч виден досье: день после матча; без даты — после окна UNDATED_DAYS
    от начала турнира."""
    if match_date is not None:
        return match_date + timedelta(days=1)
    return day + UNDATED_DAYS + timedelta(days=1)


def serve_record_on(history: ServeHistory, player_id: int, day: date) -> ServeRecord | None:
    """Подача и прием игрока за SERVE_DAYS до дня day (только видимые к этому дню матчи).
    Матч виден не позже чем через UNDATED_DAYS + 1 день после своего дня: матчи раньше
    day − UNDATED_DAYS видны все и берутся префиксной суммой, проверка видимости — только у
    последних."""
    found = history.get(player_id)
    if found is None:
        return None
    low = bisect_left(found.days, day - timedelta(days=SERVE_DAYS))
    sure = max(low, bisect_left(found.days, day - UNDATED_DAYS))
    high = bisect_left(found.days, day)
    first, last = found.sums[low], found.sums[sure]
    total = [last[index] - first[index] for index in range(4)]
    for item in found.stats[sure:high]:
        if item.visible <= day:
            total[0] += item.serve_points
            total[1] += item.serve_won
            total[2] += item.return_points
            total[3] += item.return_won
    if total[0] <= 0 or total[2] <= 0:
        return None
    return ServeRecord(*total)


@dataclass(frozen=True)
class FamilyContext:
    """Что нужно случаям семейств новых рынков: поправка сетов, слой модели геймов и
    статистика подачи игроков (только у рынков по геймам)."""

    sets: SetsCalibration = SETS_PLATT
    games: GamesCalibration = GAMES_CAL
    serve: ServeHistory = field(default_factory=dict)


def _main_line(probs: dict[int, float], *, total: bool) -> tuple[Decimal, float]:
    """Половинная линия, при которой вероятность «больше» (у тотала) или прохода форы
    стороны (у форы, probs — разница геймов стороны) ближе всего к 50%."""
    if total:
        lines = [Decimal(k) + Decimal("0.5") for k in range(max(probs) + 1)]
    else:
        lines = [Decimal(k) + Decimal("0.5") for k in range(-_GAME_LINE_MAX - 1, _GAME_LINE_MAX)]
    best: tuple[float, Decimal, float] | None = None
    for line in lines:
        if total:
            p = sum(value for key, value in probs.items() if key > line)
        else:
            p = sum(value for key, value in probs.items() if key + line > 0)
        found = (abs(p - 0.5), line, p)
        if best is None or found < best:
            best = found
    assert best is not None
    return best[1], best[2]


def _games_dist(row: RowMapping, p_side: float, best_of: int, ctx: FamilyContext) -> GamesDist:
    day = row["day"]
    tempo = serve_mean(
        serve_record_on(ctx.serve, int(row["pid"]), day),
        serve_record_on(ctx.serve, int(row["oid"]), day),
        row["surface"],
    )
    rule = decider_rule(row["level"], row["tour"], day.year, best_of)
    probs = base_probs(p_side, best_of, ctx.sets)
    return games_dist(probs, best_of, ctx.games.input_for(tempo, rule, best_of))


def family_case(
    row: RowMapping, family: str, p_side: float, ctx: FamilyContext
) -> tuple[float, int] | None:
    """(p, y) случая семейства новых рынков на основной линии со стороны row (p_side — ее
    победа в матче). Рынка нет в формате или счет неполный — None."""
    won = row["winner_id"] == row["pid"]
    best_of = int(row["best_of"]) if row["best_of"] in (3, 5) else 3
    if family in (FAMILY_SHCP, FAMILY_STOT):
        if family == FAMILY_SHCP:
            if best_of != 5:
                return None
            market = "HCP_-2.5"
        else:
            market = market_code(FAMILY_STOT, _SET_TOTAL_MAIN[best_of])
        count = set_count_from_score(row["score"], winner_is_first=won)
        result = leg_result(market, 1, count, best_of)
        p = market_prob(base_probs(p_side, best_of, ctx.sets), best_of, market, 1)
        if result is None or p is None:
            return None
        return p, int(result == RESULT_WIN)
    games = archive_games(row["score"], winner_is_first=won)
    if not games_complete(games, best_of):
        return None
    dist = _games_dist(row, p_side, best_of, ctx)
    if family == FAMILY_GTOT:
        line, p = _main_line(dist.total_probs(), total=True)
        market = market_code(FAMILY_GTOT, line)
    else:
        line, p = _main_line(dist.diff_probs(), total=False)
        market = market_code(FAMILY_GHCP, line)
    return p, int(games_leg_result(market, 1, games) == RESULT_WIN)


def archive_cases(
    rows: Sequence[RowMapping],
    scope: Scope,
    platt: PlattScaling | None,
    calibration: SetsCalibration = SETS_PLATT,
    context: FamilyContext | None = None,
) -> list[Case]:
    ctx = context or FamilyContext(sets=calibration)
    found: list[Case] = []
    # Тотал не зависит от стороны: случай — один на матч
    seen: set[tuple[int, str]] = set()
    for row in rows:
        p_raw = win_probability(float(row["r_side"]), float(row["r_opp"]))
        p_side = calibrated_p1(p_raw, platt)
        for market in scope.markets():
            if market in NEW_FAMILIES:
                key = (int(row["match_id"]), market)
                if market in (FAMILY_STOT, FAMILY_GTOT) and key in seen:
                    continue
                pair = family_case(row, market, p_side, ctx)
                if pair is None:
                    continue
                seen.add(key)
                found.append(Case(int(row["match_id"]), row["day"], pair[0], pair[1]))
                continue
            y = selection_outcome(row, market)
            if y is None:
                continue
            p = selection_prob(p_side, int(row["best_of"] or 3), market, calibration)
            found.append(Case(int(row["match_id"]), row["day"], p, y))
    return found


async def frozen_match_ids(db: AsyncSession) -> set[int]:
    """Матчи всех замороженных eval-наборов: на них сравниваются версии инструкций."""
    return set(
        await db.scalars(
            select(EvalSetItem.match_id)
            .join(EvalSet, EvalSet.id == EvalSetItem.eval_set_id)
            .where(EvalSet.frozen_at.is_not(None))
        )
    )


async def history_cases(db: AsyncSession, scope: Scope, *, today: date) -> list[Case]:
    """Случаи истории урока без матчей замороженных наборов (M1 волны 3): поправка урока
    подбирается и отбирается не на тех матчах, на которых потом сравнивается кандидат
    инструкций с этим уроком, — исходы набора не протекают в инструкции."""
    params = await model_params(db)
    model, platt = elo_model_of(params)
    calibration = sets_calibration_of(params.get(SETS_KEY))
    since = today - timedelta(days=365 * HISTORY_YEARS)
    rows = await read_only(db, cases_select(scope, model=model, since=since, until=today))
    frozen = await frozen_match_ids(db)
    kept = [row for row in rows if int(row["match_id"]) not in frozen]
    serve: ServeHistory = {}
    if any(market in GAME_FAMILIES for market in scope.markets()) and kept:
        players = sorted({int(row[key]) for row in kept for key in ("pid", "oid")})
        first = min(row["day"] for row in kept) - timedelta(days=SERVE_DAYS)
        serve = await serve_history(db, players, first, max(row["day"] for row in kept))
    context = FamilyContext(
        sets=calibration, games=games_calibration_of(params.get(GAMES_KEY)), serve=serve
    )
    # Цепь модели геймов — секунды и минуты счета на тысячах матчей: в потоке, чтобы цикл
    # событий воркера не стоял и анализы шли (M3 волны 3)
    return await asyncio.to_thread(archive_cases, kept, scope, platt, calibration, context)


@dataclass(frozen=True)
class OwnCases:
    """Свои случаи: матчи под условием (n), ноги, ставки и прогнозы-источники, средний
    остаток y − p итоговой вероятности по ногам с прогнозом."""

    n: int
    leg_ids: tuple[int, ...] = ()
    bet_ids: tuple[int, ...] = ()
    prediction_ids: tuple[int, ...] = ()
    residual: float | None = None
    legs: int = 0


async def own_cases(db: AsyncSession, scope: Scope) -> OwnCases:
    model, _ = await elo_model(db)
    rows = await read_only(db, cases_select(scope, model=model, own=True))
    if not rows:
        return OwnCases(0)
    leg_ids = sorted({int(row["leg_id"]) for row in rows})
    links = (
        await db.execute(
            select(BetLeg.id, BetLeg.bet_id, BetLeg.prediction_id).where(BetLeg.id.in_(leg_ids))
        )
    ).all()
    # Ноги — только выигрыши и проигрыши: у целой линии p — при условии «не возврат»
    # (p / (1 − p_push)), как в калибровке «Аналитики» (M2 волны 3)
    residuals = [
        (1.0 if row["leg_result"] == "win" else 0.0)
        - decided_prob(float(row["p_own"]), float(row["push_own"] or 0.0))
        for row in rows
        if row["p_own"] is not None
    ]
    return OwnCases(
        n=len({int(row["match_id"]) for row in rows}),
        leg_ids=tuple(leg_ids),
        bet_ids=tuple(sorted({bet_id for _, bet_id, _ in links})),
        prediction_ids=tuple(sorted({pid for _, _, pid in links if pid is not None})),
        residual=float(np.mean(residuals)) if residuals else None,
        legs=len(rows),
    )


async def leg_features(db: AsyncSession, leg_ids: Sequence[int]) -> dict[int, dict[str, Any]]:
    """Признаки словаря у своих ног (факты разбора): нога → признак → значение."""
    if not leg_ids:
        return {}
    model, _ = await elo_model(db)
    rows = await read_only(db, cases_select(None, model=model, own=True, leg_ids=leg_ids))
    return {int(row["leg_id"]): _feature_row(row) for row in rows}


def _feature_row(row: RowMapping) -> dict[str, Any]:
    odds = row["odds"]
    market = _market_feature(row["market"])
    features = {
        "market": market,
        "surface": row["surface"],
        "round": row["round"] or None,
        "best_of": int(row["best_of"]) if row["best_of"] else None,
        "role": row["role"],
        "elo_gap": round(float(row["elo_gap"])) if row["elo_gap"] is not None else None,
        "odds": float(odds) if odds is not None else None,
        "sets_48h": row["sets_48h"],
        "opp_sets_48h": row["opp_sets_48h"],
        "rest_days": row["rest_days"],
        "h2h_matches": row["h2h_matches"],
        "h2h_wins": row["h2h_wins"],
    }
    if market in TOTAL_FAMILIES:
        # У тотала нет стороны игрока: признаки стороны в фактах только запутали бы
        features.update({name: None for name, feature in FEATURES.items() if feature.side})
    return features


def _market_feature(code: str | None) -> str:
    """Значение признака market у ноги: старые рынки — код, новые — семейство (так их
    знает словарь условия урока: GTOT_22.5 → gtot)."""
    if not code or code in MARKETS:
        return code or MARKET_ML
    try:
        return family_of(code)
    except ValueError:
        return code


@dataclass(frozen=True)
class MatchSide:
    """Сторона матча для общего разбора: признаки словаря (рынок ML) и вероятность победы
    по базовой модели до матча (рейтинги Эло строго до дня матча, калибровка — как в
    досье)."""

    features: dict[str, Any]
    p_base: float


async def match_sides(
    db: AsyncSession, match_ids: Sequence[int]
) -> dict[tuple[int, int], MatchSide]:
    """Признаки и p_base обеих сторон матчей: (матч, сторона) → MatchSide. Только архив и
    данные до матча, без ставок и прогнозов участников. p_base стороны 2 — 1 − p_base
    стороны 1 (калибровка Платта — к игроку 1, как в досье)."""
    if not match_ids:
        return {}
    model, platt = await elo_model(db)
    rows = await read_only(db, cases_select(None, model=model, match_ids=match_ids))
    first: dict[int, float] = {}
    for row in rows:
        if int(row["side"]) == 1:
            p_raw = win_probability(float(row["r_side"]), float(row["r_opp"]))
            first[int(row["match_id"])] = calibrated_p1(p_raw, platt)
    found: dict[tuple[int, int], MatchSide] = {}
    for row in rows:
        match_id, side = int(row["match_id"]), int(row["side"])
        if match_id not in first:
            continue
        p1 = first[match_id]
        found[(match_id, side)] = MatchSide(
            features=_feature_row(row), p_base=p1 if side == 1 else 1.0 - p1
        )
    return found


# --- статистика ---


def shrink(effect: float, n: int, k: int) -> float:
    """Поправка с усадкой к нулю: effect · n / (n + k)."""
    return effect * n / (n + k) if n + k > 0 else 0.0


def _estimate(value: Estimate | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return {"value": value.value, "low": value.low, "high": value.high, "n": value.n}


@dataclass(frozen=True)
class HistoryCheck:
    """Итог проверки на истории (что пишется в lessons и lessons.metrics.history)."""

    status: Status
    reason: str | None
    n_hist: int
    n_history: int = 0
    n_holdout: int = 0
    n_shrink: int = 0
    holdout_since: date | None = None
    bias: Estimate | None = None
    shift: float | None = None
    log_loss_without: float | None = None
    log_loss_with: float | None = None
    gain: Estimate | None = None
    holdout_gain: Estimate | None = None
    seed: int = SEED
    samples: int = BOOTSTRAP_SAMPLES
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "method": METHOD,
            "status": self.status,
            "reason": self.reason,
            "n_hist": self.n_hist,
            "n_history": self.n_history,
            "n_holdout": self.n_holdout,
            "n_shrink": self.n_shrink,
            "holdout_since": self.holdout_since.isoformat() if self.holdout_since else None,
            "bias": _estimate(self.bias),
            "shift": self.shift,
            "log_loss_without": self.log_loss_without,
            "log_loss_with": self.log_loss_with,
            "gain": _estimate(self.gain),
            "holdout_gain": _estimate(self.holdout_gain),
            "seed": self.seed,
            "samples": self.samples,
            **self.extra,
        }


def _shifted(p: Any, shift: float) -> Any:
    """Вероятности с поправкой урока, обрезанные в [0, 1] (и от краев — для лог-лосса)."""
    return clip_probabilities(np.clip(p + shift, 0.0, 1.0))


def evaluate(
    cases: Sequence[Case],
    scope: Scope,
    *,
    shrink_k: int,
    seed: int = SEED,
    samples: int = BOOTSTRAP_SAMPLES,
) -> HistoryCheck:
    """Проверка на истории и отложенной части (правила — в docstring модуля)."""
    ordered = sorted(cases, key=lambda item: (item.day, item.match_id))
    total = len(ordered)
    if total == 0:
        return HistoryCheck("insufficient", "no_history", 0, seed=seed, samples=samples)
    cut = int(total * (1.0 - HOLDOUT_SHARE))
    holdout_since = ordered[min(cut, total - 1)].day
    history = [item for item in ordered if item.day < holdout_since]
    holdout = [item for item in ordered if item.day >= holdout_since]
    if len(history) < MIN_HISTORY or len(holdout) < MIN_HOLDOUT:
        return HistoryCheck(
            "insufficient",
            "few_history",
            total,
            n_history=len(history),
            n_holdout=len(holdout),
            holdout_since=holdout_since,
            seed=seed,
            samples=samples,
        )
    p_h = np.array([item.p for item in history])
    y_h = np.array([item.y for item in history], dtype=np.float64)
    bias = bootstrap_mean_ci(y_h - p_h, n=samples, seed=seed)
    shift = shrink(bias.value, len(history), shrink_k)
    without_h = log_losses(p_h, y_h)
    with_h = log_losses(_shifted(p_h, shift), y_h)
    gain = bootstrap_diff_ci(without_h, with_h, n=samples, seed=seed)
    p_o = np.array([item.p for item in holdout])
    y_o = np.array([item.y for item in holdout], dtype=np.float64)
    holdout_gain = bootstrap_diff_ci(
        log_losses(p_o, y_o), log_losses(_shifted(p_o, shift), y_o), n=samples, seed=seed
    )
    sign = scope.sign()
    status: Status = "ready"
    reason: str | None = None
    if bias.value * sign <= 0:
        status, reason = "rejected", "direction"
    elif (sign < 0 and bias.high >= 0) or (sign > 0 and bias.low <= 0):
        status, reason = "rejected", "no_bias"
    elif gain.low <= 0:
        status, reason = "rejected", "no_gain"
    elif holdout_gain.value <= 0:
        status, reason = "rejected", "holdout"
    return HistoryCheck(
        status,
        reason,
        total,
        n_history=len(history),
        n_holdout=len(holdout),
        n_shrink=len(history),
        holdout_since=holdout_since,
        bias=bias,
        shift=shift,
        log_loss_without=float(without_h.mean()),
        log_loss_with=float(with_h.mean()),
        gain=gain,
        holdout_gain=holdout_gain,
        seed=seed,
        samples=samples,
    )


async def check_history(
    db: AsyncSession, scope: Scope, *, today: date, shrink_k: int
) -> HistoryCheck:
    """Проверка урока на архиве (запрос только для чтения и evaluate)."""
    cases = await history_cases(db, scope, today=today)
    # Бутстрэп по тысячам случаев — тоже в потоке
    return await asyncio.to_thread(evaluate, cases, scope, shrink_k=shrink_k)
