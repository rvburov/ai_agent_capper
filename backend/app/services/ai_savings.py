"""«ИИ и расходы» этапа 5 (волна 4): качество версий инструкций, «Где экономим» и «До и
после» (TOKEN_ECONOMY.md 2.4; макет costs.js, правка 18).

Качество оценки матча — прогон версии общей линии инструкций на замороженном наборе
(app/services/eval_runs.py), цена — факт по agent_runs за месяц. Сравнение версий только
читается из eval_comparisons (его считает завершение прогона и экран версий): экран
расходов бутстрэп не запускает. Версии инструкций общие (Р25) — их видит каждый; цены
вызовов — только свои (personal_runs), расход общих задач на ключе администратора —
только администратору (Р14).
"""

from collections.abc import Sequence
from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import batches
from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError
from app.agent.runs import USD_STEP, price_for
from app.db.models import AgentRun, StrategyVersion, User
from app.schemas.ai import (
    BeforeAfterOut,
    PriceSource,
    SavingOut,
    UsageVersionOut,
    VersionQualityOut,
    VersionSideOut,
)
from app.schemas.learning import ComparisonOut, VersionEvalOut
from app.services import eval_runs
from app.services.strategy_versions import ACTIVE, CANDIDATE, shared_active

ZERO = Decimal(0)
ANALYSIS = "analysis"
# Статус меры по статусу версии
_STATUS = {ACTIVE: "on", CANDIDATE: "waiting"}


async def _shared_versions(db: AsyncSession) -> list[StrategyVersion]:
    return list(
        await db.scalars(
            select(StrategyVersion)
            .where(StrategyVersion.user_id.is_(None))
            .order_by(StrategyVersion.created_at.desc(), StrategyVersion.id.desc())
        )
    )


def _quality(version: StrategyVersion, evaluated: VersionEvalOut) -> VersionQualityOut:
    return VersionQualityOut(
        version_id=version.id,
        version_code=version.code,
        status=version.status,  # type: ignore[arg-type]
        eval_set_code=evaluated.eval_set_code,
        n=evaluated.n,
        log_loss=evaluated.log_loss,
        brier=evaluated.brier,
        to_market=evaluated.to_market,
        format_errors=evaluated.format_errors,
    )


async def with_quality(
    db: AsyncSession, versions: Sequence[UsageVersionOut]
) -> list[UsageVersionOut]:
    """Строки «Версии инструкций: цена и качество»: у оценки матча — версия общей линии с
    этим prompt_version и ее качество на наборе. Один промпт бывает у нескольких версий
    (кандидата отклонили и создали заново): берется действующая, затем новая с прогоном на
    наборе, иначе просто новая."""
    by_prompt: dict[str, list[StrategyVersion]] = {}
    for version in await _shared_versions(db):
        if version.prompt_version:
            by_prompt.setdefault(version.prompt_version, []).append(version)
    out: list[UsageVersionOut] = []
    for row in versions:
        same = by_prompt.get(row.prompt_version or "", []) if row.kind == ANALYSIS else []
        # Действующая — первой, остальные новыми сверху (sorted устойчив)
        same = sorted(same, key=lambda version: version.status != ACTIVE)
        found = same[0] if same else None
        quality = None
        for version in same:
            evaluated = await eval_runs.version_eval(db, version)
            if evaluated is not None:
                found, quality = version, _quality(version, evaluated)
                break
        out.append(
            row.model_copy(
                update={
                    "version_code": found.code if found is not None else None,
                    "quality": quality,
                }
            )
        )
    return out


async def _postmortem_saving(
    db: AsyncSession, user: User, config: AgentConfig, start: datetime, end: datetime
) -> SavingOut:
    """Разбор ставки через Batch: живая средняя цена разбора месяца (нет — оценка по
    настройкам) и та же без скидки; сэкономлено за месяц — администратору."""
    runs, cost = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(AgentRun.cost_usd), 0)).where(
                AgentRun.kind == "postmortem",
                AgentRun.batch.is_(True),
                AgentRun.error.is_(None),
                AgentRun.created_at >= start,
                AgentRun.created_at < end,
            )
        )
    ).one()
    per_run: Decimal | None = None
    if runs:
        per_run = (Decimal(cost) / int(runs)).quantize(USD_STEP)
    else:
        try:
            price = await price_for(db, config.postmortem_model)
            per_run = batches.round_usd(
                batches.request_estimate_usd(
                    price,
                    input_tokens=config.estimate_postmortem_input_tokens,
                    output_tokens=config.estimate_postmortem_output_tokens,
                )
            )
        except ClaudeStepError:
            per_run = None
    return SavingOut(
        kind="postmortem_batch",
        status="on" if config.postmortem_enabled else "off",
        version_id=None,
        version_code=None,
        version_name=None,
        eval_set_code=None,
        model=config.postmortem_model,
        cost_change=-0.5,
        tokens_change=None,
        log_loss=None,
        passed=None,
        per_run_usd=per_run,
        per_run_without_usd=per_run * 2 if per_run is not None else None,
        # Скидка Batch — половина цены: сэкономлено столько же, сколько заплачено
        month_usd=Decimal(cost) if user.role == "admin" else None,
        month_forecast_usd=None,
    )


def _forecast(
    change: float | None, analysis_usd: Decimal, days_elapsed: int, days_in_month: int
) -> Decimal | None:
    """Сколько версия сэкономит на ваших оценках матча за месяц по темпу (только если она
    дешевле)."""
    if change is None or change >= 0 or days_elapsed <= 0:
        return None
    pace = analysis_usd / days_elapsed * days_in_month
    return (pace * Decimal(str(-change))).quantize(USD_STEP)


