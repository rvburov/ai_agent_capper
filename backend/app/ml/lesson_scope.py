"""Условие урока: словарь признаков, проверка условия и сборка SQL (этап 5, Т7;
LLM_LEARNING.md, 1.1 и 5.2).

Claude не пишет SQL и не трогает базу: в разборе он выбирает признаки из словаря и
направление (модель завышает или занижает вероятность), а запрос строит этот модуль.
Значения условия — только связанные параметры запроса (bindparam), никакой подстановки
строк; сам запрос выполняется в транзакции только для чтения с пределом времени
(app/services/lesson_check.py).

Случай урока — исход (рынок, сторона) сыгранного матча. Признаки считаются только по
архиву и только до дня матча (WHERE день < день матча — без утечки исхода):
- market — рынок исхода (ML, HCP_-1.5, HCP_+1.5) или семейство новых рынков Р28 (shcp —
  фора ±2.5 по сетам, stot — тотал сетов, ghcp — фора по геймам, gtot — тотал геймов: линии
  у букмекеров разные, поэтому урок про семейство целиком); без условия — ML. Случай
  семейства на архиве — его основная линия (app/services/lesson_check.py), свои случаи —
  ноги любого рынка семейства. У тотала (stot, gtot) исход не про сторону: признаки стороны
  с ним не берутся, сторона случая — игрок 1;
- surface, round, best_of — покрытие (ковер — хард, как у Эло), круг, формат;
- role — фаворит или аутсайдер по Эло модели (рейтинги до матча с весом покрытия);
- elo_gap — разница рейтингов сторон, которыми пользуется модель (с весом покрытия);
- odds — кэф стороны на победу в архиве (эталон Р17: pinnacle → betfair_ex → avg);
- sets_48h, opp_sets_48h — сетов за двое суток до дня матча у стороны и у соперника
  (только у матчей с датой);
- rest_days — дней с прошлого матча стороны;
- h2h_matches, h2h_wins — личных встреч до матча и побед стороны в них.

Условие JSON (lessons.scope): {"v": 1, "direction": "lower" | "raise", "conditions":
[{"feature": "surface", "op": "in", "values": ["hard"]}, {"feature": "elo_gap", "op":
"lt", "value": 120}]}. Каноническая форма (validate_scope): условия по порядку признаков,
значения перечня — по порядку словаря, числа — округлены по шагу признака. По ней же
ищется такой же урок.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import (
    ColumnElement,
    CompoundSelect,
    Date,
    Float,
    Integer,
    String,
    and_,
    case,
    cast,
    func,
    literal,
    or_,
    select,
    union_all,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import aliased
from sqlalchemy.sql import Select

from app.db.models import (
    Bet,
    BetLeg,
    Match,
    OddsSnapshot,
    PlayerRating,
    Prediction,
    Tournament,
)
from app.ml.games import PUSH_KEY
from app.ml.market import REFERENCE_ORDER
from app.ml.markets import FAMILY_GHCP, FAMILY_GTOT, FAMILY_SHCP, FAMILY_STOT, NEW_FAMILIES
from app.ml.sets import MARKET_ML, MARKETS

SCOPE_VERSION = 1
DIRECTIONS = ("lower", "raise")
ENUM_OPS = ("in", "eq")
NUMBER_OPS = ("lt", "le", "gt", "ge")
OPS = (*ENUM_OPS, *NUMBER_OPS)
MAX_CONDITIONS = 6
ROUNDS = ("R128", "R64", "R32", "R16", "RR", "QF", "SF", "F")
ARCHIVE_SOURCES = ("sackmann", "tennis_data")
RESULT_STATUSES = ("finished", "retired")
# Набор сетов в счете архива: «6-4», «7-6(5)», «[10-8]» (как sets.SET_SCORE); очки
# тай-брейка «7-6(10-8)» сетом не считаются — перед сетом начало строки, пробел или «[»
SET_PATTERN = r"(^|[ \[])\d+-\d+"


class ScopeError(ValueError):
    """Условие не из словаря. code — ключ локали без errors., params — параметры текста."""

    def __init__(self, code: str, **params: Any) -> None:
        super().__init__(code)
        self.code = code
        self.params = params


@dataclass(frozen=True)
class Feature:
    """Признак словаря. kind — enum (перечень values) или number (от low до high с шагом
    step: целые — шаг 1). side — признак своей стороны (без него условие на П1/П2
    симметрично и ничего не говорит: у одной стороны вероятность завышена ровно настолько,
    насколько у другой занижена)."""

    name: str
    kind: Literal["enum", "number"]
    values: tuple[str, ...] = ()
    low: float = 0.0
    high: float = 0.0
    step: float = 1.0
    side: bool = False
    # Признак считается из колонок самого матча (фильтр до тяжелых подзапросов)
    base: bool = False

    @property
    def ops(self) -> tuple[str, ...]:
        return ENUM_OPS if self.kind == "enum" else NUMBER_OPS


FEATURES: dict[str, Feature] = {
    feature.name: feature
    for feature in (
        Feature("market", "enum", values=MARKETS + NEW_FAMILIES),
        Feature("surface", "enum", values=("hard", "clay", "grass"), base=True),
        Feature("round", "enum", values=ROUNDS, base=True),
        Feature("best_of", "enum", values=("3", "5"), base=True),
        Feature("role", "enum", values=("favorite", "underdog"), side=True),
        Feature("elo_gap", "number", low=0, high=1000),
        Feature("odds", "number", low=1.01, high=100, step=0.01, side=True),
        Feature("sets_48h", "number", low=0, high=20, side=True),
        Feature("opp_sets_48h", "number", low=0, high=20, side=True),
        Feature("rest_days", "number", low=0, high=400, side=True),
        Feature("h2h_matches", "number", low=0, high=100),
        Feature("h2h_wins", "number", low=0, high=100, side=True),
    )
}
FEATURE_ORDER = tuple(FEATURES)
# Тоталы: исход не про сторону матча, признаки стороны к ним не подходят
TOTAL_FAMILIES: tuple[str, ...] = (FAMILY_STOT, FAMILY_GTOT)
# Рынки, где случаи двух сторон без признака стороны гасят друг друга
SYMMETRIC_MARKETS = frozenset((MARKET_ML, FAMILY_GHCP))


class Condition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    feature: str
    op: str
    values: tuple[str, ...] = ()
    value: float | None = None

    def to_json(self) -> dict[str, Any]:
        if FEATURES[self.feature].kind == "enum":
            return {"feature": self.feature, "op": self.op, "values": list(self.values)}
        return {"feature": self.feature, "op": self.op, "value": self.value}


class Scope(BaseModel):
    """Проверенное условие урока в канонической форме."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    v: int = SCOPE_VERSION
    direction: Literal["lower", "raise"]
    conditions: tuple[Condition, ...]

    def to_json(self) -> dict[str, Any]:
        return {
            "v": self.v,
            "direction": self.direction,
            "conditions": [item.to_json() for item in self.conditions],
        }

    def markets(self) -> tuple[str, ...]:
        """Рынки случаев: из условия market, без него — только ML."""
        for item in self.conditions:
            if item.feature == "market":
                return item.values
        return (MARKET_ML,)

    def sign(self) -> int:
        """Ожидаемый знак остатка y − p: lower (модель завышает) — минус."""
        return -1 if self.direction == "lower" else 1


