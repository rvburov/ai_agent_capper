"""«ИИ и расходы» этапа 5 (волна 4): строка «Разбор ставки (Sonnet 5.5, Batch)», качество
версий инструкций (лог-лосс на наборе), «Где экономим», «До и после», бюджет проверок
$30 в месяц первого набора и $25 дальше; эталонные суммы по agent_runs.

Время — фиксированное (now сервиса), от текущей даты тесты не зависят."""

from datetime import UTC, date, datetime
from decimal import Decimal as D
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AgentRun, EvalComparison, EvalRun, EvalSet, StrategyVersion, User
from app.services import ai_access, ai_usage
from app.services.ai_usage import month_of
from tests.claude_mock import price_row
from tests.support import UserFactory

NOW = datetime(2026, 10, 14, 12, tzinfo=UTC)
SEPTEMBER = datetime(2026, 9, 15, 12, tzinfo=UTC)
PRICES_SINCE = datetime(2026, 1, 1, tzinfo=UTC)
CANDIDATE_PROMPT = "analysis.v1+lessons_block.v2:abcdef123456"


@pytest.fixture
async def prices(db: AsyncSession) -> None:
    for model in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"):
        db.add(price_row(model, PRICES_SINCE))
    await db.commit()


def _run(user_id: int | None, kind: str, cost: str, at: datetime, **fields: Any) -> AgentRun:
    return AgentRun(
        user_id=user_id,
        key_source="admin",
        kind=kind,
        model=fields.pop("model", "claude-opus-5-5"),
        cost_usd=D(cost),
        created_at=at,
        **fields,
    )


def _summary(log_loss: float, cost: str, tokens: float) -> dict[str, Any]:
    return {
        "n": 240,
        "total": 250,
        "log_loss": log_loss,
        "brier": 0.21,
        "ece": 0.03,
        "format_errors": 0,
        "max_tokens": 0,
        "refusals": 0,
        "vs_market": {"value": 0.004, "low": -0.01, "high": 0.02, "n": 240},
        "tokens_per_event": tokens,
        "cost_per_event_usd": cost,
    }


async def _versions(db: AsyncSession, admin: User) -> tuple[StrategyVersion, StrategyVersion]:
    """Действующая v3 и кандидат v4 «экономия» с прогонами на наборе и сравнением."""
    v3 = StrategyVersion(
        user_id=None,
        code="v3",
        name="v3",
        params={},
        prompt_version="analysis.v1",
        status="active",
        approved_at=datetime(2026, 9, 1, tzinfo=UTC),
    )
    db.add(v3)
    await db.flush()
    v4 = StrategyVersion(
        user_id=None,
        code="v4",
        name="v4",
        params={},
        prompt_version=CANDIDATE_PROMPT,
        status="candidate",
        goal="saving",
        parent_id=v3.id,
    )
    eval_set = EvalSet(
        code="eval-oct",
        frozen_at=datetime(2026, 10, 2, tzinfo=UTC),
        sha256="0" * 64,
        n_events=250,
        since=date(2026, 8, 1),
        rules={},
    )
    db.add_all([v4, eval_set])
    await db.flush()

    def run(version: StrategyVersion, summary: dict[str, Any]) -> EvalRun:
        return EvalRun(
            version_kind="strategy",
            strategy_version_id=version.id,
            eval_set=eval_set.code,
            eval_set_id=eval_set.id,
            split="test",
            n_events=250,
            repeat_no=1,
            status="done",
            metrics={"kind": "eval", "summary": summary, "worst_usd": "1.50"},
            created_at=datetime(2026, 10, 3, tzinfo=UTC),
        )

    base_run = run(v3, _summary(0.600, "0.012", 9000.0))
    cand_run = run(v4, _summary(0.602, "0.0084", 6210.0))
    db.add_all([base_run, cand_run])
    await db.flush()
    db.add(
        EvalComparison(
            candidate_run_id=cand_run.id,
            baseline_run_id=base_run.id,
            rule="non_inferior",
            passed=True,
            metrics={
                "rule": "non_inferior",
                "n": 240,
                "log_loss": {
                    "a": 0.600,
                    "b": 0.602,
                    "diff": 0.002,
                    "low": -0.004,
                    "high": 0.008,
                    "margin": 0.01,
                    "ok": True,
                },
                "brier": {
                    "a": 0.21,
                    "b": 0.21,
                    "diff": 0.0,
                    "low": -0.002,
                    "high": 0.002,
                    "margin": 0.005,
                    "ok": True,
                },
                "ece": {
                    "a": 0.03,
                    "b": 0.03,
                    "diff": 0.0,
                    "low": -0.01,
                    "high": 0.01,
                    "margin": 0.02,
                    "ok": True,
                },
                "cost_per_event": {"a": 0.012, "b": 0.0084, "change": -0.3, "ok": True},
                "tokens_per_event": {"a": 9000.0, "b": 6210.0, "change": -0.31, "ok": True},
                "agreement": {
                    "value": 0.97,
                    "mean_abs_dp": 0.01,
                    "noise_value": None,
                    "noise_abs_dp": None,
                    "ok": None,
                },
                "passed": True,
                "verdict": "not_worse",
            },
        )
    )
    # Проверки: прогон кандидата на ключе администратора
    db.add(
        _run(
            admin.id,
            "eval",
            "0.4000",
            datetime(2026, 10, 3, 1, tzinfo=UTC),
            eval_run_id=cand_run.id,
            batch=True,
        )
    )
    await db.commit()
    return v3, v4


