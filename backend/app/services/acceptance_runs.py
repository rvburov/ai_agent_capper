"""Приемка этапа 3, прогоны (команда acceptance-runs): настоящие анализы конвейером этапа 3
на ключе администратора и три критерия PLAN.md (этап 3, «Готово, когда»; раздел 8):
p90 длительности ≤ 3 мин, средняя стоимость ≤ $0,30, доля кэша ≥ 60%.

Каждый прогон — обычный анализ администратора из текста: разбор Haiku (текст в формате
бота с первой строкой «Приемка этапа 3, прогон N»), затем те же шаги, что в воркере
(analysis_run.execute), с новостями. События — недавние сыгранные матчи из базы с
архивными кэфами tennis-data на победу в матче (avg, без них — pinnacle): кэфы как ввод
участника. Подтверждаются известные события, а не ответ разбора (разбор лишь сверяется
с ними), и матчи берутся из архива, а не создаются новые. Прогоны идут по очереди в
процессе команды, без arq. Нечетные прогоны — 3 матча, четные — 2.

Чтобы цена была честной, у каждого матча прогона новости ищутся заново: матчи без
свежей оценки Claude (ее взяли бы бесплатно), в каждом матче хотя бы один игрок с
устаревшими новостями, который еще не встречался в серии (иначе новости взялись бы из
кэша другого прогона), сначала матчи, где таких игроков двое. Поиски прогонов не входят
в дневной лимит программы (ACCEPTANCE_MARK в app/services/analysis_run.py), их
ограничивает лимит на анализ. Прогон, где новости хотя бы одного матча взяты из кэша,
пропущены (лимит, выключены) или не получены (сбой), — неполный: приемка не проходит.
Досье, как у любого анализа, собирается на сейчас: результат самого матча в нем виден,
качество оценки здесь не проверяется.

Прогнозы пишутся с is_eval (чекпойнт ACCEPTANCE_MARK) и в статистику участника не
попадают, букмекер анализа не заполняется (avg и pinnacle не попадают в список
букмекеров администратора). Длительность — от запуска (started_at, резерв бюджета) до
конца (finished_at), без разбора. p90 — по ближайшему рангу: 18-е значение из 20 по
возрастанию. Средняя стоимость и доля кэша — по прогонам, которые дошли до done; доля
кэша — cache_read / (input + cache_write + cache_read) по всем вызовам Opus
(kind = 'analysis') этих прогонов.

Каждый прогон считается так, как будто он один (PLAN.md, раздел 8: «по вызовам Opus
одного анализа»). Прогоны идут подряд, и первый вызов Opus прогона (меньше 5 минут после
прошлого) читает кэш system, записанный прошлым прогоном; у отдельного анализа
участника этот вызов пишет кэш. Поэтому в критерии чтения кэша первым вызовом Opus
считаются записью: они не входят в долю кэша, а к стоимости прибавляется разница цены
записи (5 мин) и чтения этих токенов. Другие вызовы Opus прогона идут после первого и
читают только его кэш. Числа как есть — в отчете отдельно. У новостей поправки нет: их
чтения кэша идут и внутри одного запроса (после поиска), отделить чужие нельзя.
"""

import asyncio
import contextlib
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_UP, Decimal
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.calls import estimate_tokens
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.parse import parse_text
from app.agent.prompts import PARSE_PROMPT, load_prompt
from app.agent.runs import price_for, worst_case_usd
from app.agent.schemas import ParsedInput
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    Analysis,
    AppSettings,
    Dossier,
    Match,
    MatchAssessment,
    OddsSnapshot,
    Player,
    Tournament,
    User,
)
from app.ingest.rounds import ROUNDS
from app.ml.elo import RESULT_STATUSES
from app.services.ai_access import release_reservation, reserve_for_run
from app.services.analyses import ParseHooks, estimate_run, parse_usage
from app.services.analysis_input import (
    Confirmed,
    ConfirmedEvent,
    odds_ok,
    parsed_odds,
    resolve_player,
    short_odds,
)
from app.services.analysis_run import ACCEPTANCE_MARK, execute, plan_steps
from app.services.app_settings import SETTINGS_ROW_ID
from app.services.claude_key import key_for
from app.services.progress import TERMINAL_EVENTS, read_events
from app.services.sessions import utcnow
from app.services.strategy_versions import ensure_active, prompt_version_of

