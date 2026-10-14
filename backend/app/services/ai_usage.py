"""Расход на Claude по вызовам (agent_runs): экран «ИИ и расходы» участника и
«Администрирование → Расход ИИ» (этап 4; TOKEN_ECONOMY.md, разделы 1 и 7; Р9, Р13, Р14).

Месяц расходов — по UTC, как бюджет и лимиты (PLAN.md, раздел 6), поэтому и дни ряда
«по дням» — по UTC: сумма дней равна расходу месяца. Проверки (eval, shadow) в личный
расход не входят: у них свой бюджет на ключе администратора, они — отдельной строкой
«Расхода ИИ».

Чьи вызовы видны:
- участник — только свои (user_id сеанса);
- администратор — свои и общие задачи без участника на ключе администратора (shared,
  сейчас — приемка agent-smoke). Прогоны приемки acceptance-runs — анализы
  администратора с отметкой в checkpoint — помечены acceptance и считаются отдельно.

Доля кэша — формула PLAN.md, раздел 8: cache_read / (input + cache_write + cache_read).
Цена вызова записана в agent_runs.cost_usd; разбор цены вызова и экономия кэша — по
model_prices на момент вызова, теми же правилами, что app/agent/runs.cost_usd.

Администратору об участниках — только расход и число анализов (Р14): без analysis_id,
текстов ввода, игроков и ставок.
"""

import calendar
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import ColumnElement, Numeric, and_, case, func, literal, or_, select, tuple_
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.agent.runs import MTOK, USD_STEP
from app.core.errors import AppError
from app.db.models import AgentRun, AiLimit, Analysis, EvalRun, ModelPrice, User
from app.schemas.ai import (
    AdminAiUsageOut,
    AgentSettingsOut,
    AiRunOut,
    AiRunsOut,
    AiUsageOut,
    AnalysisCostOut,
    CostPartOut,
    EvalRunUsageOut,
    EvalUsageOut,
    ModelPriceOut,
    PersonUsageOut,
    RunCostOut,
    SharedUsageOut,
    TaskUsageOut,
    UsageDayOut,
    UsageKindCostOut,
    UsageKindOut,
    UsageModelOut,
    UsageStepOut,
    UsageSumsOut,
    UsageVersionOut,
)
from app.services.admin_users import CHECK_RUN_KINDS
from app.services.ai_access import access_for, limits_of
from app.services.ai_budget import AVG_STEP
from app.services.analysis_run import ACCEPTANCE_MARK
from app.services.app_settings import get_app_settings
from app.services.sessions import utcnow

ZERO = Decimal(0)
CENT = Decimal("0.01")
RUNS_LIMIT = 50
RUNS_LIMIT_MAX = 200
# Самый ранний месяц расходов: программы раньше не было
FIRST_MONTH = date(2026, 1, 1)


# --- месяц ---


@dataclass(frozen=True)
class Month:
    """Месяц расходов по UTC: [start, end), дни с 1-го по last_day (сегодня у текущего)."""

    first: date
    last_day: date
    days_in_month: int
    current: bool

    @property
    def start(self) -> datetime:
        return datetime(self.first.year, self.first.month, 1, tzinfo=UTC)

    @property
    def end(self) -> datetime:
        days = self.days_in_month
        return self.start + timedelta(days=days)

    @property
    def key(self) -> str:
        return f"{self.first.year:04d}-{self.first.month:02d}"

    @property
    def days_elapsed(self) -> int:
        return (self.last_day - self.first).days + 1

    def days(self) -> list[date]:
        return [self.first + timedelta(days=n) for n in range(self.days_elapsed)]


def month_of(value: str | None, now: datetime) -> Month:
    """Месяц из «2026-10» (по умолчанию — текущий по UTC). Будущий месяц и месяц раньше
    FIRST_MONTH — 422 ai.usage_month."""
    today = now.astimezone(UTC).date()
    if value is None:
        first = today.replace(day=1)
    else:
        year, month = (int(part) for part in value.split("-"))
        # Сначала сравнение чисел: date(0, 1, 1) — ValueError (год 0000 проходит шаблон)
        if (year, month) < (FIRST_MONTH.year, FIRST_MONTH.month):
            raise AppError(422, "ai.usage_month", month=value)
        first = date(year, month, 1)
    if first > today.replace(day=1) or first < FIRST_MONTH:
        raise AppError(422, "ai.usage_month", month=f"{first.year:04d}-{first.month:02d}")
    days = calendar.monthrange(first.year, first.month)[1]
    current = first == today.replace(day=1)
    last = today if current else first + timedelta(days=days - 1)
    return Month(first=first, last_day=last, days_in_month=days, current=current)


