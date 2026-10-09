"""Бэктест (app/ml/backtest.py) и отчет (app/ml/report.py): стороны, калибровка, правила
экспресса, синтетический мир, приманка, запись в БД и команда терминала."""

import asyncio
import json
from collections.abc import Iterable
from dataclasses import replace
from datetime import date
from decimal import Decimal
from pathlib import Path

import numpy as np
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.core.i18n import t
from app.db.models import EvalRun, IngestionRun, MlModel
from app.db.session import create_sessionmaker
from app.ml import backtest
from app.ml.backtest import (
    BacktestConfig,
    BacktestError,
    BacktestResult,
    DecoyResult,
    Outcome,
    StrategyRules,
    candidates,
    evaluate,
    fit_platt,
    parse_years,
    pick_parlay,
    run_backtest,
    side_flip,
)
from app.ml.elo import MODEL_ID, EloEngine, EloMatch, PreMatch, rating_surface
from app.ml.metrics import COIN_LOG_LOSS, Estimate, RoiEstimate, log_loss
from app.ml.report import num, pct, render_markdown, summary_lines
from tests.ml_world import World, make_world, small_world, store_world

FORBIDDEN_LETTERS = ("\u0451", "\u0401")
RULES = StrategyRules()
DAY = date(2024, 6, 1)


def no_forbidden_letters(text: str) -> bool:
    return not any(letter in text for letter in FORBIDDEN_LETTERS)


# --- стороны и калибровка ---


def test_sides_are_random_but_stable() -> None:
    flips = [side_flip(match_id) for match_id in range(1, 4001)]
    assert 0.45 < sum(flips) / len(flips) < 0.55
    assert flips == [side_flip(match_id) for match_id in range(1, 4001)]


def test_platt_recovers_coefficients() -> None:
    rng = np.random.default_rng(4)
    x = rng.normal(0.0, 1.5, 20_000)
    true = 1.0 / (1.0 + np.exp(-(0.3 + 0.7 * x)))
    y = (rng.random(x.size) < true).astype(float)
    platt = fit_platt(1.0 / (1.0 + np.exp(-x)), y)
    assert platt.a == pytest.approx(0.3, abs=0.05)
    assert platt.b == pytest.approx(0.7, abs=0.05)
    calibrated = platt.apply([0.5, 0.9])
    assert calibrated[0] == pytest.approx(1.0 / (1.0 + np.exp(-platt.a)))
    with pytest.raises(ValueError):
        fit_platt([0.6, 0.7], [1, 1])


# --- правила стратегии ---


def outcome(match_id: int, p: float, odds: str, *, won: bool = True, selection: int = 1) -> Outcome:
    return Outcome(match_id, DAY, selection, p, Decimal(odds), won)


def test_candidates_filter_and_one_per_match() -> None:
    pool = [
        outcome(1, 0.70, "1.50"),  # перевес 1,05
        outcome(2, 0.64, "1.70"),  # p меньше 0,65
        outcome(3, 0.90, "1.12"),  # кэф меньше 1,13
        outcome(4, 0.66, "1.81"),  # кэф больше 1,80
        outcome(5, 0.66, "1.45"),  # перевеса нет: 0,957
        outcome(6, 0.68, "1.60"),  # перевес 1,088
        outcome(6, 0.67, "1.62", selection=2),  # тот же матч, перевес 1,085
    ]
    found = candidates(pool, RULES)
    assert [(item.match_id, item.selection) for item in found] == [(6, 1), (1, 1)]
    # Правило 7: перевес не нужен
    with_rule7 = candidates(pool, RULES, require_value=False)
    assert [item.match_id for item in with_rule7] == [6, 1, 5]


def test_parlay_of_two() -> None:
    assert pick_parlay([outcome(1, 0.7, "1.6")], RULES) is None
    legs = pick_parlay([outcome(1, 0.66, "1.70"), outcome(2, 0.67, "1.65")], RULES)
    assert legs is not None and [leg.match_id for leg in legs] == [1, 2]
    # Граница итога: 1,80 × 1,80 = 3,24 — еще можно
    top = pick_parlay([outcome(1, 0.66, "1.80"), outcome(2, 0.66, "1.80")], RULES)
    assert top is not None and len(top) == 2
    # 1,13 × 1,13 = 1,2769 — меньше 1,28: ставки нет
    low = pick_parlay([outcome(1, 0.95, "1.13"), outcome(2, 0.95, "1.13")], RULES)
    assert low is None


