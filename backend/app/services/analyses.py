"""Анализы участника, HTTP-часть: ввод (текст с разбором Claude или форма), «Перед
запуском», запуск и перезапуск, отмена, решение по итогу, список и карточка анализа.
Выполнение — в воркере (app/services/analysis_run.py).

Разбор текста идет синхронно в запросе (2–5 с): до вызова — доступ участника (пауза,
нет ключа, исчерпан лимит), цену разбора отдельно не проверяем. Каждый вызов Claude —
строка agent_runs. Запуск: проверка событий, резерв бюджета под блокировкой
(reserve_for_run), матчи и кэфы участника, активная версия стратегии, статус queued и
задача arq с id «analysis:<id>:<попытка>» — повторная постановка того же запуска
невозможна, двойное нажатие отсекает проверка статуса под той же блокировкой.
Чужой анализ — 404 analysis.not_found, как несуществующий.
"""

import asyncio
import math
import secrets
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_UP, Decimal
from typing import Any, cast

import structlog
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.agent.calls import CallInfo
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.parse import parse_text
from app.agent.runs import price_for
from app.agent.schemas import ASSESSMENT_SCHEMA_VERSION
from app.core.errors import AppError
from app.core.redis import redis_key
from app.db.models import (
    ANALYSIS_ACTIVE_STATUSES,
    AgentRun,
    Analysis,
    Dossier,
    MatchAssessment,
    ModelPrice,
    Player,
    User,
)
from app.db.session import create_sessionmaker
from app.ml.strategy import StrategyParams, margin
from app.schemas.analyses import (
    AnalysisListItem,
    AnalysisListOut,
    AnalysisOut,
    ConfirmIn,
    CorridorOut,
    EstimateOut,
    EventIn,
    FairOut,
    MatchPairOut,
    PairName,
    PreviewEvent,
    PreviewOut,
    PreviewPlayer,
    RestartOut,
    TextKey,
)
from app.services import bookmakers as bookmakers_service
from app.services import play_limits, progress
from app.services.ai_access import (
    LIMIT_REFUSALS,
    access_for,
    after_run_notifications,
    release_reservation,
    reserve_for_run,
    restart_access,
)
from app.services.ai_keys import report_key_failure
from app.services.analysis_input import (
    Confirmed,
    ConfirmedEvent,
    EventDraft,
    Problem,
    archive_date,
    attach_matches,
    check_events,
    find_match,
    money,
    odds_snapshots,
    parsed_input,
    player_facts,
    raise_problem,
    short_odds,
    to_odds,
)
from app.services.analysis_result import fair_probs
from app.services.analysis_run import (
    RestartWork,
    plan_steps,
    record_call,
    reset_steps,
    restart_work,
    running_claude_steps,
)
from app.services.analysis_view import access_out, analysis_out, parse_cost, progress_event
from app.services.app_settings import check_currency, get_app_settings
from app.services.bank import CURRENCY_LOCK
from app.services.claude_key import key_for
from app.services.progress import publish
from app.services.sessions import utcnow
from app.services.strategy_versions import (
    active_version,
    ensure_active,
    params_of,
    prompt_version_of,
)

log = structlog.get_logger(__name__)

TEXT_MAX = 4000
# Разбор стоит денег: не больше 30 новых анализов из текста в час на участника
CREATE_LIMIT = 30
CREATE_WINDOW_SECONDS = 3600
LIST_LIMIT = 20
RUNNABLE = ("needs_confirmation", "failed", "cancelled")
STOPPED = ("failed", "cancelled")
CANCELLABLE = (*ANALYSIS_ACTIVE_STATUSES, "needs_confirmation")
MTOK = Decimal(1_000_000)
ESTIMATE_STEP = Decimal("0.0001")
# Оценка времени (с): подготовка, новости матча, первый вызов анализа и каждая следующая
# пачка параллельных вызовов
SECONDS_BASE = 5
SECONDS_NEWS = 30
SECONDS_ANALYSIS = 60
# Потоков прогресса (SSE) анализа в работе у одного участника одновременно; место
# незакрытого потока освобождается само чуть позже предела потока (30 мин)
STREAM_SLOTS = 5
STREAM_SLOT_SECONDS = progress.MAX_STREAM_SECONDS + 60
RETRY_STREAM_SECONDS = 30
# Статус ответа API на сбой разбора по коду ошибки
_PARSE_STATUS = {
    "ai.rate_limited": 429,
    "ai.overloaded": 503,
    "ai.unavailable": 503,
    "ai.timeout": 503,
    "ai.key_rejected": 409,
    "ai.billing": 409,
    "ai.no_key": 409,
    "ai.no_price": 409,
}

Enqueue = Callable[[int, int, str], Awaitable[None]]


