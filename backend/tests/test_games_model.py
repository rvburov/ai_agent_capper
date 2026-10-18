"""Модель геймов (Р28, этап 7, волна 3): цепь очко → гейм → тай-брейк → сет → матч,
привязка к вероятности победы, правила решающего сета, калибровочный слой (подбор на
синтетике), исходы фор и тоталов по геймам с возвратом, валуй экспресса с возвратом,
семейства в уроках, разбор счетов 13:12 и «7-6(10-8)»."""

import random
import time
from decimal import Decimal
from typing import Any

import pytest

import app.ml.markets as markets_ml
from app.ml.games import (
    GAMES_CAL,
    RULE_ADV,
    RULE_TB7,
    RULE_TB10,
    RULE_TB12,
    GamesCalibration,
    GamesInput,
    GamesSample,
    ServeRecord,
    _delta_for,
    _point_pair,
    decider_rule,
    fit_games_shift,
    games_brier,
    games_calibration_of,
    games_dist,
    hold,
    market_outcome,
    serve_mean,
    set_cells,
    set_split,
    tiebreak,
    tour_serve,
)
from app.ml.lesson_scope import market_clause, validate_scope
from app.ml.markets import games_complete, parse_games, set_finished
from app.ml.sets import SETS_PLATT, Probs3, archive_games, base_probs, parse_sets
from app.ml.strategy import make_leg, parlay_value
from app.ml.variants import Variant
from app.services import lesson_check
from app.services.lesson_check import FamilyContext, family_case

D = Decimal


def _probs(p1: float, best_of: int = 3) -> Probs3:
    return base_probs(p1, best_of, SETS_PLATT)


# --- цепь ---


def test_hold_and_tiebreak_edges() -> None:
    assert hold(0.5) == pytest.approx(0.5)
    assert hold(0.65) > 0.8 and hold(0.99) > 0.999 and hold(0.01) < 0.001
    assert tiebreak(0.6, 0.6) == pytest.approx(0.5)
    assert tiebreak(0.6, 0.6, 10) == pytest.approx(0.5)
    # Сильнее на подаче — чаще выигрывает тай-брейк; до 10 очков преимущество заметнее
    assert 0.5 < tiebreak(0.7, 0.6) < tiebreak(0.7, 0.6, 10) < 1.0
    assert tiebreak(0.98, 0.02) > 0.999


@pytest.mark.parametrize("rule", [RULE_TB7, RULE_TB10, RULE_TB12, RULE_ADV])
def test_set_distribution_sums_to_one(rule: str) -> None:
    for a_first in (True, False):
        cells = dict(set_cells(0.64, 0.6, rule, a_first))
        assert sum(cells.values()) == pytest.approx(1.0)
        assert all(set_finished(a, b) or rule == RULE_ADV for a, b in cells)
    found = dict(set_cells(0.64, 0.64, rule, True))
    assert ((7, 6) in found) == (rule in (RULE_TB7, RULE_TB10))
    assert ((13, 12) in found) == (rule == RULE_TB12)
    assert ((8, 6) in found) == (rule in (RULE_TB12, RULE_ADV))


def test_decider_rule_by_tournament_and_year() -> None:
    assert decider_rule("grand_slam", "Wimbledon", 2019, 5) == RULE_TB12
    assert decider_rule("grand_slam", "Wimbledon", 2018, 5) == RULE_ADV
    assert decider_rule("grand_slam", "Roland Garros", 2021, 5) == RULE_ADV
    assert decider_rule("grand_slam", "Roland Garros", 2022, 5) == RULE_TB10
    assert decider_rule("grand_slam", "Australian Open", 2019, 5) == RULE_TB10
    assert decider_rule("grand_slam", "Australian Open", 2018, 5) == RULE_ADV
    assert decider_rule("grand_slam", "Us Open", 2020, 5) == RULE_TB7
    assert decider_rule("grand_slam", "Wimbledon", 2026, 5) == RULE_TB10
    assert decider_rule("masters", "Shanghai", 2026, 3) == RULE_TB7
    assert decider_rule(None, None, 2026, 5) == RULE_TB7