# Критерии приемки (PLAN.md, этап 3)
P90_LIMIT_SECONDS = 180.0
COST_LIMIT_USD = Decimal("0.30")
CACHE_MIN_SHARE = 0.60
P90 = 0.9
# Кэфы tennis-data для ввода: средние по рынку, без них — Pinnacle
BOOKMAKERS = ("avg", "pinnacle")
# Строк кэфов в выборке кандидатов (4 строки на матч: 2 букмекера × 2 стороны)
CANDIDATE_ROWS = 6000
# Банк в тексте ввода по валюте программы
BANKS = {"RUB": Decimal("10000"), "USD": Decimal("1000"), "EUR": Decimal("1000")}
# Оценка разбора: выход с размышлениями (как в agent-smoke)
PARSE_OUTPUT_TOKENS = 1000
MTOK = Decimal(1_000_000)
USD_STEP = Decimal("0.0001")
# После этих сбоев следующие прогоны упадут так же: серия останавливается
STOP_CODES = frozenset(
    {
        "ai.key_rejected",
        "ai.billing",
        "ai.no_key",
        "ai.no_admin_key",
        "ai.no_price",
        "ai.budget_exhausted",
        "ai.monthly_limit",
    }
)
# Шаги, расход которых показывает отчет (agent_runs.kind)
COST_KINDS = ("parse", "news", "analysis")
# Приемка — на 20 прогонах (PLAN.md, этап 3); меньше — пробный прогон
ACCEPTANCE_RUNS = 20
# Состояния новостей матча (checkpoint.matches[id].news): найдены сейчас — done; кэш,
# выключены, лимит, сбой; нет состояния (анализ упал раньше) — missing
NEWS_FOUND = "done"
NEWS_STATES = ("done", "cache", "off", "limit", "failed", "missing")


def matches_in_run(number: int) -> int:
    """Нечетный прогон — 3 матча, четный — 2 (в среднем 2,5, как «анализ 2–3 матчей»)."""
    return 3 if number % 2 == 1 else 2


# --- подбор матчей ---


@dataclass(frozen=True)
class RunMatch:
    """Сыгранный матч из архива с кэфами на победу (в порядке игроков матча)."""

    match_id: int
    player1_id: int
    player2_id: int
    player1: str
    player2: str
    tournament_id: int | None
    tournament: str | None
    surface: str
    best_of: int
    round: str
    day: date
    odds: tuple[Decimal, Decimal]
    bookmaker: str


@dataclass(frozen=True)
class RunPlan:
    number: int
    matches: tuple[RunMatch, ...]


