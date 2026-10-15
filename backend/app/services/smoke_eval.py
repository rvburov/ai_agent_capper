"""Приемка этапа 3, smoke-eval (PLAN.md, этап 3, «Готово, когда»): оценка матча Opus 5.5
через Message Batches API (−50% на все токены) на сыгранных матчах после даты среза.

Событие — сыгранный матч (status = finished, есть победитель) с днем не раньше since и
строго раньше сегодня. Матчи до даты среза знаний модели (safe_since) модель могла
видеть при обучении: такой прогон — проба (split = train, eval_set с «:seen»), а не
приемка. Берутся первые по дню (и id) — набор воспроизводим. Досье — на
день матча (только данные строго раньше него) и без новостей: это срез «Claude без
новостей». Стороны назначаются детерминированно случайно, как в бэктесте (side_flip по
id матча): в архиве игрок 1 — победитель. Промпт анализа — из активной версии стратегии
администратора, схема и проверки кода — те же, что в анализе (assessment_schema,
check_assessment); system — с точкой кэша на 1 час (пакет идет параллельно и дольше
5 минут). Повтора в том же разговоре в Batch нет: ответ, не прошедший проверки кода,
считается отдельно (в анализе он ушел бы на повтор), но его числа идут в лог-лосс.

Учет: строка eval_runs (version_kind = strategy — версия стратегии с промптом анализа,
split = test — события после даты среза знаний модели, ни на чем не подбирались,
eval_set = smoke:d1-nonews:<since>:<число>), в metrics — пакет, события и итог.
Состояния пакета (metrics.status): creating → submitted → ended; failed — пакет не
отправлен; lost — пакета или его результатов у Anthropic больше нет (результаты хранятся
29 дней после создания, пакеты видны только из своего workspace); abandoned — закрыт
владельцем (--abandon). Пакет lost или abandoned можно снова забрать (--resume), если
он нашелся (например, вернули ключ того же workspace).
Результаты пакета: agent_runs (kind = eval, batch = true, eval_run_id, request_id =
«<batch_id>/<custom_id>»), стоимость — со скидкой Batch, поиск без скидки (его здесь
нет). Прогнозы — predictions с is_eval и eval_run_id по 6 исходам матча, стороны — в
порядке игроков матча. Повторный сбор результатов ничего не пишет второй раз.

Итог: ошибок формата (ответ не по схеме или вероятности вне 0..1), остановок max_tokens,
отказов, ошибок пакета; средний лог-лосс p_claude, p_final (после ограничения Р22) и
p_base по исходу матча, разница p_claude − p_base и ее бутстрэп-ДИ по событиям.
Критерий: оценены все события (отказ, ошибка пакета, истекший или отмененный запрос —
событие не оценено: выбросить его из лог-лосса — смещение выборки), ошибок формата и
max_tokens 0, разница не больше LOG_LOSS_MARGIN (0,01).
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from dataclasses import replace as dataclass_replace
from datetime import UTC, date, datetime, time
from decimal import ROUND_UP, Decimal
from typing import Any, cast

import anthropic
import numpy as np
from anthropic.types import Message
from anthropic.types.messages import MessageBatch
from anthropic.types.messages.batch_create_params import Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent import batches
from app.agent.analysis import check_assessment
from app.agent.batches import BATCH_NOT_FOUND, RESULTS_EXPIRED, BatchLost
from app.agent.calls import estimate_tokens
from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError, parse_output, stop_error
from app.agent.prompts import ANALYSIS_REQUEST, Prompt, load_prompt
from app.agent.schemas import ASSESSMENT_SCHEMA_VERSION, MatchAssessmentOut, assessment_schema
from app.db.models import (
    EvalRun,
    Match,
    ModelPrice,
    Player,
    Prediction,
    StrategyVersion,
    Tournament,
)
from app.ml import model_versions
from app.ml.backtest import side_flip
from app.ml.metrics import Estimate, bootstrap_diff_ci, log_losses
from app.ml.model_versions import active_model_id
from app.ml.sets import MARKETS, PROBS3_FIELDS, Probs3
from app.ml.strategy import apply_claude
from app.services.check_runs import ABANDONED, LOST, SUBMITTED
from app.services.dossier import FEATURE_SET, build_dossier
from app.services.strategy_versions import params_of

KIND = "smoke"
SPLIT = "test"
# Матчи раньше даты среза знаний модели: модель могла их видеть (проба, не приемка)
SEEN_SPLIT = "train"
# Первый день после даты среза знаний модели анализа (Opus 5.5 — июнь 2026). Для модели
# не из списка берется DEFAULT_SAFE_SINCE: при смене модели анализа сверьте дату среза с
# документацией Anthropic и допишите сюда
SAFE_SINCE = {"claude-opus-5-5": date(2026, 7, 1)}
DEFAULT_SAFE_SINCE = date(2026, 7, 1)
# Приемка — на 40 событиях (PLAN.md, этап 3); меньше — пробный прогон
ACCEPTANCE_EVENTS = 40
# Средний лог-лосс Claude хуже базовой модели не больше чем на столько (PLAN.md, этап 3)
LOG_LOSS_MARGIN = 0.01
# Опрос пакета: большинство пакетов готово за час, результаты хранятся 29 дней
POLL_SECONDS = batches.POLL_SECONDS
BOOTSTRAP_SEED = 20261012
MTOK = Decimal(1_000_000)
USD_STEP = Decimal("0.0001")
# Состояния пакета в eval_runs.metrics.status (submitted, lost, abandoned — в check_runs)
CREATING = "creating"
ENDED = "ended"
FAILED = "failed"
# Пакеты, результаты которых еще можно попробовать забрать (--resume)
COLLECTABLE = frozenset({SUBMITTED, LOST, ABANDONED})
# Почему пакет потерян (metrics.error): BATCH_NOT_FOUND, RESULTS_EXPIRED (app/agent/batches.py)
__all__ = ["BATCH_NOT_FOUND", "RESULTS_EXPIRED", "BatchLost"]
# Итог одного события
OK = "ok"
CHECKS = "checks"
FORMAT = "format"
MAX_TOKENS = "max_tokens"
REFUSAL = "refusal"
ERRORED = "errored"
EXPIRED = "expired"
CANCELED = "canceled"
OUTCOMES = (OK, CHECKS, FORMAT, MAX_TOKENS, REFUSAL, ERRORED, EXPIRED, CANCELED)
USABLE = frozenset({OK, CHECKS})


def safe_since(model: str) -> date:
    return SAFE_SINCE.get(model, DEFAULT_SAFE_SINCE)


def split_for(since: date, model: str) -> str:
    """test — все события после даты среза знаний модели, иначе train (модель могла их
    видеть, это не проверка)."""
    return SPLIT if since >= safe_since(model) else SEEN_SPLIT


def eval_set_name(since: date, count: int, split: str = SPLIT) -> str:
    name = f"{KIND}:{FEATURE_SET}-nonews:{since.isoformat()}:{count}"
    return name if split == SPLIT else f"{name}:seen"


def custom_id(eval_run_id: int, match_id: int) -> str:
    """id запроса в пакете: ^[a-zA-Z0-9_-]{1,64}$."""
    return f"ev{eval_run_id}-m{match_id}"


# --- события ---


@dataclass(frozen=True)
class SmokeMatch:
    match: Match
    day: date
    surface: str
    best_of: int


async def pick_matches(
    db: AsyncSession, *, since: date, count: int, today: date
) -> list[SmokeMatch]:
    """Первые count сыгранных матчей с днем от since до вчера включительно."""
    day = func.coalesce(Match.match_date, Tournament.start_date)
    rows = await db.execute(
        select(Match, day, Tournament.surface, Tournament.best_of)
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(
            Match.status == "finished",
            Match.winner_id.is_not(None),
            Tournament.surface.is_not(None),
            day >= since,
            day < today,
        )
        .order_by(day, Match.id)
        .limit(count)
    )
    return [
        SmokeMatch(
            match=match,
            day=match_day,
            surface=surface or "hard",
            best_of=match.best_of or tour_best_of or 3,
        )
        for match, match_day, surface, tour_best_of in rows
    ]


@dataclass(frozen=True)
class SmokeEvent:
    """Событие проверки: стороны досье (flip — игрок 2 матча стал p1), исход для p1 (y),
    досье и то, что нужно для проверки ответа и прогнозов."""

    match_id: int
    day: date
    flip: bool
    y: int
    p1: str
    p2: str
    dossier_id: int
    dossier_text: str
    as_of: datetime
    p_base: Probs3
    refs: tuple[str, ...]
    features: dict[str, Any]

    def to_json(self, eval_run_id: int) -> dict[str, Any]:
        return {
            "custom_id": custom_id(eval_run_id, self.match_id),
            "match_id": self.match_id,
            "day": self.day.isoformat(),
            "flip": self.flip,
            "y": self.y,
            "p1": self.p1,
            "p2": self.p2,
            "dossier_id": self.dossier_id,
            "as_of": self.as_of.isoformat(),
            "p_base": self.p_base.as_dict(),
            "refs": list(self.refs),
            "features": self.features,
        }


async def prepare_events(
    db: AsyncSession,
    matches: Sequence[SmokeMatch],
    *,
    model: model_versions.ModelSnapshot | None = None,
) -> list[SmokeEvent]:
    """Досье каждого матча на день матча, без новостей, со сторонами по side_flip; model —
    снимок базовой модели (у набора — закрепленный при заморозке), нет — один снимок
    активной версии на все события. commit — за вызывающим."""
    model = model or await model_versions.snapshot(db)
    ids = {pid for item in matches for pid in (item.match.player1_id, item.match.player2_id)}
    names = dict((await db.execute(select(Player.id, Player.name).where(Player.id.in_(ids)))).all())
    events: list[SmokeEvent] = []
    for item in matches:
        match = item.match
        flip = side_flip(match.id)
        first, second = (
            (match.player2_id, match.player1_id) if flip else (match.player1_id, match.player2_id)
        )
        as_of = datetime.combine(item.day, time(0), UTC)
        dossier = await build_dossier(
            db,
            match,
            as_of=as_of,
            best_of=item.best_of,
            surface=item.surface,
            with_news=False,
            swap=flip,
            model=model,
        )
        events.append(
            SmokeEvent(
                match_id=match.id,
                day=item.day,
                flip=flip,
                y=1 if match.winner_id == first else 0,
                p1=names.get(first, str(first)),
                p2=names.get(second, str(second)),
                dossier_id=dossier.dossier_id,
                dossier_text=dossier.text,
                as_of=as_of,
                p_base=dossier.p_base,
                refs=tuple(sorted((dossier.content.get("refs") or {}).keys())),
                features=dossier.features,
            )
        )
    return events


# --- запросы и цена ---


def request_text(event: SmokeEvent) -> str:
    return load_prompt(*ANALYSIS_REQUEST).format(today=event.day.isoformat())


def batch_request(
    eval_run_id: int, event: SmokeEvent, prompt: Prompt, config: AgentConfig
) -> Request:
    """Запрос пакета: те же system, сообщение, схема и effort, что у вызова анализа."""
    return cast(
        Request,
        {
            "custom_id": custom_id(eval_run_id, event.match_id),
            "params": {
                "model": config.analysis_model,
                "max_tokens": config.analysis_max_tokens,
                "system": [
                    {
                        "type": "text",
                        "text": prompt.text,
                        "cache_control": {"type": "ephemeral", "ttl": "1h"},
                    }
                ],
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": event.dossier_text},
                            {"type": "text", "text": request_text(event)},
                        ],
                    }
                ],
                "output_config": {
                    "effort": config.analysis_effort,
                    "format": {"type": "json_schema", "schema": assessment_schema()},
                },
            },
        },
    )


@dataclass(frozen=True)
class SmokeEstimate:
    estimate_usd: Decimal
    worst_usd: Decimal


def estimate(
    events: Sequence[SmokeEvent], prompt: Prompt, config: AgentConfig, price: ModelPrice
) -> SmokeEstimate:
    """Оценка и худший случай пакета: половина цены всех токенов. Оценка — как у вызова
    анализа (estimate_analysis_*), худший случай — вход по тексту сверху (2 символа на
    токен) по цене записи кэша на 1 час и весь max_tokens (batches.request_worst_usd: с
    надбавкой за длинный вход)."""
    per_input = max(price.input, price.cache_write_5m)
    one = (
        (
            config.estimate_analysis_input_tokens * per_input
            + config.estimate_analysis_output_tokens * price.output
        )
        / MTOK
        / 2
    )
    worst = Decimal(0)
    for event in events:
        tokens = estimate_tokens(prompt.text, event.dossier_text, request_text(event))
        worst += batches.request_worst_usd(
            price, input_tokens=tokens, max_tokens=config.analysis_max_tokens, cache_1h=True
        )
    return SmokeEstimate(
        estimate_usd=(one * len(events)).quantize(USD_STEP, rounding=ROUND_UP),
        worst_usd=worst.quantize(USD_STEP, rounding=ROUND_UP),
    )


# --- пакет ---


async def create_run(
    db: AsyncSession,
    *,
    version: StrategyVersion,
    prompt: Prompt,
    config: AgentConfig,
    since: date,
    events: Sequence[SmokeEvent],
    cost: SmokeEstimate,
) -> EvalRun:
    """Строка eval_runs до отправки пакета (status = creating): по ее id строятся
    custom_id. flush; commit — за вызывающим."""
    split = split_for(since, config.analysis_model)
    run = EvalRun(
        version_kind="strategy",
        strategy_version_id=version.id,
        eval_set=eval_set_name(since, len(events), split),
        split=split,
        n_events=len(events),
        metrics={},
    )
    db.add(run)
    await db.flush()
    run.metrics = {
        "kind": KIND,
        "status": CREATING,
        "since": since.isoformat(),
        "model": config.analysis_model,
        "effort": config.analysis_effort,
        "max_tokens": config.analysis_max_tokens,
        "prompt_version": prompt.version_id,
        "schema_version": ASSESSMENT_SCHEMA_VERSION,
        "estimate_usd": str(cost.estimate_usd),
        "worst_usd": str(cost.worst_usd),
        "events": [event.to_json(run.id) for event in events],
    }
    await db.flush()
    return run


async def submit(
    client: anthropic.AsyncAnthropic,
    db: AsyncSession,
    run: EvalRun,
    events: Sequence[SmokeEvent],
    prompt: Prompt,
    config: AgentConfig,
) -> str:
    """Отправка пакета; id пакета и status = submitted — в eval_runs (commit). Сбой —
    ClaudeStepError, строка — status = failed (ничего не потрачено)."""
    requests = [batch_request(run.id, event, prompt, config) for event in events]
    try:
        batch = await batches.create_batch(client, requests)
    except ClaudeStepError as exc:
        run.metrics = {**run.metrics, "status": FAILED, "error": exc.journal_detail}
        await db.commit()
        raise
    run.metrics = {
        **run.metrics,
        "status": SUBMITTED,
        "batch_id": batch.id,
        "submitted_at": batch.created_at.isoformat(),
    }
    await db.commit()
    return batch.id


async def wait_batch(
    client: anthropic.AsyncAnthropic,
    batch_id: str,
    *,
    on_poll: Callable[[MessageBatch], None] | None = None,
    poll_seconds: float | None = None,
) -> MessageBatch:
    """Опрос пакета раз в poll_seconds (по умолчанию POLL_SECONDS), пока он не закончен."""
    return await batches.wait_batch(
        client,
        batch_id,
        on_poll=on_poll,
        poll_seconds=POLL_SECONDS if poll_seconds is None else poll_seconds,
    )


async def retrieve(client: anthropic.AsyncAnthropic, batch_id: str) -> MessageBatch:
    """Пакет по id; 404 — BatchLost (app/agent/batches.py)."""
    return await batches.retrieve(client, batch_id)


async def mark_lost(db: AsyncSession, run_id: int, reason: str) -> EvalRun:
    """Пакет потерян: status = lost с причиной (commit). Худший случай пакета остается в
    бюджете проверок до конца месяца отправки (check_runs.eval_budget)."""
    run = await db.get_one(EvalRun, run_id, populate_existing=True, with_for_update=True)
    metrics = dict(run.metrics or {})
    if metrics.get("status") in COLLECTABLE:
        run.metrics = {**metrics, "status": LOST, "error": reason}
    await db.commit()
    return run


async def abandon(db: AsyncSession, run_id: int) -> EvalRun | None:
    """Закрыть незабранный пакет без результатов (--abandon): status = abandoned
    (commit). Пакет у Anthropic не отменяется. None — такого пакета smoke-eval нет;
    закрыть можно только submitted и lost."""
    run = await db.get(EvalRun, run_id, populate_existing=True, with_for_update=True)
    metrics = dict(run.metrics or {}) if run is not None else {}
    if run is None or metrics.get("kind") != KIND:
        await db.rollback()
        return None
    if metrics.get("status") in (SUBMITTED, LOST):
        run.metrics = {**metrics, "status": ABANDONED}
    await db.commit()
    return run


# --- результаты ---


@dataclass(frozen=True)
class Judged:
    """Итог одного запроса пакета: вид (OUTCOMES), метка для agent_runs.error, ответ."""

    outcome: str
    detail: str | None
    assessment: MatchAssessmentOut | None


def judge(message: Message, event: dict[str, Any], highlight: float) -> Judged:
    """Ответ пакета так же, как в анализе: сначала остановка, потом схема и проверки."""
    failure = stop_error(message)
    if failure is not None:
        if failure.code == "ai.refusal":
            return Judged(REFUSAL, failure.detail, None)
        if failure.code == "ai.max_tokens":
            return Judged(MAX_TOKENS, failure.detail, None)
        return Judged(FORMAT, failure.detail, None)
    try:
        assessment = parse_output(message, MatchAssessmentOut)
    except ClaudeStepError as exc:
        return Judged(FORMAT, exc.detail, None)
    values = [float(getattr(assessment, name)) for name in PROBS3_FIELDS]
    if not all(np.isfinite(value) and 0.0 <= value <= 1.0 for value in values):
        return Judged(FORMAT, "range", None)
    problems = check_assessment(
        assessment,
        p_base=Probs3(**event["p_base"]),
        refs=event["refs"],
        highlight=highlight,
    )
    if problems:
        return Judged(CHECKS, "checks", assessment)
    return Judged(OK, None, assessment)


@dataclass(frozen=True)
class SmokeSummary:
    """Итог проверки (то, что пишется в eval_runs.metrics и в отчет)."""

    counts: dict[str, int]
    n: int
    total: int
    log_loss_claude: float | None
    log_loss_final: float | None
    log_loss_base: float | None
    diff: Estimate | None
    cost_usd: Decimal

    @property
    def unrated(self) -> int:
        """Событий без пригодного ответа: ошибки формата, max_tokens, отказы, ошибки
        пакета, истекшие и отмененные."""
        return self.total - self.n

    @property
    def passed(self) -> bool:
        """Критерии выполнены. Это еще не приемка: она — на ACCEPTANCE_EVENTS событиях
        после даты среза знаний (решает вызывающий по n_events и split)."""
        return (
            self.total > 0
            and self.n == self.total
            and self.counts.get(FORMAT, 0) == 0
            and self.counts.get(MAX_TOKENS, 0) == 0
            and self.diff is not None
            and self.diff.value <= LOG_LOSS_MARGIN
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "counts": self.counts,
            "n": self.n,
            "total": self.total,
            "log_loss_claude": self.log_loss_claude,
            "log_loss_final": self.log_loss_final,
            "log_loss_base": self.log_loss_base,
            "diff": None
            if self.diff is None
            else {
                "value": self.diff.value,
                "low": self.diff.low,
                "high": self.diff.high,
                "n": self.diff.n,
            },
            "cost_usd": str(self.cost_usd),
            "passed": self.passed,
        }

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> "SmokeSummary":
        diff = raw.get("diff")
        counts = {str(key): int(value) for key, value in (raw.get("counts") or {}).items()}
        return cls(
            counts=counts,
            n=int(raw.get("n") or 0),
            total=int(raw.get("total") or sum(counts.values())),
            log_loss_claude=raw.get("log_loss_claude"),
            log_loss_final=raw.get("log_loss_final"),
            log_loss_base=raw.get("log_loss_base"),
            diff=None
            if not diff
            else Estimate(
                value=float(diff["value"]),
                low=float(diff["low"]),
                high=float(diff["high"]),
                n=int(diff["n"]),
            ),
            cost_usd=Decimal(str(raw.get("cost_usd") or "0")),
        )


def summarize(rows: Sequence[dict[str, Any]], cost_usd: Decimal) -> SmokeSummary:
    """Счетчики по видам итога и лог-лосс на пригодных ответах (OK и CHECKS).
    rows — события из metrics с полями outcome, y, p_base, p_claude, p_final."""
    counts = {outcome: 0 for outcome in OUTCOMES}
    for row in rows:
        counts[row["outcome"]] = counts.get(row["outcome"], 0) + 1
    usable = [row for row in rows if row["outcome"] in USABLE]
    if not usable:
        return SmokeSummary(counts, 0, len(rows), None, None, None, None, cost_usd)
    y = [row["y"] for row in usable]
    claude = log_losses([row["p_claude"] for row in usable], y)
    final = log_losses([row["p_final"] for row in usable], y)
    base = log_losses([row["p_base"]["p1_win"] for row in usable], y)
    return SmokeSummary(
        counts=counts,
        n=len(usable),
        total=len(rows),
        log_loss_claude=float(claude.mean()),
        log_loss_final=float(final.mean()),
        log_loss_base=float(base.mean()),
        diff=bootstrap_diff_ci(claude, base, seed=BOOTSTRAP_SEED),
        cost_usd=cost_usd,
    )


def _clip(value: float) -> float:
    return min(1.0, max(0.0, value))


def _predictions(
    run: EvalRun,
    event: dict[str, Any],
    assessment: MatchAssessmentOut,
    *,
    version: StrategyVersion | None,
    ml_model: str | None,
    model: str,
    agent_run_id: int,
) -> tuple[list[Prediction], Probs3]:
    """Прогнозы по 6 исходам в порядке игроков матча (у перевернутого досье стороны
    меняются местами) и итоговые числа Р22 в порядке досье."""
    p_base = Probs3(**event["p_base"])
    p_claude = Probs3(
        _clip(assessment.p1_win), _clip(assessment.p1_cover), _clip(assessment.p2_cover)
    )
    final = apply_claude(p_base, p_claude, params_of(version))
    base, claude, result = (
        final.p_base.markets(),
        final.p_claude.markets(),
        final.p_final.markets(),
    )
    rows: list[Prediction] = []
    for market in MARKETS:
        for selection in (1, 2):
            rows.append(
                Prediction(
                    user_id=None,
                    analysis_id=None,
                    match_id=int(event["match_id"]),
                    market=market,
                    selection=3 - selection if event["flip"] else selection,
                    as_of=datetime.fromisoformat(event["as_of"]),
                    dossier_id=int(event["dossier_id"]),
                    features=event.get("features") or {},
                    feature_set=FEATURE_SET,
                    strategy_version_id=run.strategy_version_id,
                    # Версия модели, что дала p_base досье (закрепленная за набором), иначе
                    # активная на момент сбора
                    ml_model_id=(event.get("features") or {}).get("ml_model_id") or ml_model,
                    llm_model=model,
                    effort=run.metrics.get("effort"),
                    prompt_version=run.metrics.get("prompt_version"),
                    p_base=_clip(base[(market, selection)]),
                    p_claude=_clip(claude[(market, selection)]),
                    p_final=_clip(result[(market, selection)]),
                    rationale=assessment.explanation,
                    agent_run_id=agent_run_id,
                    is_eval=True,
                    eval_run_id=run.id,
                )
            )
    return rows, final.p_final


_ITEM_OUTCOMES = {
    batches.ERRORED: ERRORED,
    batches.EXPIRED: EXPIRED,
    batches.CANCELED: CANCELED,
}


def _judge_item(item: batches.BatchItem, event: dict[str, Any], highlight: float) -> Judged:
    """Итог результата пакета: ответ — как в анализе (judge), остальное — ошибка пакета,
    истекший или отмененный запрос."""
    if item.message is not None:
        return judge(item.message, event, highlight)
    return Judged(_ITEM_OUTCOMES.get(item.kind, ERRORED), item.detail, None)


def replace_detail(item: batches.BatchItem, detail: str | None) -> batches.BatchItem:
    """Результат с меткой ошибки итога (ответ не по схеме, отказ) для agent_runs.error."""
    return dataclass_replace(item, detail=detail)


async def collect(
    db: AsyncSession, client: anthropic.AsyncAnthropic, run_id: int
) -> tuple[EvalRun, SmokeSummary]:
    """Результаты законченного пакета: agent_runs, прогнозы, итог в eval_runs (commit).
    Строка eval_runs под блокировкой: два одновременных сбора не пишут дважды, уже
    собранный пакет отдает сохраненный итог. Пакета или результатов у Anthropic нет —
    строка lost (commit) и BatchLost."""
    run = await db.scalar(
        select(EvalRun)
        .where(EvalRun.id == run_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None:
        raise LookupError(run_id)
    metrics = dict(run.metrics or {})
    if metrics.get("status") == ENDED:
        await db.commit()
        return run, SmokeSummary.from_json(metrics.get("summary") or {})
    batch_id = str(metrics["batch_id"])
    try:
        found = await retrieve(client, batch_id)
        # Пакет закончен, а результатов нет (прошло 29 дней после создания) — BatchLost
        batches.ended_with_results(found)
    except BatchLost as exc:
        await db.rollback()
        await mark_lost(db, run_id, exc.reason)
        raise
    events = {str(event["custom_id"]): dict(event) for event in metrics.get("events") or []}
    version = await db.get(StrategyVersion, run.strategy_version_id)
    highlight = params_of(version).claude_highlight
    ml_model = await active_model_id(db)
    # Модель из настроек на момент отправки (как в учете вызовов анализа): по ней ищется цена
    model = str(metrics.get("model") or "")
    meta = batches.RunMeta(
        kind="eval",
        model=model,
        effort=metrics.get("effort"),
        prompt_version=metrics.get("prompt_version"),
        schema_version=metrics.get("schema_version"),
        eval_run_id=run.id,
    )
    total = Decimal(0)
    step = 0
    try:
        async for item in batches.iter_results(client, batch_id):
            event = events.get(item.custom_id)
            if event is None:
                continue
            step += 1
            judged = _judge_item(item, event, highlight)
            agent_run = await batches.record_item(
                db, replace_detail(item, judged.detail), batch_id=batch_id, meta=meta, step=step
            )
            total += agent_run.cost_usd
            event["outcome"] = judged.outcome
            if judged.assessment is not None:
                rows, final = _predictions(
                    run,
                    event,
                    judged.assessment,
                    version=version,
                    ml_model=ml_model,
                    model=model,
                    agent_run_id=agent_run.id,
                )
                db.add_all(rows)
                event["p_claude"] = _clip(judged.assessment.p1_win)
                event["p_final"] = final.p1_win
    except BatchLost:
        await db.rollback()
        await mark_lost(db, run_id, BATCH_NOT_FOUND)
        raise
    for event in events.values():
        # Запроса нет в результатах (такого быть не должно): считаем ошибкой пакета
        event.setdefault("outcome", ERRORED)
    summary = summarize(list(events.values()), total)
    run.metrics = {
        **metrics,
        "status": ENDED,
        "events": list(events.values()),
        "summary": summary.to_json(),
    }
    run.cost_usd = total
    await db.commit()
    return run, summary


def stored_events(run: EvalRun) -> list[dict[str, Any]]:
    return [dict(event) for event in (run.metrics or {}).get("events") or []]
