"""Шаг новостей: Sonnet ищет свежие факты об игроках матча (web_search) и записывает их
своим инструментом record_news (strict) в том же запросе.

Каждый факт обязан ссылаться на адрес из результатов поиска этого разговора: факты с
другими адресами отбрасываются. Ошибка поиска приходит блоком web_search_tool_result с
error_code (ответ 200) — она попадает в итог, анализ идет дальше; max_uses_exceeded
(попытка сверх разрешенных поисков) сбоем не считается. Сколько поисков разрешено, модель
видит в сообщении. Номер игрока в запросе — его место в матче (1 или 2), даже когда
новости нужны только второму. pause_turn — продолжение
тем же разговором (ответ ассистента как есть, те же tools), не больше
news_max_pause_continuations раз. Модель закончила без record_news — одна просьба
вызвать его. Принудительный tool_choice на Sonnet 5.5 дает 400, поэтому только так.
news_timeout_s — предел всего разговора (запрос, продолжения и просьба), а не каждого
запроса. Сайт из allowed_domains, закрытый для робота Anthropic, API отклоняет вместе со
всем запросом (400 «domains are not accessible to our user agent»): такие сайты шаг
убирает из списка и повторяет первый запрос один раз. Шаг ничего не пишет в базу: факты
сохраняет сервис. Лимиты поиска на анализ и
на день проверяет сервис перед каждым запросом разговора (StepHooks.before_call получает
searches = max_uses): max_uses действует на один запрос, а продолжение и просьба —
новые запросы.

Поиск — web_search_20260209 у любой модели: без programmatic tool calling (Haiku 4.5)
эта версия работает с allowed_callers ["direct"] (server-tools, «ZDR and
allowed_callers»). По умолчанию поиск прямой; news_dynamic_filtering — фильтрация
результатов кодом на стороне Anthropic (allowed_callers не задается). Тогда в ответе есть
блоки выполнения кода, а пары server_tool_use и web_search_tool_result идут с полем
caller: адреса для сверки и ошибки поиска берутся из всех таких блоков, как и без
фильтрации; ответ с контейнером продолжается в том же контейнере. Точка кэша на system
(news_prompt_cache) включает и автоматическую запись в кэш после каждого результата
поиска: без точки ее нет, но тогда каждая следующая итерация серверного цикла читает
весь предыдущий вход по полной цене (tool-use-with-prompt-caching, «Server tool results
are cached automatically»).
"""

import asyncio
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from functools import partial
from typing import Any, Literal

import anthropic
import structlog
from anthropic.types import (
    BashCodeExecutionToolResultBlock,
    CodeExecutionToolResultBlock,
    Message,
    MessageParam,
    TextEditorCodeExecutionToolResultBlock,
    ToolUnionParam,
)
from pydantic import ValidationError

from app.agent.calls import CallSpec, StepHooks, assistant_turn, call, create, estimate_tokens
from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError
from app.agent.prompts import NEWS_PROMPT, NEWS_REQUEST, NEWS_RETRY, load_prompt
from app.agent.runs import Usage
from app.agent.schemas import NEWS_SCHEMA_VERSION, NewsItem, NewsReport, news_schema

log = structlog.get_logger(__name__)

KIND = "news"
RECORD_TOOL = "record_news"
RECORD_DESCRIPTION = (
    "Call once after searching: the facts you found about each player, "
    "each with its source URL from the search results."
)
SEARCH_TOOL = "web_search_20260209"
# Поиск без фильтрации кодом: проще проверить адреса и посчитать вход (understand: 1.3)
ALLOWED_CALLERS: list[Literal["direct"]] = ["direct"]
# Результаты выполнения кода (фильтрация поиска): их ошибки идут в лог и в итог шага
CODE_RESULTS = (
    CodeExecutionToolResultBlock,
    BashCodeExecutionToolResultBlock,
    TextEditorCodeExecutionToolResultBlock,
)
SUMMARY_MAX = 200
SOURCE_NAME_MAX = 200
DETAIL_MAX = 200
URL_MAX = 2000
ITEMS_PER_PLAYER = 5