async def candidate_matches(
    db: AsyncSession, config: AgentConfig, *, now: datetime
) -> tuple[list[RunMatch], set[int]]:
    """Недавние сыгранные матчи (сначала новые) с архивными кэфами на обе стороны и
    игроки с устаревшими новостями. Без матчей со свежей оценкой Claude: ее взяли бы
    бесплатно, и цена прогона была бы нечестной."""
    today = now.date()
    day = func.coalesce(Match.match_date, Tournament.start_date)
    rows = await db.execute(
        select(
            Match.id,
            Match.player1_id,
            Match.player2_id,
            Match.tournament_id,
            Match.round,
            Match.best_of,
            Tournament.name,
            Tournament.surface,
            Tournament.best_of,
            day,
            OddsSnapshot.bookmaker,
            OddsSnapshot.selection,
            OddsSnapshot.odds,
        )
        .join(OddsSnapshot, OddsSnapshot.match_id == Match.id)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(
            OddsSnapshot.kind == "archive",
            OddsSnapshot.market == "ML",
            OddsSnapshot.bookmaker.in_(BOOKMAKERS),
            Match.status.in_(RESULT_STATUSES),
            day < today,
        )
        .order_by(day.desc(), Match.id.desc())
        .limit(CANDIDATE_ROWS)
    )
    info: dict[int, tuple[Any, ...]] = {}
    prices: dict[int, dict[str, dict[int, Decimal]]] = {}
    for (
        match_id,
        player1_id,
        player2_id,
        tournament_id,
        round_code,
        match_best_of,
        tour_name,
        surface,
        tour_best_of,
        match_day,
        bookmaker,
        selection,
        odds,
    ) in rows:
        info.setdefault(
            match_id,
            (
                player1_id,
                player2_id,
                tournament_id,
                round_code,
                match_best_of or tour_best_of or 3,
                tour_name,
                surface,
                match_day,
            ),
        )
        prices.setdefault(match_id, {}).setdefault(bookmaker, {})[int(selection)] = Decimal(odds)
    reused = await _recently_assessed(db, list(info), config, now)
    ids = {pid for item in info.values() for pid in item[:2]}
    players = {row.id: row for row in await db.scalars(select(Player).where(Player.id.in_(ids)))}
    found: list[RunMatch] = []
    for match_id, item in info.items():
        player1_id, player2_id, tournament_id, round_code, best_of, tour, surface, match_day = item
        if match_id in reused or surface is None:
            continue
        pair = _odds_pair(prices.get(match_id, {}))
        if pair is None or player1_id not in players or player2_id not in players:
            continue
        found.append(
            RunMatch(
                match_id=match_id,
                player1_id=player1_id,
                player2_id=player2_id,
                player1=players[player1_id].name,
                player2=players[player2_id].name,
                tournament_id=tournament_id,
                tournament=tour,
                surface=surface,
                best_of=best_of if best_of in (3, 5) else 3,
                round=round_code if round_code in ROUNDS else "",
                day=match_day,
                odds=pair[0],
                bookmaker=pair[1],
            )
        )
    cutoff = now - timedelta(hours=config.news_ttl_hours)
    stale = {
        pid
        for pid, player in players.items()
        if player.news_checked_at is None or player.news_checked_at < cutoff
    }
    return found, stale


def _odds_pair(
    by_bookmaker: dict[str, dict[int, Decimal]],
) -> tuple[tuple[Decimal, Decimal], str] | None:
    for bookmaker in BOOKMAKERS:
        sides = by_bookmaker.get(bookmaker, {})
        first, second = sides.get(1), sides.get(2)
        if first is not None and second is not None and odds_ok(first) and odds_ok(second):
            return (first, second), bookmaker
    return None


async def _recently_assessed(
    db: AsyncSession, match_ids: Sequence[int], config: AgentConfig, now: datetime
) -> set[int]:
    if not match_ids or config.assessment_reuse_hours <= 0:
        return set()
    since = now - timedelta(hours=config.assessment_reuse_hours)
    return set(
        await db.scalars(
            select(Dossier.match_id)
            .join(MatchAssessment, MatchAssessment.dossier_id == Dossier.id)
            .where(Dossier.match_id.in_(match_ids), MatchAssessment.created_at >= since)
        )
    )


def plan_runs(candidates: Sequence[RunMatch], stale: set[int], count: int) -> list[RunPlan]:
    """Прогоны из кандидатов (сначала новые матчи): сначала матчи, где оба игрока еще не
    встречались в отборе и их новости устарели; потом — где оба не встречались и новости
    устарели хотя бы у одного; потом — где хотя бы один игрок не встречался и его новости
    устарели. Матч без такого игрока не берется: его новости пришли бы из кэша. Не
    хватает матчей — прогонов меньше count."""
    need = sum(matches_in_run(number) for number in range(1, count + 1))
    chosen: list[RunMatch] = []
    used_players: set[int] = set()
    used_matches: set[int] = set()

    def take(fits: Callable[[RunMatch], bool]) -> None:
        for match in candidates:
            if len(chosen) >= need:
                return
            if match.match_id in used_matches or not fits(match):
                continue
            chosen.append(match)
            used_matches.add(match.match_id)
            used_players.update((match.player1_id, match.player2_id))

    def fresh_pair(match: RunMatch) -> bool:
        return match.player1_id not in used_players and match.player2_id not in used_players

    def searched(player_id: int) -> bool:
        # Новости игрока будут искать: устарели и игрок еще не встречался в серии
        return player_id in stale and player_id not in used_players

    take(lambda m: fresh_pair(m) and m.player1_id in stale and m.player2_id in stale)
    take(lambda m: fresh_pair(m) and (searched(m.player1_id) or searched(m.player2_id)))
    take(lambda m: searched(m.player1_id) or searched(m.player2_id))
    plans: list[RunPlan] = []
    position = 0
    for number in range(1, count + 1):
        size = matches_in_run(number)
        part = chosen[position : position + size]
        if len(part) < size:
            break
        plans.append(RunPlan(number=number, matches=tuple(part)))
        position += size
    return plans


