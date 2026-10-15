"""Выполнение анализа в воркере: новости, досье, модель, оценка Claude, экспресс и сумма.

Путь статусов: queued → building_dossier (новости по матчам, затем досье) → modelling
(p_base) → llm_review (оценки Claude) → composing (прогнозы, экспресс, сумма) → done.
После каждого шага — чекпойнт в analyses.checkpoint, updated_at и событие прогресса.
Повторный запуск продолжает с чекпойнта: новости — по players.news_checked_at, досье —
по dossier_id, оценка — по assessment_id; оплаченные шаги не повторяются.

Сеанс БД не держится открытым во время вызова Claude: каждое чтение и запись — свой
короткий сеанс. Ключ расшифровывается прямо перед шагом и в аргументы задачи не
попадает. Перед каждым вызовом — проверка потолка анализа и лимитов по худшему случаю
(ai_access.fit_call), после — строка agent_runs (и на неудачный вызов) и предупреждения
о расходе на ключе администратора. Вызовы оценки идут параллельно, поэтому худший случай
уже допущенных, но еще не учтенных вызовов держится в резерве и входит в проверку
следующих: вызов, которому не хватает места только из-за них, ждет их конца, а не
останавливает анализ (три вызова Opus по худшему случаю дороже потолка $1). Не хватает
и без них — max_tokens оценки урезается до остатка, но не ниже analysis_min_tokens.
Так же поиски новостей: лимит анализа и лимит дня на всю программу считаются
с поисками, которые идут прямо сейчас (у дня — счетчик в Redis, его видят все воркеры).

Отмена — статус cancelled в базе: воркер видит его между шагами и перед каждым вызовом.
Все записи условные: анализ в рабочем статусе и с тем же номером запуска (attempt), что
у задачи. Поэтому отмена и уборщик не перетираются, а задача старого запуска после
отмены и перезапуска останавливается и не пишет в новый.

Весь анализ укладывается в RUN_DEADLINE_SECONDS (меньше предела задачи arq): дольше —
failed (ai.timeout). Задачу сняли (остановка воркера) — failed (analysis.worker_lost)
сразу, без ожидания уборщика; прерванный вызов Claude все равно попадает в учет.

Сбой новостей — предупреждение, анализ идет дальше (кроме отказа ключа). Сбой любого
другого шага — failed с error_code (ключ errors.*) и failed_step.
"""

import asyncio
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from typing import Any, cast

import anthropic
import structlog
from redis.asyncio import Redis
from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.analysis import assess_match
from app.agent.calls import CallInfo
from app.agent.client import client_for
from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.news import NewsOutcome, NewsTarget, fetch_news
from app.agent.prompts import Prompt, load_prompt_id
from app.agent.runs import price_for, record_run
from app.agent.schemas import ASSESSMENT_SCHEMA_VERSION
from app.core.errors import AppError
from app.core.redis import redis_key
from app.db.models import (
    ANALYSIS_ACTIVE_STATUSES,
    AgentRun,
    Analysis,
    Dossier,
    Match,
    MatchAssessment,
    Player,
    PlayerNews,
    StrategyVersion,
)
from app.ml.sets import Probs3
from app.ml.strategy import (
    StrategyParams,
)
from app.schemas.analyses import StepOut
from app.services.ai_access import (
    LIMIT_REFUSALS,
    after_run_notifications,
    call_rooms,
    fit_call,
    refusal_params,
    release_reservation,
)
from app.services.ai_keys import report_key_failure
from app.services.analysis_input import Confirmed, ConfirmedEvent
from app.services.analysis_result import ComposeInput, compose
from app.services.analysis_view import make_event
from app.services.bank import CURRENCY_LOCK
from app.services.claude_key import key_for_run
from app.services.dossier import archive_tournament, build_dossier, canonical_json
from app.services.progress import publish
from app.services.sessions import utcnow
from app.services.strategy_versions import params_of, prompt_version_of

log = structlog.get_logger(__name__)

# Анализ без движения дольше — воркер потерян (уборщик, раз в 5 минут). Разбор текста
# (parsing) идет в запросе API не дольше минуты: зависший — тоже потерян
STUCK_AFTER = timedelta(minutes=15)
REAPED_STATUSES = (*ANALYSIS_ACTIVE_STATUSES, "parsing")
# Предел всего анализа: меньше предела задачи arq (900 с, app/workers/main.py), чтобы
# анализ закончился своим failed (ai.timeout), а не снятием задачи посреди вызова
RUN_DEADLINE_SECONDS = 840
NEWS_LOCK_SECONDS = 240
NEWS_LOCK_POLL = 0.5
# Счетчик поисков в полете за день живет дольше любого анализа: зависший сам пропадет
NEWS_IN_FLIGHT_TTL = 1800
# Сбои новостей, которые останавливают анализ: ключ не работает и для анализа
_FATAL_NEWS = frozenset({"ai.key_rejected", "ai.billing", "ai.no_key", "ai.no_price"})
# Шаг новостей закончен (в том числе неудачно): перезапуск его не повторяет — досье уже
# собрано без этих новостей, а за поиск уже заплачено
NEWS_KEEP = frozenset({"done", "cache", "off", "failed", "limit"})
# Ключ чекпойнта прогона приемки (команда acceptance-runs, номер прогона): его прогнозы
# пишутся с is_eval и в статистику участника не попадают. Его поиски не входят в дневной
# лимит программы и не уменьшают его: серия из 20 прогонов делает до 100 поисков при
# лимите 30 в день и оставила бы без новостей и себя, и анализы участников до полуночи
# UTC. Поиски прогона ограничивает лимит на анализ, их число показывает оценка до запуска
ACCEPTANCE_MARK = "acceptance"
# Резерв поисков прогона приемки: без счетчика дня в Redis
_ACCEPTANCE_SEARCHES = "acceptance"
RULE_KEYS = (
    "legs_count",
    "same_match",
    "odds_low",
    "odds_high",
    "p_low",
    "no_value",
    "cover_p_low",
    "triple_p",
    "triple_odds",
    "total_low",
    "total_high",
    "form",
    "injury",
    "fatigue",
    "drawdown_legs",
    "drawdown_odds",
)
_P_STEP = 9
_RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"""


class Stopped(Exception):
    """Анализ больше не в работе (отменен, снят уборщиком, перезапущен): воркер тихо
    выходит."""


class SearchLimitReached(Exception):
    """Запрос новостей не укладывается в лимит поисков анализа или дня."""


# --- план шагов ---


def plan_steps(
    events: Sequence[ConfirmedEvent],
    config: AgentConfig,
    *,
    input_kind: str,
    parse_tokens: int,
    parse_cost: Decimal,
    parse_model: str | None,
) -> list[StepOut]:
    """Шаги хода анализа (раздел 5.2 брифа): разбор, игроки, новости по матчам, досье,
    модель, Claude по матчам, экспресс."""
    steps: list[StepOut] = []

    def add(kind: str, *, match_id: int | None = None, model: str | None = None) -> None:
        steps.append(
            StepOut(
                index=len(steps),
                kind=kind,  # type: ignore[arg-type]
                match_id=match_id,
                state="pending",
                model=model,
                elapsed_ms=0,
                tokens=0,
                cost_usd=Decimal(0),
                web_searches=0,
                detail_key=None,
                detail_params={},
            )
        )

    add("parse", model=parse_model)
    if input_kind == "text":
        steps[0] = steps[0].model_copy(
            update={"state": "done", "tokens": parse_tokens, "cost_usd": parse_cost}
        )
    else:
        steps[0] = steps[0].model_copy(
            update={"state": "skipped", "detail_key": "analysis.steps.parse_form"}
        )
    add("players")
    for event in events:
        add("news", match_id=event.match_id, model=config.news_model)
    add("dossier")
    add("model")
    for event in events:
        add("claude", match_id=event.match_id, model=config.analysis_model)
    add("compose")
    return steps


def reset_steps(raw: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Повторный запуск: незаконченные и упавшие шаги снова ждут."""
    reset: list[dict[str, Any]] = []
    for item in raw:
        if item.get("state") in ("running", "failed"):
            item = {**item, "state": "pending", "detail_key": None, "detail_params": {}}
        reset.append(item)
    return reset