def test_parlay_of_three() -> None:
    strong = [
        outcome(1, 0.75, "1.50"),  # 1,125
        outcome(2, 0.72, "1.55"),  # 1,116
        outcome(3, 0.71, "1.45"),  # 1,0295
        outcome(4, 0.80, "1.35"),  # 1,08
    ]
    legs = pick_parlay(strong, RULES)
    assert legs is not None
    assert [leg.match_id for leg in legs] == [1, 2, 4]
    # Только два сильных: экспресс из двух лучших по перевесу среди всех кандидатов
    mixed = [
        outcome(1, 0.75, "1.50"),
        outcome(2, 0.69, "1.75"),  # p меньше 0,70 — не для тройки, перевес 1,2075
        outcome(4, 0.80, "1.35"),
    ]
    legs = pick_parlay(mixed, RULES)
    assert legs is not None and [leg.match_id for leg in legs] == [2, 1]
    # Кэф выше 1,60 не идет в тройку
    over = [outcome(1, 0.75, "1.50"), outcome(2, 0.72, "1.61"), outcome(4, 0.80, "1.35")]
    legs = pick_parlay(over, RULES)
    assert legs is not None and len(legs) == 2


# --- синтетический мир ---


@pytest.fixture(scope="module")
def world() -> World:
    return make_world(seed=7)


@pytest.fixture(scope="module")
def result(world: World) -> BacktestResult:
    return evaluate(world.matches, world.odds, BacktestConfig(bootstrap=300))


