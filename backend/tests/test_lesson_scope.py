"""Условие урока и проверка кодом (этап 5, волна 2): словарь признаков и каноническая
форма условия, SQL только с параметрами (попытка инъекции через значение условия),
транзакция только для чтения, признаки на маленьком архиве (сеты за 48 часов, отдых,
личные встречи, кэф архива, роль), статистика проверки на истории (смещение, усадка,
выигрыш лог-лосса, отложенная часть) и детерминизм бутстрэпа."""

from datetime import date, timedelta
from typing import Any, cast

import numpy as np
import pytest
from sqlalchemy import insert, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import Lesson
from app.ml.lesson_scope import (
    Condition,
    EloModel,
    Scope,
    ScopeError,
    cases_select,
    dictionary,
    scope_key,
    validate_scope,
)
from app.ml.sets import MARKET_MINUS, MARKET_ML, MARKET_PLUS, SETS_PLATT, base_probs
from app.services import lesson_check
from app.services.lesson_check import Case, evaluate, read_only, shrink
from tests.learning_helpers import mini_archive, own_leg
from tests.support import UserFactory

FAVORITE = {"feature": "role", "op": "eq", "values": ["favorite"]}


def _scope(*conditions: dict[str, Any], direction: str = "lower") -> Scope:
    return validate_scope({"direction": direction, "conditions": list(conditions)})


# --- словарь и каноническая форма ---


def test_scope_is_canonical() -> None:
    first = _scope(
        {"feature": "elo_gap", "op": "lt", "value": 119.6},
        {"feature": "surface", "op": "in", "values": ["clay", "hard", "hard"]},
        {"feature": "market", "op": "in", "values": ["HCP_-1.5"]},
    )
    second = _scope(
        {"feature": "market", "op": "eq", "values": ["HCP_-1.5"]},
        {"feature": "surface", "op": "in", "values": ["hard", "clay"]},
        {"feature": "elo_gap", "op": "lt", "value": 120},
    )
    assert first == second and scope_key(first) == scope_key(second)
    assert first.to_json() == {
        "v": 1,
        "direction": "lower",
        "conditions": [
            {"feature": "market", "op": "eq", "values": ["HCP_-1.5"]},
            {"feature": "surface", "op": "in", "values": ["hard", "clay"]},
            {"feature": "elo_gap", "op": "lt", "value": 120.0},
        ],
    }
    assert first.markets() == ("HCP_-1.5",) and first.sign() == -1
    assert _scope(FAVORITE).markets() == ("ML",)
    assert _scope(FAVORITE, direction="raise").sign() == 1
    odds = _scope({"feature": "odds", "op": "ge", "value": 2.604}, FAVORITE)
    assert odds.conditions[1].value == 2.6
    assert {item["feature"] for item in dictionary()} >= {"sets_48h", "rest_days", "h2h_wins"}


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ({"direction": "lower", "conditions": []}, "lesson.scope_empty"),
        ({"direction": "down", "conditions": [FAVORITE]}, "lesson.scope_direction"),
        (
            {
                "direction": "lower",
                "conditions": [{"feature": "serve_speed", "op": "ge", "value": 210}],
            },
            "lesson.scope_feature",
        ),
        (
            {"direction": "lower", "conditions": [{"feature": "surface", "op": "lt", "value": 1}]},
            "lesson.scope_op",
        ),
        (
            {
                "direction": "lower",
                "conditions": [{"feature": "surface", "op": "in", "values": ["mud"]}],
            },
            "lesson.scope_value",
        ),
        (
            {"direction": "lower", "conditions": [{"feature": "odds", "op": "ge", "value": 500}]},
            "lesson.scope_value",
        ),
        (
            {"direction": "lower", "conditions": [{"feature": "odds", "op": "ge", "value": "2.5"}]},
            "lesson.scope_value",
        ),
        (
            {"direction": "lower", "conditions": [FAVORITE, dict(FAVORITE)]},
            "lesson.scope_duplicate",
        ),
        # На победу в матче без своей стороны: случаи двух игроков гасят друг друга
        (
            {
                "direction": "lower",
                "conditions": [{"feature": "surface", "op": "eq", "values": ["hard"]}],
            },
            "lesson.scope_side",
        ),
        (
            {
                "direction": "lower",
                "conditions": [{"feature": "h2h_matches", "op": "ge", "value": n} for n in range(1)]
                + [{"feature": "sets_48h", "op": op, "value": 1} for op in ("lt", "le", "gt", "ge")]
                + [FAVORITE, {"feature": "rest_days", "op": "ge", "value": 3}],
            },
            "lesson.scope_too_many",
        ),
    ],
)
def test_scope_outside_dictionary_is_refused(raw: dict[str, Any], code: str) -> None:
    with pytest.raises(ScopeError) as caught:
        validate_scope(raw)
    assert caught.value.code == code