def _round_value(feature: Feature, value: float) -> float:
    steps = round((value - feature.low) / feature.step)
    return round(feature.low + steps * feature.step, 6)


def _condition(raw: Any) -> Condition:
    if not isinstance(raw, Mapping):
        raise ScopeError("lesson.scope_format")
    name = raw.get("feature")
    feature = FEATURES.get(name) if isinstance(name, str) else None
    if feature is None:
        raise ScopeError("lesson.scope_feature", feature=str(name)[:40])
    op = raw.get("op")
    if op not in feature.ops:
        raise ScopeError("lesson.scope_op", feature=feature.name, op=str(op)[:10])
    if feature.kind == "enum":
        values = raw.get("values")
        if isinstance(values, str) or not isinstance(values, Sequence) or not values:
            raise ScopeError("lesson.scope_value", feature=feature.name)
        chosen = {str(item) for item in values}
        unknown = chosen - set(feature.values)
        if unknown:
            raise ScopeError("lesson.scope_value", feature=feature.name)
        ordered = tuple(item for item in feature.values if item in chosen)
        if op == "eq" and len(ordered) != 1:
            raise ScopeError("lesson.scope_value", feature=feature.name)
        # Одно значение — eq, несколько — in: каноническая форма одна
        return Condition(
            feature=feature.name, op="eq" if len(ordered) == 1 else "in", values=ordered
        )
    value = raw.get("value")
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ScopeError("lesson.scope_value", feature=feature.name)
    number = float(value)
    if not feature.low <= number <= feature.high:
        raise ScopeError("lesson.scope_value", feature=feature.name)
    return Condition(feature=feature.name, op=str(op), value=_round_value(feature, number))