@dataclass(frozen=True)
class RestartWork:
    """Что повторный запуск не повторит (как _Runner): матчи с законченным шагом
    новостей, матчи с оценкой Claude и досье матчей (match_id → dossier_id)."""

    news: frozenset[int]
    assessed: frozenset[int]
    dossiers: dict[int, int]


def restart_work(checkpoint: Mapping[str, Any] | None) -> RestartWork:
    """Сделанное по чекпойнту анализа: по нему считается оценка перезапуска (резерв не
    берется на шаги, которые воркер пропустит)."""
    raw = checkpoint or {}
    finished_news = {
        step.get("match_id")
        for step in raw.get("steps") or []
        if step.get("kind") == "news" and step.get("state") in ("done", "skipped")
    }
    news: set[int] = set()
    assessed: set[int] = set()
    dossiers: dict[int, int] = {}
    for key, entry in (raw.get("matches") or {}).items():
        match_id = int(key)
        if entry.get("news") in NEWS_KEEP and match_id in finished_news:
            news.add(match_id)
        if "assessment_id" in entry:
            assessed.add(match_id)
        if "dossier_id" in entry and "p_base" in entry:
            dossiers[match_id] = int(entry["dossier_id"])
    return RestartWork(news=frozenset(news), assessed=frozenset(assessed), dossiers=dossiers)


def running_claude_steps(checkpoint: Mapping[str, Any] | None) -> bool:
    """В чекпойнте есть шаг с вызовом Claude (новости, оценка) в работе."""
    return any(
        step.get("state") == "running" and step.get("kind") in ("news", "claude")
        for step in (checkpoint or {}).get("steps") or []
    )


# --- учет вызовов ---


async def record_call(
    db: AsyncSession,
    info: CallInfo,
    *,
    user_id: int | None,
    key_source: str,
    analysis_id: int | None,
    step: int,
) -> AgentRun:
    """Строка agent_runs за вызов и предупреждения о расходе (ключ администратора).
    flush; commit — за вызывающим."""
    run = await record_run(
        db,
        user_id=user_id,
        key_source=key_source,
        analysis_id=analysis_id,
        kind=info.kind,
        step=step,
        model=info.model,
        effort=info.effort,
        prompt_version=info.prompt_version,
        schema_version=info.schema_version,
        usage=info.usage,
        duration_ms=info.duration_ms,
        stop_reason=info.stop_reason,
        error=info.error,
        request_id=info.request_id,
    )
    if key_source == "admin":
        await after_run_notifications(db, user_id)
    return run


class _Hooks:
    """Связь шага Claude с базой: проверка до вызова и учет после (StepHooks). Вызовы
    одного шага идут друг за другом, поэтому резерв вызова — одно значение."""

    def __init__(self, runner: "_Runner", index: int) -> None:
        self.runner = runner
        self.index = index
        self.reserved_usd = Decimal(0)
        self.reserved_searches: tuple[str, int] | None = None

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
        runner = self.runner
        # Проверка и резерв — под замком: параллельный вызов видит худший случай соседа.
        # Не помещается только из-за своих вызовов в полете — ждем, пока один из них
        # закончится (release будит), и проверяем заново с его настоящей ценой
        async with runner.budget_cond:
            while True:
                async with runner.maker() as db:
                    analysis = await db.get(Analysis, runner.analysis_id)
                    if analysis is None or not runner.owns(analysis):
                        raise Stopped
                    price = await price_for(db, model)
                    fit = fit_call(
                        await call_rooms(db, analysis),
                        price,
                        input_tokens=input_tokens,
                        max_tokens=max_tokens,
                        min_tokens=min_tokens,
                        searches=searches,
                        in_flight_usd=runner.in_flight_usd,
                    )
                    if fit.refuse is not None:
                        raise ClaudeStepError(fit.refuse.code, **refusal_params(fit))
                    if not fit.wait:
                        if searches > 0:
                            self.reserved_searches = (
                                await runner.reserve_searches(db, searches),
                                searches,
                            )
                        break
                await runner.budget_cond.wait()
            runner.in_flight_usd += fit.worst_usd
            self.reserved_usd = fit.worst_usd
        if fit.max_tokens is not None and fit.max_tokens < max_tokens:
            log.info(
                "analysis.max_tokens_cut",
                analysis_id=runner.analysis_id,
                kind=kind,
                max_tokens=fit.max_tokens,
            )
        return fit.max_tokens

    async def after_call(self, info: CallInfo) -> int | None:
        runner = self.runner
        step = runner.next_call()
        try:
            async with runner.maker() as db:
                run = await record_call(
                    db,
                    info,
                    user_id=runner.user_id,
                    key_source=runner.key_source,
                    analysis_id=runner.analysis_id,
                    step=step,
                )
                cost = run.cost_usd
                run_id = run.id
                await db.commit()
        finally:
            # Резерв снимается после записи: между ними вызов считается дважды (с запасом),
            # но не пропадает из проверки ни на миг
            await self.release()
        await runner.add_usage(
            self.index, tokens=info.usage.total_tokens, cost=cost, searches=info.usage.web_searches
        )
        return run_id

    async def release(self) -> None:
        runner = self.runner
        async with runner.budget_cond:
            runner.in_flight_usd -= self.reserved_usd
            self.reserved_usd = Decimal(0)
            runner.budget_cond.notify_all()
        if self.reserved_searches is not None:
            key, count = self.reserved_searches
            self.reserved_searches = None
            await runner.release_searches(key, count)