def news_problem(
    config: AgentConfig, plans: Sequence[RunPlan]
) -> tuple[str, dict[str, Any]] | None:
    """Почему у прогонов не будет новостей при этих настройках (ключ cli.acceptance.runs.*
    и параметры) или None. Каждому матчу нужен хотя бы один поиск: матчи прогона идут по
    очереди, и в худшем случае каждый тратит все news_max_uses."""
    if not config.news_enabled:
        return "news_off", {}
    size = max((len(plan.matches) for plan in plans), default=0)
    need = (size - 1) * config.news_max_uses + 1 if size else 0
    if need > config.news_max_searches_per_analysis:
        return "news_per_analysis", {
            "limit": config.news_max_searches_per_analysis,
            "matches": size,
            "uses": config.news_max_uses,
            "need": need,
        }
    return None


def max_searches(config: AgentConfig, plans: Sequence[RunPlan]) -> int:
    """Поисков серии в худшем случае: по news_max_uses на матч, не больше лимита на
    анализ (дневной лимит программы к прогонам приемки не применяется)."""
    return sum(
        min(len(plan.matches) * config.news_max_uses, config.news_max_searches_per_analysis)
        for plan in plans
    )


# --- ввод ---

# Текст ввода — данные для разбора в формате бота (как SAMPLE_TEXT в agent_smoke), а не
# текст интерфейса: формат ввода один при любом языке экрана. Раунд — как пишет участник
_ROUND_TEXT = {
    "R128": "1/64",
    "R64": "1/32",
    "R32": "1/16",
    "R16": "1/8",
    "QF": "1/4",
    "SF": "1/2",
    "F": "финал",
}
_SURFACE_TEXT = {"hard": "хард", "clay": "грунт", "grass": "трава"}
_CURRENCY_SIGN = {"RUB": "₽", "USD": "$", "EUR": "€"}


def bank_for(currency: str) -> Decimal:
    return BANKS.get(currency, BANKS["USD"])


def _amount(value: Decimal) -> str:
    return f"{int(value):,}".replace(",", " ")


def input_text(plan: RunPlan, *, title: str, currency: str) -> str:
    """Текст ввода в формате бота: первая строка — метка прогона (title), банк, букмекер,
    события и кэфы на победу."""
    bookmaker = plan.matches[0].bookmaker
    lines = [
        title,
        f"Текущий банк: {_amount(bank_for(currency))} {_CURRENCY_SIGN.get(currency, '$')}",
        f"Букмекер: {bookmaker}",
        "",
        "События:",
    ]
    for match in plan.matches:
        parts = [f"{match.player1} vs {match.player2}"]
        if match.tournament:
            parts.append(" ".join(match.tournament.split()))
        parts.append(_SURFACE_TEXT.get(match.surface, match.surface))
        if match.round in _ROUND_TEXT:
            parts.append(_ROUND_TEXT[match.round])
        lines.append(", ".join(parts))
        lines.append(f"Кэфы: П1 = {short_odds(match.odds[0])}, П2 = {short_odds(match.odds[1])}")
    return "\n".join(lines)


def confirmed_events(plan: RunPlan) -> list[ConfirmedEvent]:
    return [
        ConfirmedEvent(
            position=position,
            player1_id=match.player1_id,
            player2_id=match.player2_id,
            surface=match.surface,
            best_of=match.best_of,
            round=match.round,
            odds={
                "ML": [match.odds[0], match.odds[1]],
                "HCP_-1.5": [None, None],
                "HCP_+1.5": [None, None],
            },
            bookmaker=match.bookmaker,
            match_id=match.match_id,
            tournament_id=match.tournament_id,
            tournament_name=match.tournament,
        )
        for position, match in enumerate(plan.matches, start=1)
    ]