# --- общие части запросов ---


def _in_month(month: Month) -> ColumnElement[bool]:
    return and_(AgentRun.created_at >= month.start, AgentRun.created_at < month.end)


def personal_runs(user: User) -> ColumnElement[bool]:
    """Вызовы, которые видит пользователь: свои; администратору — еще общие задачи без
    участника на ключе администратора. Без проверок (eval, shadow)."""
    own: ColumnElement[bool] = AgentRun.user_id == user.id
    if user.role == "admin":
        own = or_(own, and_(AgentRun.user_id.is_(None), AgentRun.key_source == "admin"))
    return and_(own, AgentRun.kind.not_in(CHECK_RUN_KINDS))


def _acceptance() -> ColumnElement[bool]:
    """Вызов прогона приемки (анализ с отметкой ACCEPTANCE_MARK); для внешнего соединения
    с analyses: вызов без анализа — нет."""
    return func.coalesce(Analysis.checkpoint.has_key(ACCEPTANCE_MARK), False)


def _share(read: int, prompt: int) -> float | None:
    return read / prompt if prompt else None


@dataclass
class _Sums:
    """Сумма вызовов (строки группировки); ok_* — только вызовы без ошибки."""

    runs: int = 0
    errors: int = 0
    cost: Decimal = ZERO
    input: int = 0
    cache_write: int = 0
    cache_read: int = 0
    output: int = 0
    searches: int = 0
    ok_runs: int = 0
    ok_cost: Decimal = ZERO
    ok_prompt: int = 0
    ok_output: int = 0
    models: set[str] = field(default_factory=set)
    efforts: set[str] = field(default_factory=set)

    @property
    def prompt(self) -> int:
        return self.input + self.cache_write + self.cache_read

    def add(self, row: Any) -> None:
        self.runs += int(row.runs)
        self.errors += int(row.errors)
        self.cost += Decimal(row.cost)
        self.input += int(row.input)
        self.cache_write += int(row.cache_write)
        self.cache_read += int(row.cache_read)
        self.output += int(row.output)
        self.searches += int(row.searches)
        self.ok_runs += int(row.ok_runs)
        self.ok_cost += Decimal(row.ok_cost)
        self.ok_prompt += int(row.ok_prompt)
        self.ok_output += int(row.ok_output)
        self.models.add(row.model)
        if row.effort:
            self.efforts.add(row.effort)

    def out(self) -> dict[str, Any]:
        return {
            "runs": self.runs,
            "errors": self.errors,
            "cost_usd": self.cost,
            "input_tokens": self.input,
            "cache_write_tokens": self.cache_write,
            "cache_read_tokens": self.cache_read,
            "output_tokens": self.output,
            "prompt_tokens": self.prompt,
            "web_searches": self.searches,
            "cache_share": _share(self.cache_read, self.prompt),
        }

    def avg_cost(self) -> Decimal | None:
        return (self.ok_cost / self.ok_runs).quantize(USD_STEP) if self.ok_runs else None


def _sum_columns() -> list[Any]:
    ok = AgentRun.error.is_(None)
    return [
        func.count().label("runs"),
        func.count(AgentRun.error).label("errors"),
        func.coalesce(func.sum(AgentRun.cost_usd), 0).label("cost"),
        func.coalesce(func.sum(AgentRun.input_tokens), 0).label("input"),
        func.coalesce(func.sum(AgentRun.cache_write_tokens), 0).label("cache_write"),
        func.coalesce(func.sum(AgentRun.cache_read_tokens), 0).label("cache_read"),
        func.coalesce(func.sum(AgentRun.output_tokens), 0).label("output"),
        func.coalesce(func.sum(AgentRun.web_searches), 0).label("searches"),
        func.count().filter(ok).label("ok_runs"),
        func.coalesce(func.sum(AgentRun.cost_usd).filter(ok), 0).label("ok_cost"),
        func.coalesce(
            func.sum(
                AgentRun.input_tokens + AgentRun.cache_write_tokens + AgentRun.cache_read_tokens
            ).filter(ok),
            0,
        ).label("ok_prompt"),
        func.coalesce(func.sum(AgentRun.output_tokens).filter(ok), 0).label("ok_output"),
    ]