async def get_owned(
    db: AsyncSession, user: User, analysis_id: int, *, lock: bool = False
) -> Analysis:
    """Свой анализ; чужой и несуществующий — 404 analysis.not_found."""
    stmt = select(Analysis).where(Analysis.id == analysis_id, Analysis.user_id == user.id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    found: Analysis | None = await db.scalar(stmt)
    if found is None:
        raise AppError(404, "analysis.not_found")
    return found


# --- ввод ---


async def _hit_create_limit(redis: Redis, user_id: int) -> None:
    key = redis_key("rl", "analyses", user_id)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, CREATE_WINDOW_SECONDS, nx=True)
        count = int((await pipe.execute())[0])
    if count > CREATE_LIMIT:
        wait = max(int(await redis.ttl(key)), 1)
        raise AppError(429, "common.rate_limited", retry_after=wait)


async def _limit_refused(db: AsyncSession, user_id: int, code: str, *, rollback: bool) -> None:
    """Отказ по лимиту месяца или общему бюджету: порог 100% мог пройти без вызова Claude
    (администратор снизил лимит, выросла цена) — предупреждения о расходе, как после
    вызова (не чаще раза в месяц)."""
    if code not in LIMIT_REFUSALS:
        return
    if rollback:
        await db.rollback()
    await after_run_notifications(db, user_id)
    await db.commit()


class ParseHooks:
    """Учет вызова разбора в запросе API (сеанс запроса, commit после каждого вызова).
    Транзакция закрывается до вызова: соединение из пула API не ждет ответа Claude.
    Тот же учет — у разбора в команде приемки acceptance-runs."""

    def __init__(self, db: AsyncSession, user: User, key_source: str, analysis_id: int) -> None:
        self.db = db
        self.user_id = user.id
        self.key_source = key_source
        self.analysis_id = analysis_id
        self.calls = 0

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
        await self.db.commit()
        return None

    async def after_call(self, info: CallInfo) -> int | None:
        self.calls += 1
        run = await record_call(
            self.db,
            info,
            user_id=self.user_id,
            key_source=self.key_source,
            analysis_id=self.analysis_id,
            step=self.calls,
        )
        run_id = run.id
        await self.db.commit()
        return run_id


async def create_form(db: AsyncSession, user: User) -> Analysis:
    """Пустой черновик для ввода формой (без Claude)."""
    analysis = Analysis(
        user_id=user.id, input_text="", input_kind="form", status="needs_confirmation"
    )
    db.add(analysis)
    await db.commit()
    return analysis


async def _parse_aborted(db: AsyncSession, analysis_id: int) -> None:
    """Прерванный разбор — failed (шаг parse) отдельным коротким сеансом: сеанс запроса
    мог сломаться вместе с разбором, а отмена задачи не должна оборвать эту запись."""
    maker = create_sessionmaker(cast(AsyncEngine, db.bind))

    async def mark() -> None:
        # Сначала отпустить транзакцию запроса: она могла держать строку анализа (учет
        # вызова прибавляет его стоимость к analyses.cost_usd)
        try:
            await db.rollback()
        except Exception:
            await db.invalidate()
        async with maker() as session:
            await session.execute(
                update(Analysis)
                .where(Analysis.id == analysis_id, Analysis.status == "parsing")
                .values(
                    status="failed",
                    error_code="common.internal",
                    error_params={},
                    failed_step="parse",
                    finished_at=utcnow(),
                )
            )
            await session.commit()

    try:
        await asyncio.shield(mark())
    except BaseException:
        log.warning("analysis.parse_abort_not_saved", analysis_id=analysis_id)


async def create_from_text(db: AsyncSession, redis: Redis, user: User, text: str) -> Analysis:
    """Анализ из текста: разбор Claude (Haiku) и статус needs_confirmation. Нет доступа —
    409 с кодом причины; пауза или лимит дня ответственной игры — 409 play.*; сбой
    разбора — анализ failed (шаг parse) и ошибка с кодом."""
    cleaned = text.replace("\x00", "").strip()
    if not cleaned:
        raise AppError(422, "analysis.text_empty")
    if len(cleaned) > TEXT_MAX:
        raise AppError(422, "analysis.text_too_long", max=TEXT_MAX)
    # Разбор — тоже вызов Claude: на паузе и сверх лимита дня ответственной игры не идет
    await play_limits.check(db, user)
    access = await access_for(db, user, estimate_usd=None)
    if not access.allowed:
        await _limit_refused(db, user.id, access.reason or "", rollback=False)
        raise AppError(409, access.reason or "ai.no_key", **access.reason_params)
    await _hit_create_limit(redis, user.id)
    config = await load_agent_config(db)
    analysis = Analysis(user_id=user.id, input_text=cleaned, input_kind="text", status="parsing")
    db.add(analysis)
    await db.commit()
    try:
        key = await key_for(db, key_source=access.key_source, user_id=user.id)
        await db.commit()
        client = client_for(key, timeout=float(config.parse_timeout_s))
        hooks = ParseHooks(db, user, access.key_source, analysis.id)
        parsed = await parse_text(client, cleaned, config, hooks)
    except ClaudeStepError as exc:
        if exc.is_key_failure:
            await report_key_failure(db, access.key_source, user.id, exc.code)
        analysis.status = "failed"
        analysis.error_code = exc.code
        analysis.error_params = {key: str(value) for key, value in exc.params.items()}
        analysis.failed_step = "parse"
        analysis.finished_at = utcnow()
        await db.commit()
        raise AppError(
            _PARSE_STATUS.get(exc.code, 502), exc.code, analysis_id=analysis.id, **exc.params
        ) from None
    except BaseException:
        # Остановка сервера (отмена запроса) или сбой вне Claude: анализ не остается в
        # parsing, из которого его нельзя ни запустить, ни отменить
        await _parse_aborted(db, analysis.id)
        raise
    analysis.parsed = parsed.model_dump(mode="json")
    analysis.bookmaker = (parsed.bookmaker or "").strip()[:64] or None
    analysis.status = "needs_confirmation"
    await db.commit()
    return analysis