async def parse_agrees(db: AsyncSession, parsed: ParsedInput, plan: RunPlan) -> bool:
    """Разбор нашел те же события: игроки (поиском в базе, как в анализе) и кэфы."""
    if len(parsed.events) != len(plan.matches):
        return False
    for event, match in zip(parsed.events, plan.matches, strict=True):
        first = await resolve_player(db, event.player1.raw, event.player1.latin)
        second = await resolve_player(db, event.player2.raw, event.player2.latin)
        ids = (
            first.best.player_id if first.best is not None else None,
            second.best.player_id if second.best is not None else None,
        )
        if ids != (match.player1_id, match.player2_id):
            return False
        if parsed_odds(event.odds)["ML"] != [match.odds[0], match.odds[1]]:
            return False
    return True


# --- оценка ---


@dataclass(frozen=True)
class SeriesEstimate:
    """Оценка серии и худший случай: каждый анализ ограничен потолком анализа
    администратора (per_analysis_hard_usd), плюс разбор по худшему случаю."""

    estimate_usd: Decimal
    worst_usd: Decimal
    per_run_max_usd: Decimal
    matches: int


async def estimate_series(
    db: AsyncSession,
    config: AgentConfig,
    plans: Sequence[RunPlan],
    *,
    currency: str,
    prompt_version: str,
    now: datetime,
) -> SeriesEstimate:
    parse_price = await price_for(db, config.parse_model)
    prompt = load_prompt(*PARSE_PROMPT)
    cap = await db.scalar(
        select(AppSettings.per_analysis_hard_usd).where(AppSettings.id == SETTINGS_ROW_ID)
    )
    total = Decimal(0)
    worst = Decimal(0)
    per_run_max = Decimal(0)
    for plan in plans:
        text = input_text(plan, title="", currency=currency)
        tokens = estimate_tokens(prompt.text, text)
        run = await estimate_run(
            db, config, confirmed_events(plan), prompt_version=prompt_version, now=now
        )
        cost = (
            run.cost_usd
            + (tokens * parse_price.input + PARSE_OUTPUT_TOKENS * parse_price.output) / MTOK
        )
        per_run_max = max(per_run_max, run.cost_usd)
        total += cost
        worst += Decimal(cap or 0) + worst_case_usd(
            parse_price, input_tokens=tokens, max_tokens=config.parse_max_tokens
        )
    return SeriesEstimate(
        estimate_usd=total.quantize(USD_STEP, rounding=ROUND_UP),
        worst_usd=worst.quantize(USD_STEP, rounding=ROUND_UP),
        per_run_max_usd=per_run_max,
        matches=sum(len(plan.matches) for plan in plans),
    )


# --- прогон ---


@dataclass
class RunResult:
    """Итог прогона: статус анализа, длительность от запуска до конца, расход по шагам и
    токены вызовов Opus для доли кэша."""

    number: int
    match_ids: tuple[int, ...]
    analysis_id: int | None = None
    status: str = "failed"
    error_code: str | None = None
    error_params: dict[str, Any] = field(default_factory=dict)
    failed_step: str | None = None
    duration_s: float | None = None
    cost_usd: Decimal = Decimal(0)
    costs: dict[str, Decimal] = field(default_factory=dict)
    opus_input: int = 0
    opus_write: int = 0
    opus_read: int = 0
    # Чтение кэша первым вызовом Opus (кэш прошлого прогона) и сколько стоила бы его
    # запись вместо чтения
    opus_first_read: int = 0
    first_read_extra_usd: Decimal = Decimal(0)
    searches: int = 0
    news: dict[str, int] = field(default_factory=dict)
    parse_agrees: bool | None = None

    @property
    def done(self) -> bool:
        return self.status == "done"

    @property
    def news_full(self) -> bool:
        """Новости всех матчей найдены в этом прогоне (не из кэша, не пропущены)."""
        return self.news.get(NEWS_FOUND, 0) == len(self.match_ids)

    @property
    def alone_cost_usd(self) -> Decimal:
        """Стоимость прогона, если бы он шел один: первый вызов Opus пишет кэш."""
        return self.cost_usd + self.first_read_extra_usd

    @property
    def cache_share(self) -> float | None:
        """Доля кэша прогона, если бы он шел один (критерий)."""
        prompt = self.opus_input + self.opus_write + self.opus_read
        return (self.opus_read - self.opus_first_read) / prompt if prompt else None

    @property
    def raw_cache_share(self) -> float | None:
        """Доля кэша как есть: с чтением кэша прошлого прогона."""
        prompt = self.opus_input + self.opus_write + self.opus_read
        return self.opus_read / prompt if prompt else None

    @property
    def stops_series(self) -> bool:
        return self.error_code in STOP_CODES