# --- выполнение ---


class _Runner:
    def __init__(
        self,
        analysis_id: int,
        maker: async_sessionmaker[AsyncSession],
        redis: Redis,
        *,
        deadline_s: float = RUN_DEADLINE_SECONDS,
    ) -> None:
        self.analysis_id = analysis_id
        self.maker = maker
        self.redis = redis
        self.deadline_s = deadline_s
        self.lock = asyncio.Lock()
        # Резерв вызовов в полете: худший случай допущенных, но еще не учтенных вызовов.
        # Вызов, которому не хватает места только из-за них, ждет их конца (wait/notify)
        self.budget_cond = asyncio.Condition()
        self.in_flight_usd = Decimal(0)
        self.searches_in_flight: dict[str, int] = {}
        self.attempt = 0
        self.user_id = 0
        self.key_source = "admin"
        self.status = "queued"
        self.steps: list[StepOut] = []
        self.checkpoint: dict[str, Any] = {}
        self.calls = 0
        self.current: int | None = None
        self.events: list[ConfirmedEvent] = []
        self.confirmed = Confirmed(events=[], bank=None, bookmaker=None)
        self.config = AgentConfig()
        self.params = StrategyParams()
        self.prompt: Prompt | None = None
        self.strategy_version_id: int | None = None
        self.started: dict[int, float] = {}

    # --- состояние ---

    def next_call(self) -> int:
        self.calls += 1
        return self.calls

    def owns(self, analysis: Analysis) -> bool:
        """Анализ еще в работе и это тот же запуск: после отмены и перезапуска задача
        старого запуска не пишет в новый."""
        return analysis.status in ANALYSIS_ACTIVE_STATUSES and analysis.attempt == self.attempt

    def entry(self, match_id: int) -> dict[str, Any]:
        matches: dict[str, Any] = self.checkpoint.setdefault("matches", {})
        found: dict[str, Any] = matches.setdefault(str(match_id), {})
        return found

    def warn(self, key: str, **params: Any) -> None:
        warnings: list[dict[str, Any]] = self.checkpoint.setdefault("warnings", [])
        item = {"key": key, "params": params}
        if item not in warnings:
            warnings.append(item)

    def _checkpoint_json(self) -> dict[str, Any]:
        return {**self.checkpoint, "steps": [step.model_dump(mode="json") for step in self.steps]}

    async def _save(
        self,
        *,
        status: str | None = None,
        event: str = "step",
        step: StepOut | None = None,
        finishing: bool = False,
    ) -> None:
        """Чекпойнт и статус (только если анализ еще в работе) и событие прогресса.

        finishing — итог уже идущего шага (расход вызова, done/failed): после отмены он
        тоже пишется в чекпойнт отмененного анализа того же запуска. Вызов, начатый до
        отмены, доработал и оплачен, и «Продолжить» не должен покупать его снова. Событие
        не шлем (поток закрыт отменой), новых шагов после отмены нет: начало шага и смена
        статуса по-прежнему останавливают задачу."""
        values: dict[str, Any] = {"checkpoint": self._checkpoint_json()}
        if status is not None:
            values["status"] = status
        allowed = [*ANALYSIS_ACTIVE_STATUSES]
        if finishing and status is None:
            allowed.append("cancelled")
        async with self.maker() as db:
            row = (
                await db.execute(
                    update(Analysis)
                    .where(
                        Analysis.id == self.analysis_id,
                        Analysis.attempt == self.attempt,
                        Analysis.status.in_(allowed),
                    )
                    .values(**values)
                    .returning(Analysis.status)
                )
            ).first()
            await db.commit()
        if row is None:
            raise Stopped
        if row[0] == "cancelled":
            return
        if status is not None:
            self.status = status
        await self._publish(event, step=step)

    async def _publish(self, kind: str, *, step: StepOut | None = None) -> None:
        try:
            await publish(
                self.redis,
                self.analysis_id,
                make_event(self.analysis_id, self.status, self.steps, kind, step=step),
            )
        except Exception:
            log.warning("analysis.progress_failed", analysis_id=self.analysis_id)

    async def set_step(
        self,
        index: int,
        state: str,
        *,
        detail_key: str | None = None,
        detail_params: dict[str, Any] | None = None,
    ) -> None:
        async with self.lock:
            loop = asyncio.get_running_loop()
            fields: dict[str, Any] = {"state": state}
            if state == "running":
                self.started[index] = loop.time()
                self.current = index
            elif index in self.started:
                elapsed = int((loop.time() - self.started.pop(index)) * 1000)
                fields["elapsed_ms"] = self.steps[index].elapsed_ms + elapsed
            if detail_key is not None:
                fields["detail_key"] = detail_key
                fields["detail_params"] = detail_params or {}
            self.steps[index] = self.steps[index].model_copy(update=fields)
            await self._save(step=self.steps[index], finishing=state != "running")

    async def add_usage(self, index: int, *, tokens: int, cost: Decimal, searches: int) -> None:
        async with self.lock:
            step = self.steps[index]
            self.steps[index] = step.model_copy(
                update={
                    "tokens": step.tokens + tokens,
                    "cost_usd": step.cost_usd + cost,
                    "web_searches": step.web_searches + searches,
                }
            )
            await self._save(step=self.steps[index], finishing=True)

    async def set_status(self, status: str) -> None:
        async with self.lock:
            await self._save(status=status, event="status")

    async def check_active(self) -> None:
        async with self.maker() as db:
            row = (
                await db.execute(
                    select(Analysis.status, Analysis.attempt).where(Analysis.id == self.analysis_id)
                )
            ).first()
        if row is None or row[0] not in ANALYSIS_ACTIVE_STATUSES or row[1] != self.attempt:
            raise Stopped

    def index_of(self, kind: str, match_id: int | None = None) -> int:
        for step in self.steps:
            if step.kind == kind and step.match_id == match_id:
                return step.index
        raise KeyError(kind)

    async def key(self) -> str:
        async with self.maker() as db:
            analysis = await db.get(Analysis, self.analysis_id)
            if analysis is None or not self.owns(analysis):
                raise Stopped
            value_ = await key_for_run(db, analysis)
            await db.commit()
        return value_

    # --- запуск ---

    async def load(self, attempt: int | None) -> bool:
        async with self.maker() as db:
            analysis = await db.get(Analysis, self.analysis_id)
            if analysis is None or analysis.status != "queued":
                return False
            if attempt is not None and analysis.attempt != attempt:
                return False
            self.attempt = analysis.attempt
            self.user_id = analysis.user_id
            self.key_source = analysis.key_source or "admin"
            self.config = await load_agent_config(db)
            version = (
                await db.get(StrategyVersion, analysis.strategy_version_id)
                if analysis.strategy_version_id is not None
                else None
            )
            self.strategy_version_id = analysis.strategy_version_id
            self.params = params_of(version)
            self.prompt = load_prompt_id(analysis.prompt_version or prompt_version_of(version))
            self.confirmed = Confirmed.from_json(analysis.confirmed)
            self.events = self.confirmed.events
            self.checkpoint = {
                key: value_ for key, value_ in (analysis.checkpoint or {}).items() if key != "steps"
            }
            self.steps = [
                StepOut.model_validate(item)
                for item in (analysis.checkpoint or {}).get("steps", [])
            ]
            self.calls = int(
                await db.scalar(
                    select(func.count())
                    .select_from(AgentRun)
                    .where(AgentRun.analysis_id == self.analysis_id)
                )
                or 0
            )
        if not self.steps:
            self.steps = plan_steps(
                self.events,
                self.config,
                input_kind="form",
                parse_tokens=0,
                parse_cost=Decimal(0),
                parse_model=None,
            )
        return True

    async def run(self, attempt: int | None) -> str:
        if not await self.load(attempt):
            async with self.maker() as db:
                status = await db.scalar(
                    select(Analysis.status).where(Analysis.id == self.analysis_id)
                )
            return status or "missing"
        try:
            async with asyncio.timeout(self.deadline_s):
                await self.steps_all()
        except Stopped:
            await self._release_running()
            return await self._current_status()
        except ClaudeStepError as exc:
            if exc.is_key_failure:
                await self._report_key(exc.code)
            status = await self.fail(exc.code, exc.params)
            if exc.code in LIMIT_REFUSALS and self.key_source == "admin":
                await self._limit_notices()
            return status
        except AppError as exc:
            return await self.fail(exc.code, exc.params)
        except TimeoutError:
            # Общий предел анализа: прерванные вызовы уже учтены (app/agent/calls.py)
            log.warning("analysis.deadline", analysis_id=self.analysis_id)
            return await self.fail("ai.timeout", {})
        except asyncio.CancelledError:
            # Задачу сняли (остановка воркера, предел arq): failed сразу, не ждать уборщика
            try:
                await asyncio.shield(self.fail("analysis.worker_lost", {}))
            except BaseException:
                log.warning("analysis.cancel_not_saved", analysis_id=self.analysis_id)
            raise
        except Exception:
            log.exception("analysis.crashed", analysis_id=self.analysis_id)
            return await self.fail("common.internal", {})
        finally:
            await self.release_all_searches()
        return "done"

    async def steps_all(self) -> None:
        await self.set_status("building_dossier")
        await self.players()
        await self.news()
        await self.dossiers()
        await self.set_status("modelling")
        await self.model()
        await self.set_status("llm_review")
        await self.claude()
        await self.set_status("composing")
        await self.compose()

    async def _release_running(self) -> None:
        """Задача остановилась (отмена): все ее вызовы закончены, а шаги, которые так и не
        дошли до вызова, остались «в работе». Они снова ждут — иначе «Продолжить» считал
        бы, что вызов еще идет (start_run отвечает 409, пока в отмененном анализе идет
        шаг Claude)."""
        async with self.lock:
            changed = False
            for number, step in enumerate(self.steps):
                if step.state == "running":
                    self.steps[number] = step.model_copy(
                        update={"state": "pending", "detail_key": None, "detail_params": {}}
                    )
                    changed = True
            if not changed:
                return
            try:
                await self._save(finishing=True)
            except Stopped:
                return

    async def _current_status(self) -> str:
        async with self.maker() as db:
            status = await db.scalar(select(Analysis.status).where(Analysis.id == self.analysis_id))
        return status or "missing"

    async def _report_key(self, code: str) -> None:
        async with self.maker() as db:
            await report_key_failure(db, self.key_source, self.user_id, code)
            await db.commit()

    async def _limit_notices(self) -> None:
        """Остановка по лимиту месяца или бюджету: порог 100% мог пройти без вызова
        (лимит снизили посреди анализа) — предупреждения о расходе."""
        try:
            async with self.maker() as db:
                await after_run_notifications(db, self.user_id)
                await db.commit()
        except Exception:
            log.warning("analysis.limit_notices_failed", analysis_id=self.analysis_id)

    async def fail(self, code: str, params: dict[str, Any]) -> str:
        """failed с кодом ошибки и шагом; резерв снимается. Анализ уже не в работе
        (отменен, перезапущен) — его не трогаем, только шаги этой задачи, оставшиеся «в
        работе», снова ждут (_release_running). Возвращает статус анализа."""
        step_kind = self.steps[self.current].kind if self.current is not None else None
        safe_params = {key: str(value_) for key, value_ in params.items()}
        async with self.maker() as db:
            analysis = await db.get(Analysis, self.analysis_id, with_for_update=True)
            stopped = analysis is None or not self.owns(analysis)
            if analysis is not None and not stopped:
                if self.current is not None and self.steps[self.current].state == "running":
                    self.steps[self.current] = self.steps[self.current].model_copy(
                        update={
                            "state": "failed",
                            "detail_key": f"errors.{code}",
                            "detail_params": dict(params),
                        }
                    )
                analysis.status = "failed"
                analysis.error_code = code[:64]
                analysis.error_params = safe_params
                analysis.failed_step = step_kind
                analysis.finished_at = utcnow()
                analysis.checkpoint = self._checkpoint_json()
                await release_reservation(db, analysis)
                await db.commit()
        if stopped:
            await self._release_running()
            return await self._current_status()
        self.status = "failed"
        await self._publish_failed(code, safe_params, step_kind)
        return "failed"

    async def _publish_failed(
        self, code: str, params: dict[str, Any], step_kind: str | None
    ) -> None:
        event = make_event(self.analysis_id, "failed", self.steps, "failed")
        event["error"] = {"code": code, "params": params, "step": step_kind}
        try:
            await publish(self.redis, self.analysis_id, event)
        except Exception:
            log.warning("analysis.progress_failed", analysis_id=self.analysis_id)

    # --- шаги ---

    async def players(self) -> None:
        index = self.index_of("players")
        if self.steps[index].state == "done":
            return
        await self.set_step(index, "running")
        ids = {pid for event in self.events for pid in (event.player1_id, event.player2_id)}
        match_ids = {event.match_id for event in self.events if event.match_id is not None}
        async with self.maker() as db:
            known = set(await db.scalars(select(Player.id).where(Player.id.in_(ids))))
            matches = set(await db.scalars(select(Match.id).where(Match.id.in_(match_ids))))
        if not self.events:
            raise AppError(422, "analysis.no_events")
        for event in self.events:
            for number, pid in ((1, event.player1_id), (2, event.player2_id)):
                if pid not in known:
                    raise AppError(
                        422, "analysis.player_missing", position=event.position, player=number
                    )
            if event.match_id not in matches:
                raise AppError(409, "analysis.match_missing", position=event.position)
        await self.set_step(
            index, "done", detail_key="analysis.steps.players", detail_params={"count": len(ids)}
        )

    # новости

    async def news(self) -> None:
        for event in self.events:
            assert event.match_id is not None
            index = self.index_of("news", event.match_id)
            entry = self.entry(event.match_id)
            if entry.get("news") in NEWS_KEEP and self.steps[index].state in ("done", "skipped"):
                continue
            await self.check_active()
            await self.set_step(index, "running")
            state, detail, params = await self._match_news(index, event, entry)
            await self.set_step(index, state, detail_key=detail, detail_params=params)

    async def _stale(self, player_ids: Sequence[int]) -> list[Player]:
        """Игроки, у которых новости старше news_ttl_hours (или их не искали)."""
        cutoff = utcnow() - timedelta(hours=self.config.news_ttl_hours)
        async with self.maker() as db:
            rows = await db.scalars(select(Player).where(Player.id.in_(player_ids)))
            players = {row.id: row for row in rows}
        stale: list[Player] = []
        for pid in player_ids:
            player = players.get(pid)
            checked = player.news_checked_at if player is not None else None
            if player is not None and (checked is None or checked < cutoff):
                stale.append(player)
        return stale

    @property
    def acceptance(self) -> bool:
        """Прогон приемки (acceptance-runs): дневной лимит поисков к нему не применяется."""
        return bool(self.checkpoint.get(ACCEPTANCE_MARK))

    async def _searches_used(self, db: AsyncSession) -> tuple[int, int]:
        """Поиски, уже записанные в agent_runs: этого анализа и всей программы за день
        (без прогонов приемки)."""
        day_start = datetime.combine(utcnow().date(), time(0), UTC)
        used_here = await db.scalar(
            select(func.coalesce(func.sum(AgentRun.web_searches), 0)).where(
                AgentRun.analysis_id == self.analysis_id, AgentRun.kind == "news"
            )
        )
        used_today = await db.scalar(
            select(func.coalesce(func.sum(AgentRun.web_searches), 0))
            .select_from(AgentRun)
            .outerjoin(Analysis, Analysis.id == AgentRun.analysis_id)
            .where(
                AgentRun.kind == "news",
                AgentRun.created_at >= day_start,
                or_(Analysis.id.is_(None), ~Analysis.checkpoint.has_key(ACCEPTANCE_MARK)),
            )
        )
        return int(used_here or 0), int(used_today or 0)

    def _day_key(self) -> str:
        return redis_key("analysis", "news_searches", utcnow().date().isoformat())

    async def _searches_left(self) -> int:
        async with self.maker() as db:
            used_here, used_today = await self._searches_used(db)
        here = (
            self.config.news_max_searches_per_analysis
            - used_here
            - sum(self.searches_in_flight.values())
        )
        if self.acceptance:
            return here
        in_flight_day = int(await self.redis.get(self._day_key()) or 0)
        return min(here, self.config.news_max_searches_per_day - used_today - in_flight_day)

    async def reserve_searches(self, db: AsyncSession, count: int) -> str:
        """Резерв поисков одного запроса новостей (count = max_uses): лимит анализа и лимит
        дня с поисками, которые идут сейчас (у прогона приемки — только лимит анализа). Не
        хватает — SearchLimitReached. Возвращает ключ счетчика дня (снять резерв —
        release_searches)."""
        used_here, used_today = await self._searches_used(db)
        mine = sum(self.searches_in_flight.values())
        if used_here + mine + count > self.config.news_max_searches_per_analysis:
            raise SearchLimitReached
        if self.acceptance:
            self.searches_in_flight[_ACCEPTANCE_SEARCHES] = (
                self.searches_in_flight.get(_ACCEPTANCE_SEARCHES, 0) + count
            )
            return _ACCEPTANCE_SEARCHES
        key = self._day_key()
        async with self.redis.pipeline(transaction=True) as pipe:
            pipe.incrby(key, count)
            pipe.expire(key, NEWS_IN_FLIGHT_TTL)
            in_flight_day = int((await pipe.execute())[0])
        if used_today + in_flight_day > self.config.news_max_searches_per_day:
            await self.redis.decrby(key, count)
            raise SearchLimitReached
        self.searches_in_flight[key] = self.searches_in_flight.get(key, 0) + count
        return key

    async def release_searches(self, key: str, count: int) -> None:
        left = self.searches_in_flight.get(key, 0) - count
        if left > 0:
            self.searches_in_flight[key] = left
        else:
            self.searches_in_flight.pop(key, None)
        if key == _ACCEPTANCE_SEARCHES:
            return
        try:
            await self.redis.decrby(key, count)
        except Exception:
            log.warning("analysis.search_release_failed", analysis_id=self.analysis_id)

    async def release_all_searches(self) -> None:
        """Конец задачи: резерв поисков, который не снял учет вызова (сбой), снимается."""
        for key, count in list(self.searches_in_flight.items()):
            await self.release_searches(key, count)

    async def _match_news(
        self, index: int, event: ConfirmedEvent, entry: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any]]:
        """Новости матча: из кэша, поиск или пропуск. Возвращает состояние шага и текст."""
        assert event.match_id is not None
        if not self.config.news_enabled:
            entry["news"] = "off"
            return "skipped", "analysis.steps.news_off", {}
        pair = [event.player1_id, event.player2_id]
        stale = await self._stale(pair)
        if not stale:
            entry["news"] = "cache"
            return "done", "analysis.steps.news_cache", {}
        left = await self._searches_left()
        max_uses = min(self.config.news_max_uses, left)
        if max_uses < 1:
            return self._news_limit(event, entry)
        tokens = await self._lock_news([player.id for player in stale])
        try:
            stale = await self._stale([player.id for player in stale])
            if not stale:
                entry["news"] = "cache"
                return "done", "analysis.steps.news_cache", {}
            try:
                outcome = await self._fetch_news(index, event, stale, max_uses)
            except SearchLimitReached:
                # Продолжение разговора или параллельный анализ не уложились в лимит
                return self._news_limit(event, entry)
            except ClaudeStepError as exc:
                if exc.code in _FATAL_NEWS:
                    raise
                return self._news_failed(event, entry, exc.code)
            if not outcome.searched:
                # Ни один поиск не удался: новости не проверены, news_checked_at не трогаем,
                # иначе 12 часов никто не искал бы новости этих игроков
                codes = ", ".join(sorted(set(outcome.search_errors))) or "no_search"
                return self._news_failed(event, entry, codes)
            checked = [player.id for player in stale]
            if outcome.misplaced:
                # Часть ответа — под номером игрока не из запроса: чьи это факты, неизвестно.
                # Проверенными считаются только игроки, о которых модель ответила под их
                # номером, остальных поищет следующий анализ
                log.warning(
                    "analysis.news_misplaced",
                    analysis_id=self.analysis_id,
                    match_id=event.match_id,
                    groups=outcome.misplaced,
                )
                checked = [pid for pid in checked if pid in outcome.reported]
            if not checked:
                return self._news_failed(event, entry, "bad_player")
            await self._save_news(outcome, checked)
        finally:
            await self._unlock_news(tokens)
        entry["news"] = "done"
        if outcome.search_errors:
            self.warn(
                "analysis.warnings.search_errors",
                match_id=event.match_id,
                codes=", ".join(sorted(set(outcome.search_errors))),
            )
        return (
            "done",
            "analysis.steps.news_found",
            {
                "facts": len(outcome.facts),
                "players": len(stale),
                "searches": outcome.searches,
                "search_errors": sorted(set(outcome.search_errors)),
            },
        )

    def _news_limit(
        self, event: ConfirmedEvent, entry: dict[str, Any]
    ) -> tuple[str, str, dict[str, Any]]:
        entry["news"] = "limit"
        self.warn("analysis.warnings.news_limit", match_id=event.match_id)
        return "skipped", "analysis.steps.news_limit", {}

    def _news_failed(
        self, event: ConfirmedEvent, entry: dict[str, Any], code: str
    ) -> tuple[str, str, dict[str, Any]]:
        entry["news"] = "failed"
        self.warn("analysis.warnings.news_failed", match_id=event.match_id, code=code)
        return "skipped", "analysis.steps.news_failed", {"code": code}

    async def _fetch_news(
        self, index: int, event: ConfirmedEvent, stale: Sequence[Player], max_uses: int
    ) -> NewsOutcome:
        names = await self._match_label(event)
        # Номер — место игрока в матче, как в строке «Матч» запроса: если новости нужны
        # только второму игроку, он остается номером 2 (иначе модель путала номера, и
        # факты уходили не тому игроку или пропадали)
        targets = [
            NewsTarget(
                position=1 if player.id == event.player1_id else 2,
                player_id=player.id,
                name=player.name,
            )
            for player in stale
        ]
        key = await self.key()
        client = client_for(key, timeout=float(self.config.news_timeout_s))
        return await fetch_news(
            client,
            targets=targets,
            match_label=names,
            today=utcnow().date(),
            config=self.config,
            hooks=_Hooks(self, index),
            max_uses=max_uses,
        )

    async def _match_label(self, event: ConfirmedEvent) -> str:
        """Строка «Матч: …» запроса новостей: игроки и турнир из базы, покрытие и раунд
        из списков. Название турнира из ввода участника сюда не идет (archive_tournament):
        свободный текст с переводами строк подменял список игроков запроса."""
        async with self.maker() as db:
            rows = await db.execute(
                select(Player.id, Player.name).where(
                    Player.id.in_((event.player1_id, event.player2_id))
                )
            )
            names = {pid: name for pid, name in rows}
            tour, _ = await archive_tournament(db, event.tournament_id)
        label = f"{names.get(event.player1_id, '?')} vs {names.get(event.player2_id, '?')}"
        extra = [part for part in (tour, event.surface, event.round) if part]
        return label + (", " + ", ".join(extra) if extra else "")

    async def _lock_news(self, player_ids: Sequence[int]) -> dict[str, str]:
        """Блокировка поиска новостей игрока (Redis SET NX): второй анализ ждет и потом
        берет новости из кэша. Зависшая блокировка истекает сама."""
        held: dict[str, str] = {}
        loop = asyncio.get_running_loop()
        for pid in sorted(player_ids):
            key = redis_key("analysis", "news_lock", pid)
            token = secrets.token_hex(8)
            deadline = loop.time() + NEWS_LOCK_SECONDS
            while True:
                if await self.redis.set(key, token, nx=True, ex=NEWS_LOCK_SECONDS):
                    held[key] = token
                    break
                if loop.time() >= deadline:
                    break
                await asyncio.sleep(NEWS_LOCK_POLL)
        return held

    async def _unlock_news(self, held: dict[str, str]) -> None:
        for key, token in held.items():
            try:
                await cast(Any, self.redis.eval(_RELEASE_LUA, 1, key, token))
            except Exception:
                log.warning("analysis.news_unlock_failed", analysis_id=self.analysis_id)

    async def _save_news(self, outcome: NewsOutcome, player_ids: Sequence[int]) -> None:
        now = utcnow()
        async with self.maker() as db:
            for fact in outcome.facts:
                await db.execute(
                    pg_insert(PlayerNews)
                    .values(
                        player_id=fact.player_id,
                        published_at=datetime.combine(fact.published_at, time(0), UTC),
                        kind=fact.kind,
                        summary=fact.summary,
                        source_url=fact.source_url,
                        source_name=fact.source_name or None,
                        fetched_at=now,
                        agent_run_id=outcome.agent_run_id,
                        details=fact.details,
                    )
                    .on_conflict_do_nothing(
                        index_elements=[PlayerNews.player_id, PlayerNews.source_url]
                    )
                )
            await db.execute(
                update(Player).where(Player.id.in_(player_ids)).values(news_checked_at=now)
            )
            await db.commit()

    # досье и модель

    async def dossiers(self) -> None:
        index = self.index_of("dossier")
        if self.steps[index].state == "done" and all(
            "dossier_id" in self.entry(cast(int, event.match_id)) for event in self.events
        ):
            return
        await self.check_active()
        await self.set_step(index, "running")
        data_to: str | None = None
        for event in self.events:
            assert event.match_id is not None
            entry = self.entry(event.match_id)
            if "dossier_id" in entry and "p_base" in entry:
                continue
            async with self.maker() as db:
                match = await db.get(Match, event.match_id)
                if match is None:
                    raise AppError(409, "analysis.match_missing", position=event.position)
                result = await build_dossier(
                    db, match, as_of=utcnow(), best_of=event.best_of, surface=event.surface
                )
                await db.commit()
            entry["dossier_id"] = result.dossier_id
            entry["p_base"] = result.p_base.as_dict()
            entry["features"] = result.features
            entry["as_of"] = utcnow().isoformat()
            data_to = result.content.get("data_to") or data_to
        await self.set_step(
            index,
            "done",
            detail_key="analysis.steps.dossier",
            detail_params={"matches": len(self.events), "data_to": data_to},
        )

    async def model(self) -> None:
        index = self.index_of("model")
        if self.steps[index].state == "done":
            return
        await self.set_step(index, "running")
        await self.set_step(
            index,
            "done",
            detail_key="analysis.steps.model",
            detail_params={"matches": len(self.events)},
        )

    # Claude

    async def claude(self) -> None:
        todo: list[tuple[int, ConfirmedEvent]] = []
        for event in self.events:
            assert event.match_id is not None
            index = self.index_of("claude", event.match_id)
            entry = self.entry(event.match_id)
            if "assessment_id" in entry:
                continue
            await self.check_active()
            reused = await self._reusable(entry)
            if reused is not None:
                entry["assessment_id"] = reused[0]
                entry["reused_from"] = reused[1].isoformat()
                await self.set_step(index, "running")
                await self.set_step(
                    index,
                    "done",
                    detail_key="analysis.steps.claude_reused",
                    detail_params={"at": reused[1].isoformat()},
                )
                continue
            todo.append((index, event))
        if not todo:
            return
        # Первый матч отдельно: он пишет кэш промпта, остальные читают его параллельно
        first, rest = todo[0], todo[1:]
        await self._assess(*first)
        if not rest:
            return
        limit = asyncio.Semaphore(self.config.analysis_parallel)

        async def guarded(index: int, event: ConfirmedEvent) -> None:
            async with limit:
                await self._assess(index, event)

        # Упавший матч не обрывает соседние: их вызовы уже оплачиваются, а готовые оценки
        # возьмет повторный запуск. Ошибка — первая по порядку матчей
        results = await asyncio.gather(
            *(guarded(index, event) for index, event in rest), return_exceptions=True
        )
        for (index, _), outcome in zip(rest, results, strict=True):
            if isinstance(outcome, BaseException):
                self.current = index
                raise outcome

    async def _reusable(self, entry: dict[str, Any]) -> tuple[int, datetime] | None:
        if self.config.assessment_reuse_hours <= 0 or self.prompt is None:
            return None
        since = utcnow() - timedelta(hours=self.config.assessment_reuse_hours)
        async with self.maker() as db:
            row = (
                await db.execute(
                    select(MatchAssessment.id, MatchAssessment.created_at).where(
                        MatchAssessment.dossier_id == entry["dossier_id"],
                        MatchAssessment.model == self.config.analysis_model,
                        MatchAssessment.effort == self.config.analysis_effort,
                        MatchAssessment.prompt_version == self.prompt.version_id,
                        MatchAssessment.schema_version == ASSESSMENT_SCHEMA_VERSION,
                        MatchAssessment.created_at >= since,
                    )
                )
            ).first()
        return (int(row[0]), row[1]) if row is not None else None

    async def _assess(self, index: int, event: ConfirmedEvent) -> None:
        assert event.match_id is not None and self.prompt is not None
        entry = self.entry(event.match_id)
        await self.check_active()
        await self.set_step(index, "running")
        async with self.maker() as db:
            content = await db.scalar(
                select(Dossier.content).where(Dossier.id == entry["dossier_id"])
            )
        if content is None:
            raise AppError(409, "analysis.match_missing", position=event.position)
        key = await self.key()
        client = client_for(
            key,
            timeout=anthropic.Timeout(float(self.config.analysis_stream_timeout_s), connect=5.0),
        )
        outcome = await assess_match(
            client,
            prompt=self.prompt,
            dossier_text=canonical_json(content),
            today=utcnow().date(),
            p_base=Probs3(**entry["p_base"]),
            refs=set((content.get("refs") or {}).keys()),
            highlight=self.params.claude_highlight,
            config=self.config,
            hooks=_Hooks(self, index),
        )
        async with self.maker() as db:
            output = outcome.assessment.model_dump(mode="json")
            assessment_id = await db.scalar(
                pg_insert(MatchAssessment)
                .values(
                    dossier_id=entry["dossier_id"],
                    model=self.config.analysis_model,
                    effort=self.config.analysis_effort,
                    prompt_version=self.prompt.version_id,
                    schema_version=ASSESSMENT_SCHEMA_VERSION,
                    output=output,
                    agent_run_id=outcome.agent_run_id,
                )
                .on_conflict_do_update(
                    constraint="uq_match_assessments_key",
                    set_={
                        "output": output,
                        "agent_run_id": outcome.agent_run_id,
                        "created_at": func.now(),
                    },
                )
                .returning(MatchAssessment.id)
            )
            await db.commit()
        entry["assessment_id"] = int(cast(int, assessment_id))
        entry.pop("reused_from", None)
        await self.set_step(
            index,
            "done",
            detail_key="analysis.steps.claude_done",
            detail_params={"calls": outcome.calls},
        )

    # экспресс и сумма

    async def compose(self) -> None:
        """Прогнозы, экспресс и сумма одной транзакцией вместе со статусом done."""
        index = self.index_of("compose")
        await self.check_active()
        await self.set_step(index, "running")
        async with self.lock:
            loop = asyncio.get_running_loop()
            elapsed = int((loop.time() - self.started.pop(index, loop.time())) * 1000)
            self.steps[index] = self.steps[index].model_copy(
                update={"state": "done", "elapsed_ms": elapsed}
            )
            async with self.maker() as db:
                # Разделяемая CURRENCY_LOCK до строки анализа, как у start_run: валюта
                # программы и банк из учета читаются ниже, а смена валюты не найдет итог,
                # пока он не закоммичен, — пусть ждет commit и пересчитает его
                await db.execute(select(func.pg_advisory_xact_lock_shared(CURRENCY_LOCK)))
                analysis = await db.get(Analysis, self.analysis_id, with_for_update=True)
                if analysis is None or not self.owns(analysis):
                    raise Stopped
                entries = {
                    int(event.match_id): self.entry(int(event.match_id))
                    for event in self.events
                    if event.match_id is not None
                }
                result = await compose(
                    db,
                    ComposeInput(
                        analysis=analysis,
                        events=self.events,
                        entries=entries,
                        params=self.params,
                        # Банк — из строки под блокировкой, а не из памяти: смена валюты
                        # посреди прогона пересчитывает confirmed
                        bank_input=Confirmed.from_json(analysis.confirmed).bank,
                        bookmaker=self.confirmed.bookmaker,
                        warnings=list(self.checkpoint.get("warnings") or []),
                        # Прогон приемки (acceptance-runs): прогнозы не в статистику участника
                        is_eval=bool(self.checkpoint.get(ACCEPTANCE_MARK)),
                    ),
                )
                self.checkpoint["predictions_written"] = True
                analysis.status = "done"
                analysis.result = result
                analysis.finished_at = utcnow()
                analysis.checkpoint = self._checkpoint_json()
                await release_reservation(db, analysis)
                await db.commit()
            self.status = "done"
        await self._publish("done", step=self.steps[index])