def _usd(value: Decimal) -> Decimal:
    return value.quantize(USD_STEP, rounding=ROUND_HALF_UP)


# --- участник: свой расход за месяц ---


async def usage(
    db: AsyncSession, user: User, month: str | None = None, *, now: datetime | None = None
) -> AiUsageOut:
    """Свой расход за месяц: итоги, по дням UTC, видам, моделям, шагам и версиям
    инструкций; свои анализы; цены моделей и настройки агента (см. AiUsageOut)."""
    now = now or utcnow()
    span = month_of(month, now)
    day = func.date(func.timezone("UTC", AgentRun.created_at)).label("day")
    shared = AgentRun.user_id.is_(None).label("shared")
    acceptance = _acceptance().label("acceptance")
    price = _price_at_run()
    rows = (
        await db.execute(
            select(
                day,
                AgentRun.kind,
                AgentRun.model,
                AgentRun.effort,
                AgentRun.step,
                AgentRun.prompt_version,
                AgentRun.key_source,
                shared,
                acceptance,
                *_sum_columns(),
                *_priced_columns(price),
            )
            .select_from(AgentRun)
            .outerjoin(Analysis, Analysis.id == AgentRun.analysis_id)
            .outerjoin(price, literal(True))
            .where(personal_runs(user), _in_month(span))
            .group_by(
                day,
                AgentRun.kind,
                AgentRun.model,
                AgentRun.effort,
                AgentRun.step,
                AgentRun.prompt_version,
                AgentRun.key_source,
                shared,
                acceptance,
            )
        )
    ).all()
    totals = _Sums()
    by_day: dict[date, _Sums] = defaultdict(_Sums)
    day_kinds: dict[date, dict[str, _Sums]] = defaultdict(lambda: defaultdict(_Sums))
    by_kind: dict[str, _Sums] = defaultdict(_Sums)
    by_model: dict[str, _Sums] = defaultdict(_Sums)
    by_step: dict[tuple[str, int], _Sums] = defaultdict(_Sums)
    by_version: dict[tuple[str, str | None], _Sums] = defaultdict(_Sums)
    scope = {"own": ZERO, "acceptance": ZERO, "shared": ZERO}
    keys = {"admin": ZERO, "own": ZERO}
    search_usd = cache_saved = ZERO
    for row in rows:
        totals.add(row)
        by_day[row.day].add(row)
        day_kinds[row.day][row.kind].add(row)
        by_kind[row.kind].add(row)
        by_model[row.model].add(row)
        by_step[(row.kind, int(row.step))].add(row)
        by_version[(row.kind, row.prompt_version)].add(row)
        where = "shared" if row.shared else "acceptance" if row.acceptance else "own"
        scope[where] += Decimal(row.cost)
        keys[row.key_source] += Decimal(row.cost)
        search_usd += Decimal(row.search_usd)
        cache_saved += Decimal(row.cache_saved)

    analyses = await _analysis_costs(db, user, span)
    finished = [item for item in analyses if item.done and not item.acceptance]
    avg = _avg([item.cost_usd for item in finished], USD_STEP)
    # Средняя на ключе администратора — как в GET /ai/budget (тот же шаг): по ней
    # «хватит на N анализов» остатка лимита, который тратится только на этом ключе
    admin_avg = _avg([item.cost_usd for item in finished if item.key_source == "admin"], AVG_STEP)
    forecast, left = await _forecast(db, user, span, totals.cost, keys["admin"], admin_avg)
    settings = await get_app_settings(db)
    config = await load_agent_config(db)
    return AiUsageOut(
        month=span.key,
        month_start=span.first,
        last_day=span.last_day,
        days_in_month=span.days_in_month,
        days_elapsed=span.days_elapsed,
        current=span.current,
        totals=UsageSumsOut(**totals.out()),
        own_usd=scope["own"],
        acceptance_usd=scope["acceptance"],
        shared_usd=scope["shared"],
        admin_key_usd=keys["admin"],
        own_key_usd=keys["own"],
        search_usd=_usd(search_usd),
        cache_saved_usd=_usd(cache_saved),
        days=[
            UsageDayOut(
                day=item,
                **by_day[item].out(),
                kinds=[
                    UsageKindCostOut(kind=kind, runs=sums.runs, cost_usd=sums.cost)
                    for kind, sums in sorted(day_kinds[item].items())
                ],
            )
            for item in span.days()
        ],
        kinds=[
            UsageKindOut(
                kind=kind,
                share=float(sums.cost / totals.cost) if totals.cost > 0 else None,
                **sums.out(),
                avg_cost_usd=sums.avg_cost(),
                avg_prompt_tokens=round(sums.ok_prompt / sums.ok_runs) if sums.ok_runs else None,
                avg_output_tokens=round(sums.ok_output / sums.ok_runs) if sums.ok_runs else None,
                models=sorted(sums.models),
                efforts=sorted(sums.efforts),
            )
            for kind, sums in sorted(by_kind.items(), key=lambda item: (-item[1].cost, item[0]))
        ],
        models=[
            UsageModelOut(model=model, **sums.out())
            for model, sums in sorted(by_model.items(), key=lambda item: (-item[1].cost, item[0]))
        ],
        steps=[
            UsageStepOut(kind=kind, step=step, runs=sums.runs, cost_usd=sums.cost)
            for (kind, step), sums in sorted(by_step.items(), key=lambda item: item[0][::-1])
        ],
        versions=[
            UsageVersionOut(
                kind=kind,
                prompt_version=version,
                runs=sums.runs,
                cost_usd=sums.cost,
                avg_cost_usd=sums.avg_cost(),
            )
            for (kind, version), sums in sorted(
                by_version.items(), key=lambda item: (item[0][0], item[0][1] or "")
            )
        ],
        analyses=analyses,
        avg_analysis_usd=avg,
        admin_key_avg_usd=admin_avg,
        forecast_usd=forecast,
        analyses_left=left,
        prices=await current_prices(db, now),
        settings=AgentSettingsOut(
            parse_model=config.parse_model,
            parse_effort=config.parse_effort,
            news_enabled=config.news_enabled,
            news_model=config.news_model,
            news_effort=config.news_effort,
            news_searches_per_match=config.news_max_uses,
            news_searches_per_analysis=config.news_max_searches_per_analysis,
            news_searches_per_day=config.news_max_searches_per_day,
            news_ttl_hours=config.news_ttl_hours,
            news_lookback_days=config.news_lookback_days,
            news_domains=list(config.news_domains),
            news_prompt_cache=config.news_prompt_cache,
            analysis_model=config.analysis_model,
            analysis_effort=config.analysis_effort,
            analysis_parallel=config.analysis_parallel,
            assessment_reuse_hours=config.assessment_reuse_hours,
            soft_cap_usd=settings.per_analysis_soft_usd,
            hard_cap_usd=settings.per_analysis_hard_usd,
            default_per_analysis_usd=config.default_per_analysis_usd,
        ),
    )