StepCallback = Callable[[dict[str, Any]], None]


async def _follow(redis: Redis, analysis_id: int, on_step: StepCallback) -> None:
    """Прогресс анализа из потока Redis (те же события, что видит экран): законченные
    шаги — в on_step, до события конца."""
    last = "0-0"
    while True:
        for event_id, event in await read_events(redis, analysis_id, last, block_ms=1000):
            last = event_id
            # Последний шаг (экспресс и сумма) приходит в событии конца done
            step = event.get("step")
            if isinstance(step, dict) and step.get("state") in ("done", "failed", "skipped"):
                on_step(step)
            if event.get("type") in TERMINAL_EVENTS:
                return


async def run_one(
    maker: async_sessionmaker[AsyncSession],
    redis: Redis,
    *,
    admin_id: int,
    plan: RunPlan,
    title: str,
    currency: str,
    on_step: StepCallback | None = None,
) -> RunResult:
    """Один прогон: разбор текста, запуск с известными событиями и выполнение шагами
    воркера. Сбой — в RunResult (error_code), а не исключением. Ctrl+C (отмена задачи) —
    анализ failed (analysis.worker_lost) и отмена дальше."""
    result = RunResult(number=plan.number, match_ids=tuple(m.match_id for m in plan.matches))
    try:
        return await _run(
            maker,
            redis,
            result,
            admin_id=admin_id,
            plan=plan,
            title=title,
            currency=currency,
            on_step=on_step,
        )
    except asyncio.CancelledError:
        if result.analysis_id is not None:
            with contextlib.suppress(Exception):
                await asyncio.shield(_interrupted(maker, result.analysis_id))
        raise


async def _interrupted(maker: async_sessionmaker[AsyncSession], analysis_id: int) -> None:
    """Прогон прерван, пока анализ не дошел до шагов воркера (разбор, резерв, очередь):
    failed (analysis.worker_lost) и резерв снят, не дожидаясь уборщика. Анализ в работе
    при отмене помечает сам воркер (analysis_run._Runner.run)."""
    async with maker() as db:
        row = await db.get_one(Analysis, analysis_id, populate_existing=True, with_for_update=True)
        if row.status not in ("parsing", "needs_confirmation", "queued"):
            return
        row.failed_step = "parse" if row.status == "parsing" else None
        row.status = "failed"
        row.error_code = "analysis.worker_lost"
        row.error_params = {}
        row.finished_at = utcnow()
        await release_reservation(db, row)
        await db.commit()


async def _run(
    maker: async_sessionmaker[AsyncSession],
    redis: Redis,
    result: RunResult,
    *,
    admin_id: int,
    plan: RunPlan,
    title: str,
    currency: str,
    on_step: StepCallback | None,
) -> RunResult:
    async with maker() as db:
        config = await load_agent_config(db)
        admin = await db.get_one(User, admin_id)
        text = input_text(plan, title=title, currency=currency)
        analysis = Analysis(user_id=admin.id, input_text=text, input_kind="text", status="parsing")
        db.add(analysis)
        await db.commit()
        result.analysis_id = analysis.id
        try:
            key = await key_for(db, key_source="admin", user_id=admin.id)
            await db.commit()
            parsed = await parse_text(
                client_for(key, timeout=float(config.parse_timeout_s)),
                text,
                config,
                ParseHooks(db, admin, "admin", analysis.id),
            )
        except ClaudeStepError as exc:
            await _stop(db, analysis, exc.code, "parse", exc.params)
            result.error_code, result.failed_step = exc.code, "parse"
            await _collect(db, result)
            return result
        result.parse_agrees = await parse_agrees(db, parsed, plan)
        events = confirmed_events(plan)
        bank = bank_for(currency)
        bookmaker = plan.matches[0].bookmaker
        analysis.parsed = parsed.model_dump(mode="json")
        analysis.confirmed = Confirmed(events=events, bank=bank, bookmaker=bookmaker).to_json()
        analysis.bank_input = bank
        # analysis.bookmaker не заполняется: из него берется список букмекеров участника
        # (bets.bookmakers), а avg и pinnacle — источник кэфов tennis-data, не букмекер
        analysis.status = "needs_confirmation"
        strategy = await ensure_active(db, admin.id)
        await db.commit()
        prompt_version = prompt_version_of(strategy)
        estimate = await estimate_run(
            db, config, events, prompt_version=prompt_version, now=utcnow()
        )
        try:
            await reserve_for_run(db, admin, analysis, estimate_usd=estimate.cost_usd)
        except AppError as exc:
            await db.rollback()
            await _stop(db, analysis, exc.code, None, exc.params)
            result.error_code = exc.code
            await _collect(db, result)
            return result
        tokens, spent = await parse_usage(db, analysis.id)
        steps = plan_steps(
            events,
            config,
            input_kind="text",
            parse_tokens=tokens,
            parse_cost=spent,
            parse_model=config.parse_model,
        )
        analysis.checkpoint = {
            "matches": {},
            "steps": [step.model_dump(mode="json") for step in steps],
            ACCEPTANCE_MARK: plan.number,
        }
        analysis.strategy_version_id = strategy.id
        analysis.prompt_version = prompt_version
        analysis.status = "queued"
        analysis.attempt += 1
        attempt = analysis.attempt
        await db.commit()
    follower = asyncio.create_task(_follow(redis, result.analysis_id, on_step or (lambda _: None)))
    try:
        await execute(result.analysis_id, maker, redis, attempt=attempt)
    finally:
        # Последние события успевают дойти; дольше не ждем (поток мог не записаться)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(follower), timeout=3)
        follower.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await follower
    async with maker() as db:
        await _collect(db, result)
    return result


