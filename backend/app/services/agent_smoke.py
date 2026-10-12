"""Проверка конвейера на живом ключе администратора (команда agent-smoke): один разбор
образца, новости одного игрока (web_search и record_news в одном запросе) и анализ
одного матча из базы двумя разговорами подряд — второй обязан прочитать кэш промпта.

Прогнозы и новости не пишутся. Каждый вызов — строка agent_runs (деньги потрачены, они
входят в бюджет месяца), досье — в dossiers (общие данные). Цена — около $0,30
(estimate_smoke), в худшем случае больше (max_smoke: продолжения поиска и итерации
анализа). Досье собирается на день матча: результат самого матча в него не попадает.
Итог проверяет команда (problems): разбор нашел одно событие, модель искала перед
record_news, второй вызов анализа прочитал кэш — иначе проверка не пройдена. Сбой шага
новостей проверку не останавливает (в анализе он тоже лишь предупреждение): анализ матча
все равно проверяется, а причина сбоя попадает в итог.

agent-smoke --only news — только шаг новостей одного игрока (≈ $0,01–0,13): варианты
шага (модель, фильтрация поиска кодом, число поисков, точка кэша) для сравнения на одном
игроке. Перед запуском models.retrieve сверяет, принимает ли модель веб-поиск и, для
фильтрации кодом, programmatic tool calling (capabilities API моделей; запрос бесплатный).
Итерации серверного цикла каждого вызова (usage.iterations) показывают форму разговора,
по ним же считается цена того же разговора без точки кэша: так один запуск отвечает,
нужна ли точка, без второго запуска с другими результатами поиска.
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, time
from decimal import ROUND_UP, Decimal
from typing import Any

import anthropic
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.analysis import assess_match
from app.agent.calls import CallInfo
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError, claude_errors
from app.agent.news import NewsFact, NewsTarget, fetch_news
from app.agent.parse import parse_text
from app.agent.prompts import ANALYSIS_PROMPT, load_prompt
from app.agent.runs import Iteration, cost_without_cache, price_for, worst_case_usd
from app.core.errors import AppError
from app.db.models import Match, Player, Tournament
from app.ml.elo import RESULT_STATUSES
from app.ml.sets import Probs3
from app.services.analysis_run import record_call
from app.services.claude_key import key_for
from app.services.dossier import build_dossier

SAMPLE_TEXT = """Текущий банк: 10 000 ₽
Букмекер: Fonbet