def _price_at_run() -> Any:
    """Цена модели вызова на момент вызова (последняя строка model_prices не позже
    created_at): подзапрос LATERAL к agent_runs."""
    return (
        select(
            ModelPrice.input,
            ModelPrice.cache_read,
            ModelPrice.search_price,
            ModelPrice.long_input_threshold,
            ModelPrice.long_multiplier,
        )
        .where(ModelPrice.model == AgentRun.model, ModelPrice.valid_from <= AgentRun.created_at)
        .order_by(ModelPrice.valid_from.desc())
        .limit(1)
        .lateral("price")
    )


def _priced_columns(price: Any) -> list[Any]:
    """Цена поисков и экономия кэша (чтение кэша по цене обычного входа минус цена
    чтения) по ценам модели на момент каждого вызова, с второй ступенью и Batch, как
    app/agent/runs.cost_usd. Вызов без цены дает 0."""
    prompt = AgentRun.input_tokens + AgentRun.cache_write_tokens + AgentRun.cache_read_tokens
    long_factor = case(
        (
            and_(
                price.c.long_input_threshold.is_not(None),
                price.c.long_multiplier.is_not(None),
                prompt > price.c.long_input_threshold,
            ),
            price.c.long_multiplier,
        ),
        else_=literal(Decimal(1), Numeric()),
    )
    batch = case(
        (AgentRun.batch, literal(Decimal("0.5"), Numeric())), else_=literal(Decimal(1), Numeric())
    )
    # Миллион — числом без масштаба: иначе SQLAlchemy привяжет его к NUMERIC(10, 4) цены
    saved = (
        AgentRun.cache_read_tokens * (price.c.input - price.c.cache_read) / literal(MTOK, Numeric())
    )
    return [
        func.coalesce(func.sum(AgentRun.web_searches * price.c.search_price), 0).label(
            "search_usd"
        ),
        func.coalesce(func.sum(saved * long_factor * batch), 0).label("cache_saved"),
    ]