def test_decoy_catches_leak_only_in_test_years(
    world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Утечка исхода только в тестовых годах (особые пути данных — последние годы):
    калибровка на годах без утечки сжимает прогнозы приманки к 0,5 и прячет ее. Ловит
    вторая проверка — Платт, подогнанный на самих тестовых событиях приманки."""

    class Leaky(EloEngine):
        def run(self, matches: Iterable[EloMatch]) -> list[PreMatch]:
            out: list[PreMatch] = []
            for match in matches:
                court = rating_surface(match.surface)
                if match.day.year >= 2024:
                    # Утечка: исход учтен до «прогноза до матча»
                    self.update(match.player1_id, match.player2_id, match.winner_id, match.surface)
                out.append(
                    self.pre_match(match.match_id, match.player1_id, match.player2_id, court)
                )
                if match.day.year < 2024:
                    self.update(match.player1_id, match.player2_id, match.winner_id, match.surface)
            return out

    monkeypatch.setattr(backtest, "EloEngine", Leaky)
    leaky = evaluate(world.matches, world.odds, BacktestConfig(bootstrap=50))
    decoy = leaky.decoy
    # Первая проверка (калибровка лет калибровки) утечку не видит, вторая — видит
    assert decoy.log_loss >= decoy.threshold
    assert decoy.refit_log_loss is not None and decoy.refit_log_loss < decoy.threshold
    assert not decoy.passed
    assert summary_lines(leaky)[-1].startswith("Приманка НЕ пройдена")


def test_synthetic_world(world: World, result: BacktestResult) -> None:
    data = result.data
    assert data.matches == len(world.matches)
    assert data.test.events > 1000
    assert data.test_with_market == data.test.events
    assert data.market_share == 1.0
    assert set(data.market_by_year) == {2024, 2025}
    assert result.surface_weight in BacktestConfig().surface_weights
    assert set(result.tuning) == set(BacktestConfig().surface_weights)
    assert result.calibrated is not None and result.market is not None
    assert result.raw is not None and result.calibrated_gap is not None

    # Эло лучше монетки, рынок (истинная p + шум) лучше Эло
    assert result.calibrated.log_loss.high < COIN_LOG_LOSS
    assert result.market.log_loss.value < result.calibrated.log_loss.value
    assert result.calibrated_gap.log_loss.low > 0
    assert result.calibrated_gap.skill is not None and result.calibrated_gap.skill < 0

    # Истинная вероятность лучше Эло на тех же событиях
    config = result.config
    test = [
        match
        for match in world.matches
        if match.status == "finished"
        and match.level in config.levels
        and match.day.year in config.test_years
    ]
    true_p = [
        1 - world.true_p1[match.match_id]
        if side_flip(match.match_id)
        else world.true_p1[match.match_id]
        for match in test
    ]
    y = [0.0 if side_flip(match.match_id) else 1.0 for match in test]
    assert log_loss(true_p, y) < result.calibrated.log_loss.value

    # Приманка: на монетке модель не лучше 0,693, и с калибровкой на самой приманке тоже
    assert result.decoy.passed
    assert result.decoy.log_loss == pytest.approx(COIN_LOG_LOSS, abs=0.01)
    assert result.decoy.n == result.calibrated.n
    assert result.decoy.refit_log_loss is not None
    assert result.decoy.refit_log_loss >= result.decoy.threshold

    # Ставки: 3 букмекера × (экспресс, одиночные на его исходах, одиночные на всех
    # кандидатах) × (без правила 7, с ним)
    assert len(result.bets) == 18
    # Одиночные на исходах экспрессов — ровно ноги экспрессов (Р21)
    for parlay in (bet for bet in result.bets if bet.kind == "parlay"):
        [legs] = [
            bet
            for bet in result.bets
            if bet.kind == "legs" and (bet.bookmaker, bet.rule7) == (parlay.bookmaker, parlay.rule7)
        ]
        assert legs.bets == sum(size * count for size, count in parlay.legs.items())
    for bet in result.bets:
        assert bet.bets > 0
        if bet.kind == "parlay":
            assert set(bet.legs) <= {2, 3} and sum(bet.legs.values()) == bet.bets
            assert bet.avg_odds is not None and 1.28 <= bet.avg_odds <= 4.10
        else:
            assert bet.avg_odds is not None and 1.13 <= bet.avg_odds <= 1.80
    singles = {(bet.bookmaker, bet.rule7): bet.bets for bet in result.bets if bet.kind == "single"}
    for bookmaker in config.bet_bookmakers:
        assert singles[(bookmaker, True)] >= singles[(bookmaker, False)]
    assert result.slices and all(item.n >= config.min_slice for item in result.slices)
    assert {item.kind for item in result.slices} == {"surface", "level"}
    assert sum(item.n for item in result.calibration) == result.calibrated.n


def test_evaluation_is_deterministic(world: World, result: BacktestResult) -> None:
    again = evaluate(world.matches, world.odds, BacktestConfig(bootstrap=300))
    first, second = result.metrics(), again.metrics()
    first.pop("created_at")
    second.pop("created_at")
    assert first == second
    # Все числа годятся для JSONB: без NaN и бесконечностей
    json.dumps(first, allow_nan=False)


def test_report_markdown(result: BacktestResult) -> None:
    text = render_markdown(result)
    assert no_forbidden_letters(text)
    for key in (
        "backtest.report.title",
        "backtest.report.data_title",
        "backtest.report.accuracy_title",
        "backtest.report.calibration_title",
        "backtest.report.slices_title",
        "backtest.report.roi_title",
        "backtest.report.decoy_title",
        "backtest.report.assumptions_title",
        "backtest.report.license_sackmann",
        "backtest.report.license_tennis_data",
        "backtest.assumptions.odds_moment",
        "backtest.assumptions.retired",
        "backtest.assumptions.carpet",
        "backtest.report.roi_upper_bound",
    ):
        assert t(key) in text, key
    # ROI на «максимуме по рынку» помечен как верхняя граница
    assert {bet.bookmaker for bet in result.bets if bet.upper_bound} == {"max"}
    max_name = t("backtest.report.upper_bound_name", name=t("backtest.bookmakers.max"))
    assert f"| {max_name} |" in text
    only_avg = replace(result, bets=[bet for bet in result.bets if not bet.upper_bound])
    assert t("backtest.report.roi_upper_bound") not in render_markdown(only_avg)
    lines = summary_lines(result)
    assert lines[0].startswith(t("backtest.verdict.worse").split(" на ")[0])
    assert any(line.startswith(t("backtest.verdict.decoy_passed").split(":")[0]) for line in lines)
    for line in lines:
        assert line in text
        assert "{" not in line
    # Числа — с запятой, как принято по-русски
    gap = result.calibrated_gap
    assert gap is not None
    assert f"{gap.log_loss.value:.3f}".replace(".", ",") in lines[0]


def test_verdict_follows_numbers(result: BacktestResult) -> None:
    """Вывод формулирует код: знак и интервал разницы с рынком, ROI и приманка."""
    gap, calibrated = result.calibrated_gap, result.calibrated
    assert gap is not None and calibrated is not None

    def lines_with(**changes: object) -> list[str]:
        return summary_lines(replace(result, **changes))  # type: ignore[arg-type]

    better = replace(gap, log_loss=Estimate(-0.012, -0.014, -0.010, 500))
    first = lines_with(calibrated_gap=better)[0]
    assert first == t(
        "backtest.verdict.better",
        diff="0,012",
        signed="−0,012",
        low="−0,014",
        high="−0,010",
        n=500,
    )
    tie = replace(gap, log_loss=Estimate(0.002, -0.003, 0.007, 500))
    assert lines_with(calibrated_gap=tie)[0].startswith(t("backtest.verdict.tie").split(":")[0])
    weak = replace(calibrated, log_loss=Estimate(0.69, 0.68, 0.70, 500))
    assert lines_with(calibrated=weak)[1] == t(
        "backtest.verdict.coin_not_better", model="0,690", coin="0,693"
    )
    failed = DecoyResult(log_loss=0.65, threshold=0.688, passed=False, n=500)
    assert lines_with(decoy=failed)[-1] == t(
        "backtest.verdict.decoy_failed", value="0,650", threshold="0,688"
    )

    main = next(bet for bet in result.bets if bet.kind == "parlay" and bet.bookmaker == "avg")

    def with_roi(roi: RoiEstimate) -> list[str]:
        bets = [replace(bet, roi=roi) if bet is main else bet for bet in result.bets]
        return lines_with(bets=bets)

    assert (
        t("backtest.verdict.roi_profit")
        in with_roi(RoiEstimate(400, 400.0, 440.0, 40.0, 0.1, 0.02, 0.18))[2]
    )
    assert (
        t("backtest.verdict.roi_loss")
        in with_roi(RoiEstimate(400, 400.0, 360.0, -40.0, -0.1, -0.18, -0.02))[2]
    )
    assert (
        t("backtest.verdict.roi_few", min=30)
        in with_roi(RoiEstimate(5, 5.0, 9.0, 4.0, 0.8, 0.1, 1.5))[2]
    )
    assert with_roi(RoiEstimate(0, 0.0, 0.0, 0.0, None, None, None))[2] == t(
        "backtest.verdict.roi_none", bookmaker=t("backtest.bookmakers.avg")
    )
    # Без среднего вывод — по другому букмекеру, но не по максимуму рынка
    no_avg = [bet for bet in result.bets if bet.bookmaker != "avg"]
    assert t("backtest.bookmakers.pinnacle") in lines_with(bets=no_avg)[2]
    only_max = [bet for bet in result.bets if bet.bookmaker == "max"]
    assert len(lines_with(bets=only_max)) == 3  # рынок, монетка, приманка — без ROI


def test_parlay_is_compared_with_singles_on_its_legs(result: BacktestResult) -> None:
    """Р21: одиночные ставки — на тех же исходах, что вошли в экспрессы, и вывод
    показывает, сколько съедает экспресс."""
    parlay, legs = (
        next(
            bet
            for bet in result.bets
            if bet.kind == kind and bet.bookmaker == "avg" and not bet.rule7
        )
        for kind in ("parlay", "legs")
    )
    assert parlay.roi.roi is not None and legs.roi.roi is not None
    diff = (parlay.roi.roi - legs.roi.roi) * 100
    line = summary_lines(result)[2]
    assert (
        t(
            "backtest.verdict.roi_legs",
            bets=legs.bets,
            roi=pct(legs.roi.roi),
            diff=num(abs(diff), 1),
            direction=t(
                "backtest.verdict.roi_legs_worse"
                if diff < 0
                else "backtest.verdict.roi_legs_better"
            ),
        )
        in line
    )
    report = render_markdown(result)
    assert t("backtest.report.kind_legs") in report and t("backtest.report.kind_single") in report


def test_without_market_and_tuning_years() -> None:
    """Короткая история без кэфов: вес покрытия по умолчанию, сравнения с рынком нет."""
    world = make_world(players=40, years=range(2022, 2026), tournaments_per_year=10, odds_from=2030)
    result = evaluate(world.matches, world.odds, BacktestConfig(bootstrap=100))
    assert result.market is None and result.calibrated is None and result.calibrated_gap is None
    assert result.data.test_with_market == 0 and result.data.market_share == 0.0
    assert result.surface_weight == 0.5 and result.tuning == {}
    assert result.n_events == result.model_all.n
    texts = " ".join(result.warnings)
    assert t("backtest.warnings.no_tune", years="2019, 2020, 2021", weight=0.5) in texts
    assert t("backtest.warnings.no_market", bookmaker="pinnacle", years="2024, 2025") in texts
    assert all(bet.bets == 0 and bet.roi.roi is None for bet in result.bets)
    lines = summary_lines(result)
    assert lines[0] == t("backtest.verdict.no_market", bookmaker=t("backtest.bookmakers.pinnacle"))
    text = render_markdown(result)
    assert no_forbidden_letters(text) and t("backtest.report.warnings_title") in text
    json.dumps(result.metrics(), allow_nan=False)


def test_no_calibration_when_few_events() -> None:
    world = make_world(players=16, years=range(2024, 2026), tournaments_per_year=2, draw=8)
    result = evaluate(world.matches, world.odds, BacktestConfig(bootstrap=50, min_slice=1))
    assert (result.platt.a, result.platt.b) == (0.0, 1.0)
    assert any(
        t("backtest.warnings.no_calibration", years="2022, 2023", n=0, min=50) == w
        for w in result.warnings
    )


def test_config_and_errors() -> None:
    config = BacktestConfig.for_test_years([2023, 2022])
    assert config.test_years == (2022, 2023)
    assert config.calib_years == (2020, 2021)
    assert config.tune_years == (2017, 2018, 2019)
    assert config.eval_set == "atp-tour-2022-2023"
    with pytest.raises(BacktestError):
        BacktestConfig(calib_years=(2023, 2024)).validate()
    with pytest.raises(BacktestError):
        evaluate([], {}, BacktestConfig())
    assert parse_years("2024,2025") == (2024, 2025)
    assert parse_years("2023-2025") == (2023, 2024, 2025)
    assert parse_years(" 2025 , 2024 ") == (2024, 2025)
    for bad in ("", "abc", "2025-2023", "1900", "2024,x"):
        with pytest.raises(ValueError):
            parse_years(bad)


def test_retired_counts_for_bets_only() -> None:
    """Матч с отказом идет в ROI (результат как есть), но не в метрики точности."""
    world = make_world(
        players=40, years=range(2018, 2026), tournaments_per_year=10, seed=5, retired_share=0.0
    )
    matches = [
        replace(match, status="retired")
        if match.day.year >= 2024 and match.match_id % 3 == 0
        else match
        for match in world.matches
    ]
    config = BacktestConfig(bootstrap=50)
    result = evaluate(matches, world.odds, config)
    in_test = [
        match
        for match in matches
        if match.day.year in config.test_years and match.level in config.levels
    ]
    finished = sum(match.status == "finished" for match in in_test)
    assert 0 < finished < len(in_test)
    assert result.data.test.events == finished
    assert result.calibrated is not None and result.calibrated.n == finished
    assert result.data.bet_events == len(in_test)


# --- БД и команда терминала ---


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> async_sessionmaker[AsyncSession]:
    """Фабрика сеансов для бэктеста (db — ради чистой базы перед тестом)."""
    return create_sessionmaker(engine)


async def test_run_backtest_saves_model_and_eval_run(
    db: AsyncSession, factory: async_sessionmaker[AsyncSession]
) -> None:
    world = small_world()
    await store_world(db, world)
    db.add(IngestionRun(source="sackmann", status="ok", finished_at=func.now()))
    await db.commit()
    result = await run_backtest(BacktestConfig(bootstrap=200), db_factory=factory)
    assert result.eval_run_id is not None
    assert result.calibrated is not None and result.market is not None
    assert result.data.matches == 540
    assert result.freshness is not None
    sources = {item.source: item for item in result.freshness.sources}
    assert sources["sackmann"].last_ok_run is not None
    assert sources["sackmann"].last_day == result.freshness.last_day
    # Даты матчей Сакманна пришли из tennis-data: свежесть tennis-data — по ним, хотя
    # source у матчей sackmann
    assert sources["tennis_data"].last_ok_run is None
    assert sources["tennis_data"].last_day == max(
        match.match_date for match in world.matches if match.match_date is not None
    )

    run = await db.get(EvalRun, result.eval_run_id)
    assert run is not None
    assert (run.version_kind, run.ml_model_id, run.split) == ("ml_model", MODEL_ID, "test")
    assert run.eval_set == "atp-tour-2024-2025"
    assert run.n_events == result.calibrated.n
    assert run.cost_usd == 0
    assert run.metrics["calibrated"]["log_loss"]["value"] == pytest.approx(
        result.calibrated.log_loss.value
    )
    assert run.metrics["decoy"]["passed"] is True
    assert run.metrics["config"]["eval_set"] == "atp-tour-2024-2025"

    model = await db.get(MlModel, MODEL_ID)
    assert model is not None
    assert model.params["surface_weight"] == result.surface_weight
    assert model.params["platt"] == {"a": result.platt.a, "b": result.platt.b}
    assert model.metrics["n_events"] == result.calibrated.n
    assert model.train_from == result.data.first_day

    # Без сохранения база не меняется
    await run_backtest(BacktestConfig(bootstrap=50), save=False, db_factory=factory)
    assert await db.scalar(select(func.count()).select_from(EvalRun)) == 1


async def run_main(*argv: str) -> int:
    return await asyncio.to_thread(backtest.main, list(argv))


async def test_main_prints_report_without_saving(
    db: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    await store_world(db, small_world())
    assert await run_main("--report", "-", "--no-save") == 0
    captured = capsys.readouterr()
    out = captured.out
    assert out.startswith("# " + t("backtest.report.title"))
    assert t("backtest.report.license_sackmann") in out
    assert no_forbidden_letters(out)
    # Короткий вывод — в stderr: stdout целиком отчет
    assert captured.err.strip() and "# " not in captured.err
    assert await db.scalar(select(func.count()).select_from(EvalRun)) == 0


async def test_main_writes_report_file(
    db: AsyncSession, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    await store_world(db, small_world())
    path = tmp_path / "reports" / "backtest.md"
    assert await run_main("--report", str(path), "--test-years", "2024-2025") == 0
    out = capsys.readouterr().out
    assert t("backtest.cli.saved", path=path) in out
    run_id = await db.scalar(select(EvalRun.id))
    assert run_id is not None and t("backtest.cli.eval_run", id=run_id) in out
    text = path.read_text(encoding="utf-8")
    assert text.startswith("# " + t("backtest.report.title")) and no_forbidden_letters(text)
    # Без --report — только короткий вывод
    assert await run_main("--no-save") == 0
    out = capsys.readouterr().out
    assert "# " not in out and t("backtest.report.title") not in out


async def test_main_errors(db: AsyncSession, capsys: pytest.CaptureFixture[str]) -> None:
    assert await run_main("--no-save") == 1
    assert t("backtest.errors.no_test_events", years="2024, 2025") in capsys.readouterr().err
    with pytest.raises(SystemExit) as exit_info:
        await run_main("--test-years", "2025-2020")
    assert exit_info.value.code == 2