# --- задачи воркера ---


async def execute(
    analysis_id: int,
    maker: async_sessionmaker[AsyncSession],
    redis: Redis,
    *,
    attempt: int | None = None,
    deadline_s: float = RUN_DEADLINE_SECONDS,
) -> str:
    """Выполняет анализ в статусе queued (attempt — номер запуска задачи: чужой запуск
    ничего не делает). Возвращает итоговый статус."""
    return await _Runner(analysis_id, maker, redis, deadline_s=deadline_s).run(attempt)


async def reap_stuck(
    maker: async_sessionmaker[AsyncSession], redis: Redis, *, now: datetime | None = None
) -> list[int]:
    """Анализы в рабочем статусе (и в разборе текста) без движения дольше STUCK_AFTER —
    failed (analysis.worker_lost): воркер или процесс API упал, задачу сняли. Резерв
    снимается."""
    moment = now or utcnow()
    reaped: list[tuple[int, list[StepOut], str | None]] = []
    async with maker() as db:
        rows = await db.scalars(
            select(Analysis)
            .where(
                Analysis.status.in_(REAPED_STATUSES),
                Analysis.updated_at < moment - STUCK_AFTER,
            )
            .with_for_update(skip_locked=True)
        )
        for analysis in rows:
            steps = [
                StepOut.model_validate(item)
                for item in (analysis.checkpoint or {}).get("steps", [])
            ]
            failed_step: str | None = "parse" if analysis.status == "parsing" else None
            for number, step in enumerate(steps):
                if step.state == "running":
                    failed_step = step.kind
                    steps[number] = step.model_copy(
                        update={"state": "failed", "detail_key": "errors.analysis.worker_lost"}
                    )
            analysis.status = "failed"
            analysis.error_code = "analysis.worker_lost"
            analysis.error_params = {}
            analysis.failed_step = failed_step
            analysis.finished_at = moment
            analysis.checkpoint = {
                **(analysis.checkpoint or {}),
                "steps": [step.model_dump(mode="json") for step in steps],
            }
            await release_reservation(db, analysis)
            reaped.append((analysis.id, steps, failed_step))
        await db.commit()
    for analysis_id, steps, failed_step in reaped:
        event = make_event(analysis_id, "failed", steps, "failed")
        event["error"] = {"code": "analysis.worker_lost", "params": {}, "step": failed_step}
        try:
            await publish(redis, analysis_id, event)
        except Exception:
            log.warning("analysis.progress_failed", analysis_id=analysis_id)
    return [analysis_id for analysis_id, _, _ in reaped]
