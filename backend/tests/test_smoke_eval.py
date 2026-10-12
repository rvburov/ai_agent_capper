"""Команда smoke-eval (приемка этапа 3) на поддельном Claude с эндпойнтами Batch: события и
досье на день матча без новостей, стороны, оценка и бюджет проверок, пакет и его опрос,
--no-wait и --resume, учет со скидкой Batch, прогнозы is_eval, метрики и коды возврата.
Неоцененные события, дата среза знаний, пробный прогон, потерянный пакет и --abandon,
резерв бюджета проверок по сроку и месяцу."""

import asyncio
import json
import math
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from anthropic.types import Message
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import cli
from app.agent.runs import cost_usd, price_for, usage_from
from app.db.models import (
    AgentRun,
    AppSettings,
    Dossier,
    EvalRun,
    Match,
    PlayerNews,
    Prediction,
    StrategyVersion,
)
from app.ml.backtest import side_flip
from app.ml.metrics import log_losses
from app.services import check_runs, smoke_eval
from app.services.strategy_versions import ensure_active
from tests.analysis_helpers import install, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude, message
from tests.support import UserFactory

EVENTS = 6


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeClaude]:
    monkeypatch.setattr(smoke_eval, "POLL_SECONDS", 0.0)
    # Матчи мира тестов — до даты среза знаний Opus 5.5: в этих тестах срез раньше их
    monkeypatch.setattr(smoke_eval, "SAFE_SINCE", {})
    monkeypatch.setattr(smoke_eval, "DEFAULT_SAFE_SINCE", date(2000, 1, 1))
    yield from install(FakeClaude())


def _since() -> str:
    return (datetime.now(UTC).date() - timedelta(days=400)).isoformat()


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine, make_user: UserFactory) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await make_user(role="admin")
    return {**found, "admin": admin.id}


def _args(*extra: str) -> list[str]:
    return ["smoke-eval", "--events", str(EVENTS), "--since", _since(), *extra]


# --- расчеты без сети ---


def _row(outcome: str, y: int, p_claude: float, p_base: float) -> dict[str, Any]:
    return {
        "outcome": outcome,
        "y": y,
        "p_claude": p_claude,
        "p_final": p_claude,
        "p_base": {"p1_win": p_base, "p1_cover": 0.3, "p2_cover": 0.1},
    }


def test_summary_on_known_numbers() -> None:
    rows = [
        _row("ok", 1, 0.8, 0.7),
        _row("ok", 0, 0.4, 0.3),
        _row("checks", 1, 0.6, 0.6),
        _row("format", 1, 0.0, 0.5),
        _row("refusal", 0, 0.0, 0.5),
    ]
    summary = smoke_eval.summarize(rows, Decimal("0.123"))
    claude = (-math.log(0.8) - math.log(0.6) - math.log(0.6)) / 3
    base = (-math.log(0.7) - math.log(0.7) - math.log(0.6)) / 3
    assert summary.n == 3
    assert summary.log_loss_claude == pytest.approx(claude)
    assert summary.log_loss_base == pytest.approx(base)
    assert summary.diff is not None and summary.diff.value == pytest.approx(claude - base)
    assert summary.diff.low <= summary.diff.value <= summary.diff.high
    assert summary.counts["format"] == 1 and summary.counts["refusal"] == 1
    # Ошибка формата — критерий не выполнен, даже если лог-лосс лучше
    assert not summary.passed
    good = smoke_eval.summarize(rows[:3], Decimal(0))
    # Claude хуже базовой модели на 0,0069: в пределах допуска 0,01
    assert good.diff is not None and 0 < good.diff.value <= smoke_eval.LOG_LOSS_MARGIN
    assert good.passed
    worse = smoke_eval.summarize([_row("ok", 1, 0.5, 0.7), _row("ok", 0, 0.5, 0.3)], Decimal(0))
    assert worse.diff is not None and worse.diff.value > smoke_eval.LOG_LOSS_MARGIN
    assert not worse.passed
    empty = smoke_eval.summarize([_row("errored", 1, 0.0, 0.5)], Decimal(0))
    assert empty.n == 0 and empty.diff is None and not empty.passed
    assert smoke_eval.SmokeSummary.from_json(summary.to_json()) == summary
    # Не оцененное событие (отказ, ошибка пакета, истек, отменен) — критерий не выполнен,
    # даже если лог-лосс оцененных в пределах допуска: выбросить его — смещение выборки
    for outcome in ("refusal", "errored", "expired", "canceled"):
        partial = smoke_eval.summarize([*rows[:3], _row(outcome, 0, 0.0, 0.5)], Decimal(0))
        assert partial.n == 3 and partial.total == 4 and partial.unrated == 1
        assert partial.diff is not None and partial.diff.value <= smoke_eval.LOG_LOSS_MARGIN
        assert not partial.passed
    # Итог, сохраненный до поля total, читается: total — сумма счетчиков
    old = {key: value for key, value in good.to_json().items() if key != "total"}
    assert smoke_eval.SmokeSummary.from_json(old).total == 3