def test_delta_matches_set_probability() -> None:
    """Привязка к Эло: при подобранной Δ цепь выигрывает сет с вероятностью s."""
    for m in (0.58, 0.64, 0.7):
        for s in (0.1, 0.45, 0.62, 0.9):
            win = set_split(*_point_pair(m, _delta_for(m, s)), RULE_TB7)[0]
            assert win == pytest.approx(s, abs=2e-3)


@pytest.mark.parametrize("best_of", [3, 5])
def test_games_dist_sums_and_symmetry(best_of: int) -> None:
    games = GamesInput(0.64, RULE_TB10 if best_of == 5 else RULE_TB7, -0.03)
    first = games_dist(_probs(0.7, best_of), best_of, games)
    mirror = games_dist(_probs(0.3, best_of), best_of, games)
    assert sum(first.cells.values()) == pytest.approx(1.0)
    for (a, b), p in first.cells.items():
        assert mirror.cells[(b, a)] == pytest.approx(p, abs=1e-6)
    # Фаворит выигрывает больше геймов, тотал — в разумных пределах
    diffs = first.diff_probs()
    assert sum(k * p for k, p in diffs.items()) > 0
    low, high = (18, 28) if best_of == 3 else (28, 45)
    assert low < first.mean_total() < high


def test_extreme_probabilities_do_not_break() -> None:
    games = GamesInput(0.64)
    for p1 in (0.0, 0.001, 0.5, 0.999, 1.0):
        dist = games_dist(Probs3(p1, p1 * 0.6, (1 - p1) * 0.6), 3, games)
        assert sum(dist.cells.values()) == pytest.approx(1.0)
    win, push = games_dist(_probs(0.999), 3, games).outcome("GHCP_-2.5", 1)
    assert win > 0.9 and push == 0.0


def test_outcomes_with_push_and_pairs() -> None:
    dist = games_dist(_probs(0.62), 3, GamesInput(0.64, RULE_TB7, -0.033))
    over, push = dist.outcome("GTOT_22", 1)
    under, push2 = dist.outcome("GTOT_22", 2)
    assert push == push2 and 0.05 < push < 0.2
    assert over + under + push == pytest.approx(1.0)
    half_over, half_push = dist.outcome("GTOT_22.5", 1)
    assert half_push == 0.0 and half_over == pytest.approx(over)
    minus, _ = dist.outcome("GHCP_-3.5", 1)
    plus, _ = dist.outcome("GHCP_+3.5", 2)
    assert minus + plus == pytest.approx(1.0)
    win, hcp_push = dist.outcome("GHCP_-3", 1)
    assert hcp_push > 0 and win == pytest.approx(minus)
    with pytest.raises(ValueError):
        dist.outcome("STOT_2.5", 1)


def test_claude_shift_carries_to_games() -> None:
    """Поправка Claude к p1_win переносится на фору по геймам кодом: выше победа — выше
    фора фаворита; тотал — только через равенство матча."""
    games = GamesInput(0.64, RULE_TB7, -0.033)
    base = market_outcome(_probs(0.6), 3, "GHCP_-2.5", 1, games)
    final = market_outcome(_probs(0.68), 3, "GHCP_-2.5", 1, games)
    assert base is not None and final is not None and final[0] > base[0] + 0.03
    # Без входа цепи у рынка по геймам вероятности нет; у рынков по сетам — есть
    assert market_outcome(_probs(0.6), 3, "GTOT_22.5", 1) is None
    assert market_outcome(_probs(0.6), 3, "STOT_2.5", 1) is not None
    found = market_outcome(_probs(0.6), None, "ML", 1)
    assert found is not None and found[0] == pytest.approx(0.6) and found[1] == 0.0