def validate_scope(raw: Any) -> Scope:
    """Условие из разбора или формы → каноническая форма. Не из словаря — ScopeError."""
    if not isinstance(raw, Mapping):
        raise ScopeError("lesson.scope_format")
    direction = raw.get("direction")
    if direction not in DIRECTIONS:
        raise ScopeError("lesson.scope_direction")
    items = raw.get("conditions")
    if isinstance(items, str) or not isinstance(items, Sequence) or not items:
        raise ScopeError("lesson.scope_empty")
    if len(items) > MAX_CONDITIONS:
        raise ScopeError("lesson.scope_too_many", max=MAX_CONDITIONS)
    conditions = [_condition(item) for item in items]
    keys = [
        (item.feature, item.op if FEATURES[item.feature].kind == "number" else "")
        for item in conditions
    ]
    if len(set(keys)) != len(keys):
        raise ScopeError("lesson.scope_duplicate")
    conditions.sort(key=lambda item: (FEATURE_ORDER.index(item.feature), OPS.index(item.op)))
    try:
        scope = Scope(direction=direction, conditions=tuple(conditions))
    except ValidationError:
        raise ScopeError("lesson.scope_format") from None
    side = any(FEATURES[item.feature].side for item in scope.conditions)
    if side and set(scope.markets()) & set(TOTAL_FAMILIES):
        # У тотала «сторона» — больше или меньше, а не игрок: признак стороны смешал бы
        # «больше» при фаворите П1 и «меньше» при фаворите П2 (M1 волны 3)
        raise ScopeError("lesson.scope_total_side")
    if not side and set(scope.markets()) <= SYMMETRIC_MARKETS:
        # «П1 или П2 на харде» — без своей стороны случаи двух игроков гасят друг друга;
        # у форы по геймам так же: основные линии сторон L и −L дополняют друг друга
        raise ScopeError("lesson.scope_side")
    return scope


def scope_key(scope: Scope) -> str:
    """Ключ для поиска такого же урока: каноническое условие строкой."""
    parts: list[str] = [scope.direction]
    for item in scope.conditions:
        if item.values:
            parts.append(f"{item.feature}:{item.op}:{','.join(item.values)}")
        else:
            parts.append(f"{item.feature}:{item.op}:{item.value}")
    return "|".join(parts)


_OP_SIGNS = {"eq": "=", "in": "∈", "lt": "<", "le": "≤", "gt": ">", "ge": "≥"}


def describe(scope: Scope) -> str:
    """Условие урока строкой из признаков словаря (для блока уроков в system анализа):
    «role = favorite; elo_gap < 120; surface ∈ hard, clay». Собирается только кодом из
    проверенного условия — без свободного текста (m7 волны 3)."""
    parts: list[str] = []
    for item in scope.conditions:
        feature = FEATURES[item.feature]
        sign = _OP_SIGNS[item.op]
        if feature.kind == "enum":
            values = ", ".join(item.values)
            if item.op == "in" and len(item.values) == 1:
                sign = "="
            parts.append(f"{item.feature} {sign} {values}")
            continue
        value = float(item.value if item.value is not None else 0.0)
        shown = str(int(value)) if feature.step >= 1 and value.is_integer() else f"{value:g}"
        parts.append(f"{item.feature} {sign} {shown}")
    return "; ".join(parts) if parts else f"market = {MARKET_ML}"