async def _calls(db: AsyncSession, member: User) -> None:
    """Оценки матча участника (v3), два разбора ставок — общая задача через Batch."""
    db.add_all(
        [
            _run(
                member.id,
                "analysis",
                "0.1000",
                datetime(2026, 10, 5, tzinfo=UTC),
                prompt_version="analysis.v1",
            ),
            _run(
                member.id,
                "analysis",
                "0.2000",
                datetime(2026, 10, 6, tzinfo=UTC),
                prompt_version="analysis.v1",
            ),
            _run(
                None,
                "postmortem",
                "0.0100",
                datetime(2026, 10, 7, tzinfo=UTC),
                model="claude-sonnet-5-5",
                batch=True,
                prompt_version="postmortem.v1",
            ),
            _run(
                None,
                "postmortem",
                "0.0120",
                datetime(2026, 10, 8, tzinfo=UTC),
                model="claude-sonnet-5-5",
                batch=True,
                prompt_version="postmortem.v1",
            ),
            # Прошлый месяц — в октябре не считается
            _run(
                None,
                "postmortem",
                "0.5000",
                datetime(2026, 9, 30, 23, tzinfo=UTC),
                model="claude-sonnet-5-5",
                batch=True,
            ),
        ]
    )
    await db.commit()


async def test_member_usage_quality_savings_before_after(
    db: AsyncSession, make_user: UserFactory, prices: None
) -> None:
    admin = (await make_user(role="admin")).user
    member = (await make_user()).user
    await _versions(db, admin)
    await _calls(db, member)

    out = await ai_usage.usage(db, member, now=NOW)
    # Свой расход: только свои оценки матча, разборов (общая задача) и проверок нет
    assert out.totals.cost_usd == D("0.3000") and out.totals.runs == 2
    assert [kind.kind for kind in out.kinds] == ["analysis"]
    assert out.settings.postmortem_model == "claude-sonnet-5-5" and out.settings.postmortem_batch
    # Качество версии — лог-лосс прогона v3 на наборе
    [row] = out.versions
    assert (row.prompt_version, row.version_code) == ("analysis.v1", "v3")
    assert row.quality is not None and row.quality.log_loss == 0.600
    assert (row.quality.eval_set_code, row.quality.n, row.quality.status) == (
        "eval-oct",
        240,
        "active",
    )
    assert row.avg_cost_usd == D("0.150000")

    savings = {item.kind: item for item in out.savings}
    version = savings["version"]
    assert (version.version_code, version.status, version.passed) == ("v4", "waiting", True)
    assert (version.cost_change, version.tokens_change) == (-0.3, -0.31)
    assert version.log_loss is not None and version.log_loss.high == 0.008
    # Темп своих оценок матча за месяц × 30%: 0,30 / 14 дней × 31 × 0,3
    expected = (D("0.3000") / 14 * 31 * D("0.3")).quantize(D("0.000001"))
    assert version.month_forecast_usd == expected
    batch = savings["postmortem_batch"]
    assert batch.status == "on" and batch.model == "claude-sonnet-5-5"
    assert (batch.per_run_usd, batch.per_run_without_usd) == (D("0.011000"), D("0.022000"))
    # Сколько сэкономил ключ администратора, участнику не показываем
    assert batch.month_usd is None
    assert savings["cache"].month_usd == out.cache_saved_usd

    pair = out.before_after
    assert pair is not None
    assert (pair.before.code, pair.after.code) == ("v3", "v4")
    assert (pair.before.eval.log_loss, pair.after.eval.log_loss) == (0.600, 0.602)
    assert (pair.before.live_runs, pair.before.live_avg_usd) == (2, D("0.150000"))
    assert (pair.after.live_runs, pair.after.live_avg_usd) == (0, None)
    assert pair.comparison is not None and pair.comparison.cost_per_event.change == -0.3
    assert pair.comparison.passed and pair.comparison.candidate_code == "v4"