# --- оценка и «Перед запуском» ---


@dataclass(frozen=True)
class Estimate:
    """Оценка до запуска. news_players и news_matches — игроки и запросы новостей, которые
    вошли в цену: не больше, чем помещается в лимит поисков анализа."""

    cost_usd: Decimal
    seconds: int
    news_players: int
    reused_matches: int
    reused: frozenset[int]
    news_matches: int = 0


def _drafts(events: Sequence[EventIn]) -> list[EventDraft]:
    drafts: list[EventDraft] = []
    for event in events:
        odds = {
            "ML": [to_odds(value) for value in event.odds.ml],
            "HCP_-1.5": [to_odds(value) for value in event.odds.minus],
            "HCP_+1.5": [to_odds(value) for value in event.odds.plus],
        }
        drafts.append(
            EventDraft(
                player1_id=event.player1_id,
                player2_id=event.player2_id,
                tournament_id=event.tournament_id,
                tournament_name=event.tournament_name or None,
                surface=event.surface,
                best_of=event.best_of,
                round=event.round,
                odds=odds,
                bookmaker=event.bookmaker or None,
                line_no=event.line_no,
            )
        )
    return drafts


def _confirmed_drafts(confirmed: Confirmed) -> list[EventDraft]:
    return [
        EventDraft(
            player1_id=event.player1_id,
            player2_id=event.player2_id,
            tournament_id=event.tournament_id,
            tournament_name=event.tournament_name,
            surface=event.surface,
            best_of=event.best_of,
            round=event.round,
            odds=event.odds,
            bookmaker=event.bookmaker,
            line_no=event.line_no,
        )
        for event in confirmed.events
    ]


async def _prices(db: AsyncSession, config: AgentConfig) -> dict[str, ModelPrice]:
    found: dict[str, ModelPrice] = {}
    for model in config.models():
        try:
            found[model] = await price_for(db, model)
        except ClaudeStepError:
            continue
    return found


def _call_cost(price: ModelPrice, input_tokens: int, output_tokens: int) -> Decimal:
    per_input = max(price.input, price.cache_write_5m)
    return (input_tokens * per_input + output_tokens * price.output) / MTOK


async def _reusable_match(
    db: AsyncSession, match_id: int, config: AgentConfig, prompt_version: str, now: datetime
) -> bool:
    if config.assessment_reuse_hours <= 0:
        return False
    found = await db.scalar(
        select(MatchAssessment.id)
        .join(Dossier, Dossier.id == MatchAssessment.dossier_id)
        .where(
            Dossier.match_id == match_id,
            *_assessment_key(config, prompt_version, now),
            Dossier.as_of >= datetime.combine(now.date(), datetime.min.time(), UTC),
        )
        .limit(1)
    )
    return found is not None


def _assessment_key(config: AgentConfig, prompt_version: str, now: datetime) -> list[Any]:
    return [
        MatchAssessment.model == config.analysis_model,
        MatchAssessment.effort == config.analysis_effort,
        MatchAssessment.prompt_version == prompt_version,
        MatchAssessment.schema_version == ASSESSMENT_SCHEMA_VERSION,
        MatchAssessment.created_at >= now - timedelta(hours=config.assessment_reuse_hours),
    ]


async def _reusable_dossier(
    db: AsyncSession, dossier_id: int, config: AgentConfig, prompt_version: str, now: datetime
) -> bool:
    """Свежая оценка по досье из чекпойнта: перезапуск возьмет его, а не соберет новое
    (как _Runner._reusable)."""
    if config.assessment_reuse_hours <= 0:
        return False
    found = await db.scalar(
        select(MatchAssessment.id)
        .where(
            MatchAssessment.dossier_id == dossier_id,
            *_assessment_key(config, prompt_version, now),
        )
        .limit(1)
    )
    return found is not None


def _stale(checked: datetime | None, cutoff: datetime) -> bool:
    return checked is None or checked < cutoff


async def news_searches_used(db: AsyncSession, analysis_id: int) -> int:
    """Поиски, уже записанные анализом в agent_runs (как _Runner._searches_used)."""
    used = await db.scalar(
        select(func.coalesce(func.sum(AgentRun.web_searches), 0)).where(
            AgentRun.analysis_id == analysis_id, AgentRun.kind == "news"
        )
    )
    return int(used or 0)