async def _version_saving(
    db: AsyncSession,
    version: StrategyVersion,
    base: StrategyVersion | None,
    *,
    analysis_usd: Decimal,
    days_elapsed: int,
    days_in_month: int,
) -> SavingOut:
    comparison = await eval_runs.latest_comparison(db, version, base) if base is not None else None
    evaluated = await eval_runs.version_eval(db, version)
    if comparison is None:
        status = "unchecked" if version.status in (ACTIVE, CANDIDATE) else "off"
    else:
        status = _STATUS.get(version.status, "off")
    change = comparison.cost_per_event.change if comparison is not None else None
    return SavingOut(
        kind="version",
        status=status,  # type: ignore[arg-type]
        version_id=version.id,
        version_code=version.code,
        version_name=version.name or None,
        eval_set_code=evaluated.eval_set_code if evaluated is not None else None,
        model=None,
        cost_change=change,
        tokens_change=comparison.tokens_per_event.change if comparison is not None else None,
        log_loss=comparison.log_loss if comparison is not None else None,
        passed=comparison.passed if comparison is not None else None,
        per_run_usd=None,
        per_run_without_usd=None,
        month_usd=None,
        month_forecast_usd=_forecast(change, analysis_usd, days_elapsed, days_in_month),
    )


async def savings(
    db: AsyncSession,
    user: User,
    config: AgentConfig,
    *,
    start: datetime,
    end: datetime,
    analysis_usd: Decimal,
    cache_saved_usd: Decimal,
    days_elapsed: int,
    days_in_month: int,
) -> list[SavingOut]:
    """«Где экономим»: версии с целью «экономия» (против базы — действующей или прежней),
    разбор ставки через Batch, кэш инструкций."""
    items: list[SavingOut] = []
    shared = await _shared_versions(db)
    by_id = {version.id: version for version in shared}
    active = await shared_active(db)
    for version in shared:
        if version.goal != "saving":
            continue
        base = active if version.status != ACTIVE else by_id.get(version.parent_id or 0)
        if base is not None and base.id == version.id:
            base = by_id.get(version.parent_id or 0)
        items.append(
            await _version_saving(
                db,
                version,
                base,
                analysis_usd=analysis_usd,
                days_elapsed=days_elapsed,
                days_in_month=days_in_month,
            )
        )
    items.append(await _postmortem_saving(db, user, config, start, end))
    items.append(
        SavingOut(
            kind="cache",
            status="on",
            version_id=None,
            version_code=None,
            version_name=None,
            eval_set_code=None,
            model=None,
            cost_change=None,
            tokens_change=None,
            log_loss=None,
            passed=None,
            per_run_usd=None,
            per_run_without_usd=None,
            month_usd=cache_saved_usd,
            month_forecast_usd=None,
        )
    )
    return items


def _side(
    version: StrategyVersion,
    evaluated: VersionEvalOut,
    live: dict[str, tuple[int, Decimal | None]],
    price_source: PriceSource | None,
) -> VersionSideOut:
    runs, avg = live.get(version.prompt_version or "", (0, None))
    price = {"eval": evaluated.cost_per_event_usd, "live": avg}.get(price_source or "")
    return VersionSideOut(
        version_id=version.id,
        code=version.code,
        name=version.name or None,
        status=version.status,  # type: ignore[arg-type]
        prompt_version=version.prompt_version,
        eval=evaluated,
        live_avg_usd=avg,
        live_runs=runs,
        price_usd=price,
    )


def _price_source(
    before: VersionEvalOut,
    after: VersionEvalOut,
    live_before: Decimal | None,
    live_after: Decimal | None,
) -> PriceSource | None:
    """Обе цены — на одной основе: прогоны на одном наборе (Batch, без новостей; так
    сравнение честное — одни и те же матчи), иначе обе живые (ваши вызовы), иначе цену не
    сравниваем. Смешивать нельзя: живая цена с кэшем и новостями против цены прогона через
    Batch со скидкой выглядела бы как удешевление, которого нет."""
    same_set = before.eval_set_code == after.eval_set_code
    if same_set and before.cost_per_event_usd is not None and after.cost_per_event_usd is not None:
        return "eval"
    if live_before is not None and live_after is not None:
        return "live"
    return None


async def before_after(
    db: AsyncSession, versions: Sequence[UsageVersionOut]
) -> BeforeAfterOut | None:
    """Пара версий: действующая и последний кандидат с прогоном, иначе прежняя и
    действующая. Обе — с прогоном на наборе; иначе None."""
    active = await shared_active(db)
    if active is None:
        return None
    shared = await _shared_versions(db)
    candidate = next(
        (version for version in shared if version.status == CANDIDATE),
        None,
    )
    pairs: list[tuple[StrategyVersion, StrategyVersion]] = []
    if candidate is not None:
        pairs.append((active, candidate))
    parent = next((version for version in shared if version.id == active.parent_id), None)
    if parent is not None:
        pairs.append((parent, active))
    live = {
        row.prompt_version or "": (row.runs, row.avg_cost_usd)
        for row in versions
        if row.kind == ANALYSIS
    }
    for before, after in pairs:
        before_eval = await eval_runs.version_eval(db, before)
        after_eval = await eval_runs.version_eval(db, after)
        if before_eval is None or after_eval is None:
            continue
        comparison: ComparisonOut | None = await eval_runs.latest_comparison(db, after, before)
        source = _price_source(
            before_eval,
            after_eval,
            live.get(before.prompt_version or "", (0, None))[1],
            live.get(after.prompt_version or "", (0, None))[1],
        )
        return BeforeAfterOut(
            before=_side(before, before_eval, live, source),
            after=_side(after, after_eval, live, source),
            comparison=comparison,
            price_source=source,
        )
    return None