События:
Синнер vs Руне, Шанхай, хард, 1/8
Кэфы: П1 = 1.17, П2 = 5.10
Фора по сетам: П1(-1.5) = 1.62, П2(+1.5) = 2.30"""
ESTIMATE_STEP = Decimal("0.01")
MTOK = Decimal(1_000_000)
PARSE_TOKENS = (2000, 1000)
# Поисков в запросе новостей проверки
NEWS_USES = 2
# Тайм-аут запроса models.retrieve (проверка модели новостей)
CHECK_TIMEOUT_S = 15.0


@dataclass(frozen=True)
class SmokeCall:
    """Один вызов проверки: шаг, модель, токены, поиски, стоимость, ошибка. iterations —
    итерации серверного цикла (usage.iterations), no_cache_usd — цена того же вызова без
    точек кэша (по итерациям; None — API итераций не прислал)."""

    step: str
    model: str
    input_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    output_tokens: int
    web_searches: int
    cost_usd: Decimal
    error: str | None
    iterations: tuple[Iteration, ...] = ()
    no_cache_usd: Decimal | None = None


@dataclass
class SmokeReport:
    calls: list[SmokeCall] = field(default_factory=list)
    parsed_events: int = 0
    news_facts: int = 0
    news_errors: tuple[str, ...] = ()
    news_searched: bool = False
    # Шаг новостей не выполнен: текст ошибки и ответ Anthropic, если он есть
    news_failure: str | None = None
    match_id: int | None = None
    p_base: float | None = None
    p_claude: float | None = None

    @property
    def news_searches(self) -> int:
        return sum(call.web_searches for call in self.calls if call.step == "news")

    def problems(self) -> list[tuple[str, dict[str, Any]]]:
        """Что проверка не подтвердила (ключ cli.agent_smoke.problems.* и параметры):
        пустой список — конвейер работает на живом API."""
        found: list[tuple[str, dict[str, Any]]] = []
        if self.parsed_events != 1:
            found.append(("events", {"events": self.parsed_events}))
        if self.news_failure is not None:
            found.append(("news_failed", {"message": self.news_failure}))
        elif not self.news_searched or self.news_searches == 0:
            found.append(("search", {}))
        if self.second_cache_read == 0:
            found.append(("cache", {}))
        return found

    @property
    def total_usd(self) -> Decimal:
        return sum((call.cost_usd for call in self.calls), Decimal(0))

    @property
    def second_cache_read(self) -> int:
        """Чтение кэша второго вызова анализа (0 — кэш не сработал)."""
        analysis = [call for call in self.calls if call.step == "analysis"]
        return analysis[1].cache_read_tokens if len(analysis) > 1 else 0


class _Hooks:
    def __init__(self, db: AsyncSession, calls: list[SmokeCall]) -> None:
        self.db = db
        self.calls = calls

    async def before_call(
        self,
        *,
        kind: str,
        model: str,
        input_tokens: int,
        max_tokens: int,
        min_tokens: int,
        searches: int,
    ) -> int | None:
        await price_for(self.db, model)
        # Транзакция не висит открытой, пока ждем Claude
        await self.db.commit()
        return None

    async def after_call(self, info: CallInfo) -> int | None:
        run = await record_call(
            self.db, info, user_id=None, key_source="admin", analysis_id=None, step=0
        )
        run_id = run.id
        price = await price_for(self.db, info.model)
        self.calls.append(
            SmokeCall(
                step=info.kind,
                model=info.model,
                input_tokens=info.usage.input_tokens,
                cache_write_tokens=info.usage.cache_write_tokens,
                cache_read_tokens=info.usage.cache_read_tokens,
                output_tokens=info.usage.output_tokens,
                web_searches=info.usage.web_searches,
                cost_usd=run.cost_usd,
                error=info.error,
                iterations=info.usage.iterations,
                no_cache_usd=cost_without_cache(price, info.usage),
            )
        )
        await self.db.commit()
        return run_id


def failure_text(exc: ClaudeStepError) -> str:
    """Текст сбоя шага для вывода команды: сообщение и ответ Anthropic, если он есть."""
    if exc.api_message:
        return f"{exc.message} ({exc.api_message})"
    return exc.message


def _tokens_cost(price_input: Decimal, price_output: Decimal, inp: int, out: int) -> Decimal:
    return (inp * price_input + out * price_output) / MTOK


async def _news_estimate(db: AsyncSession, config: AgentConfig, max_uses: int) -> Decimal:
    """Оценка одного запроса новостей по estimate_news_* (вход — по цене записи кэша)."""
    news = await price_for(db, config.news_model)
    total = _tokens_cost(
        max(news.input, news.cache_write_5m),
        news.output,
        config.estimate_news_input_tokens,
        config.estimate_news_output_tokens,
    )
    return total + max_uses * news.search_price


async def _news_worst(db: AsyncSession, config: AgentConfig, max_uses: int) -> Decimal:
    """Худший случай разговора новостей: запрос, все продолжения pause_turn и просьба
    вызвать record_news, у каждого — весь max_tokens и все поиски."""
    news = await price_for(db, config.news_model)
    return (config.news_max_pause_continuations + 2) * worst_case_usd(
        news,
        input_tokens=config.estimate_news_input_tokens,
        max_tokens=config.news_max_tokens,
        searches=max_uses,
    )


async def estimate_smoke(db: AsyncSession, config: AgentConfig) -> Decimal:
    """Оценка цены проверки: разбор, новости одного игрока и два вызова анализа."""
    parse = await price_for(db, config.parse_model)
    analysis = await price_for(db, config.analysis_model)
    total = _tokens_cost(parse.input, parse.output, *PARSE_TOKENS)
    total += await _news_estimate(db, config, min(config.news_max_uses, NEWS_USES))
    total += 2 * _tokens_cost(
        max(analysis.input, analysis.cache_write_5m),
        analysis.output,
        config.estimate_analysis_input_tokens,
        config.estimate_analysis_output_tokens,
    )
    return total.quantize(ESTIMATE_STEP, rounding=ROUND_UP)


async def max_smoke(db: AsyncSession, config: AgentConfig) -> Decimal:
    """Худший случай проверки: разбор, разговор новостей со всеми продолжениями и
    просьбой (поиски каждого запроса), два разговора анализа со всеми итерациями — все
    по худшему случаю вызова (весь max_tokens)."""
    parse = await price_for(db, config.parse_model)
    analysis = await price_for(db, config.analysis_model)
    total = worst_case_usd(parse, input_tokens=PARSE_TOKENS[0], max_tokens=config.parse_max_tokens)
    total += await _news_worst(db, config, min(config.news_max_uses, NEWS_USES))
    total += (
        2
        * config.analysis_max_iterations
        * worst_case_usd(
            analysis,
            input_tokens=config.estimate_analysis_input_tokens,
            max_tokens=config.analysis_max_tokens,
        )
    )
    return total.quantize(ESTIMATE_STEP, rounding=ROUND_UP)


def _match_day() -> Any:
    return func.coalesce(Match.match_date, Tournament.start_date)


async def smoke_match(db: AsyncSession, match_id: int | None) -> Match:
    """Матч для анализа: указанный или последний сыгранный в базе (у матча без даты —
    начало турнира, как в досье: у архива Сакманна дат матчей нет)."""
    if match_id is not None:
        match = await db.get(Match, match_id)
        if match is None:
            raise AppError(404, "agent_smoke.match_not_found", match=match_id)
        return match
    found = await db.scalar(
        select(Match)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.status.in_(RESULT_STATUSES), _match_day().is_not(None))
        .order_by(_match_day().desc(), Match.id.desc())
        .limit(1)
    )
    if found is None:
        raise AppError(404, "agent_smoke.no_matches")
    return found


async def _dossier_moment(db: AsyncSession, match: Match) -> datetime:
    """День матча: досье видит только матчи строго раньше него, поэтому результат самого
    матча (форма, личные встречи) в досье не попадает. Дня нет — сейчас."""
    day = match.match_date
    if day is None and match.tournament_id is not None:
        day = await db.scalar(
            select(Tournament.start_date).where(Tournament.id == match.tournament_id)
        )
    if day is None:
        return datetime.now(UTC)
    return datetime.combine(day, time(0), UTC)


async def run_smoke(
    db: AsyncSession,
    *,
    match_id: int | None = None,
    progress: Callable[[str], None] | None = None,
    report: SmokeReport | None = None,
) -> SmokeReport:
    """Проверка на ключе администратора. Сбой шага — ClaudeStepError (учет записан, в
    report — вызовы до сбоя)."""
    config = await load_agent_config(db)
    report = report if report is not None else SmokeReport()
    hooks = _Hooks(db, report.calls)
    key = await key_for(db, key_source="admin", user_id=0)
    await db.commit()
    say = progress or (lambda _: None)

    say("parse")
    client = client_for(key, timeout=float(config.parse_timeout_s))
    parsed = await parse_text(client, SAMPLE_TEXT, config, hooks)
    report.parsed_events = len(parsed.events)

    match = await smoke_match(db, match_id)
    report.match_id = match.id
    player = await db.get_one(Player, match.player1_id)
    say("news")
    try:
        outcome = await fetch_news(
            client_for(key, timeout=float(config.news_timeout_s)),
            targets=[NewsTarget(position=1, player_id=player.id, name=player.name)],
            match_label=player.name,
            today=datetime.now(UTC).date(),
            config=config,
            hooks=hooks,
            max_uses=min(config.news_max_uses, NEWS_USES),
        )
    except ClaudeStepError as exc:
        if exc.is_key_failure:
            raise
        report.news_failure = failure_text(exc)
    else:
        report.news_facts = len(outcome.facts)
        report.news_errors = outcome.search_errors
        report.news_searched = outcome.searched

    say("dossier")
    surface = await db.scalar(
        select(Tournament.surface).where(Tournament.id == match.tournament_id)
    )
    dossier = await build_dossier(
        db,
        match,
        as_of=await _dossier_moment(db, match),
        best_of=match.best_of or 3,
        surface=surface or "hard",
    )
    await db.commit()
    report.p_base = dossier.p_base.p1_win
    stream_client = client_for(
        key, timeout=anthropic.Timeout(float(config.analysis_stream_timeout_s), connect=5.0)
    )
    prompt = load_prompt(*ANALYSIS_PROMPT)
    refs = set((dossier.content.get("refs") or {}).keys())
    for number in (1, 2):
        say(f"analysis {number}")
        assessed = await assess_match(
            stream_client,
            prompt=prompt,
            dossier_text=dossier.text,
            today=datetime.now(UTC).date(),
            p_base=Probs3(**dossier.p_base.as_dict()),
            refs=refs,
            highlight=0.08,
            config=config,
            hooks=hooks,
        )
        report.p_claude = assessed.assessment.p1_win
    return report


# --- только шаг новостей (agent-smoke --only news) ---


@dataclass(frozen=True)
class NewsOptions:
    """Варианты шага новостей для сравнения на одном игроке: None — как в настройках
    агента."""

    model: str | None = None
    dynamic_filtering: bool | None = None
    max_uses: int | None = None
    prompt_cache: bool | None = None


@dataclass(frozen=True)
class ModelSupport:
    """Что модель принимает по capabilities API моделей: веб-поиск и programmatic tool
    calling (без него фильтрация поиска кодом дает 400). None — API не сообщил."""

    web_search: bool | None
    code_execution: bool | None


@dataclass
class NewsSmokeReport:
    """Итог шага новостей одного игрока: вызовы, проверенные факты с источниками, поиски,
    ошибки поиска и кода, сбой шага."""

    player_id: int
    player_name: str
    max_uses: int
    calls: list[SmokeCall] = field(default_factory=list)
    facts: list[NewsFact] = field(default_factory=list)
    search_errors: tuple[str, ...] = ()
    code_errors: tuple[str, ...] = ()
    limited: int = 0
    dropped: int = 0
    searched: bool = False
    failure: str | None = None

    @property
    def searches(self) -> int:
        return sum(call.web_searches for call in self.calls)

    @property
    def total_usd(self) -> Decimal:
        return sum((call.cost_usd for call in self.calls), Decimal(0))

    @property
    def no_cache_usd(self) -> Decimal | None:
        """Цена того же разговора без точки кэша (по итерациям всех вызовов). None — у
        какого-то вызова итераций нет: пересчет был бы неполным."""
        prices = [call.no_cache_usd for call in self.calls]
        if not prices or any(price is None for price in prices):
            return None
        return sum((price for price in prices if price is not None), Decimal(0))

    def problems(self) -> list[tuple[str, dict[str, Any]]]:
        """Что не подтвердилось (ключи cli.agent_smoke.problems.*): шаг не выполнен или
        ни один поиск не прошел. Ноль фактов — не сбой: новостей может не быть."""
        if self.failure is not None:
            return [("news_failed", {"message": self.failure})]
        if not self.searched or self.searches == 0:
            return [("search", {})]
        return []


def news_config(config: AgentConfig, options: NewsOptions) -> AgentConfig:
    """Настройки агента с вариантами шага новостей. Неверное значение (модель, число
    поисков) — AppError 400 agent_config.invalid."""
    changes = {
        name: value
        for name, value in (
            ("news_model", options.model),
            ("news_dynamic_filtering", options.dynamic_filtering),
            ("news_max_uses", options.max_uses),
            ("news_prompt_cache", options.prompt_cache),
        )
        if value is not None
    }
    try:
        return AgentConfig.model_validate({**config.model_dump(), **changes})
    except ValidationError as exc:
        errors = exc.errors()
        name = str(errors[0]["loc"][0]) if errors and errors[0]["loc"] else ""
        raise AppError(400, "agent_config.invalid", name=name) from None


async def smoke_player(db: AsyncSession, player_id: int | None) -> Player:
    """Игрок для новостей: указанный или первый игрок последнего сыгранного матча."""
    if player_id is not None:
        player = await db.get(Player, player_id)
        if player is None:
            raise AppError(404, "agent_smoke.player_not_found", player=player_id)
        return player
    match = await smoke_match(db, None)
    return await db.get_one(Player, match.player1_id)


async def estimate_news_smoke(db: AsyncSession, config: AgentConfig) -> tuple[Decimal, Decimal]:
    """Оценка и худший случай шага новостей одного игрока (с округлением вверх до цента)."""
    estimate = await _news_estimate(db, config, config.news_max_uses)
    worst = await _news_worst(db, config, config.news_max_uses)
    return (
        estimate.quantize(ESTIMATE_STEP, rounding=ROUND_UP),
        worst.quantize(ESTIMATE_STEP, rounding=ROUND_UP),
    )


def _supported(value: Any, *path: str) -> bool | None:
    """capabilities.<path>.supported; поля нет — None (старый ответ API или подделка)."""
    for name in path:
        value = getattr(value, name, None)
        if value is None:
            return None
    flag = getattr(value, "supported", None)
    return flag if isinstance(flag, bool) else None


async def check_news_model(db: AsyncSession, config: AgentConfig) -> ModelSupport:
    """Принимает ли модель новостей веб-поиск (capabilities.server_tools.web_search) и,
    если включена фильтрация кодом, programmatic tool calling (capabilities.code_execution).
    Не принимает — AppError до платного вызова. Запрос models.retrieve бесплатный."""
    key = await key_for(db, key_source="admin", user_id=0)
    await db.commit()
    client = client_for(key, timeout=CHECK_TIMEOUT_S)
    try:
        with claude_errors():
            info = await client.models.retrieve(config.news_model)
    except ClaudeStepError as exc:
        if exc.params.get("status") == 404:
            raise AppError(404, "agent_smoke.model_unavailable", model=config.news_model) from None
        raise
    caps = info.capabilities
    support = ModelSupport(
        web_search=_supported(caps, "server_tools", "web_search"),
        code_execution=_supported(caps, "code_execution"),
    )
    if support.web_search is False:
        raise AppError(409, "agent_smoke.no_web_search", model=config.news_model)
    if config.news_dynamic_filtering and support.code_execution is False:
        raise AppError(409, "agent_smoke.no_code_execution", model=config.news_model)
    return support


async def run_news_smoke(
    db: AsyncSession, *, config: AgentConfig, player: Player
) -> NewsSmokeReport:
    """Шаг новостей одного игрока на ключе администратора с настройками config. Новости
    не пишутся, каждый вызов — строка agent_runs. Сбой шага — в report.failure (сбой
    ключа — ClaudeStepError)."""
    report = NewsSmokeReport(
        player_id=player.id, player_name=player.name, max_uses=config.news_max_uses
    )
    key = await key_for(db, key_source="admin", user_id=0)
    await db.commit()
    try:
        outcome = await fetch_news(
            client_for(key, timeout=float(config.news_timeout_s)),
            targets=[NewsTarget(position=1, player_id=player.id, name=player.name)],
            match_label=player.name,
            today=datetime.now(UTC).date(),
            config=config,
            hooks=_Hooks(db, report.calls),
            max_uses=config.news_max_uses,
        )
    except ClaudeStepError as exc:
        if exc.is_key_failure:
            raise
        report.failure = failure_text(exc)
        return report
    report.facts = outcome.facts
    report.search_errors = outcome.search_errors
    report.code_errors = outcome.code_errors
    report.limited = outcome.limited
    report.dropped = outcome.dropped
    report.searched = outcome.searched
    return report