async def test_admin_usage_postmortem_row_and_eval_budget(
    db: AsyncSession, make_user: UserFactory, prices: None
) -> None:
    admin = (await make_user(role="admin")).user
    member = (await make_user()).user
    await _versions(db, admin)
    await _calls(db, member)

    mine = await ai_usage.usage(db, admin, now=NOW)
    # У администратора общие задачи — в его расходе: строка разбора ставки через Batch
    kinds = {kind.kind: kind for kind in mine.kinds}
    assert kinds["postmortem"].runs == 2 and kinds["postmortem"].batch_runs == 2
    assert kinds["postmortem"].cost_usd == D("0.0220")
    assert kinds["postmortem"].models == ["claude-sonnet-5-5"]
    batch = next(item for item in mine.savings if item.kind == "postmortem_batch")
    assert batch.month_usd == D("0.0220")

    out = await ai_usage.admin_usage(db, admin, now=NOW)
    # Эталон: ключ администратора без проверок = 0,10 + 0,20 + 0,010 + 0,012
    assert out.spent_usd == D("0.3220")
    assert out.shared.cost_usd == D("0.0220") and out.shared.kinds == ["postmortem"]
    [task] = out.shared.tasks
    assert (task.kind, task.runs, task.batch_runs, task.cost_usd) == (
        "postmortem",
        2,
        2,
        D("0.0220"),
    )
    assert task.models == ["claude-sonnet-5-5"]
    [analysis] = out.tasks
    assert (analysis.kind, analysis.runs, analysis.batch_runs) == ("analysis", 2, 0)
    # Бюджет проверок: месяц первого набора — $30, со следующего — $25
    assert (out.eval.budget_usd, out.eval.first_month, out.eval.next_usd) == (
        D("30"),
        True,
        D("25"),
    )
    assert out.eval.batch_size == 100 and out.eval.spent_usd == D("0.4000")
    [item] = out.eval.items
    assert (item.kind, item.status, item.version_code, item.worst_usd) == (
        "eval",
        "done",
        "v4",
        D("1.50"),
    )
    overview = await ai_access.budget_overview(db, NOW)
    assert overview.eval_budget_usd == D("30")

    september = await ai_usage.admin_usage(db, admin, "2026-09", now=NOW)
    assert (september.eval.budget_usd, september.eval.first_month) == (D("25"), False)
    assert september.shared.cost_usd == D("0.5000")
    assert month_of("2026-09", NOW).key == "2026-09"
    assert (await ai_access.budget_overview(db, SEPTEMBER)).eval_budget_usd == D("25")


async def test_savings_without_versions_or_postmortems(
    db: AsyncSession, make_user: UserFactory, prices: None
) -> None:
    """Пустая программа: ни версий с прогоном, ни разборов — «До и после» нет, цена
    разбора — оценка по настройкам (половина обычной цены)."""
    member = (await make_user()).user
    out = await ai_usage.usage(db, member, now=NOW)
    assert out.before_after is None
    assert [item.kind for item in out.savings] == ["postmortem_batch", "cache"]
    batch = out.savings[0]
    assert batch.per_run_usd is not None and batch.per_run_usd > 0
    assert batch.per_run_without_usd == batch.per_run_usd * 2
