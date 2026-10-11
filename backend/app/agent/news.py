"""Шаг новостей: Sonnet ищет свежие факты об игроках матча (web_search) и записывает их
своим инструментом record_news (strict) в том же запросе.

Каждый факт обязан ссылаться на адрес из результатов поиска этого разговора: факты с
другими адресами отбрасываются. Ошибка поиска приходит блоком web_search_tool_result с
error_code (ответ 200) — она попадает в итог, анализ идет дальше. pause_turn — продолжение
тем же разговором (ответ ассистента как есть, те же tools), не больше
news_max_pause_continuations раз. Модель закончила без record_news — одна просьба
вызвать его. Принудительный tool_choice на Sonnet 5.5 дает 400, поэтому только так.
news_timeout_s — предел всего разговора (запрос, продолжения и просьба), а не каждого
запроса. Шаг ничего не пишет в базу: факты сохраняет сервис. Лимиты поиска на анализ и
на день проверяет сервис перед каждым запросом разговора (StepHooks.before_call получает
searches = max_uses): max_uses действует на один запрос, а продолжение и просьба —
новые запросы.
"""

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from functools import partial
from typing import Any, Literal

import anthropic
from anthropic.types import Message, MessageParam, ToolUnionParam
from pydantic import ValidationError

from app.agent.calls import CallSpec, StepHooks, assistant_turn, call, create, estimate_tokens
from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError
from app.agent.prompts import NEWS_PROMPT, NEWS_REQUEST, NEWS_RETRY, load_prompt
from app.agent.runs import Usage
from app.agent.schemas import NEWS_SCHEMA_VERSION, NewsItem, NewsReport, news_schema

KIND = "news"
RECORD_TOOL = "record_news"
RECORD_DESCRIPTION = (
    "Call once after searching: the facts you found about each player, "
    "each with its source URL from the search results."
)
# Поиск без фильтрации кодом: проще проверить адреса и посчитать вход (understand: 1.3)
ALLOWED_CALLERS: list[Literal["direct"]] = ["direct"]
SUMMARY_MAX = 200
SOURCE_NAME_MAX = 200
DETAIL_MAX = 200
URL_MAX = 2000
ITEMS_PER_PLAYER = 5


@dataclass(frozen=True)
class NewsTarget:
    """Игрок, о котором ищем: номер в запросе (1 или 2), id и имя латиницей."""

    position: Literal[1, 2]
    player_id: int
    name: str


@dataclass(frozen=True)
class NewsFact:
    """Проверенный факт для player_news."""

    player_id: int
    kind: str
    summary: str
    published_at: date
    source_url: str
    source_name: str
    details: dict[str, Any] | None


@dataclass(frozen=True)
class NewsOutcome:
    """Итог шага: факты, число поисков, коды ошибок поиска, сколько фактов отброшено,
    id последней строки agent_runs и usage всех вызовов. searched — хотя бы один поиск
    вернул результаты (пусть пустые): без этого новости не проверены, даже если модель
    вызвала record_news."""

    facts: list[NewsFact]
    searches: int
    search_errors: tuple[str, ...]
    dropped: int
    agent_run_id: int | None
    usage: Usage
    searched: bool


def _tools(config: AgentConfig, max_uses: int) -> list[ToolUnionParam]:
    search: dict[str, Any] = {
        "type": "web_search_20260209",
        "name": "web_search",
        "max_uses": max_uses,
        "allowed_callers": ALLOWED_CALLERS,
    }
    if config.news_domains:
        search["allowed_domains"] = list(config.news_domains)
    record: dict[str, Any] = {
        "name": RECORD_TOOL,
        "description": RECORD_DESCRIPTION,
        "strict": True,
        "input_schema": news_schema(),
    }
    return [search, record]  # type: ignore[list-item]


def _record_input(message: Message) -> Any | None:
    for block in message.content:
        if block.type == "tool_use" and block.name == RECORD_TOOL:
            return block.input
    return None


def _read(message: Message) -> tuple[NewsReport | None, str | None]:
    """Вход record_news по схеме (None — инструмент не вызван)."""
    raw = _record_input(message)
    if raw is None:
        return None, None
    try:
        return NewsReport.model_validate(raw), None
    except ValidationError:
        raise ClaudeStepError("ai.bad_output", detail="schema") from None


def _search_results(message: Message, urls: set[str], errors: list[str]) -> int:
    """Адреса и коды ошибок поиска из ответа; возвращает число удачных поисков."""
    done = 0
    for block in message.content:
        if block.type != "web_search_tool_result":
            continue
        content = block.content
        if isinstance(content, list):
            done += 1
            urls.update(item.url for item in content)
        else:
            errors.append(str(content.error_code))
    return done


def _day(value: str) -> date | None:
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def _clean(value: str, limit: int) -> str:
    return " ".join(value.split())[:limit]