def dictionary() -> list[dict[str, Any]]:
    """Словарь для формы «Предложить урок» и промпта разбора."""
    return [
        {
            "feature": feature.name,
            "kind": feature.kind,
            "ops": list(feature.ops),
            "values": list(feature.values),
            "low": feature.low if feature.kind == "number" else None,
            "high": feature.high if feature.kind == "number" else None,
            "step": feature.step if feature.kind == "number" else None,
            "side": feature.side,
        }
        for feature in FEATURES.values()
    ]


# --- сборка SQL ---


@dataclass(frozen=True)
class EloModel:
    """Параметры базовой модели для признаков роли и разницы Эло (ml_models.params)."""

    weight: float = 0.5
    initial: float = 1500.0


# Коды рынков семейства для своих ног: фора ±2.5 по сетам — два кода, остальные — префикс
_FAMILY_CODES: dict[str, tuple[str, ...]] = {FAMILY_SHCP: ("HCP_-2.5", "HCP_+2.5")}
_FAMILY_PREFIX: dict[str, str] = {FAMILY_STOT: "STOT_", FAMILY_GHCP: "GHCP_", FAMILY_GTOT: "GTOT_"}


def market_clause(column: Any, values: Sequence[str]) -> ColumnElement[bool]:
    """Рынок ноги подходит под значения признака market: код рынка или семейство (все
    линии). Значения — параметры запроса."""
    codes = [value for value in values if value in MARKETS]
    for value in values:
        codes.extend(_FAMILY_CODES.get(value, ()))
    clauses: list[ColumnElement[bool]] = [column.in_(codes)] if codes else []
    clauses.extend(
        column.startswith(_FAMILY_PREFIX[value]) for value in values if value in _FAMILY_PREFIX
    )
    return or_(*clauses) if clauses else literal(False)


def _surface(column: Any) -> ColumnElement[str | None]:
    """Покрытие рейтинга: ковер — хард (как ml/elo.rating_surface)."""
    return case((column == "carpet", "hard"), else_=column)


def _archive_sides(since: date, until: date) -> CompoundSelect[*tuple[Any, ...]]:
    """Сыгранные матчи архива, по строке на сторону: side 1 — игрок 1, side 2 — игрок 2."""
    day = func.coalesce(Match.match_date, Tournament.start_date)
    return _sides(
        (
            Match.status == "finished",
            Match.winner_id.is_not(None),
            Match.source.in_(ARCHIVE_SOURCES),
            day >= since,
            day < until,
        )
    )


def _match_sides(match_ids: Sequence[int]) -> CompoundSelect[*tuple[Any, ...]]:
    """Эти матчи, по строке на сторону (признаки общего разбора матча)."""
    return _sides((Match.id.in_(list(match_ids)),), outer=True)


def _sides(
    where: Sequence[ColumnElement[bool]], *, outer: bool = False
) -> CompoundSelect[*tuple[Any, ...]]:
    day = func.coalesce(Match.match_date, Tournament.start_date)
    columns = (
        Match.id.label("match_id"),
        day.label("day"),
        Match.match_date.label("match_date"),
        Match.winner_id.label("winner_id"),
        Match.score.label("score"),
        func.coalesce(Match.best_of, Tournament.best_of, 3).label("best_of"),
        _surface(Tournament.surface).label("surface"),
        Match.round.label("round"),
        Tournament.category.label("level"),
        Tournament.name.label("tour"),
        literal(None, String).label("market"),
        literal(None, String).label("leg_result"),
        literal(None, Float).label("p_own"),
        literal(None, Float).label("push_own"),
        literal(None, Integer).label("leg_id"),
    )
    first = (
        select(
            *columns,
            literal(1, Integer).label("side"),
            Match.player1_id.label("pid"),
            Match.player2_id.label("oid"),
        )
        .join(Tournament, Tournament.id == Match.tournament_id, isouter=outer)
        .where(*where)
    )
    second = (
        select(
            *columns,
            literal(2, Integer).label("side"),
            Match.player2_id.label("pid"),
            Match.player1_id.label("oid"),
        )
        .join(Tournament, Tournament.id == Match.tournament_id, isouter=outer)
        .where(*where)
    )
    return union_all(first, second)


def _push(prediction: Any, name: str) -> Any:
    """features.p_push.<name> прогноза текстом (app/ml/games.PUSH_KEY)."""
    return prediction.features[PUSH_KEY][name].astext