def _avg(values: list[Decimal], step: Decimal) -> Decimal | None:
    return (sum(values, ZERO) / len(values)).quantize(step) if values else None


async def _analysis_costs(db: AsyncSession, user: User, span: Month) -> list[AnalysisCostOut]:
    """Свои анализы, запущенные в этом месяце (по времени запуска), по порядку."""
    rows = await db.execute(
        select(
            Analysis.id,
            Analysis.started_at,
            Analysis.cost_usd,
            Analysis.status,
            func.coalesce(Analysis.checkpoint.has_key(ACCEPTANCE_MARK), False),
            Analysis.key_source,
        )
        .where(
            Analysis.user_id == user.id,
            Analysis.started_at >= span.start,
            Analysis.started_at < span.end,
        )
        .order_by(Analysis.started_at, Analysis.id)
    )
    return [
        AnalysisCostOut(
            id=analysis_id,
            started_at=started,
            cost_usd=Decimal(cost or 0),
            done=status == "done",
            acceptance=bool(acceptance),
            key_source=key_source,
        )
        for analysis_id, started, cost, status, acceptance, key_source in rows
    ]


async def _forecast(
    db: AsyncSession,
    user: User,
    span: Month,
    total: Decimal,
    admin_key: Decimal,
    admin_avg: Decimal | None,
) -> tuple[Decimal, int | None]:
    """Прогноз на конец месяца и «хватит на N анализов» по средней цене анализа на ключе
    администратора (см. AiUsageOut). Лимиты и остаток — из access_for, как в GET
    /ai/budget: одно и то же число на обоих экранах."""
    if not span.current:
        return total, None

    def pace(value: Decimal) -> Decimal:
        return (value / span.days_elapsed * span.days_in_month).quantize(CENT)

    if user.role == "admin" or user.ai_mode == "own":
        return pace(total), None
    access = await access_for(db, user, estimate_usd=None)
    if access.paused or access.monthly_limit_usd is None:
        return admin_key.quantize(CENT), None
    forecast = min(access.monthly_limit_usd, pace(admin_key))
    left: int | None = None
    if admin_avg is not None and admin_avg > 0 and access.left_month_usd is not None:
        left = int(access.left_month_usd // admin_avg)
    return forecast, left


async def current_prices(db: AsyncSession, now: datetime | None = None) -> list[ModelPriceOut]:
    """Действующие цены моделей (последняя строка model_prices не позже now)."""
    moment = now or utcnow()
    rows = await db.scalars(
        select(ModelPrice)
        .where(ModelPrice.valid_from <= moment)
        .ext(distinct_on(ModelPrice.model))
        .order_by(ModelPrice.model, ModelPrice.valid_from.desc())
    )
    return [
        ModelPriceOut(
            model=row.model,
            valid_from=row.valid_from,
            input=row.input,
            output=row.output,
            cache_read=row.cache_read,
            cache_write_5m=row.cache_write_5m,
            cache_write_1h=row.cache_write_1h,
            search_price=row.search_price,
            long_input_threshold=row.long_input_threshold,
            long_multiplier=row.long_multiplier,
        )
        for row in rows
    ]


# --- журнал вызовов ---


def _long_factor(price: ModelPrice, prompt_tokens: int) -> Decimal:
    """Вторая ступень цены — то же правило, что в app/agent/runs.cost_usd."""
    threshold, multiplier = price.long_input_threshold, price.long_multiplier
    if threshold is not None and multiplier is not None and prompt_tokens > threshold:
        return Decimal(multiplier)
    return Decimal(1)


def run_cost(price: ModelPrice, run: AgentRun) -> RunCostOut:
    """Разбор цены вызова по частям: токены × цена за 1 млн × вторая ступень × Batch
    (половина), поиски — по цене поиска без скидки (как app/agent/runs.cost_usd)."""
    prompt = run.input_tokens + run.cache_write_tokens + run.cache_read_tokens
    factor = _long_factor(price, prompt)
    scale = factor / 2 if run.batch else factor

    def part(tokens: int, per_mtok: Decimal) -> CostPartOut:
        cost = _usd(tokens * per_mtok / MTOK * scale)
        return CostPartOut(tokens=tokens, price=per_mtok, cost_usd=cost)

    return RunCostOut(
        valid_from=price.valid_from,
        input=part(run.input_tokens, price.input),
        cache_write_5m=part(run.cache_write_5m_tokens, price.cache_write_5m),
        cache_write_1h=part(run.cache_write_1h_tokens, price.cache_write_1h),
        cache_read=part(run.cache_read_tokens, price.cache_read),
        output=part(run.output_tokens, price.output),
        searches=CostPartOut(
            tokens=run.web_searches,
            price=price.search_price,
            cost_usd=_usd(run.web_searches * price.search_price),
        ),
        long_factor=factor,
        batch=run.batch,
    )


def _price_at(prices: Sequence[ModelPrice], model: str, moment: datetime) -> ModelPrice | None:
    """Цена модели на момент вызова (prices — новые сверху)."""
    for price in prices:
        if price.model == model and price.valid_from <= moment:
            return price
    return None


def _run_out(run: AgentRun, acceptance: bool, price: ModelPrice | None) -> AiRunOut:
    prompt = run.input_tokens + run.cache_write_tokens + run.cache_read_tokens
    return AiRunOut(
        id=run.id,
        created_at=run.created_at,
        kind=run.kind,
        step=run.step,
        model=run.model,
        effort=run.effort,
        prompt_version=run.prompt_version,
        key_source=run.key_source,  # type: ignore[arg-type]
        analysis_id=run.analysis_id if run.user_id is not None else None,
        shared=run.user_id is None,
        acceptance=acceptance,
        batch=run.batch,
        input_tokens=run.input_tokens,
        cache_write_tokens=run.cache_write_tokens,
        cache_read_tokens=run.cache_read_tokens,
        output_tokens=run.output_tokens,
        thinking_tokens=run.thinking_tokens,
        prompt_tokens=prompt,
        web_searches=run.web_searches,
        cache_share=_share(run.cache_read_tokens, prompt),
        cost_usd=run.cost_usd,
        duration_ms=run.duration_ms,
        stop_reason=run.stop_reason,
        error=run.error,
        price=run_cost(price, run) if price is not None else None,
    )


async def runs(
    db: AsyncSession,
    user: User,
    *,
    month: str | None = None,
    kind: str | None = None,
    before: int | None = None,
    limit: int = RUNS_LIMIT,
    now: datetime | None = None,
) -> AiRunsOut:
    """Свои вызовы месяца, новые сверху, с разбором цены. kind — вид вызова или shared
    (общие задачи без участника и прогоны приемки). before — id последнего вызова прошлой
    страницы (свой, иначе 422 ai.bad_cursor)."""
    span = month_of(month, now or utcnow())
    acceptance = _acceptance()
    conds: list[ColumnElement[bool]] = [personal_runs(user), _in_month(span)]
    if kind == "shared":
        conds.append(or_(AgentRun.user_id.is_(None), acceptance))
    elif kind is not None:
        conds.append(AgentRun.kind == kind)
    count, cost = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(AgentRun.cost_usd), 0))
            .select_from(AgentRun)
            .outerjoin(Analysis, Analysis.id == AgentRun.analysis_id)
            .where(*conds)
        )
    ).one()
    page = list(conds)
    if before is not None:
        cursor = (
            await db.execute(
                select(AgentRun.created_at, AgentRun.id).where(
                    AgentRun.id == before, personal_runs(user)
                )
            )
        ).first()
        if cursor is None:
            raise AppError(422, "ai.bad_cursor")
        page.append(tuple_(AgentRun.created_at, AgentRun.id) < tuple_(cursor.created_at, cursor.id))
    rows = (
        await db.execute(
            select(AgentRun, acceptance)
            .outerjoin(Analysis, Analysis.id == AgentRun.analysis_id)
            .where(*page)
            .order_by(AgentRun.created_at.desc(), AgentRun.id.desc())
            .limit(limit + 1)
        )
    ).all()
    shown = rows[:limit]
    models = {run.model for run, _ in shown}
    prices = list(
        await db.scalars(
            select(ModelPrice)
            .where(ModelPrice.model.in_(models))
            .order_by(ModelPrice.valid_from.desc())
        )
    )
    items = [
        _run_out(run, bool(flag), _price_at(prices, run.model, run.created_at))
        for run, flag in shown
    ]
    return AiRunsOut(
        items=items,
        total_runs=int(count),
        total_cost_usd=Decimal(cost),
        next_before=items[-1].id if len(rows) > limit else None,
    )