def test_failed_family_has_no_probability(monkeypatch: pytest.MonkeyPatch) -> None:
    games = GamesInput(0.64)
    monkeypatch.setattr(markets_ml, "FAILED_FAMILIES", ("gtot",))
    assert markets_ml.model_state("gtot") == "failed" and not markets_ml.has_model("gtot")
    assert market_outcome(_probs(0.6), 3, "GTOT_22.5", 1, games) is None
    assert market_outcome(_probs(0.6), 3, "GHCP_-2.5", 1, games) is not None
    monkeypatch.setattr(markets_ml, "FAILED_FAMILIES", ())
    monkeypatch.setattr(markets_ml, "MODEL_FAMILIES", ("ml", "h15", "shcp", "stot"))
    assert markets_ml.model_state("ghcp") == "none"


def test_speed_of_one_match() -> None:
    """Один матч — миллисекунды (новые входы, без кэша)."""
    started = time.perf_counter()
    for index in range(5):
        tempo = 0.6 + index * 0.0137
        games_dist(_probs(0.55 + index * 0.071, 5), 5, GamesInput(tempo, RULE_TB10, -0.06))
    assert (time.perf_counter() - started) / 5 < 0.2


# --- темп и калибровочный слой ---


def test_serve_mean_barnett_clarke() -> None:
    assert serve_mean(None, None, "grass") == pytest.approx(tour_serve("grass"))
    big = ServeRecord(serve_points=5000, serve_won=3500, return_points=5000, return_won=1800)
    weak = ServeRecord(serve_points=5000, serve_won=3000, return_points=5000, return_won=1700)
    # Сильная подача обоих — темп выше среднего тура, слабая — ниже; порядок не важен
    assert serve_mean(big, big, "hard") > tour_serve("hard") > serve_mean(weak, weak, "hard")
    assert serve_mean(big, weak, "clay") == pytest.approx(serve_mean(weak, big, "clay"))


def test_calibration_json_and_fallbacks() -> None:
    assert games_calibration_of(None) == GAMES_CAL
    assert games_calibration_of({"shift": {"3": -0.02}}).shift == {3: -0.02, 5: GAMES_CAL.shift[5]}
    assert games_calibration_of({"shift": {"3": "x", "5": 0.5}}).shift == dict(GAMES_CAL.shift)
    cal = GamesCalibration({3: -0.03, 5: -0.05})
    assert games_calibration_of(cal.to_json()).shift == {3: -0.03, 5: -0.05}
    item = cal.input_for(0.65, RULE_TB10, 5)
    assert GamesInput.from_json(item.to_json(), surface="hard", best_of=5) == item
    fallback = GamesInput.from_json(None, surface="clay", best_of=3)
    assert fallback.tempo == tour_serve("clay") and fallback.shift == GAMES_CAL.shift[3]
    assert GamesInput.from_json({"m": "x"}, surface=None, best_of=5).decider == RULE_TB7
    assert GamesInput.from_json({"m": 0.6, "decider": "zz"}, surface=None, best_of=3).decider == (
        RULE_TB7
    )


def _synthetic(true_shift: float, n: int, seed: int) -> list[GamesSample]:
    """Матчи, сыгранные «по модели» с известным сдвигом темпа: счет по геймам — случайный
    по распределению сетов цепи (несколько сочетаний p и темпа — кэш цепи)."""
    rng = random.Random(seed)
    found: list[GamesSample] = []
    for _ in range(n):
        p1 = rng.choice((0.35, 0.5, 0.62, 0.75))
        tempo = rng.choice((0.6, 0.64, 0.68))
        probs = _probs(p1)
        dist = games_dist(probs, 3, GamesInput(tempo, RULE_TB7, true_shift))
        cells = list(dist.cells.items())
        pick = rng.random()
        total = 0.0
        chosen = cells[-1][0]
        for cell, p in cells:
            total += p
            if pick <= total:
                chosen = cell
                break
        # Счет сетами не нужен: потери считаются по суммам геймов
        found.append(GamesSample(probs, 3, tempo, RULE_TB7, (chosen,)))
    return found