def _own_sides() -> Select[*tuple[Any, ...]]:
    """Свои случаи: ноги рассчитанных ставок приложения с исходом (выигрыш или проигрыш)
    и прогнозом. День — день матча, иначе день ставки."""
    day = func.coalesce(Match.match_date, Tournament.start_date, cast(Bet.placed_at, Date))
    # У тотала selection — больше или меньше, а не игрок: сторона — игрок 1, как у случая
    # тотала на архиве (M1 волны 3)
    total = or_(*(BetLeg.market.startswith(_FAMILY_PREFIX[family]) for family in TOTAL_FAMILIES))
    first = or_(total, BetLeg.selection == 1)
    pid = case((first, Match.player1_id), else_=Match.player2_id)
    oid = case((first, Match.player2_id), else_=Match.player1_id)
    side = case((total, literal(1, Integer)), else_=BetLeg.selection)
    return (
        select(
            Match.id.label("match_id"),
            day.label("day"),
            Match.match_date.label("match_date"),
            Match.winner_id.label("winner_id"),
            Match.score.label("score"),
            func.coalesce(Match.best_of, Tournament.best_of, 3).label("best_of"),
            _surface(Tournament.surface).label("surface"),
            Match.round.label("round"),
            Tournament.category.label("level"),
            Tournament.name.label("tour"),
            BetLeg.market.label("market"),
            BetLeg.result.label("leg_result"),
            func.coalesce(Prediction.p_final, Prediction.p_claude).label("p_own"),
            # Вероятность возврата той же оценки (целая линия по геймам; нет — 0)
            func.coalesce(
                cast(
                    case(
                        (Prediction.p_final.is_not(None), _push(Prediction, "final")),
                        else_=_push(Prediction, "claude"),
                    ),
                    Float,
                ),
                0.0,
            ).label("push_own"),
            BetLeg.id.label("leg_id"),
            side.label("side"),
            pid.label("pid"),
            oid.label("oid"),
        )
        .join(Bet, Bet.id == BetLeg.bet_id)
        .join(Match, Match.id == BetLeg.match_id)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .join(Prediction, Prediction.id == BetLeg.prediction_id)
        .where(
            Bet.source == "app",
            Bet.status.in_(("won", "lost")),
            BetLeg.result.in_(("win", "loss")),
            Prediction.is_eval.is_(False),
        )
    )


def _rating(sides: Any, player: Any, surface: Any) -> Any:
    """Рейтинг игрока до дня матча (строка player_ratings строго раньше дня)."""
    rating = aliased(PlayerRating)
    return (
        select(rating.elo)
        .where(rating.player_id == player, rating.surface == surface, rating.as_of < sides.c.day)
        .order_by(rating.as_of.desc())
        .limit(1)
        .correlate(sides)
        .scalar_subquery()
    )


def _sets_48h(sides: Any, player: Any) -> Any:
    other = aliased(Match)
    total = (
        select(
            func.coalesce(
                func.sum(func.regexp_count(func.coalesce(other.score, ""), SET_PATTERN)), 0
            )
        )
        .where(
            or_(other.player1_id == player, other.player2_id == player),
            other.match_date >= sides.c.match_date - timedelta(days=2),
            other.match_date < sides.c.match_date,
            other.status.in_(RESULT_STATUSES),
        )
        .correlate(sides)
        .scalar_subquery()
    )
    return case((sides.c.match_date.is_(None), None), else_=total)


def _rest_days(sides: Any) -> Any:
    other, tour = aliased(Match), aliased(Tournament)
    played = func.coalesce(other.match_date, tour.start_date)
    last = (
        select(func.max(played))
        .select_from(other)
        .outerjoin(tour, tour.id == other.tournament_id)
        .where(
            or_(other.player1_id == sides.c.pid, other.player2_id == sides.c.pid),
            played < sides.c.day,
            other.status.in_(RESULT_STATUSES),
        )
        .correlate(sides)
        .scalar_subquery()
    )
    return sides.c.day - last