def news_requests(config: AgentConfig, searches_used: int = 0) -> int:
    """Сколько запросов новостей воркер успеет до лимита поисков анализа: каждый берет
    max_uses поисков (последний — остаток). Как _Runner._match_news, без лимита дня: он
    общий для всей программы и к моменту шага новостей может измениться."""
    left = config.news_max_searches_per_analysis - searches_used
    return math.ceil(left / config.news_max_uses) if left > 0 else 0


async def estimate_run(
    db: AsyncSession,
    config: AgentConfig,
    events: Sequence[ConfirmedEvent],
    *,
    prompt_version: str,
    now: datetime,
    done: RestartWork | None = None,
    analysis_id: int | None = None,
) -> Estimate:
    """Оценка анализа до запуска: новости — только у матчей с устаревшими новостями
    игроков и не больше, чем помещается в лимит поисков анализа (новости идут по порядку
    матчей, у остальных шаг пропускается); анализ Claude — у матчей без свежей оценки (ее
    берут бесплатно). done — повторный запуск: шаги, которые воркер не повторит (новости,
    оценки, досье из чекпойнта), в оценку и резерв не входят. analysis_id — поиски,
    которые анализ уже потратил, вычитаются из его лимита (как в воркере)."""
    prices = await _prices(db, config)
    work = done or RestartWork(news=frozenset(), assessed=frozenset(), dossiers={})
    ids = {pid for event in events for pid in (event.player1_id, event.player2_id)}
    cutoff = now - timedelta(hours=config.news_ttl_hours)
    checked: dict[int, datetime | None] = {
        pid: when
        for pid, when in await db.execute(
            select(Player.id, Player.news_checked_at).where(Player.id.in_(ids))
        )
    }
    stale_players = {pid for pid in ids if _stale(checked.get(pid), cutoff)}
    used = await news_searches_used(db, analysis_id) if analysis_id is not None else 0
    news_left = news_requests(config, used)
    news_matches = 0
    news_players: set[int] = set()
    analysed = 0
    reused: set[int] = set()
    for event in events:
        match_id = event.match_id
        if match_id is None:
            found = await find_match(db, event.player1_id, event.player2_id, day=now.date())
            match_id = found.id if found is not None else None
        pair = {event.player1_id, event.player2_id}
        if (
            config.news_enabled
            and match_id not in work.news
            and pair & stale_players
            and news_matches < news_left
        ):
            news_matches += 1
            news_players |= pair & stale_players
        if match_id is not None and (
            match_id in work.assessed
            or (
                await _reusable_dossier(db, work.dossiers[match_id], config, prompt_version, now)
                if match_id in work.dossiers
                else await _reusable_match(db, match_id, config, prompt_version, now)
            )
        ):
            reused.add(event.position)
        else:
            analysed += 1
    cost = Decimal(0)
    analysis_price = prices.get(config.analysis_model)
    if analysis_price is not None:
        cost += analysed * _call_cost(
            analysis_price,
            config.estimate_analysis_input_tokens,
            config.estimate_analysis_output_tokens,
        )
    news_price = prices.get(config.news_model)
    if news_price is not None and news_matches:
        per_match = (
            _call_cost(
                news_price, config.estimate_news_input_tokens, config.estimate_news_output_tokens
            )
            + config.estimate_news_searches * news_price.search_price
        )
        cost += news_matches * per_match
    seconds = SECONDS_BASE + SECONDS_NEWS * news_matches
    if analysed:
        batches = math.ceil((analysed - 1) / config.analysis_parallel) if analysed > 1 else 0
        seconds += SECONDS_ANALYSIS * (1 + batches)
    return Estimate(
        cost_usd=cost.quantize(ESTIMATE_STEP, rounding=ROUND_UP),
        seconds=seconds,
        news_players=len(news_players),
        reused_matches=len(reused),
        reused=frozenset(reused),
        news_matches=news_matches,
    )


async def _input_drafts(analysis: Analysis, body: ConfirmIn | None) -> list[EventDraft]:
    if body is not None and body.events is not None:
        return _drafts(body.events)
    if analysis.confirmed:
        return _confirmed_drafts(Confirmed.from_json(analysis.confirmed))
    return []


def _fair_out(fair: dict[tuple[str, int], float]) -> list[FairOut]:
    return [
        FairOut(market=market, selection=selection, q=round(q, 4))  # type: ignore[arg-type]
        for (market, selection), q in sorted(fair.items())
    ]


def _margins(event: EventDraft) -> tuple[float | None, float | None]:
    ml = event.odds.get("ML", [None, None])
    margin_ml = round(margin(ml[0], ml[1]), 4) if ml[0] is not None and ml[1] is not None else None
    minus = event.odds.get("HCP_-1.5", [None, None])
    plus = event.odds.get("HCP_+1.5", [None, None])
    margin_hcp = None
    for a, b in ((minus[0], plus[1]), (minus[1], plus[0])):
        if a is not None and b is not None:
            margin_hcp = round(margin(a, b), 4)
            break
    return margin_ml, margin_hcp