def test_shift_is_recovered_on_synthetic_data() -> None:
    samples = _synthetic(-0.03, 2500, seed=7)
    fitted = fit_games_shift(samples, 3, -0.018)
    assert fitted is not None and abs(fitted - (-0.03)) <= 0.0061
    right = games_brier(samples, 3, -0.03)
    wrong = games_brier(samples, 3, 0.0)
    assert right is not None and wrong is not None and right < wrong
    assert fit_games_shift(samples, 5, 0.0) is None


# --- экспресс с возвратом ---


def test_parlay_value_with_push() -> None:
    first = make_leg(1, "GTOT_22", 2, 0.47, D("2.05"), push=0.08)
    second = make_leg(2, "ML", 1, 0.7, D("1.60"))
    assert parlay_value([first, second]) == pytest.approx((0.47 * 2.05 + 0.08) * 0.7 * 1.6 - 1)
    assert parlay_value([second]) == pytest.approx(second.value)
    variant = Variant("best_express", (first, second), "best_express")
    assert variant.value == pytest.approx(parlay_value([first, second]))


# --- счета ---


def test_long_and_two_sided_tiebreak_scores() -> None:
    assert parse_games("6:4 7:6(10-8)") == [(6, 4), (7, 6)]
    assert parse_games("4:6 6:3 13:12") == [(4, 6), (6, 3), (13, 12)]
    assert games_complete(parse_games("4:6 6:3 13:12") or [], 3)
    assert parse_sets("7-6(10-8) 6-4") == [(7, 6, "(10-8)"), (6, 4, "")]
    games = archive_games("6-3 4-6 6-7(4) 6-4 13-12(3)", winner_is_first=False)
    assert games[-1] == (12, 13) and games_complete(games, 5)
    assert not set_finished(12, 11)
    # L5 волны 3: 13:12 — только решающий сет (как окно расчета на frontend); очки
    # тай-брейка — с любым разделителем «-», «:», «–»
    assert not set_finished(13, 12, last=False) and set_finished(13, 12)
    assert not games_complete(parse_games("13:12 6:3") or [], 3)
    assert not games_complete(parse_games("13:12 4:6 6:3") or [], 3)
    for text in ("6:4 7:6(10-8)", "6:4 7:6(10:8)", "6:4 7:6(10\u20138)"):
        assert parse_games(text) == [(6, 4), (7, 6)], text


# --- уроки: семейства новых рынков ---


def test_lesson_market_feature_takes_families() -> None:
    scope = validate_scope(
        {
            "direction": "lower",
            "conditions": [{"feature": "market", "op": "in", "values": ["gtot", "ML", "shcp"]}],
        }
    )
    assert scope.markets() == ("ML", "shcp", "gtot")
    clause = market_clause(markets_ml_column(), ("gtot", "shcp", "HCP_-1.5"))
    sql = str(clause.compile(compile_kwargs={"literal_binds": True}))
    assert "'HCP_-2.5'" in sql and "'HCP_+2.5'" in sql and "GTOT" in sql


def markets_ml_column() -> Any:
    from app.db.models import BetLeg

    return BetLeg.market


class _Row(dict[str, Any]):
    """Строка случая урока (как RowMapping)."""


def _case_row(score: str, best_of: int = 3, **extra: Any) -> Any:
    from datetime import date

    row = _Row(
        match_id=1,
        day=date(2025, 6, 1),
        side=1,
        winner_id=10,
        pid=10,
        oid=20,
        score=score,
        best_of=best_of,
        surface="hard",
        round="R32",
        level="250",
        tour="Test Open",
        r_side=1700.0,
        r_opp=1600.0,
    )
    row.update(extra)
    return row