def _h2h(sides: Any, *, wins: bool) -> Any:
    other, tour = aliased(Match), aliased(Tournament)
    played = func.coalesce(other.match_date, tour.start_date)
    counted = (
        func.coalesce(func.sum(case((other.winner_id == sides.c.pid, 1), else_=0)), 0)
        if wins
        else func.count()
    )
    return (
        select(counted)
        .select_from(other)
        .outerjoin(tour, tour.id == other.tournament_id)
        .where(
            or_(
                and_(other.player1_id == sides.c.pid, other.player2_id == sides.c.oid),
                and_(other.player1_id == sides.c.oid, other.player2_id == sides.c.pid),
            ),
            played < sides.c.day,
            other.status.in_(RESULT_STATUSES),
        )
        .correlate(sides)
        .scalar_subquery()
    )


def _odds(sides: Any) -> Any:
    snapshot = aliased(OddsSnapshot)
    order = func.array_position(literal(list(REFERENCE_ORDER), ARRAY(String)), snapshot.bookmaker)
    return (
        select(snapshot.odds)
        .where(
            snapshot.match_id == sides.c.match_id,
            snapshot.market == MARKET_ML,
            snapshot.kind == "archive",
            snapshot.selection == sides.c.side,
            snapshot.bookmaker.in_(REFERENCE_ORDER),
        )
        .order_by(order)
        .limit(1)
        .correlate(sides)
        .scalar_subquery()
    )


def _number(feature: Feature, column: Any, op: str, value: float) -> ColumnElement[bool]:
    bound = literal(value, Float) if feature.step != 1 else literal(int(value), Integer)
    if op == "lt":
        return column < bound  # type: ignore[no-any-return]
    if op == "le":
        return column <= bound  # type: ignore[no-any-return]
    if op == "gt":
        return column > bound  # type: ignore[no-any-return]
    return column >= bound  # type: ignore[no-any-return]


def _condition_sql(item: Condition, columns: Mapping[str, Any]) -> ColumnElement[bool]:
    feature = FEATURES[item.feature]
    column = columns[item.feature]
    if feature.kind == "enum":
        # Значения — параметры запроса (expanding bindparam), не текст SQL
        return column.in_(list(item.values))  # type: ignore[no-any-return]
    assert item.value is not None
    return _number(feature, column, item.op, item.value)