def _corridor(event: EventDraft, params: StrategyParams) -> list[CorridorOut]:
    low, high = params.leg_odds
    return [
        CorridorOut(market=market, selection=selection, odds=short_odds(value))  # type: ignore[arg-type]
        for market, pair in event.odds.items()
        for selection, value in enumerate(pair, start=1)
        if value is not None and low <= value <= high
    ]


async def preview(
    db: AsyncSession, user: User, analysis_id: int, body: ConfirmIn | None
) -> PreviewOut:
    """Карточка «Перед запуском» без Claude: игроки, маржа и рынок без маржи, коридор
    стратегии, оценка цены и времени, доступ и причины запрета."""
    analysis = await get_owned(db, user, analysis_id)
    now = utcnow()
    today = now.date()
    config = await load_agent_config(db)
    version = await active_version(db, user.id)
    params = params_of(version)
    drafts = await _input_drafts(analysis, body)
    confirmed, problems = await check_events(db, drafts, today=today)
    estimate = await estimate_run(
        db,
        config,
        confirmed,
        prompt_version=prompt_version_of(version),
        now=now,
        analysis_id=analysis.id,
    )
    access = await access_for(db, user, estimate_usd=estimate.cost_usd)
    ids = {pid for event in drafts for pid in (event.player1_id, event.player2_id) if pid}
    facts = await player_facts(db, ids, today=today)
    cutoff = now - timedelta(hours=config.news_ttl_hours)
    events: list[PreviewEvent] = []
    for position, draft in enumerate(drafts, start=1):
        margin_ml, margin_hcp = _margins(draft)
        players = []
        for pid in (draft.player1_id, draft.player2_id):
            found = facts.get(pid) if pid else None
            if found is None:
                continue
            players.append(
                PreviewPlayer(
                    id=found.id,
                    name=found.name,
                    country=found.country,
                    elo_rank=found.elo_rank,
                    news_fresh=found.news_checked_at is not None
                    and found.news_checked_at >= cutoff,
                    news_checked_at=found.news_checked_at,
                    last_match=found.last_match,
                )
            )
        events.append(
            PreviewEvent(
                position=position,
                margin_ml=margin_ml,
                margin_hcp=margin_hcp,
                market_p=_fair_out(fair_probs(draft.odds)),
                in_corridor=_corridor(draft, params),
                players=players,
                reused=position in estimate.reused,
                problems=[
                    _problem_text(problem)
                    for problem in problems
                    if problem.params.get("position") == position
                ],
            )
        )
    return PreviewOut(
        events=events,
        problems=[
            _problem_text(problem) for problem in problems if "position" not in problem.params
        ],
        estimate=EstimateOut(
            cost_usd=estimate.cost_usd,
            seconds=estimate.seconds,
            news_players=estimate.news_players,
            reused_matches=estimate.reused_matches,
        ),
        access=access_out(access),
        data_to=await archive_date(db, today=today),
    )


def _problem_text(problem: Problem) -> TextKey:
    return TextKey(key=f"errors.{problem.code}", params=problem.params)


# --- запуск ---


def _bank_from_parse(analysis: Analysis, currency: str) -> Decimal | None:
    parsed = parsed_input(analysis.parsed)
    if parsed is None:
        return None
    if parsed.bank.currency is not None and parsed.bank.currency != currency:
        return None
    return money(parsed.bank.amount)