def _answer(**fields: Any) -> dict[str, Any]:
    answer = {
        "p1_win": 0.72,
        "p1_cover": 0.4,
        "p2_cover": 0.1,
        "confidence": "medium",
        "factors": [{"player": 1, "effect": "plus", "text": "Эло выше", "ref": "elo"}],
        "flags": {"p1": [], "p2": []},
        "explanation": "Близко к базовой модели.",
        "divergence_note": "",
    }
    answer.update(fields)
    return answer


def _message(text: str | None, stop: str = "end_turn") -> Message:
    content = [{"type": "text", "text": text}] if text is not None else []
    return Message.model_validate(message(content, model="claude-opus-5-5", stop_reason=stop))


def test_judge_like_analysis() -> None:
    event = {"p_base": {"p1_win": 0.7, "p1_cover": 0.4, "p2_cover": 0.1}, "refs": ["elo", "form"]}
    ok = smoke_eval.judge(_message(json.dumps(_answer())), event, 0.08)
    assert ok.outcome == "ok" and ok.assessment is not None
    checks = smoke_eval.judge(_message(json.dumps(_answer(p1_win=0.9))), event, 0.08)
    assert checks.outcome == "checks" and checks.assessment is not None
    assert (
        smoke_eval.judge(_message(json.dumps(_answer(p1_win=1.5))), event, 0.08).outcome == "format"
    )
    assert smoke_eval.judge(_message('{"p1_win": 0.7'), event, 0.08).outcome == "format"
    assert smoke_eval.judge(_message("{}", "max_tokens"), event, 0.08).outcome == "max_tokens"
    refused = smoke_eval.judge(_message(None, "refusal"), event, 0.08)
    assert refused.outcome == "refusal"


# --- команда ---


