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
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, time
from decimal import ROUND_UP, Decimal
from typing import Any

import anthropic
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.analysis import assess_match
from app.agent.calls import CallInfo
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.news import NewsTarget, fetch_news
from app.agent.parse import parse_text
from app.agent.prompts import ANALYSIS_PROMPT, load_prompt
from app.agent.runs import price_for, worst_case_usd
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


@dataclass(frozen=True)
class SmokeCall:
    """Один вызов проверки: шаг, модель, токены, поиски, стоимость, ошибка."""

    step: str
    model: str
    input_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    output_tokens: int
    web_searches: int
    cost_usd: Decimal
    error: str | None


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
    def __init__(self, db: AsyncSession, report: SmokeReport) -> None:
        self.db = db
        self.report = report

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
        self.report.calls.append(
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


async def estimate_smoke(db: AsyncSession, config: AgentConfig) -> Decimal:
    """Оценка цены проверки: разбор, новости одного игрока и два вызова анализа."""
    parse = await price_for(db, config.parse_model)
    news = await price_for(db, config.news_model)
    analysis = await price_for(db, config.analysis_model)
    total = _tokens_cost(parse.input, parse.output, *PARSE_TOKENS)
    total += _tokens_cost(
        max(news.input, news.cache_write_5m),
        news.output,
        config.estimate_news_input_tokens,
        config.estimate_news_output_tokens,
    )
    total += config.news_max_uses * news.search_price
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
    news = await price_for(db, config.news_model)
    analysis = await price_for(db, config.analysis_model)
    total = worst_case_usd(parse, input_tokens=PARSE_TOKENS[0], max_tokens=config.parse_max_tokens)
    total += (config.news_max_pause_continuations + 2) * worst_case_usd(
        news,
        input_tokens=config.estimate_news_input_tokens,
        max_tokens=config.news_max_tokens,
        searches=min(config.news_max_uses, NEWS_USES),
    )
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
    hooks = _Hooks(db, report)
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