async def start_run(
    db: AsyncSession,
    redis: Redis,
    user: User,
    analysis_id: int,
    body: ConfirmIn | None,
    *,
    enqueue: Enqueue,
) -> Analysis:
    """Запуск (и повторный запуск после сбоя или отмены): проверка событий, резерв
    бюджета, матчи и кэфы, статус queued и задача воркера. Пауза или достигнутый лимит
    дня ответственной игры — 409 play.* на любом ключе (app/services/play_limits.py).

    Вся транзакция — под разделяемой CURRENCY_LOCK, как у ставки: банк из ввода
    (bank_input, confirmed.bank) пишется в валюте, которую видит смена валюты. Банк из
    формы, открытой до смены (body.currency не та), — 409 common.currency_changed."""
    # До любых блокировок строк (резерв берет строку настроек): порядок, как у смены валюты
    await db.execute(select(func.pg_advisory_xact_lock_shared(CURRENCY_LOCK)))
    analysis = await get_owned(db, user, analysis_id)
    if analysis.status not in RUNNABLE:
        raise AppError(409, "analysis.bad_state", status=analysis.status)
    await play_limits.check(db, user)
    new_events = body is not None and body.events is not None
    if new_events and analysis.confirmed:
        # Подтвержденные события запуска не меняются: другие события — новый анализ
        raise AppError(409, "analysis.bad_state", status=analysis.status)
    now = utcnow()
    today = now.date()
    config = await load_agent_config(db)
    if _call_still_running(analysis, config, now):
        raise AppError(409, "analysis.step_running")
    settings = await get_app_settings(db)
    if body is not None:
        check_currency(settings, body.currency)
    if new_events:
        assert body is not None and body.events is not None
        events, problems = await check_events(db, _drafts(body.events), today=today)
        raise_problem(problems)
        bank = body.bank.quantize(Decimal("0.01")) if body.bank is not None else None
        if bank is None and analysis.input_kind == "text":
            bank = _bank_from_parse(analysis, settings.currency)
        bookmaker = (body.bookmaker or analysis.bookmaker or "").strip()[:64] or None
        confirmed = Confirmed(events=events, bank=bank, bookmaker=bookmaker)
    elif analysis.confirmed:
        confirmed = Confirmed.from_json(analysis.confirmed)
    else:
        raise AppError(422, "analysis.no_events")
    version = await active_version(db, user.id)
    estimate = await estimate_run(
        db,
        config,
        confirmed.events,
        prompt_version=prompt_version_of(version),
        now=now,
        done=None if new_events else restart_work(analysis.checkpoint),
        analysis_id=analysis.id,
    )
    user_id = user.id
    try:
        await reserve_for_run(db, user, analysis, estimate_usd=estimate.cost_usd)
    except AppError as exc:
        await _limit_refused(db, user_id, exc.code, rollback=True)
        raise
    # Под блокировкой строки анализа: второй запуск того же анализа ждал здесь
    if analysis.status not in RUNNABLE or (new_events and analysis.confirmed):
        # Статус — до rollback: после него объект устарел, а ленивая загрузка в async — сбой
        current = analysis.status
        await db.rollback()
        raise AppError(409, "analysis.bad_state", status=current)
    if new_events:
        attached = await attach_matches(db, confirmed.events, day=today)
        db.add_all(odds_snapshots(attached, bookmaker=confirmed.bookmaker, taken_at=now))
        confirmed = Confirmed(events=attached, bank=confirmed.bank, bookmaker=confirmed.bookmaker)
        analysis.confirmed = confirmed.to_json()
        analysis.bank_input = confirmed.bank
        analysis.bookmaker = confirmed.bookmaker
        # Новое название букмекера — в «Мои букмекеры»
        await bookmakers_service.remember(db, user.id, [confirmed.bookmaker])
        parse_tokens, parse_spent = await parse_usage(db, analysis.id)
        steps = plan_steps(
            attached,
            config,
            input_kind=analysis.input_kind,
            parse_tokens=parse_tokens,
            parse_cost=parse_spent,
            parse_model=config.parse_model if analysis.input_kind == "text" else None,
        )
        analysis.checkpoint = {
            "matches": {},
            "steps": [step.model_dump(mode="json") for step in steps],
        }
    else:
        checkpoint = dict(analysis.checkpoint or {})
        checkpoint["steps"] = reset_steps(checkpoint.get("steps") or [])
        analysis.checkpoint = checkpoint
    strategy = await ensure_active(db, user.id)
    analysis.strategy_version_id = strategy.id
    analysis.prompt_version = prompt_version_of(strategy)
    analysis.status = "queued"
    analysis.attempt += 1
    analysis.error_code = None
    analysis.error_params = None
    analysis.failed_step = None
    analysis.finished_at = None
    await db.commit()
    job_id = f"analysis:{analysis.id}:{analysis.attempt}"
    try:
        await enqueue(analysis.id, analysis.attempt, job_id)
    except Exception:
        log.exception("analysis.enqueue_failed", analysis_id=analysis.id)
        locked = await get_owned(db, user, analysis.id, lock=True)
        if locked.status == "queued":
            locked.status = "failed"
            locked.error_code = "analysis.worker_lost"
            locked.finished_at = utcnow()
            await release_reservation(db, locked)
        await db.commit()
        raise AppError(503, "common.busy") from None
    await _publish(redis, analysis, "status")
    return analysis


def _step_window(config: AgentConfig) -> timedelta:
    return timedelta(seconds=max(config.analysis_step_timeout_s, config.news_timeout_s))


def _call_still_running(analysis: Analysis, config: AgentConfig, now: datetime) -> bool:
    """Отмененный анализ, в котором вызов Claude еще идет: задача старого запуска
    доработает шаг и запишет его в чекпойнт. Перезапуск сейчас купил бы тот же шаг второй
    раз, а резерв не учел бы худший случай идущего вызова. Шаг не может идти дольше
    предела шага: зависший после остановки воркера не держит анализ дольше."""
    if analysis.status != "cancelled" or not running_claude_steps(analysis.checkpoint):
        return False
    return analysis.updated_at > now - _step_window(config)


