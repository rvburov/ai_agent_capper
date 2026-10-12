"""Учет вызовов Claude: токены и стоимость каждого вызова в agent_runs (Р9, Р13).

Стоимость считает код по model_prices на момент вызова (TOKEN_ECONOMY.md, раздел 1):
вход без кэша, запись кэша 5 мин и 1 ч, чтение кэша и выход — по своим ценам за 1 млн
токенов; Batch — половина цены всех токенов; поиск — по цене за один поиск без скидки;
вторая ступень цены (Haiku 5.5) — если весь вход запроса больше порога, цены токенов
умножаются на множитель. Каждый вызов API — своя строка (и каждое продолжение pause_turn).
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, ROUND_UP, Decimal

from anthropic.types import Message
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.errors import ClaudeStepError
from app.db.models import AgentRun, Analysis, ModelPrice
from app.services.sessions import utcnow

MTOK = Decimal(1_000_000)
USD_STEP = Decimal("0.000001")
_STOP_REASON_LENGTH = 32
_REQUEST_ID_LENGTH = 128


@dataclass(frozen=True)
class Usage:
    """Токены одного вызова (или сумма нескольких). input_tokens — вход без кэша,
    cache_write_tokens — запись кэша всего (5 мин + 1 ч), output_tokens — с размышлениями."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_write_tokens: int = 0
    cache_write_5m_tokens: int = 0
    cache_write_1h_tokens: int = 0
    cache_read_tokens: int = 0
    thinking_tokens: int | None = None
    web_searches: int = 0
    batch: bool = False

    @property
    def prompt_tokens(self) -> int:
        """Весь вход запроса: по нему считается порог второй ступени цены."""
        return self.input_tokens + self.cache_write_tokens + self.cache_read_tokens

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.output_tokens

    def __add__(self, other: "Usage") -> "Usage":
        """Сумма вызовов одного шага (продолжения pause_turn, итерации анализа)."""
        thinking = (
            None
            if self.thinking_tokens is None and other.thinking_tokens is None
            else (self.thinking_tokens or 0) + (other.thinking_tokens or 0)
        )
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            cache_write_tokens=self.cache_write_tokens + other.cache_write_tokens,
            cache_write_5m_tokens=self.cache_write_5m_tokens + other.cache_write_5m_tokens,
            cache_write_1h_tokens=self.cache_write_1h_tokens + other.cache_write_1h_tokens,
            cache_read_tokens=self.cache_read_tokens + other.cache_read_tokens,
            thinking_tokens=thinking,
            web_searches=self.web_searches + other.web_searches,
            batch=self.batch or other.batch,
        )


def usage_from(message: Message) -> Usage:
    """Usage из ответа API (или из результата Batch: service_tier == batch)."""
    u = message.usage
    cache_write = u.cache_creation_input_tokens or 0
    if u.cache_creation is not None:
        write_5m = u.cache_creation.ephemeral_5m_input_tokens
        write_1h = u.cache_creation.ephemeral_1h_input_tokens
    else:
        # Без разбивки по TTL: считаем записью на 5 мин (так пишет наш код)
        write_5m, write_1h = cache_write, 0
    details = u.output_tokens_details
    return Usage(
        input_tokens=u.input_tokens,
        output_tokens=u.output_tokens,
        cache_write_tokens=cache_write,
        cache_write_5m_tokens=write_5m,
        cache_write_1h_tokens=write_1h,
        cache_read_tokens=u.cache_read_input_tokens or 0,
        thinking_tokens=details.thinking_tokens if details is not None else None,
        web_searches=u.server_tool_use.web_search_requests if u.server_tool_use else 0,
        batch=u.service_tier == "batch",
    )


def _long_factor(price: ModelPrice, prompt_tokens: int) -> Decimal:
    threshold, multiplier = price.long_input_threshold, price.long_multiplier
    if threshold is not None and multiplier is not None and prompt_tokens > threshold:
        return Decimal(multiplier)
    return Decimal(1)


def cost_usd(price: ModelPrice, usage: Usage) -> Decimal:
    """Стоимость вызова в долларах, 6 знаков (agent_runs.cost_usd)."""
    tokens = (
        usage.input_tokens * price.input
        + usage.cache_write_5m_tokens * price.cache_write_5m
        + usage.cache_write_1h_tokens * price.cache_write_1h
        + usage.cache_read_tokens * price.cache_read
        + usage.output_tokens * price.output
    ) / MTOK
    tokens *= _long_factor(price, usage.prompt_tokens)
    if usage.batch:
        tokens /= 2
    total = tokens + usage.web_searches * price.search_price
    return total.quantize(USD_STEP, rounding=ROUND_HALF_UP)