async def _stop(
    db: AsyncSession,
    analysis: Analysis,
    code: str,
    step: str | None,
    params: dict[str, Any],
) -> None:
    """Прогон не дошел до воркера: анализ — failed с кодом, как сбой разбора в API."""
    row = await db.get_one(Analysis, analysis.id, populate_existing=True)
    row.status = "failed"
    row.error_code = code[:64]
    row.error_params = {key: str(value) for key, value in params.items()}
    row.failed_step = step
    row.finished_at = utcnow()
    await db.commit()


async def _collect(db: AsyncSession, result: RunResult) -> None:
    """Итог прогона из базы: статус, длительность, расход по шагам, токены Opus."""
    assert result.analysis_id is not None
    analysis = await db.get_one(Analysis, result.analysis_id, populate_existing=True)
    result.status = analysis.status
    result.error_code = analysis.error_code
    result.error_params = dict(analysis.error_params or {})
    result.failed_step = analysis.failed_step
    if analysis.started_at is not None and analysis.finished_at is not None:
        result.duration_s = (analysis.finished_at - analysis.started_at).total_seconds()
    rows = await db.execute(
        select(
            AgentRun.kind,
            func.sum(AgentRun.cost_usd),
            func.sum(AgentRun.input_tokens),
            func.sum(AgentRun.cache_write_tokens),
            func.sum(AgentRun.cache_read_tokens),
            func.sum(AgentRun.web_searches),
        )
        .where(AgentRun.analysis_id == result.analysis_id)
        .group_by(AgentRun.kind)
    )
    result.costs = {}
    for kind, cost, inp, write, read, searches in rows:
        result.costs[kind] = Decimal(cost or 0)
        if kind == "analysis":
            result.opus_input, result.opus_write, result.opus_read = (
                int(inp or 0),
                int(write or 0),
                int(read or 0),
            )
        if kind == "news":
            result.searches = int(searches or 0)
    result.cost_usd = sum(result.costs.values(), Decimal(0))
    matches = (analysis.checkpoint or {}).get("matches") or {}
    result.news = {}
    for match_id in result.match_ids:
        state = str((matches.get(str(match_id)) or {}).get("news") or "missing")
        state = state if state in NEWS_STATES else "missing"
        result.news[state] = result.news.get(state, 0) + 1
    first = (
        await db.execute(
            select(AgentRun.model, AgentRun.cache_read_tokens)
            .where(AgentRun.analysis_id == result.analysis_id, AgentRun.kind == "analysis")
            .order_by(AgentRun.id)
            .limit(1)
        )
    ).first()
    result.opus_first_read, result.first_read_extra_usd = 0, Decimal(0)
    if first is not None and first.cache_read_tokens:
        price = await price_for(db, first.model)
        result.opus_first_read = int(first.cache_read_tokens)
        result.first_read_extra_usd = (
            result.opus_first_read * (price.cache_write_5m - price.cache_read) / MTOK
        )