def test_handicap_scope_needs_no_side() -> None:
    """У форы −1.5 обе стороны не дополняют друг друга: условие без стороны допустимо."""
    scope = _scope(
        {"feature": "market", "op": "in", "values": ["HCP_-1.5"]},
        {"feature": "surface", "op": "eq", "values": ["hard"]},
    )
    assert scope.markets() == ("HCP_-1.5",)


# --- SQL: только параметры, только чтение ---

INJECTION = "hard') OR 1=1; DROP TABLE lessons; --"


async def test_condition_values_are_bound_parameters(db: AsyncSession) -> None:
    """Значение условия, даже подсунутое в обход словаря, уходит в базу параметром: в
    тексте SQL его нет, запрос ничего не находит и ничего не ломает."""
    scope = Scope(
        direction="lower",
        conditions=(
            Condition(feature="surface", op="in", values=(INJECTION,)),
            Condition(feature="role", op="eq", values=("favorite",)),
            Condition(feature="sets_48h", op="ge", value=5.0),
        ),
    )
    stmt = cases_select(scope, model=EloModel(), since=date(2000, 1, 1), until=date(2030, 1, 1))
    sql = str(stmt.compile(dialect=db.get_bind().dialect))
    assert "DROP" not in sql and "OR 1=1" not in sql and "hard'" not in sql
    assert "favorite" not in sql
    assert await read_only(db, stmt) == []
    assert await db.scalar(select(Lesson.id).limit(1)) is None  # таблица на месте
    own = cases_select(scope, model=EloModel(), own=True)
    assert "DROP" not in str(own.compile(dialect=db.get_bind().dialect))
    assert await read_only(db, own) == []


async def test_read_only_transaction_refuses_writes(db: AsyncSession) -> None:
    stmt = insert(Lesson).values(code="L-999", text="запись", kind="numeric")
    with pytest.raises(DBAPIError) as caught:
        await read_only(db, cast(Any, stmt))
    assert "read-only" in str(caught.value)
    assert await db.scalar(select(Lesson.id).where(Lesson.code == "L-999")) is None


# --- признаки на архиве ---


async def test_features_on_archive_and_own_legs(
    db: AsyncSession, engine: AsyncEngine, make_user: UserFactory
) -> None:
    world = await mini_archive(db, engine)
    day = world.day
    scope = _scope(FAVORITE, {"feature": "sets_48h", "op": "ge", "value": 5})
    rows = await read_only(
        db,
        cases_select(
            scope, model=EloModel(), since=day - timedelta(days=30), until=day + timedelta(days=1)
        ),
    )
    assert [(row["match_id"], row["side"]) for row in rows] == [(world.m3.id, 1)]
    [row] = rows
    assert row["role"] == "favorite" and row["pid"] == world.a
    # Сеты за двое суток: m1 (2) + m2 (3) у A, m1 (2) у B; отдых — от прошлого матча
    assert (row["sets_48h"], row["opp_sets_48h"]) == (5, 2)
    assert row["rest_days"] == 1
    assert (row["h2h_matches"], row["h2h_wins"]) == (1, 1)
    assert float(row["odds"]) == 1.40
    assert row["elo_gap"] > 0 and row["r_side"] > row["r_opp"]
    # Без условия на сеты — и полуфинал, и прошлые матчи фаворитов до дня D
    wide = await read_only(
        db,
        cases_select(
            _scope(FAVORITE),
            model=EloModel(),
            since=day - timedelta(days=30),
            until=day + timedelta(days=1),
        ),
    )
    assert {item["match_id"] for item in wide} >= {world.m3.id}
    underdog = await read_only(
        db,
        cases_select(
            _scope(
                {"feature": "role", "op": "eq", "values": ["underdog"]},
                {"feature": "odds", "op": "ge", "value": 2.5},
            ),
            model=EloModel(),
            since=day - timedelta(days=30),
            until=day + timedelta(days=1),
        ),
    )
    assert [(item["match_id"], item["side"], float(item["odds"])) for item in underdog] == [
        (world.m3.id, 2, 3.0)
    ]

    # Свои случаи: ноги рассчитанных ставок под условием (матчей, а не ног)
    user = await make_user()
    other = await make_user()
    await own_leg(db, user.id, world.m3, selection=1, result="loss")
    await own_leg(db, other.id, world.m3, selection=1, result="loss")
    await own_leg(db, user.id, world.m3, selection=2, result="win")
    await own_leg(db, user.id, world.m2, selection=1, result="void")
    await own_leg(db, user.id, world.m3, selection=1, result="loss", is_eval=True)
    own = await lesson_check.own_cases(db, scope)
    assert own.n == 1 and own.legs == 2 and len(own.bet_ids) == 2
    assert own.residual == pytest.approx(-0.7)
    features = await lesson_check.leg_features(db, list(own.leg_ids))
    assert {item["sets_48h"] for item in features.values()} == {5}