def cases_select(
    scope: Scope | None,
    *,
    model: EloModel,
    own: bool = False,
    since: date | None = None,
    until: date | None = None,
    leg_ids: Sequence[int] | None = None,
    match_ids: Sequence[int] | None = None,
) -> Select[*tuple[Any, ...]]:
    """Запрос случаев условия: архив (own=False, матчи с днем в [since, until)) или свои
    ноги рассчитанных ставок (own=True; leg_ids — только эти ноги). Колонки: match_id,
    day, side, winner_id, pid, oid, score, best_of, surface, round, level и tour (категория и
    название турнира — правило решающего сета модели геймов), market, leg_result, p_own,
    leg_id, r_side, r_opp (рейтинги модели до матча), колонки признаков. scope None — без
    условия (признаки ног для фактов разбора); match_ids — обе стороны этих матчей (признаки
    общего разбора матча). Все значения условия и параметры модели — связанные параметры."""
    if match_ids is not None:
        sides = _match_sides(match_ids).subquery("sides")
    elif own:
        sides = _own_sides().subquery("sides")
    else:
        assert since is not None and until is not None
        sides = _archive_sides(since, until).subquery("sides")
    conditions = scope.conditions if scope is not None else ()
    base_columns = {
        "surface": sides.c.surface,
        "round": sides.c.round,
        "best_of": cast(sides.c.best_of, String),
    }
    base_where = [
        _condition_sql(item, base_columns) for item in conditions if FEATURES[item.feature].base
    ]
    if own and scope is not None:
        base_where.append(market_clause(sides.c.market, scope.markets()))
    if leg_ids is not None:
        base_where.append(sides.c.leg_id.in_(list(leg_ids)))
    weight = literal(model.weight, Float)
    initial = literal(model.initial, Float)

    def blended(player: Any) -> Any:
        overall = func.coalesce(_rating(sides, player, "all"), initial)
        on_surface = func.coalesce(_rating(sides, player, sides.c.surface), initial)
        return case(
            (sides.c.surface.is_(None), overall),
            else_=(1.0 - weight) * overall + weight * on_surface,
        )

    inner = (
        select(
            sides.c.match_id,
            sides.c.day,
            sides.c.side,
            sides.c.winner_id,
            sides.c.pid,
            sides.c.oid,
            sides.c.score,
            sides.c.best_of,
            sides.c.surface,
            sides.c.round,
            sides.c.level,
            sides.c.tour,
            sides.c.market,
            sides.c.leg_result,
            sides.c.p_own,
            sides.c.push_own,
            sides.c.leg_id,
            blended(sides.c.pid).label("r_side"),
            blended(sides.c.oid).label("r_opp"),
            _odds(sides).label("odds"),
            _sets_48h(sides, sides.c.pid).label("sets_48h"),
            _sets_48h(sides, sides.c.oid).label("opp_sets_48h"),
            cast(_rest_days(sides), Integer).label("rest_days"),
            _h2h(sides, wins=False).label("h2h_matches"),
            _h2h(sides, wins=True).label("h2h_wins"),
        )
        .where(*base_where)
        # OFFSET 0 — граница оптимизатора: подзапросы признаков считаются по разу на
        # строку, а не в каждом месте, где на них ссылается условие
        .offset(0)
        .subquery("feat")
    )
    columns: dict[str, Any] = {
        "role": case(
            (inner.c.r_side > inner.c.r_opp, "favorite"),
            (inner.c.r_side < inner.c.r_opp, "underdog"),
            else_=None,
        ),
        "elo_gap": func.abs(inner.c.r_side - inner.c.r_opp),
        "odds": inner.c.odds,
        "sets_48h": inner.c.sets_48h,
        "opp_sets_48h": inner.c.opp_sets_48h,
        "rest_days": inner.c.rest_days,
        "h2h_matches": inner.c.h2h_matches,
        "h2h_wins": inner.c.h2h_wins,
    }
    where = [
        _condition_sql(item, columns)
        for item in conditions
        if not FEATURES[item.feature].base and item.feature != "market"
    ]
    return (
        select(inner, columns["role"].label("role"), columns["elo_gap"].label("elo_gap"))
        .where(*where)
        .order_by(inner.c.day, inner.c.match_id, inner.c.side)
    )


def ratings_select(
    *,
    model: EloModel,
    since: date,
    until: date,
    levels: Sequence[str] | None = None,
) -> Select[*tuple[Any, ...]]:
    """Сыгранные матчи архива с днем в [since, until) и рейтинги модели сторон до дня
    матча (r1 — игрок 1, r2 — игрок 2, с весом покрытия): для замороженного eval-набора и
    перекалибровки базовой модели (score — для поправки модели сетов). levels — уровни
    турниров (основной тур); None — все. level и tour — категория и название турнира
    (правило решающего сета модели геймов)."""
    day = func.coalesce(Match.match_date, Tournament.start_date)
    where: list[ColumnElement[bool]] = [
        Match.status == "finished",
        Match.winner_id.is_not(None),
        Match.source.in_(ARCHIVE_SOURCES),
        day >= since,
        day < until,
    ]
    if levels is not None:
        where.append(Tournament.category.in_(list(levels)))
    sides = (
        select(
            Match.id.label("match_id"),
            day.label("day"),
            Match.winner_id.label("winner_id"),
            Match.player1_id.label("p1"),
            Match.player2_id.label("p2"),
            _surface(Tournament.surface).label("surface"),
            Match.round.label("round"),
            func.coalesce(Match.best_of, Tournament.best_of, 3).label("best_of"),
            Match.score.label("score"),
            Tournament.category.label("level"),
            Tournament.name.label("tour"),
        )
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(*where)
        .subquery("sides")
    )
    weight = literal(model.weight, Float)
    initial = literal(model.initial, Float)

    def blended(player: Any) -> Any:
        overall = func.coalesce(_rating(sides, player, "all"), initial)
        on_surface = func.coalesce(_rating(sides, player, sides.c.surface), initial)
        return case(
            (sides.c.surface.is_(None), overall),
            else_=(1.0 - weight) * overall + weight * on_surface,
        )

    return select(
        sides,
        blended(sides.c.p1).label("r1"),
        blended(sides.c.p2).label("r2"),
    ).order_by(sides.c.day, sides.c.match_id)