# --- итог ---


def nearest_rank(values: Sequence[float], share: float) -> float | None:
    """Перцентиль по ближайшему рангу: значение номер ⌈share·n⌉ по возрастанию."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, math.ceil(share * len(ordered) - 1e-9))
    return ordered[rank - 1]


@dataclass(frozen=True)
class SeriesSummary:
    """Итог серии. planned — сколько прогонов собирались сделать (серию могли прервать
    или остановить); стоимость и доля кэша — как у отдельных анализов, *_raw — как есть."""

    planned: int
    runs: int
    done: int
    p90_s: float | None
    mean_cost_usd: Decimal | None
    mean_cost_raw_usd: Decimal | None
    cache_share: float | None
    cache_share_raw: float | None
    step_costs: dict[str, Decimal]
    p90_ok: bool
    cost_ok: bool
    cache_ok: bool
    news_matches: int
    news_found: int
    news_states: dict[str, int]
    parse_agrees: int
    parse_checked: int

    @property
    def errors(self) -> int:
        return self.runs - self.done

    @property
    def news_ok(self) -> bool:
        """У всех матчей всех прогонов новости найдены в серии (не кэш и не пропуск)."""
        return self.news_matches > 0 and self.news_found == self.news_matches

    @property
    def complete(self) -> bool:
        """Сделаны все задуманные прогоны: серию не прервали и не остановили."""
        return self.runs == self.planned

    @property
    def passed(self) -> bool:
        """Три критерия, новости у всех матчей, ни одного прогона с ошибкой, серия не
        прервана. Это еще не приемка: она — на ACCEPTANCE_RUNS прогонах (trial)."""
        return (
            self.p90_ok
            and self.cost_ok
            and self.cache_ok
            and self.news_ok
            and self.done == self.runs > 0
            and self.complete
        )

    @property
    def trial(self) -> bool:
        """Прогонов меньше, чем нужно приемке: пробный прогон, приемкой не считается."""
        return self.planned < ACCEPTANCE_RUNS


def _mean(values: Sequence[Decimal]) -> Decimal | None:
    if not values:
        return None
    return (sum(values, Decimal(0)) / len(values)).quantize(Decimal("0.000001"))


def summarize(results: Sequence[RunResult], *, planned: int | None = None) -> SeriesSummary:
    done = [result for result in results if result.done]
    durations = [result.duration_s for result in done if result.duration_s is not None]
    p90 = nearest_rank(durations, P90)
    mean = _mean([result.alone_cost_usd for result in done])
    read = sum(result.opus_read for result in done)
    first_read = sum(result.opus_first_read for result in done)
    prompt = sum(result.opus_input + result.opus_write + result.opus_read for result in done)
    share = (read - first_read) / prompt if prompt else None
    states = {state: 0 for state in NEWS_STATES}
    for result in results:
        for state, number in result.news.items():
            states[state] = states.get(state, 0) + number
    steps = {
        kind: (
            sum((result.costs.get(kind, Decimal(0)) for result in done), Decimal(0)) / len(done)
        ).quantize(Decimal("0.000001"))
        if done
        else Decimal(0)
        for kind in COST_KINDS
    }
    checked = [result for result in results if result.parse_agrees is not None]
    return SeriesSummary(
        planned=len(results) if planned is None else planned,
        runs=len(results),
        done=len(done),
        p90_s=p90,
        mean_cost_usd=mean,
        mean_cost_raw_usd=_mean([result.cost_usd for result in done]),
        cache_share=share,
        cache_share_raw=read / prompt if prompt else None,
        step_costs=steps,
        p90_ok=p90 is not None and p90 <= P90_LIMIT_SECONDS,
        cost_ok=mean is not None and mean <= COST_LIMIT_USD,
        cache_ok=share is not None and share >= CACHE_MIN_SHARE,
        news_matches=sum(len(result.match_ids) for result in results),
        news_found=states.get(NEWS_FOUND, 0),
        news_states=states,
        parse_agrees=sum(1 for result in checked if result.parse_agrees),
        parse_checked=len(checked),
    )