@dataclass(frozen=True)
class NewsTarget:
    """Игрок, о котором ищем: номер — его место в матче (1 или 2, как в строке «Матч»
    запроса, даже если в списке он один), id и имя латиницей."""

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
    вызвала record_news. limited — попытки поиска сверх max_uses (не сбой: разрешенные
    поиски прошли). misplaced — группы record_news с номером игрока не из запроса,
    reported — id игроков, о которых модель ответила (с фактами или без). code_errors —
    сбои выполнения кода при фильтрации поиска: error_code инструмента или
    «return_code:N» упавшего кода (участнику не показываются)."""

    facts: list[NewsFact]
    searches: int
    search_errors: tuple[str, ...]
    dropped: int
    agent_run_id: int | None
    usage: Usage
    searched: bool
    limited: int = 0
    misplaced: int = 0
    reported: frozenset[int] = frozenset()
    code_errors: tuple[str, ...] = ()


# Отказ API из-за сайтов, закрытых для робота Anthropic (текст ответа 400)
_BLOCKED_DOMAINS = re.compile(r"domains are not accessible to our user agent: \[([^\]]*)\]")
_QUOTED = re.compile(r"'([^']+)'|\"([^\"]+)\"")


def blocked_domains(exc: ClaudeStepError) -> set[str]:
    """Сайты из отказа «domains are not accessible to our user agent» (пусто — отказ
    другой)."""
    if exc.code != "ai.bad_request" or not exc.api_message:
        return set()
    found = _BLOCKED_DOMAINS.search(exc.api_message)
    if found is None:
        return set()
    return {(a or b).strip().lower() for a, b in _QUOTED.findall(found.group(1))}


def _tools(
    config: AgentConfig, max_uses: int, skip: frozenset[str] = frozenset()
) -> list[ToolUnionParam]:
    search: dict[str, Any] = {"type": SEARCH_TOOL, "name": "web_search", "max_uses": max_uses}
    if not config.news_dynamic_filtering:
        search["allowed_callers"] = ALLOWED_CALLERS
    domains = [domain for domain in config.news_domains if domain.split("/")[0] not in skip]
    if domains:
        search["allowed_domains"] = domains
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


# Модель попробовала искать сверх max_uses: разрешенные поиски прошли, это не сбой поиска
# (иначе участник видел бы «часть поисков не удалась»), а только запись в лог
MAX_USES_EXCEEDED = "max_uses_exceeded"


@dataclass
class _Found:
    """Что собрано из ответов разговора: адреса результатов поиска, ошибки поиска,
    попытки сверх max_uses, ошибки выполнения кода и число удачных поисков."""

    urls: set[str] = field(default_factory=set)
    errors: list[str] = field(default_factory=list)
    limited: list[str] = field(default_factory=list)
    code_errors: list[str] = field(default_factory=list)
    searched: int = 0


def _code_error(content: Any) -> str | None:
    """Сбой выполнения кода фильтрации: ошибка инструмента (error_code) или упавший код —
    ненулевой return_code (Traceback в stderr или превышение 90 с на ячейку: тогда в
    выводе detection_timeout, а error_code нет; code-execution-tool, «Tool versions»)."""
    code = getattr(content, "error_code", None)
    if code is not None:
        return str(code)
    returned = getattr(content, "return_code", None)
    if isinstance(returned, int) and returned != 0:
        return f"return_code:{returned}"
    return None


def _search_results(message: Message, found: _Found) -> None:
    """Адреса и коды ошибок поиска из ответа. Блоки web_search_tool_result берутся все:
    и прямого поиска, и вызванные кодом фильтрации (с полем caller). Попытки сверх
    max_uses — в limited, остальные ошибки поиска — в errors, сбои кода — в
    code_errors."""
    for block in message.content:
        if isinstance(block, CODE_RESULTS):
            failure = _code_error(block.content)
            if failure is not None:
                found.code_errors.append(failure)
            continue
        if block.type != "web_search_tool_result":
            continue
        content = block.content
        if isinstance(content, list):
            found.searched += 1
            found.urls.update(item.url for item in content)
        elif str(content.error_code) == MAX_USES_EXCEEDED:
            found.limited.append(MAX_USES_EXCEEDED)
        else:
            found.errors.append(str(content.error_code))


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


@dataclass(frozen=True)
class _Facts:
    facts: list[NewsFact]
    dropped: int
    misplaced: int
    reported: frozenset[int]


def _facts(
    report: NewsReport, targets: Sequence[NewsTarget], *, urls: set[str], since: date, today: date
) -> _Facts:
    """Проверенные факты. Группа с номером игрока не из запроса отбрасывается целиком:
    чей это факт, неизвестно (misplaced), а игрок такой группы не считается проверенным."""
    by_position = {target.position: target for target in targets}
    facts: list[NewsFact] = []
    dropped = 0
    misplaced = 0
    reported: set[int] = set()
    seen: set[tuple[int, str]] = set()
    for group in report.players:
        target = by_position.get(group.player)
        if target is None:
            dropped += len(group.items)
            misplaced += 1
            continue
        reported.add(target.player_id)
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
    return _Facts(facts, dropped, misplaced, frozenset(reported))


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
        max_uses=max_uses,
    )
    system_block: dict[str, Any] = {"type": "text", "text": prompt.text}
    if config.news_prompt_cache:
        system_block["cache_control"] = {"type": "ephemeral"}
    system: list[Any] = [system_block]
    tools = _tools(config, max_uses)
    messages: list[MessageParam] = [{"role": "user", "content": user_text}]
    found = _Found()
    # Контейнер выполнения кода (фильтрация поиска): продолжение идет в том же
    container: str | None = None
    total = Usage()
    run_id: int | None = None
    continuations = 0
    asked = False
    previous: Usage | None = None
    skipped: frozenset[str] = frozenset()
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
        params: dict[str, Any] = {
            "model": config.news_model,
            "max_tokens": config.news_max_tokens,
            "system": system,
            "tools": tools,
            "messages": list(messages),
            "output_config": {"effort": config.news_effort},
        }
        if container is not None:
            params["container"] = container
        try:
            result = await call(
                hooks, spec, partial(create, client, **params), timeout_s=left, read=_read
            )
        except ClaudeStepError as exc:
            # Закрытые сайты отклоняют только первый запрос: убираем их и пробуем еще раз.
            # Если в списке не осталось ни одного сайта — сбой, а не поиск по всему вебу
            blocked = blocked_domains(exc) - skipped
            remaining = [d for d in config.news_domains if d.split("/")[0] not in skipped | blocked]
            if previous is not None or not blocked or not remaining or skipped:
                raise
            skipped = skipped | blocked
            log.warning("news.domains_blocked", domains=sorted(blocked))
            tools = _tools(config, max_uses, skipped)
            continue
        message = result.message
        total = total + result.usage
        previous = result.usage
        run_id = result.agent_run_id
        _search_results(message, found)
        if message.container is not None:
            container = message.container.id
        report = result.value
        if report is not None:
            checked = _facts(report, targets, urls=found.urls, since=since, today=today)
            if found.limited:
                log.info("news.max_uses_exceeded", attempts=len(found.limited), max_uses=max_uses)
            if found.code_errors:
                log.warning("news.code_errors", codes=sorted(set(found.code_errors)))
            return NewsOutcome(
                facts=checked.facts,
                searches=total.web_searches,
                search_errors=tuple(found.errors),
                dropped=checked.dropped,
                agent_run_id=run_id,
                usage=total,
                searched=found.searched > 0,
                limited=len(found.limited),
                misplaced=checked.misplaced,
                reported=checked.reported,
                code_errors=tuple(found.code_errors),
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