def test_family_cases_on_main_line() -> None:
    ctx = FamilyContext()
    total = family_case(_case_row("6-4 6-4"), "gtot", 0.64, ctx)
    assert total is not None and abs(total[0] - 0.5) < 0.1 and total[1] in (0, 1)
    hcp = family_case(_case_row("6-1 6-1"), "ghcp", 0.64, ctx)
    assert hcp is not None and abs(hcp[0] - 0.5) < 0.15 and hcp[1] == 1
    sets_total = family_case(_case_row("6-4 6-4"), "stot", 0.64, ctx)
    assert sets_total is not None and sets_total[1] == 0
    # Фора ±2.5 — только до 3 побед; 3:0 стороны — исход 1
    assert family_case(_case_row("6-4 6-4"), "shcp", 0.64, ctx) is None
    three = family_case(_case_row("6-4 6-4 6-4", best_of=5), "shcp", 0.7, ctx)
    assert three is not None and three[1] == 1
    # Недоигранный счет — без случая
    assert family_case(_case_row("6-4 2-1"), "gtot", 0.64, ctx) is None


def _family_scope(family: str, direction: str) -> Any:
    condition = {"feature": "market", "op": "eq", "values": [family]}
    return validate_scope({"direction": direction, "conditions": [condition]})


def test_archive_cases_count_total_once_per_match() -> None:
    scope = validate_scope(
        {
            "direction": "raise",
            "conditions": [{"feature": "market", "op": "eq", "values": ["gtot"]}],
        }
    )
    rows: list[Any] = [
        _case_row("6-4 6-4"),
        _case_row("6-4 6-4", side=2, pid=20, oid=10, r_side=1600.0, r_opp=1700.0),
    ]
    cases = lesson_check.archive_cases(rows, scope, None)
    assert len(cases) == 1


def test_total_legs_ignore_player_form() -> None:
    from app.ml.strategy import leg_blocks

    blocks = {1: ("form",), 2: ("form", "injury")}
    assert leg_blocks("ML", 1, blocks) == ("form",)
    assert leg_blocks("GHCP_-3.5", 2, blocks) == ("form", "injury")
    assert leg_blocks("GTOT_22.5", 1, blocks) == ("injury",)
    assert leg_blocks("STOT_2.5", 2, {1: ("form",)}) == ()


async def test_lesson_cases_for_game_families(db: Any, engine: Any, make_user: Any) -> None:
    """Свои случаи урока про семейство — ноги любой линии семейства; на архиве — основная
    линия по цепи модели геймов с темпом по подаче за 52 недели."""
    from datetime import timedelta

    from app.db.models import MatchStat
    from tests.learning_helpers import mini_archive, own_leg

    world = await mini_archive(db, engine)
    for match in (world.m0, world.m1, world.m2):
        for player, won in ((match.player1_id, 40), (match.player2_id, 30)):
            db.add(
                MatchStat(
                    match_id=match.id,
                    player_id=player,
                    serve_points=60,
                    first_in=40,
                    first_won=won - 10,
                    second_won=10,
                    source="sackmann",
                )
            )
    await db.commit()
    scope = _family_scope("gtot", "lower")
    user = await make_user()
    await own_leg(db, user.id, world.m3, selection=1, market="GTOT_21.5", result="loss")
    await own_leg(db, user.id, world.m2, selection=2, market="GTOT_24", result="win")
    await own_leg(db, user.id, world.m1, selection=1, market="GHCP_-3.5", result="win")
    await own_leg(db, user.id, world.m1, selection=1, market="ML", result="win")
    own = await lesson_check.own_cases(db, scope)
    assert own.legs == 2 and own.n == 2
    cases = await lesson_check.history_cases(db, scope, today=world.day + timedelta(days=1))
    # Тотал — один случай на матч: четыре матча мини-архива
    assert len(cases) == 4 and all(0.2 < case.p < 0.8 for case in cases)
    # Фора по геймам — со стороной (без нее урок вырождается, как ML): только фавориты
    ghcp = validate_scope(
        {
            "direction": "raise",
            "conditions": [
                {"feature": "market", "op": "eq", "values": ["ghcp"]},
                {"feature": "role", "op": "eq", "values": ["favorite"]},
            ],
        }
    )
    sides = await lesson_check.history_cases(db, ghcp, today=world.day + timedelta(days=1))
    # Фаворит есть в трех матчах: у первого матча мини-архива рейтинги сторон равны
    assert len(sides) == 3
    serve = await lesson_check.serve_history(
        db, [world.a], world.day - timedelta(days=30), world.day
    )
    # Подача A за окно до дня D: m1 и m2 (у m3 статистики нет, m0 — без A)
    record = lesson_check.serve_record_on(serve, world.a, world.day)
    assert record is not None and record.serve_points == 120