async def restart_state(db: AsyncSession, user: User, analysis: Analysis) -> RestartOut | None:
    """Пустит ли сейчас start_run повторный запуск остановленного анализа: шаг, начатый до
    отмены; оценка по чекпойнту; лимиты и потолок (ai_access.restart_access). Без резерва
    и без записи. Экран включает «Перезапустить» и «Продолжить» по этому ответу, а не
    угадывает по /api/ai/budget. None — анализ не остановлен или событий нет."""
    if analysis.status not in STOPPED or not analysis.confirmed:
        return None
    if analysis.status == "cancelled" and running_claude_steps(analysis.checkpoint):
        # updated_at пересчитывает база (onupdate): после commit отмены он не загружен, а
        # ленивая загрузка в async — сбой
        await db.refresh(analysis, attribute_names=["updated_at"])
    now = utcnow()
    config = await load_agent_config(db)
    if _call_still_running(analysis, config, now):
        return RestartOut(
            allowed=False,
            reason_code="analysis.step_running",
            reason_params={},
            retry_at=analysis.updated_at + _step_window(config),
        )
    # Пауза и лимиты дня ответственной игры: start_run откажет так же
    blocked = await play_limits.blocked_reason(db, user, now=now)
    if blocked is not None:
        return RestartOut(
            allowed=False,
            reason_code=blocked.code,
            reason_params={key: str(value) for key, value in blocked.params.items()},
            retry_at=None,
        )
    version = await active_version(db, user.id)
    estimate = await estimate_run(
        db,
        config,
        Confirmed.from_json(analysis.confirmed).events,
        prompt_version=prompt_version_of(version),
        now=now,
        done=restart_work(analysis.checkpoint),
        analysis_id=analysis.id,
    )
    access = await restart_access(db, user, analysis, estimate_usd=estimate.cost_usd)
    return RestartOut(
        allowed=access.allowed,
        reason_code=access.reason,
        reason_params=dict(access.reason_params),
        retry_at=None,
    )


async def analysis_view(db: AsyncSession, user: User, analysis: Analysis) -> AnalysisOut:
    """Анализ для экрана; у остановленного — можно ли его перезапустить сейчас."""
    return await analysis_out(db, analysis, restart=await restart_state(db, user, analysis))


async def parse_usage(db: AsyncSession, analysis_id: int) -> tuple[int, Decimal]:
    """Токены и стоимость разбора текста анализа (для шага parse хода анализа)."""
    row = (
        await db.execute(
            select(
                func.coalesce(
                    func.sum(
                        AgentRun.input_tokens
                        + AgentRun.cache_write_tokens
                        + AgentRun.cache_read_tokens
                        + AgentRun.output_tokens
                    ),
                    0,
                ),
            ).where(AgentRun.analysis_id == analysis_id, AgentRun.kind == "parse")
        )
    ).one()
    return int(row[0] or 0), await parse_cost(db, analysis_id)


async def _publish(redis: Redis, analysis: Analysis, kind: str) -> None:
    try:
        await publish(redis, analysis.id, progress_event(analysis, kind))
    except Exception:
        log.warning("analysis.progress_failed", analysis_id=analysis.id)


# --- ход анализа (SSE) ---


@dataclass(frozen=True)
class StreamStart:
    """Начало потока SSE: снимок из базы, позиция потока до снимка, идет ли анализ,
    проверка итога в базе (на случай, если событие конца не записалось в Redis) и
    освобождение места потока участника (по концу потока)."""

    snapshot: dict[str, Any]
    start_id: str
    live: bool
    recheck: Callable[[], Awaitable[dict[str, Any] | None]]
    release: Callable[[], Awaitable[None]]


async def _take_stream_slot(redis: Redis, user_id: int) -> Callable[[], Awaitable[None]]:
    """Место потока участника: поток анализа в работе держит соединение Redis и
    2 дескриптора API до 30 минут, и без предела один участник занял бы их все (общие с
    очередью и лимитами входа). Место — запись в sorted set с моментом начала: место
    потока, который не закрылся (сбой процесса), освобождается само через
    STREAM_SLOT_SECONDS. Сверх STREAM_SLOTS — 429 common.rate_limited (экран при ошибке
    потока опрашивает анализ сам). Возвращает освобождение места."""
    key = redis_key("analysis", "streams", user_id)
    token = secrets.token_hex(8)
    now = time.time()
    async with redis.pipeline(transaction=True) as pipe:
        pipe.zremrangebyscore(key, "-inf", now - STREAM_SLOT_SECONDS)
        pipe.zadd(key, {token: now})
        pipe.zcard(key)
        pipe.expire(key, STREAM_SLOT_SECONDS)
        taken = int((await pipe.execute())[2])

    async def release() -> None:
        try:
            await redis.zrem(key, token)
        except Exception:
            log.warning("analysis.stream_slot_release_failed", user_id=user_id)

    if taken > STREAM_SLOTS:
        await release()
        raise AppError(429, "common.rate_limited", retry_after=RETRY_STREAM_SECONDS)
    return release


async def _nothing() -> None:
    return None


