"""Проверка конвейера на живом ключе администратора (команда agent-smoke): один разбор
образца, новости одного игрока (web_search и record_news в одном запросе) и анализ
одного матча из базы двумя разговорами подряд — второй обязан прочитать кэш промпта.

Прогнозы и новости не пишутся. Каждый вызов — строка agent_runs (деньги потрачены, они
входят в бюджет месяца), досье — в dossiers (общие данные). Цена — около $0,30
(estimate_smoke).
"""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import ROUND_UP, Decimal

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.analysis import assess_match
from app.agent.calls import CallInfo
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.news import NewsTarget, fetch_news
from app.agent.parse import parse_text
from app.agent.prompts import ANALYSIS_PROMPT, load_prompt
from app.agent.runs import price_for
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
    match_id: int | None = None
    p_base: float | None = None
    p_claude: float | None = None

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
        self, *, kind: str, model: str, input_tokens: int, max_tokens: int, searches: int
    ) -> None:
        await price_for(self.db, model)
        # Транзакция не висит открытой, пока ждем Claude
        await self.db.commit()

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


async def smoke_match(db: AsyncSession, match_id: int | None) -> Match:
    """Матч для анализа: указанный или последний сыгранный в базе."""
    if match_id is not None:
        match = await db.get(Match, match_id)
    else:
        match = await db.scalar(
            select(Match)
            .where(Match.status.in_(RESULT_STATUSES), Match.match_date.is_not(None))
            .order_by(Match.match_date.desc(), Match.id.desc())
            .limit(1)
        )
    if match is None:
        raise AppError(404, "common.not_found")
    return match


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
    outcome = await fetch_news(
        client_for(key, timeout=float(config.news_timeout_s)),
        targets=[NewsTarget(position=1, player_id=player.id, name=player.name)],
        match_label=player.name,
        today=datetime.now(UTC).date(),
        config=config,
        hooks=hooks,
        max_uses=min(config.news_max_uses, 2),
    )
    report.news_facts = len(outcome.facts)
    report.news_errors = outcome.search_errors

    say("dossier")
    surface = await db.scalar(
        select(Tournament.surface).where(Tournament.id == match.tournament_id)
    )
    dossier = await build_dossier(
        db,
        match,
        as_of=datetime.now(UTC),
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