def test_recalibration_keeps_previous_games_layer_on_few_matches() -> None:
    from datetime import date

    from app.services.recalibration import Sample, choose_games

    previous = GamesCalibration({3: -0.03, 5: -0.06})
    items = [
        Sample(
            index,
            date(2026, 1, 1),
            0.6,
            1,
            None,
            games=((6, 4), (6, 4)),
            tempo=0.64,
            decider=RULE_TB7,
        )
        for index in range(40)
    ]
    chosen, report = choose_games(items[:30], items[30:], None, SETS_PLATT, previous)
    assert chosen == previous
    assert report["3"]["fitted"] is None and report["3"]["taken"] is False
    assert report["3"]["n_train"] == 30 and report["3"]["prev_brier"] is not None
    assert report["5"]["n_holdout"] == 0


def test_serve_record_on_prefix_sums_match_full_scan() -> None:
    """M3 волны 3: окно подачи по префиксным суммам дает то же, что перебор всей истории
    (видимость матча без даты — через UNDATED_DAYS после дня турнира)."""
    from datetime import date, timedelta

    from app.services.dossier import SERVE_DAYS
    from app.services.lesson_check import _Stat, serve_index, serve_record_on

    rng = random.Random(5)
    start = date(2020, 1, 1)
    raw: dict[int, list[Any]] = {}
    for player in range(6):
        items = []
        for _ in range(80):
            day = start + timedelta(days=rng.randint(0, 1500))
            visible = day + timedelta(days=17 if rng.random() < 0.3 else 1)
            items.append(_Stat(visible, day, rng.randint(1, 90), rng.randint(0, 50), 60, 20))
        raw[player] = items
    history = serve_index(raw)

    def scan(player: int, day: date) -> tuple[int, int, int, int] | None:
        total = [0, 0, 0, 0]
        for item in raw.get(player, ()):
            if item.visible <= day and item.day >= day - timedelta(days=SERVE_DAYS):
                total[0] += item.serve_points
                total[1] += item.serve_won
                total[2] += item.return_points
                total[3] += item.return_won
        return tuple(total) if total[0] > 0 and total[2] > 0 else None  # type: ignore[return-value]

    for _ in range(2000):
        player, day = rng.randrange(7), start + timedelta(days=rng.randint(-30, 1600))
        record = serve_record_on(history, player, day)
        got = (
            None
            if record is None
            else (record.serve_points, record.serve_won, record.return_points, record.return_won)
        )
        assert got == scan(player, day), (player, day)