def worst_case_usd(
    price: ModelPrice, *, input_tokens: int, max_tokens: int, searches: int = 0
) -> Decimal:
    """Худший случай вызова до его начала: весь вход по самой дорогой цене входа (запись
    кэша 5 мин дороже обычного входа), выход — весь max_tokens, поиски — все разрешенные.
    По нему проверяется потолок анализа и лимиты перед вызовом."""
    per_input = max(price.input, price.cache_write_5m)
    tokens = (input_tokens * per_input + max_tokens * price.output) / MTOK
    tokens *= _long_factor(price, input_tokens)
    total = tokens + searches * price.search_price
    return total.quantize(USD_STEP, rounding=ROUND_UP)


def max_tokens_within(
    price: ModelPrice, *, budget_usd: Decimal, input_tokens: int, searches: int = 0
) -> int:
    """Наибольший max_tokens, при котором худший случай вызова (worst_case_usd) не больше
    budget_usd. 0 — не помещается даже вход. Выход бесплатный — без предела (большое
    число, вызывающий сам ограничит его настройкой)."""
    per_input = max(price.input, price.cache_write_5m)
    factor = _long_factor(price, input_tokens)
    fixed = input_tokens * per_input / MTOK * factor + searches * price.search_price
    per_output = price.output * factor / MTOK
    # Запас в миллионную долю: worst_case_usd округляет сумму вверх до нее
    rest = budget_usd - fixed - USD_STEP
    if rest < 0:
        return 0
    if per_output <= 0:
        return 10**9
    return int(rest / per_output)


async def price_for(db: AsyncSession, model: str, *, at: datetime | None = None) -> ModelPrice:
    """Цена модели, действующая на момент at (по умолчанию — сейчас). Нет цены —
    ClaudeStepError ai.no_price: без цены расход не посчитать, вызывать Claude нельзя."""
    moment = at or utcnow()
    price = await db.scalar(
        select(ModelPrice)
        .where(ModelPrice.model == model, ModelPrice.valid_from <= moment)
        .order_by(ModelPrice.valid_from.desc())
        .limit(1)
    )
    if price is None:
        raise ClaudeStepError("ai.no_price", detail=f"no_price:{model}", model=model)
    return price


async def list_prices(db: AsyncSession) -> list[ModelPrice]:
    """Все цены моделей: по модели, новые сверху (команда prices)."""
    rows = await db.scalars(
        select(ModelPrice).order_by(ModelPrice.model, ModelPrice.valid_from.desc())
    )
    return list(rows)


async def record_run(
    db: AsyncSession,
    *,
    user_id: int | None,
    key_source: str,
    analysis_id: int | None,
    kind: str,
    step: int,
    model: str,
    effort: str | None,
    prompt_version: str | None,
    schema_version: str | None,
    usage: Usage,
    duration_ms: int | None,
    stop_reason: str | None,
    error: str | None,
    request_id: str | None,
    eval_run_id: int | None = None,
) -> AgentRun:
    """Записывает вызов Claude (и неудачный: usage тогда нулевой или частичный) со
    стоимостью по ценам на сейчас и прибавляет ее к analyses.cost_usd. Делает flush,
    commit — за вызывающим. Анализа уже нет (участника удалили во время анализа) —
    строка пишется без analysis_id: деньги потрачены и считаются в бюджете месяца."""
    price = await price_for(db, model)
    cost = cost_usd(price, usage)
    if analysis_id is not None:
        exists = await db.scalar(select(Analysis.id).where(Analysis.id == analysis_id))
        if exists is None:
            analysis_id = None
    run = AgentRun(
        user_id=user_id,
        key_source=key_source,
        analysis_id=analysis_id,
        eval_run_id=eval_run_id,
        kind=kind,
        step=step,
        model=model,
        effort=effort,
        prompt_version=prompt_version,
        schema_version=schema_version,
        input_tokens=usage.input_tokens,
        cache_write_tokens=usage.cache_write_tokens,
        cache_write_5m_tokens=usage.cache_write_5m_tokens,
        cache_write_1h_tokens=usage.cache_write_1h_tokens,
        cache_read_tokens=usage.cache_read_tokens,
        output_tokens=usage.output_tokens,
        thinking_tokens=usage.thinking_tokens,
        web_searches=usage.web_searches,
        batch=usage.batch,
        cost_usd=cost,
        duration_ms=duration_ms,
        stop_reason=stop_reason[:_STOP_REASON_LENGTH] if stop_reason else None,
        error=error,
        request_id=request_id[:_REQUEST_ID_LENGTH] if request_id else None,
    )
    db.add(run)
    if analysis_id is not None and cost:
        await db.execute(
            update(Analysis)
            .where(Analysis.id == analysis_id)
            .values(cost_usd=Analysis.cost_usd + cost)
        )
    await db.flush()
    return run