async def test_smoke_eval_full_run(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fake.batch_polls = 2
    report = tmp_path / "smoke.md"
    code = await asyncio.to_thread(cli.main, [*_args("--yes", "--report", str(report))])
    printed = capsys.readouterr()
    run = await db.scalar(select(EvalRun))
    assert run is not None and run.metrics["status"] == "ended"
    assert run.version_kind == "strategy" and run.split == "test"
    assert "пробный прогон" in printed.out
    assert run.eval_set == f"smoke:d1-nonews:{_since()}:{EVENTS}" and run.n_events == EVENTS
    version = await db.get_one(StrategyVersion, run.strategy_version_id)
    assert version.user_id == world["admin"]
    batch_id = run.metrics["batch_id"]
    assert batch_id == "msgbatch_fake1" and "в работе" in printed.out
    # Каждый запрос пакета — как вызов анализа: модель, effort, схема, без потока и поиска
    calls = fake.calls("analysis")
    assert len(calls) == EVENTS
    assert all(body["model"] == "claude-opus-5-5" for body in calls)
    assert all(body["output_config"]["effort"] == "medium" for body in calls)
    assert all("tools" not in body for body in calls)
    assert all(
        body["system"][0]["cache_control"] == {"type": "ephemeral", "ttl": "1h"} for body in calls
    )
    # Учет: kind eval, batch, request_id «пакет/запрос», стоимость — половина обычной
    runs = list(await db.scalars(select(AgentRun).order_by(AgentRun.id)))
    assert len(runs) == EVENTS
    assert all(r.kind == "eval" and r.batch and r.eval_run_id == run.id for r in runs)
    assert all(
        r.request_id is not None and r.request_id.startswith(f"{batch_id}/ev{run.id}-m")
        for r in runs
    )
    price = await price_for(db, "claude-opus-5-5")
    usage = usage_from(
        Message.model_validate(
            message([], model="claude-opus-5-5", input_tokens=2500, output_tokens=900)
        )
    )
    assert runs[-1].cost_usd > 0
    full = cost_usd(price, replace(usage, cache_read_tokens=runs[-1].cache_read_tokens))
    half = cost_usd(price, replace(usage, cache_read_tokens=runs[-1].cache_read_tokens, batch=True))
    assert runs[-1].cost_usd == half and half < full
    assert run.cost_usd == sum((r.cost_usd for r in runs), Decimal(0))
    # Прогнозы: 6 исходов на событие, в порядке игроков матча
    predictions = list(await db.scalars(select(Prediction)))
    assert len(predictions) == 6 * EVENTS
    assert all(p.is_eval and p.eval_run_id == run.id and p.user_id is None for p in predictions)
    for event in run.metrics["events"]:
        ml = {
            p.selection: p
            for p in predictions
            if p.match_id == event["match_id"] and p.market == "ML"
        }
        assert event["flip"] == side_flip(event["match_id"])
        p1 = event["p_base"]["p1_win"]
        assert ml[2 if event["flip"] else 1].p_base == pytest.approx(p1)
        assert ml[2 if event["flip"] else 1].p_claude == pytest.approx(event["p_claude"])
        match = await db.get_one(Match, event["match_id"])
        first = match.player2_id if event["flip"] else match.player1_id
        assert event["y"] == (1 if match.winner_id == first else 0)
        assert event["outcome"] == "ok"
    rows = run.metrics["events"]
    claude = float(log_losses([r["p_claude"] for r in rows], [r["y"] for r in rows]).mean())
    assert run.metrics["summary"]["log_loss_claude"] == pytest.approx(claude)
    text = report.read_text(encoding="utf-8")
    assert "# Приемка этапа 3: smoke-eval" in text and batch_id in text
    passed = run.metrics["summary"]["passed"]
    # 6 событий из 40: критерии выполнены — пробный прогон (код 3), а не приемка
    assert code == (3 if passed else 1)
    assert ("**Пробный прогон" in text) == passed and "**Smoke-eval пройден.**" not in text


async def test_dossier_on_match_day_without_news(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude
) -> None:
    """Досье — на день матча (результат самого матча и позже не видны) и без новостей,
    даже если новости о игроке получены до матча."""
    matches = await smoke_eval.pick_matches(
        db, since=date.fromisoformat(_since()), count=EVENTS, today=datetime.now(UTC).date()
    )
    first = matches[0]
    db.add(
        PlayerNews(
            player_id=first.match.player1_id,
            published_at=datetime.combine(first.day - timedelta(days=3), time(0), UTC),
            kind="injury",
            summary="Травма спины",
            source_url="https://www.atptour.com/en/news/x",
            fetched_at=datetime.combine(first.day - timedelta(days=2), time(0), UTC),
        )
    )
    await db.commit()
    events = await smoke_eval.prepare_events(db, matches)
    await db.commit()
    for item, event in zip(matches, events, strict=True):
        dossier = await db.get_one(Dossier, event.dossier_id)
        assert dossier.content["as_of"] == item.day.isoformat()
        assert dossier.content["p1"]["news"] == [] and dossier.content["p2"]["news"] == []
        days = [row["d"] for side in ("p1", "p2") for row in dossier.content[side]["form"]["m"]]
        assert all(day < item.day.isoformat() for day in days)
        expected_p1 = item.match.player2_id if event.flip else item.match.player1_id
        assert dossier.content["p1"]["id"] == expected_p1
    assert [m.day for m in matches] == sorted(m.day for m in matches)


async def test_smoke_eval_confirm_and_budget(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answers = iter(["нет"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    # Отказ — свой код 2
    assert await asyncio.to_thread(cli.main, _args()) == 2
    out = capsys.readouterr().out
    assert "в худшем случае до $" in out and "Batch" in out
    assert fake.batches == {} and await db.scalar(select(func.count()).select_from(EvalRun)) == 0

    await db.execute(update(AppSettings).values(eval_budget_usd=Decimal("0.05")))
    await db.commit()
    assert await asyncio.to_thread(cli.main, _args("--yes")) == 1
    assert "больше остатка бюджета проверок" in capsys.readouterr().err
    assert fake.batches == {}


async def test_unclaimed_batch_reserves_eval_budget(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    """Незабранный пакет держит свой худший случай: второй пакет на те же деньги не идет."""
    fake.batch_polls = 100
    assert await asyncio.to_thread(cli.main, _args("--yes", "--no-wait")) == 0
    out = capsys.readouterr().out
    run = await db.scalar(select(EvalRun))
    assert run is not None and run.metrics["status"] == "submitted"
    assert f"--resume {run.id}" in out
    worst = Decimal(run.metrics["worst_usd"])
    await db.execute(update(AppSettings).values(eval_budget_usd=worst + worst / 2))
    await db.commit()
    assert await asyncio.to_thread(cli.main, _args("--yes", "--no-wait")) == 1
    assert "в незабранных пакетах" in capsys.readouterr().err
    assert len(fake.batches) == 1


async def test_resume_collects_once(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    fake.batch_polls = 3
    assert await asyncio.to_thread(cli.main, _args("--yes", "--no-wait")) == 0
    run = await db.scalar(select(EvalRun))
    assert run is not None
    capsys.readouterr()
    # Пакет еще в работе: --resume --no-wait только показывает состояние
    assert (
        await asyncio.to_thread(cli.main, ["smoke-eval", "--resume", str(run.id), "--no-wait"]) == 0
    )
    assert "в работе" in capsys.readouterr().out
    assert await db.scalar(select(func.count()).select_from(AgentRun)) == 0
    code = await asyncio.to_thread(cli.main, ["smoke-eval", "--resume", str(run.id)])
    first = capsys.readouterr().out
    assert "Итог smoke-eval" in first
    count = await db.scalar(select(func.count()).select_from(AgentRun))
    assert count == EVENTS
    # Повторный сбор ничего не пишет второй раз и дает тот же итог
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--resume", str(run.id)]) == code
    assert await db.scalar(select(func.count()).select_from(AgentRun)) == EVENTS
    assert await db.scalar(select(func.count()).select_from(Prediction)) == 6 * EVENTS
    assert len(fake.calls("analysis")) == EVENTS
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--resume", "999"]) == 1
    assert "smoke-eval с id 999 нет" in capsys.readouterr().err


async def test_smoke_eval_counts_failures(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    """max_tokens, отказ, ошибка запроса и истекший запрос считаются отдельно; max_tokens —
    критерий не выполнен (код 1). Ошибки пакета оплачиваются нулем."""
    fake.fail("analysis", "max_tokens")
    fake.fail("analysis", "refusal")
    fake.fail("analysis", "overloaded")
    fake.fail("batch", "expired")
    assert await asyncio.to_thread(cli.main, _args("--yes")) == 1
    printed = capsys.readouterr()
    assert "Smoke-eval не пройден" in printed.err
    run = await db.scalar(select(EvalRun))
    assert run is not None
    counts = run.metrics["summary"]["counts"]
    assert counts["max_tokens"] == 1 and counts["refusal"] == 1
    assert counts["errored"] == 1 and counts["expired"] == 1 and counts["ok"] == EVENTS - 4
    runs = list(await db.scalars(select(AgentRun)))
    errors = {r.error for r in runs if r.error}
    assert {"max_tokens", "refusal:cyber", "batch:overloaded_error", "batch:expired"} <= errors
    assert all(r.cost_usd == 0 for r in runs if r.error and r.error.startswith("batch:"))
    assert await db.scalar(select(func.count()).select_from(Prediction)) == 6 * (EVENTS - 4)


async def test_smoke_eval_batch_rejected(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    fake.fail("batch_create", "bad_request")
    assert await asyncio.to_thread(cli.main, _args("--yes")) == 1
    assert "Запрос к Claude не выполнен" in capsys.readouterr().err
    run = await db.scalar(select(EvalRun))
    assert run is not None and run.metrics["status"] == "failed"
    # Неотправленный пакет не держит бюджет
    assert await asyncio.to_thread(cli.main, _args("--yes")) in (1, 3)
    assert len(fake.batches) == 1


async def test_smoke_eval_needs_events(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    future = (datetime.now(UTC).date() + timedelta(days=1)).isoformat()
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--since", future, "--yes"]) == 1
    err = capsys.readouterr().err
    assert "по вчера: 0, нужно: 40" in err and "раньше" not in err
    with pytest.raises(SystemExit):
        cli.main(["smoke-eval", "--since", "2026-13-01"])
    assert "неверная дата" in capsys.readouterr().err


async def test_smoke_eval_passes_only_when_all_events_rated(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Приемка (размер выборки как в PLAN, здесь подменен на 6): все события оценены — код
    0; 5 ошибок пакета из 6 — код 1, хотя лог-лосс единственного оцененного в норме."""
    monkeypatch.setattr(smoke_eval, "ACCEPTANCE_EVENTS", EVENTS)
    fake.shift = 0.0
    assert await asyncio.to_thread(cli.main, _args("--yes")) == 0
    assert "Smoke-eval пройден" in capsys.readouterr().out
    fake.fail("analysis", "overloaded", times=EVENTS - 1)
    assert await asyncio.to_thread(cli.main, _args("--yes")) == 1
    printed = capsys.readouterr()
    assert "не оценено: 5" in printed.err
    assert "оценены все события (без отказов и ошибок пакета): 1 из 6" in printed.out
    run = await db.scalar(select(EvalRun).order_by(EvalRun.id.desc()).limit(1))
    assert run is not None and run.metrics["summary"]["passed"] is False


async def test_smoke_eval_since_before_cutoff(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Матчи раньше даты среза знаний модель могла видеть: без --before-cutoff отказ, с
    ним — проба (split = train, набор с «:seen», код 3 даже на размере приемки)."""
    monkeypatch.setattr(smoke_eval, "SAFE_SINCE", {"claude-opus-5-5": date(2026, 7, 1)})
    monkeypatch.setattr(smoke_eval, "ACCEPTANCE_EVENTS", EVENTS)
    fake.shift = 0.0
    assert await asyncio.to_thread(cli.main, _args("--yes")) == 1
    err = capsys.readouterr().err
    assert "раньше 2026-07-01" in err and "claude-opus-5-5" in err and "--before-cutoff" in err
    assert fake.batches == {}
    assert await asyncio.to_thread(cli.main, _args("--yes", "--before-cutoff")) == 3
    printed = capsys.readouterr()
    assert "проба (split = train)" in printed.out and "Пробный прогон" not in printed.err
    assert "Smoke-eval: критерии выполнены, но это пробный прогон" in printed.err
    run = await db.scalar(select(EvalRun))
    assert run is not None and run.split == "train" and run.eval_set.endswith(":seen")


async def test_lost_batch_is_marked_and_released(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пакета у Anthropic нет (404: другой workspace) — свой текст, а не «ключ отозван»;
    строка lost, худший случай — в бюджете до конца месяца отправки, потом нет."""
    fake.batch_polls = 100
    assert await asyncio.to_thread(cli.main, _args("--yes", "--no-wait", "--local-sh")) == 0
    out = capsys.readouterr().out
    assert "bash deploy/local.sh smoke-eval --resume" in out and "python -m" not in out
    run = await db.scalar(select(EvalRun))
    assert run is not None
    worst = Decimal(run.metrics["worst_usd"])
    fake.batches.clear()
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--resume", str(run.id)]) == 1
    err = capsys.readouterr().err
    assert "не найден у Anthropic" in err and "workspace" in err and "отозван" not in err
    await db.refresh(run)
    assert run.metrics["status"] == "lost" and run.metrics["error"] == "batch_not_found"
    assert (await check_runs.eval_budget(db)).reserved_usd == worst
    # Отправлен в прошлом месяце: в этом месяце резерва нет
    sent = datetime.now(UTC) - timedelta(days=40)
    run.metrics = {**run.metrics, "submitted_at": sent.isoformat()}
    await db.commit()
    assert (await check_runs.eval_budget(db)).reserved_usd == 0


async def test_expired_results_are_lost(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    """Пакет виден, но результатов нет (29 дней прошло) — lost с причиной results_expired."""
    fake.batch_polls = 1
    assert await asyncio.to_thread(cli.main, _args("--yes", "--no-wait")) == 0
    run = await db.scalar(select(EvalRun))
    assert run is not None and run.metrics["status"] == "submitted"
    fake.batches[run.metrics["batch_id"]]["expired"] = True
    capsys.readouterr()
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--resume", str(run.id)]) == 1
    assert "больше не хранятся" in capsys.readouterr().err
    await db.refresh(run)
    assert run.metrics["status"] == "lost" and run.metrics["error"] == "results_expired"
    assert await db.scalar(select(func.count()).select_from(AgentRun)) == 0


async def test_abandon_and_resume_later(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    """--abandon закрывает незабранный пакет; пока результаты хранятся, --resume их
    забирает. Законченную проверку закрыть нельзя."""
    fake.batch_polls = 1
    assert await asyncio.to_thread(cli.main, _args("--yes", "--no-wait")) == 0
    run = await db.scalar(select(EvalRun))
    assert run is not None
    capsys.readouterr()
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--abandon", str(run.id)]) == 0
    assert "закрыта без результатов" in capsys.readouterr().out
    await db.refresh(run)
    assert run.metrics["status"] == "abandoned"
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--resume", str(run.id)]) in (1, 3)
    await db.refresh(run)
    assert run.metrics["status"] == "ended"
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--abandon", str(run.id)]) == 1
    assert "закрыть нельзя: состояние ended" in capsys.readouterr().err
    assert await asyncio.to_thread(cli.main, ["smoke-eval", "--abandon", "999"]) == 1


async def test_eval_budget_reserve_windows(db: AsyncSession, world: dict[str, int]) -> None:
    """Резерв: submitted — 29 дней после отправки или до конца месяца отправки; lost и
    abandoned — до конца месяца отправки."""
    version = await ensure_active(db, world["admin"])
    now = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
    rows = [
        ("submitted", datetime(2026, 9, 20, tzinfo=UTC), "1.00"),  # 41 д. — нет
        ("submitted", datetime(2026, 10, 5, tzinfo=UTC), "2.00"),  # 26 д. — да
        ("submitted", datetime(2026, 10, 1, tzinfo=UTC), "4.00"),  # 30 д., этот месяц — да
        ("lost", datetime(2026, 9, 30, tzinfo=UTC), "8.00"),  # прошлый месяц — нет
        ("lost", datetime(2026, 10, 2, tzinfo=UTC), "16.00"),  # да
        ("abandoned", datetime(2026, 10, 3, tzinfo=UTC), "32.00"),  # да
        ("ended", datetime(2026, 10, 3, tzinfo=UTC), "64.00"),  # забран — нет
    ]
    for status, sent, worst in rows:
        db.add(
            EvalRun(
                version_kind="strategy",
                strategy_version_id=version.id,
                eval_set="smoke:test",
                split="test",
                n_events=1,
                metrics={
                    "kind": "smoke",
                    "status": status,
                    "worst_usd": worst,
                    "submitted_at": sent.isoformat(),
                },
            )
        )
    await db.commit()
    budget = await check_runs.eval_budget(db, now)
    assert budget.reserved_usd == Decimal("2.00") + Decimal("4.00") + Decimal("16.00") + Decimal(
        "32.00"
    )
    # Через 29 дней после отправки, уже в новом месяце, пакет 5 октября не в резерве
    later = await check_runs.eval_budget(db, datetime(2026, 11, 4, tzinfo=UTC))
    assert later.reserved_usd == 0