async def test_lesson_history_does_not_block_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """M3 волны 3: счет случаев урока и бутстрэп идут в потоке — цикл событий в это время
    работает (анализы воркера не стоят)."""
    import asyncio
    from datetime import date

    from app.services import lesson_check as module

    def slow(*args: Any, **kwargs: Any) -> list[Any]:
        time.sleep(0.4)
        return []

    async def no_rows(db: Any, stmt: Any) -> list[Any]:
        return []

    async def params(db: Any) -> dict[str, Any]:
        return {}

    async def frozen(db: Any) -> set[int]:
        return set()

    monkeypatch.setattr(module, "archive_cases", slow)
    monkeypatch.setattr(module, "evaluate", slow)
    monkeypatch.setattr(module, "read_only", no_rows)
    monkeypatch.setattr(module, "model_params", params)
    monkeypatch.setattr(module, "frozen_match_ids", frozen)
    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    task = asyncio.create_task(ticker())
    scope = _family_scope("gtot", "lower")
    await module.check_history(None, scope, today=date(2026, 1, 1), shrink_k=200)  # type: ignore[arg-type]
    task.cancel()
    # 0.8 с счета: при работе в цикле событий тиков было бы 0–1
    assert ticks >= 20


def test_parlay_probability_agrees_with_value() -> None:
    """L4 волны 3: вероятность экспресса и варианта согласована с валуем и у целой линии:
    p · итоговый кэф − 1 = ev; у половинных линий — Πp, как раньше."""
    from app.ml.strategy import parlay_p, parlay_total

    first = make_leg(1, "GTOT_22", 2, 0.47, D("2.05"), push=0.08)
    second = make_leg(2, "ML", 1, 0.7, D("1.60"))
    legs = [first, second]
    p = parlay_p(legs)
    assert p * float(parlay_total(legs)) - 1 == pytest.approx(parlay_value(legs))
    assert p == pytest.approx((0.47 + 0.08 / 2.05) * 0.7)
    assert parlay_p([second, make_leg(3, "GTOT_22.5", 1, 0.55, D("1.8"))]) == pytest.approx(
        0.7 * 0.55
    )
    variant = Variant("best_express", (first, second), "best_express")
    assert variant.p * float(variant.total_odds) - 1 == pytest.approx(variant.value)


def test_stored_express_fallback_leg_keeps_push() -> None:
    """L3 волны 3: ногу сохраненного экспресса не найти среди ног (у строки нет кэфа) —
    запасная нога считает валуй с возвратом строки таблицы рынков."""
    from app.ml.strategy import StrategyParams
    from app.services.analysis_result import stored_variants
    from app.services.bank import BankState

    def row(market: str, selection: int, p: float, odds: str | None, pid: int, push: float) -> Any:
        return {
            "market": market, "selection": selection, "p_final": p, "odds": odds,
            "prediction_id": pid, "p_push": push,
        }  # fmt: skip

    result = {
        "matches": [
            {
                "match_id": 1,
                "confidence": "high",
                "markets": [
                    row("ML", 1, 0.74, "1.45", 11, 0.0),
                    row("GTOT_22", 1, 0.62, None, 12, 0.08),
                ],
            },
            {"match_id": 2, "confidence": "high", "markets": [row("ML", 1, 0.75, "1.40", 21, 0.0)]},
        ],
        "express": {
            "legs": [
                {"match_id": 1, "market": "GTOT_22", "selection": 1, "p": 0.62, "odds": "1.70",
                 "prediction_id": 12},
                {"match_id": 2, "market": "ML", "selection": 1, "p": 0.75, "odds": "1.40",
                 "prediction_id": 21},
            ]
        },
    }  # fmt: skip
    zero = D("0")
    state = BankState(
        balance=D("10000"), currency="RUB", in_play=zero, equity=D("10000"), peak=D("10000"),
        drawdown=zero, invested=D("10000"), growth=None, week_change=None, winrate=None,
        settled_bets=0, empty=False,
    )  # fmt: skip
    found = stored_variants(
        result, params=StrategyParams(), state=state, bank_input=D("10000"), currency="RUB"
    )
    strategy = next(item for item in found if item["code"] == "strategy")
    expected = (0.62 * 1.70 + 0.08) * (0.75 * 1.40) - 1
    assert strategy["value"] == pytest.approx(expected, abs=1e-4)