# --- администратор: расход ключа по людям, задачам и проверкам (Р14) ---


def _ratio(part: Decimal, whole: Decimal | None) -> float | None:
    return float(part / whole) if whole else None


def _models(values: Iterable[str | None]) -> list[str]:
    return sorted({value for value in values if value})


async def admin_usage(
    db: AsyncSession, admin: User, month: str | None = None, *, now: datetime | None = None
) -> AdminAiUsageOut:
    """«Расход ИИ» администратора за месяц (см. AdminAiUsageOut): только расход на ИИ и
    число анализов по людям, без анализов, ввода и ставок (Р14)."""
    now = now or utcnow()
    span = month_of(month, now)
    settings = await get_app_settings(db)
    budget = Decimal(settings.monthly_budget_usd)
    in_month = _in_month(span)
    not_check = AgentRun.kind.not_in(CHECK_RUN_KINDS)
    prompt = AgentRun.input_tokens + AgentRun.cache_write_tokens + AgentRun.cache_read_tokens

    # Расход по людям и ключу; user_id NULL — общие задачи без участника
    spent: dict[tuple[int | None, str], Decimal] = {}
    shared_kinds: dict[str, tuple[int, Decimal, int, int]] = {}
    tasks: dict[str, list[Any]] = {}
    rows = await db.execute(
        select(
            AgentRun.user_id,
            AgentRun.key_source,
            AgentRun.kind,
            func.count(),
            func.coalesce(func.sum(AgentRun.cost_usd), 0),
            func.coalesce(func.sum(AgentRun.cache_read_tokens), 0),
            func.coalesce(func.sum(prompt), 0),
            func.array_agg(AgentRun.model.distinct()),
        )
        .where(in_month, not_check)
        .group_by(AgentRun.user_id, AgentRun.key_source, AgentRun.kind)
    )
    key_read = key_prompt = 0
    for user_id, key_source, kind, count, cost, read, total_prompt, models in rows:
        cost = Decimal(cost)
        spent[(user_id, key_source)] = spent.get((user_id, key_source), ZERO) + cost
        if key_source != "admin":
            continue
        key_read += int(read)
        key_prompt += int(total_prompt)
        if user_id is None:
            runs_, cost_, read_, prompt_ = shared_kinds.get(kind, (0, ZERO, 0, 0))
            shared_kinds[kind] = (
                runs_ + int(count),
                cost_ + cost,
                read_ + int(read),
                prompt_ + int(total_prompt),
            )
        else:
            item = tasks.setdefault(kind, [0, ZERO, 0, 0, set()])
            item[0] += int(count)
            item[1] += cost
            item[2] += int(read)
            item[3] += int(total_prompt)
            item[4].update(models or [])

    # Анализы по людям и ключу за месяц (по времени запуска, как лимиты)
    analyses: dict[tuple[int | None, str], int] = {}
    done_costs: list[Decimal] = []
    started = await db.execute(
        select(Analysis.user_id, Analysis.key_source, Analysis.status, Analysis.cost_usd).where(
            Analysis.started_at >= span.start,
            Analysis.started_at < span.end,
            Analysis.key_source.is_not(None),
        )
    )
    for owner, source, state, analysis_cost in started:
        if source is None:
            continue
        analyses[(owner, source)] = analyses.get((owner, source), 0) + 1
        if source == "admin" and state == "done":
            done_costs.append(Decimal(analysis_cost or 0))

    ids = {uid for uid, _ in [*spent, *analyses] if uid is not None}
    users = list(
        await db.scalars(
            select(User)
            .where(or_(User.status != "deleted", User.id.in_(ids)))
            .order_by(User.id)
            .execution_options(populate_existing=True)
        )
    )
    limit_rows = {
        row.user_id: row
        for row in await db.scalars(
            select(AiLimit).where(AiLimit.user_id.in_([user.id for user in users]))
        )
    }
    people: list[PersonUsageOut] = []
    for user in users:
        key_spent = spent.get((user.id, "admin"), ZERO)
        limits = limits_of(limit_rows.get(user.id), settings) if user.role != "admin" else None
        people.append(
            PersonUsageOut(
                user_id=user.id,
                display_name=user.display_name,
                role=user.role,  # type: ignore[arg-type]
                status=user.status,  # type: ignore[arg-type]
                ai_mode=user.ai_mode,  # type: ignore[arg-type]
                key_spent_usd=key_spent,
                own_spent_usd=spent.get((user.id, "own"), ZERO),
                analyses=analyses.get((user.id, "admin"), 0),
                own_analyses=analyses.get((user.id, "own"), 0),
                limit_usd=limits.monthly_usd if limits is not None else None,
                paused=limits.paused if limits is not None else False,
                budget_share=_ratio(key_spent, budget),
                limit_share=_ratio(key_spent, limits.monthly_usd) if limits else None,
            )
        )
    people.sort(key=lambda item: (-item.key_spent_usd, -item.own_spent_usd, item.user_id))

    key_spent_total = sum((cost for (_, source), cost in spent.items() if source == "admin"), ZERO)
    shared_cost = sum((item[1] for item in shared_kinds.values()), ZERO)
    shared_read = sum(item[2] for item in shared_kinds.values())
    shared_prompt = sum(item[3] for item in shared_kinds.values())
    return AdminAiUsageOut(
        month=span.key,
        month_start=span.first,
        last_day=span.last_day,
        days_in_month=span.days_in_month,
        days_elapsed=span.days_elapsed,
        current=span.current,
        budget_usd=budget,
        spent_usd=key_spent_total,
        budget_share=_ratio(key_spent_total, budget),
        analyses=sum(count for (_, source), count in analyses.items() if source == "admin"),
        avg_analysis_usd=(
            (sum(done_costs, ZERO) / len(done_costs)).quantize(USD_STEP) if done_costs else None
        ),
        cache_share=_share(key_read, key_prompt),
        own_key_usd=sum((cost for (_, source), cost in spent.items() if source == "own"), ZERO),
        people=people,
        shared=SharedUsageOut(
            runs=sum(item[0] for item in shared_kinds.values()),
            cost_usd=shared_cost,
            cache_share=_share(shared_read, shared_prompt),
            budget_share=_ratio(shared_cost, budget),
            kinds=sorted(shared_kinds),
        ),
        tasks=[
            TaskUsageOut(
                kind=kind,
                runs=item[0],
                cost_usd=item[1],
                cache_share=_share(item[2], item[3]),
                budget_share=_ratio(item[1], budget),
                models=_models(item[4]),
            )
            for kind, item in sorted(tasks.items(), key=lambda pair: (-pair[1][1], pair[0]))
        ],
        eval=await _eval_usage(db, span, Decimal(settings.eval_budget_usd)),
    )