# --- статистика проверки ---


def _cases(n: int, bias: float, seed: int) -> list[Case]:
    rng = np.random.default_rng(seed)
    start = date(2018, 1, 1)
    found: list[Case] = []
    for index in range(n):
        p = float(rng.uniform(0.3, 0.85))
        y = int(rng.random() < min(0.99, max(0.01, p + bias)))
        found.append(Case(index + 1, start + timedelta(days=int(index * 2900 / n)), p, y))
    return found


def test_real_bias_is_confirmed_with_shrinkage() -> None:
    """Модель в условии завышает вероятность на 8 п.п.: урок lower подтверждается на истории
    и на отложенной части, поправка — с усадкой к нулю."""
    scope = _scope(FAVORITE)
    check = evaluate(_cases(3000, -0.08, 1), scope, shrink_k=200)
    assert check.status == "ready" and check.reason is None
    assert check.bias is not None and check.bias.value == pytest.approx(-0.08, abs=0.03)
    assert check.bias.high < 0
    # n в усадке — только случаи истории архива (свои в формулу не входят)
    n = check.n_history
    assert check.n_shrink == n
    assert check.shift == pytest.approx(check.bias.value * n / (n + 200))
    assert check.shift is not None and abs(check.shift) < abs(check.bias.value)
    assert check.gain is not None and check.gain.low > 0
    assert check.holdout_gain is not None and check.holdout_gain.value > 0
    assert check.n_history + check.n_holdout == 3000 and check.n_holdout >= 700
    assert check.log_loss_with is not None and check.log_loss_without is not None
    assert check.log_loss_with < check.log_loss_without
    # Детерминизм: тот же seed — те же числа; другой seed — другой интервал
    assert evaluate(_cases(3000, -0.08, 1), scope, shrink_k=200) == check
    other = evaluate(_cases(3000, -0.08, 1), scope, shrink_k=200, seed=7)
    assert other.bias is not None and other.bias.value == check.bias.value
    assert (other.bias.low, other.bias.high) != (check.bias.low, check.bias.high)


def test_wrong_direction_and_no_effect_are_rejected() -> None:
    scope = _scope(FAVORITE)
    raise_scope = _scope(FAVORITE, direction="raise")
    biased = _cases(3000, -0.08, 1)
    assert evaluate(biased, raise_scope, shrink_k=200).reason == "direction"
    flat = evaluate(_cases(3000, 0.0, 2), scope, shrink_k=200)
    assert flat.status == "rejected" and flat.reason in ("direction", "no_bias", "no_gain")
    few = evaluate(_cases(150, -0.08, 3), scope, shrink_k=200)
    assert few.status == "insufficient" and few.reason == "few_history"
    assert evaluate([], scope, shrink_k=200).reason == "no_history"


def test_shrink() -> None:
    assert shrink(-0.05, 200, 200) == pytest.approx(-0.025)
    assert shrink(-0.05, 1800, 200) == pytest.approx(-0.045)
    assert shrink(0.1, 0, 0) == 0.0


def test_selection_prob_uses_sets_calibration() -> None:
    # Случаи истории урока считаются той же моделью сетов, что и досье: с поправкой p(−1.5)
    fixed = base_probs(0.7, 3, SETS_PLATT)
    assert lesson_check.selection_prob(0.7, 3, MARKET_ML) == 0.7
    assert lesson_check.selection_prob(0.7, 3, MARKET_MINUS) == fixed.p1_cover
    assert lesson_check.selection_prob(0.7, 3, MARKET_PLUS) == 1.0 - fixed.p2_cover
    # Неизвестный формат — как до 2 побед; без поправки — независимые сеты
    assert lesson_check.selection_prob(0.7, 4, MARKET_MINUS) == fixed.p1_cover
    raw = lesson_check.selection_prob(0.7, 5, MARKET_PLUS, {})
    assert raw == 1.0 - base_probs(0.7, 5).p2_cover
    assert lesson_check.selection_prob(0.7, 5, MARKET_PLUS) < raw
