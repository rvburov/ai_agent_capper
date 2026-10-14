"""Сигналы расхода ИИ администраторам (TOKEN_ECONOMY.md, раздел 6; решения Т18, Т19).

Правила считает код по agent_runs и analyses; задача воркера check_ai_alerts — раз в час.
Сработало правило — каждому активному администратору уведомление ai_alert: вид один,
правило — в variant и params (rule), текст — notifications.ai_alert.<правило>. Одно
уведомление на правило в сутки на человека. Администратор может выключить вид в
«Уведомлениях».

Правила (пороги — в RULES, поиски в день — из настроек агента):
- cache — доля кэша в шагах оценки матча по 10 последним анализам ниже 50%;
- cost — анализ за сутки дороже двух медиан за 7 дней (медиана — не меньше чем по 5);
- stops — ответов max_tokens и refusal за сутки больше 2% вызовов;
- searches — поисков за день (UTC, без прогонов приемки) столько, сколько дневной лимит
  news_max_searches_per_day: дальше новости не ищутся, поиск по кэшу не работает;
- no_price — у модели из настроек агента нет цены в model_prices: анализы не запускаются;
- rate_limit — 3 и больше ответов 429 за час (повторы SDK уже не помогли).
Проверочные прогоны (eval, shadow) в правила не входят. Прогоны приемки (acceptance-runs,
метка в analyses.checkpoint) не входят в цену анализа, долю кэша и поиски: это
нарочно дорогие многоматчевые анализы с поиском новостей, они не про рабочий расход.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from statistics import median
from typing import Any

import structlog
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import AgentConfig, load_agent_config
from app.db.models import AgentRun, Analysis, ModelPrice, Notification, User
from app.services.notifications import notify
from app.services.sessions import utcnow

log = structlog.get_logger(__name__)

COSTS_LINK = "/costs"
CHECK_KINDS = ("eval", "shadow")
# Метка прогона приемки в analyses.checkpoint (app/services/analysis_run.py)
ACCEPTANCE_MARK = "acceptance"


@dataclass(frozen=True)
class AlertRules:
    """Пороги правил — в одном месте. Поиски в день — в настройках агента."""

    cache_min_share: float = 0.50
    cache_analyses: int = 10
    cost_factor: Decimal = Decimal(2)
    cost_window: timedelta = timedelta(days=7)
    cost_recent: timedelta = timedelta(hours=24)
    cost_min_analyses: int = 5
    stops_max_share: float = 0.02
    stops_window: timedelta = timedelta(hours=24)
    rate_limit_series: int = 3
    rate_limit_window: timedelta = timedelta(hours=1)
    # Одно уведомление на правило в сутки: 23 часа, чтобы ежечасная проверка, сдвинутая на
    # секунды, не пропускала день
    repeat_after: timedelta = timedelta(hours=23)


RULES = AlertRules()
RULE_NAMES = ("cache", "cost", "stops", "searches", "no_price", "rate_limit")


@dataclass(frozen=True)
class Fired:
    """Сработавшее правило и числа для текста уведомления."""

    rule: str
    params: dict[str, Any]


# Числа в тексте уведомления — по-русски, с запятой, как formatUsd и проценты на фронтенде
def _pct(value: float) -> str:
    return f"{value * 100:.1f}".rstrip("0").rstrip(".").replace(".", ",")


def _usd(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01"))).replace(".", ",")


def _working_runs() -> Any:
    return AgentRun.kind.not_in(CHECK_KINDS)


def _not_acceptance() -> Any:
    """Анализ не прогон приемки (у checkpoint нет метки acceptance)."""
    return ~Analysis.checkpoint.has_key(ACCEPTANCE_MARK)


async def check_cache(db: AsyncSession, now: datetime, config: AgentConfig) -> Fired | None:
    """Доля кэша в шагах оценки матча по последним 10 анализам (у которых он был)."""
    recent = (
        select(AgentRun.analysis_id)
        .join(Analysis, Analysis.id == AgentRun.analysis_id)
        .where(AgentRun.kind == "analysis", _not_acceptance())
        .group_by(AgentRun.analysis_id)
        .order_by(func.max(AgentRun.created_at).desc())
        .limit(RULES.cache_analyses)
        .subquery()
    )
    row = (
        await db.execute(
            select(
                func.count(func.distinct(AgentRun.analysis_id)),
                func.coalesce(func.sum(AgentRun.cache_read_tokens), 0),
                func.coalesce(
                    func.sum(
                        AgentRun.input_tokens
                        + AgentRun.cache_write_tokens
                        + AgentRun.cache_read_tokens
                    ),
                    0,
                ),
            ).where(AgentRun.kind == "analysis", AgentRun.analysis_id.in_(select(recent)))
        )
    ).one()
    analyses, read, prompt = int(row[0]), int(row[1]), int(row[2])
    if analyses < RULES.cache_analyses or prompt <= 0:
        return None
    share = read / prompt
    if share >= RULES.cache_min_share:
        return None
    return Fired(
        "cache",
        {"share": _pct(share), "min": _pct(RULES.cache_min_share), "analyses": analyses},
    )


async def check_cost(db: AsyncSession, now: datetime, config: AgentConfig) -> Fired | None:
    """Анализ за сутки дороже двух медиан цены анализа за 7 дней."""
    rows = list(
        await db.execute(
            select(Analysis.cost_usd, Analysis.finished_at).where(
                Analysis.status == "done",
                Analysis.finished_at >= now - RULES.cost_window,
                Analysis.cost_usd > 0,
                _not_acceptance(),
            )
        )
    )
    if len(rows) < RULES.cost_min_analyses:
        return None
    middle = Decimal(median(Decimal(cost) for cost, _ in rows))
    recent = [
        Decimal(cost) for cost, at in rows if at is not None and at >= now - RULES.cost_recent
    ]
    if not recent or middle <= 0:
        return None
    worst = max(recent)
    if worst <= middle * RULES.cost_factor:
        return None
    return Fired(
        "cost",
        {
            "cost": _usd(worst),
            "median": _usd(middle),
            "factor": str(RULES.cost_factor),
            "analyses": len(rows),
        },
    )


async def check_stops(db: AsyncSession, now: datetime, config: AgentConfig) -> Fired | None:
    """Доля обрезанных ответов и отказов среди вызовов за сутки."""
    bad = AgentRun.stop_reason.in_(("max_tokens", "refusal"))
    row = (
        await db.execute(
            select(func.count(), func.count().filter(bad)).where(
                AgentRun.created_at >= now - RULES.stops_window, _working_runs()
            )
        )
    ).one()
    total, stopped = int(row[0]), int(row[1])
    if not stopped or stopped / total <= RULES.stops_max_share:
        return None
    return Fired(
        "stops",
        {
            "share": _pct(stopped / total),
            "max": _pct(RULES.stops_max_share),
            "stopped": stopped,
            "runs": total,
        },
    )


async def check_searches(db: AsyncSession, now: datetime, config: AgentConfig) -> Fired | None:
    """Поиски за день (UTC) без прогонов приемки дошли до дневного лимита настроек."""
    limit = config.news_max_searches_per_day
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    used = await db.scalar(
        select(func.coalesce(func.sum(AgentRun.web_searches), 0))
        .select_from(AgentRun)
        .outerjoin(Analysis, Analysis.id == AgentRun.analysis_id)
        .where(
            AgentRun.kind == "news",
            AgentRun.created_at >= day_start,
            or_(Analysis.id.is_(None), _not_acceptance()),
        )
    )
    searches = int(used or 0)
    if limit <= 0 or searches < limit:
        return None
    return Fired("searches", {"searches": searches, "limit": limit})


async def check_prices(db: AsyncSession, now: datetime, config: AgentConfig) -> Fired | None:
    """Модели из настроек агента без цены на сейчас."""
    priced = set(
        await db.scalars(
            select(ModelPrice.model).where(
                ModelPrice.model.in_(config.models()), ModelPrice.valid_from <= now
            )
        )
    )
    missing = [model for model in config.models() if model not in priced]
    if not missing:
        return None
    return Fired("no_price", {"models": ", ".join(missing)})


async def check_rate_limit(db: AsyncSession, now: datetime, config: AgentConfig) -> Fired | None:
    """Серия ответов 429 за час: повторы SDK закончились, вызов не прошел."""
    count = await db.scalar(
        select(func.count()).where(
            AgentRun.created_at >= now - RULES.rate_limit_window,
            _working_runs(),
            or_(AgentRun.error.like("429:%"), AgentRun.error.like("%rate_limit_error%")),
        )
    )
    errors = int(count or 0)
    if errors < RULES.rate_limit_series:
        return None
    return Fired("rate_limit", {"errors": errors, "minutes": RULES.rate_limit_window.seconds // 60})


Check = Callable[[AsyncSession, datetime, AgentConfig], Awaitable[Fired | None]]
CHECKS: tuple[Check, ...] = (
    check_cache,
    check_cost,
    check_stops,
    check_searches,
    check_prices,
    check_rate_limit,
)


async def evaluate(db: AsyncSession, *, now: datetime | None = None) -> list[Fired]:
    """Какие правила сработали сейчас (без уведомлений)."""
    now = now or utcnow()
    config = await load_agent_config(db)
    fired: list[Fired] = []
    for check in CHECKS:
        found = await check(db, now, config)
        if found is not None:
            fired.append(found)
    return fired


async def _admins(db: AsyncSession) -> list[int]:
    return list(
        await db.scalars(
            select(User.id).where(User.role == "admin", User.status == "active").order_by(User.id)
        )
    )


async def _sent_recently(db: AsyncSession, admin_id: int, rule: str, since: datetime) -> bool:
    found = await db.scalar(
        select(Notification.id)
        .where(
            Notification.user_id == admin_id,
            Notification.kind == "ai_alert",
            Notification.params["rule"].astext == rule,
            Notification.created_at > since,
        )
        .limit(1)
    )
    return found is not None


async def run_checks(db: AsyncSession, *, now: datetime | None = None) -> list[str]:
    """Проверка правил и уведомления администраторам: одно на правило в сутки каждому.
    Делает commit. Возвращает сработавшие правила."""
    now = now or utcnow()
    fired = await evaluate(db, now=now)
    admins = await _admins(db)
    since = now - RULES.repeat_after
    for item in fired:
        for admin_id in admins:
            if await _sent_recently(db, admin_id, item.rule, since):
                continue
            await notify(
                db,
                user_id=admin_id,
                kind="ai_alert",
                variant=item.rule,
                link=COSTS_LINK,
                rule=item.rule,
                **item.params,
            )
    await db.commit()
    if fired:
        log.warning("ai_alerts.fired", rules=[item.rule for item in fired])
    return [item.rule for item in fired]