async def _eval_usage(db: AsyncSession, span: Month, budget: Decimal) -> EvalUsageOut:
    """Проверки месяца на ключе администратора по прогонам (eval_runs)."""
    rows = (
        await db.execute(
            select(
                AgentRun.eval_run_id,
                EvalRun.created_at,
                EvalRun.metrics["kind"].astext,
                EvalRun.eval_set,
                EvalRun.n_events,
                func.count(),
                func.coalesce(func.sum(AgentRun.cost_usd), 0),
                func.array_agg(AgentRun.model.distinct()),
            )
            .outerjoin(EvalRun, EvalRun.id == AgentRun.eval_run_id)
            .where(
                _in_month(span),
                AgentRun.key_source == "admin",
                AgentRun.kind.in_(CHECK_RUN_KINDS),
            )
            # По первичному ключу прогона: остальные его поля от него зависят
            .group_by(AgentRun.eval_run_id, EvalRun.id)
            .order_by(EvalRun.created_at.desc().nulls_last(), AgentRun.eval_run_id)
        )
    ).all()
    items = [
        EvalRunUsageOut(
            eval_run_id=run_id,
            created_at=created,
            name=name,
            eval_set=eval_set,
            n_events=n_events,
            models=_models(models or []),
            runs=int(count),
            cost_usd=Decimal(cost),
        )
        for run_id, created, name, eval_set, n_events, count, cost, models in rows
    ]
    return EvalUsageOut(
        budget_usd=budget,
        spent_usd=sum((item.cost_usd for item in items), ZERO),
        runs=sum(item.runs for item in items),
        items=items,
    )