def _fact(
    item: NewsItem, target: NewsTarget, *, urls: set[str], since: date, today: date
) -> NewsFact | None:
    """Факт годится: адрес из поиска, дата в периоде, текст не пустой; у результата
    матча — подробности (соперник, счет, турнир, дата, победа)."""
    url = item.source_url.strip()
    if url not in urls or len(url) > URL_MAX:
        return None
    published = _day(item.published_at)
    if published is None or not since <= published <= today:
        return None
    summary = _clean(item.summary, SUMMARY_MAX)
    if not summary:
        return None
    details: dict[str, Any] | None = None
    if item.kind == "result":
        result = item.result
        played = _day(result.date) if result is not None else None
        if result is None or played is None:
            return None
        details = {
            "opponent": _clean(result.opponent, DETAIL_MAX),
            "score": _clean(result.score, DETAIL_MAX),
            "tournament": _clean(result.tournament, DETAIL_MAX),
            "date": played.isoformat(),
            "won": result.won,
        }
    return NewsFact(
        player_id=target.player_id,
        kind=item.kind,
        summary=summary,
        published_at=published,
        source_url=url,
        source_name=_clean(item.source_name, SOURCE_NAME_MAX),
        details=details,
    )


def _facts(
    report: NewsReport, targets: Sequence[NewsTarget], *, urls: set[str], since: date, today: date
) -> tuple[list[NewsFact], int]:
    by_position = {target.position: target for target in targets}
    facts: list[NewsFact] = []
    dropped = 0
    seen: set[tuple[int, str]] = set()
    for group in report.players:
        target = by_position.get(group.player)
        if target is None:
            dropped += len(group.items)
            continue
        kept = 0
        for item in group.items:
            fact = _fact(item, target, urls=urls, since=since, today=today)
            key = (target.player_id, item.source_url.strip())
            if fact is None or key in seen or kept >= ITEMS_PER_PLAYER:
                dropped += 1
                continue
            seen.add(key)
            facts.append(fact)
            kept += 1
    return facts, dropped


async def fetch_news(
    client: anthropic.AsyncAnthropic,
    *,
    targets: Sequence[NewsTarget],
    match_label: str,
    today: date,
    config: AgentConfig,
    hooks: StepHooks,
    max_uses: int,
) -> NewsOutcome:
    """Новости игроков матча одним разговором. Сбой вызова — ClaudeStepError (учет
    записан); модель не вызвала record_news и после просьбы — ai.bad_output."""
    prompt = load_prompt(*NEWS_PROMPT)
    since = today - timedelta(days=config.news_lookback_days)
    user_text = load_prompt(*NEWS_REQUEST).format(
        today=today.isoformat(),
        since=since.isoformat(),
        days=config.news_lookback_days,
        match=match_label,
        players="\n".join(f"{target.position}. {target.name}" for target in targets),
    )
    system: list[Any] = [
        {"type": "text", "text": prompt.text, "cache_control": {"type": "ephemeral"}}
    ]
    tools = _tools(config, max_uses)
    messages: list[MessageParam] = [{"role": "user", "content": user_text}]
    urls: set[str] = set()
    errors: list[str] = []
    searched = 0
    total = Usage()
    run_id: int | None = None
    continuations = 0
    asked = False
    previous: Usage | None = None
    loop = asyncio.get_running_loop()
    deadline = loop.time() + config.news_timeout_s
    while True:
        left = deadline - loop.time()
        if left <= 0:
            raise ClaudeStepError("ai.timeout", detail="step_timeout")
        base = estimate_tokens(prompt.text, user_text)
        if previous is not None:
            base = previous.prompt_tokens + previous.output_tokens + base
        spec = CallSpec(
            kind=KIND,
            model=config.news_model,
            effort=config.news_effort,
            prompt_version=prompt.version_id,
            schema_version=NEWS_SCHEMA_VERSION,
            input_tokens=base + config.estimate_news_input_tokens,
            max_tokens=config.news_max_tokens,
            searches=max_uses,
        )
        result = await call(
            hooks,
            spec,
            partial(
                create,
                client,
                model=config.news_model,
                max_tokens=config.news_max_tokens,
                system=system,
                tools=tools,
                messages=list(messages),
                output_config={"effort": config.news_effort},
            ),
            timeout_s=left,
            read=_read,
        )
        message = result.message
        total = total + result.usage
        previous = result.usage
        run_id = result.agent_run_id
        searched += _search_results(message, urls, errors)
        report = result.value
        if report is not None:
            facts, dropped = _facts(report, targets, urls=urls, since=since, today=today)
            return NewsOutcome(
                facts=facts,
                searches=total.web_searches,
                search_errors=tuple(errors),
                dropped=dropped,
                agent_run_id=run_id,
                usage=total,
                searched=searched > 0,
            )
        if message.stop_reason == "pause_turn":
            if continuations >= config.news_max_pause_continuations:
                raise ClaudeStepError("ai.bad_output", detail="pause_limit")
            continuations += 1
            messages.append(assistant_turn(message))
            continue
        if asked:
            raise ClaudeStepError("ai.bad_output", detail="news_not_recorded")
        asked = True
        messages.append(assistant_turn(message))
        messages.append({"role": "user", "content": load_prompt(*NEWS_RETRY).text})