async def stream_start(db: AsyncSession, redis: Redis, user: User, analysis_id: int) -> StreamStart:
    """Свой анализ (чужой — 404) и все, что нужно потоку. Соединение БД запроса
    освобождается здесь: поток дальше читает только Redis, а итог проверяет коротким
    сеансом раз в полминуты. Поток анализа в работе занимает место участника (не больше
    STREAM_SLOTS одновременно)."""
    analysis = await get_owned(db, user, analysis_id)
    # Позиция потока — до снимка: события после нее снимок мог не увидеть
    start = await progress.last_event_id(redis, analysis_id)
    await db.refresh(analysis)
    snapshot = progress_event(analysis, "snapshot", with_steps=True)
    live = analysis.status in ANALYSIS_ACTIVE_STATUSES
    release = await _take_stream_slot(redis, user.id) if live else _nothing
    maker = create_sessionmaker(cast(AsyncEngine, db.bind))
    await db.close()

    async def recheck() -> dict[str, Any] | None:
        async with maker() as session:
            found = await session.get(Analysis, analysis_id)
            if found is None or found.status in ANALYSIS_ACTIVE_STATUSES:
                return None
            return progress_event(found, "snapshot", with_steps=True)

    return StreamStart(
        snapshot=snapshot, start_id=start, live=live, recheck=recheck, release=release
    )


# --- отмена, решение, список ---


async def cancel(db: AsyncSession, redis: Redis, user: User, analysis_id: int) -> Analysis:
    """Отмена: анализ в работе или черновик → cancelled, резерв снимается. Воркер увидит
    отмену между шагами (уже идущий вызов Claude доработает и будет учтен)."""
    analysis = await get_owned(db, user, analysis_id, lock=True)
    if analysis.status not in CANCELLABLE:
        raise AppError(409, "analysis.bad_state", status=analysis.status)
    analysis.status = "cancelled"
    analysis.finished_at = utcnow()
    await release_reservation(db, analysis)
    await db.commit()
    await _publish(redis, analysis, "cancelled")
    return analysis


async def set_decision(
    db: AsyncSession, user: User, analysis_id: int, decision: str | None
) -> Analysis:
    """«Не ставить» (skip) или снять это решение (None). Решение «поставил» пишет только
    сохранение ставки (POST /bets)."""
    analysis = await get_owned(db, user, analysis_id, lock=True)
    if analysis.status != "done" or analysis.decision == "bet":
        raise AppError(409, "analysis.bad_state", status=analysis.status)
    if decision not in (None, "skip"):
        raise AppError(409, "analysis.bad_state", status=analysis.status)
    analysis.decision = decision
    await db.commit()
    return analysis


def _pairs(analysis: Analysis, names: dict[int, PairName]) -> list[MatchPairOut]:
    """Игроки матчей: подтвержденные — из базы (с русским именем), у черновика — как в
    тексте."""
    if analysis.confirmed:
        unknown = PairName(name="?", name_ru=None)
        return [
            MatchPairOut(
                player1=names.get(event.player1_id, unknown),
                player2=names.get(event.player2_id, unknown),
            )
            for event in Confirmed.from_json(analysis.confirmed).events
        ]
    parsed = parsed_input(analysis.parsed)
    if parsed is None:
        return []
    return [
        MatchPairOut(
            player1=PairName(name=event.player1.raw, name_ru=None),
            player2=PairName(name=event.player2.raw, name_ru=None),
        )
        for event in parsed.events
    ]


async def list_analyses(
    db: AsyncSession,
    user: User,
    *,
    before: int | None,
    limit: int = LIST_LIMIT,
    launched: bool = False,
) -> AnalysisListOut:
    """Свои анализы, новые сверху; before — курсор (id), следующая страница — next_cursor.
    launched — только запущенные: каждый разбор текста и каждая форма создают черновик, и
    без фильтра они вытесняют анализы из короткого списка."""
    stmt = select(Analysis).where(Analysis.user_id == user.id)
    if before is not None:
        stmt = stmt.where(Analysis.id < before)
    if launched:
        stmt = stmt.where(Analysis.started_at.is_not(None))
    rows = list(await db.scalars(stmt.order_by(Analysis.id.desc()).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]
    ids = {
        pid
        for row in rows
        if row.confirmed
        for event in Confirmed.from_json(row.confirmed).events
        for pid in (event.player1_id, event.player2_id)
    }
    names = (
        {
            pid: PairName(name=name, name_ru=name_ru)
            for pid, name, name_ru in await db.execute(
                select(Player.id, Player.name, Player.name_ru).where(Player.id.in_(ids))
            )
        }
        if ids
        else {}
    )
    items = []
    for row in rows:
        pairs = _pairs(row, names)
        items.append(
            AnalysisListItem(
                id=row.id,
                status=row.status,  # type: ignore[arg-type]
                created_at=row.created_at,
                finished_at=row.finished_at,
                input_kind=row.input_kind,  # type: ignore[arg-type]
                matches=[f"{pair.player1.name} vs {pair.player2.name}" for pair in pairs],
                pairs=pairs,
                decision=row.decision,  # type: ignore[arg-type]
                cost_usd=row.cost_usd,
            )
        )
    return AnalysisListOut(
        items=items,
        next_cursor=rows[-1].id if more and rows else None,
    )
