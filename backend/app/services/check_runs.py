"""Общее для команд приемки этапа 3 (acceptance-runs, smoke-eval, parse-eval):
администратор, на чьем ключе идут вызовы, и бюджет проверок.

Бюджет проверок (Р22) — app_settings.eval_budget_usd на месяц по UTC. Проверки — вызовы
Claude с kind из CHECK_RUN_KINDS (eval, shadow): smoke-eval через Batch и разбор
эталонных сообщений parse-eval. В расход участника и общий бюджет ключа администратора
они не входят. Anthropic списывает деньги за запросы пакета, когда они выполнены, а
строки agent_runs с их ценой пишутся, когда результаты забирают. Поэтому худший случай
пакета (eval_runs.metrics.worst_usd) держится в резерве, пока строк нет:

- submitted (еще не забран) — пока результаты можно забрать: 29 дней после отправки, а в
  месяце отправки — до конца месяца. Старше — в резерв не входит: результатов уже не
  будет, а деньги списаны в прошлом месяце;
- lost (пакета или результатов у Anthropic нет) и abandoned (закрыт владельцем,
  smoke-eval --abandon) — до конца месяца отправки: деньги, скорее всего, списаны, а
  сколько — неизвестно.

Пакеты этапа 5 (быстрая проверка урока, прогоны eval) живут в batch_jobs (kind eval и
shadow) с теми же окнами резерва (app/agent/batches.py, reserved_usd); прогон eval_runs
со ссылкой на пакет (batch_job_id) второй раз не считается.

До отправки резерв тоже держится (М2 волны 2): быстрая проверка урока в pending (резерв
пишется при запуске, metrics.worst_usd) и smoke-eval в creating — PENDING_RESERVE после
создания строки (дольше — сбой до отправки, такую быструю проверку уборщик ставит failed).
Остаток проверяется и резерв пишется под FOR UPDATE строки app_settings (lock_budget, та
же блокировка, что у резерва анализа и пакета разборов): две проверки не займут один
остаток.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.batches import reserved_usd
from app.db.models import AgentRun, AppSettings, EvalRun, User
from app.services.admin_users import CHECK_RUN_KINDS, find_user_by_email, month_start
from app.services.app_settings import SETTINGS_ROW_ID
from app.services.sessions import utcnow

ZERO = Decimal(0)
# Статусы пакета smoke-eval (eval_runs.metrics.status): отправлен и еще не забран;
# потерян (у Anthropic его нет); закрыт владельцем без результатов
SUBMITTED = "submitted"
LOST = "lost"
ABANDONED = "abandoned"
CREATING = "creating"
# Результаты пакета хранятся 29 дней после создания
RESULTS_DAYS = 29
# Резерв проверки до отправки пакета (pending быстрой проверки, creating smoke-eval)
PENDING_RESERVE = timedelta(hours=1)


async def lock_budget(db: AsyncSession) -> None:
    """FOR UPDATE строки app_settings до commit вызывающего: проверка остатка и запись
    резерва бюджета (проверок или общего) идут по одной."""
    await db.execute(
        select(AppSettings.id).where(AppSettings.id == SETTINGS_ROW_ID).with_for_update()
    )


async def pick_admin(db: AsyncSession, email: str | None) -> User | None:
    """Администратор для вызовов: по email или первый действующий. Не администратор,
    заблокирован или не найден — None."""
    if email:
        user = await find_user_by_email(db, email)
        if user is None or user.role != "admin" or user.status != "active":
            return None
        return user
    found: User | None = await db.scalar(
        select(User).where(User.role == "admin", User.status == "active").order_by(User.id).limit(1)
    )
    return found


@dataclass(frozen=True)
class EvalBudget:
    """Бюджет проверок на месяц: всего, потрачено, в резерве за незабранными пакетами."""

    budget_usd: Decimal
    spent_usd: Decimal
    reserved_usd: Decimal

    @property
    def left_usd(self) -> Decimal:
        return max(ZERO, self.budget_usd - self.spent_usd - self.reserved_usd)


async def eval_budget(
    db: AsyncSession, now: datetime | None = None, *, exclude_run_id: int | None = None
) -> EvalBudget:
    """Бюджет проверок месяца. exclude_run_id — без резерва до отправки этого прогона (его
    пакет сейчас уходит, худший случай считается заново)."""
    moment = now or utcnow()
    budget = await db.scalar(
        select(AppSettings.eval_budget_usd).where(AppSettings.id == SETTINGS_ROW_ID)
    )
    spent = await db.scalar(
        select(func.sum(AgentRun.cost_usd)).where(
            AgentRun.kind.in_(CHECK_RUN_KINDS), AgentRun.created_at >= month_start(moment)
        )
    )
    month = month_start(moment)
    # Пакет месяца отправки в резерве всегда, прошлого месяца — пока его можно забрать
    collectable_since = min(month, moment - timedelta(days=RESULTS_DAYS))
    reserved = ZERO
    rows = await db.execute(
        select(EvalRun.id, EvalRun.created_at, EvalRun.status, EvalRun.metrics).where(
            EvalRun.batch_job_id.is_(None),
            EvalRun.metrics["status"].astext.in_((SUBMITTED, LOST, ABANDONED, CREATING))
            | (EvalRun.status == "pending"),
        )
    )
    for run_id, created_at, status, metrics in rows:
        if run_id == exclude_run_id:
            continue
        state = metrics.get("status")
        if status == "pending" or state == CREATING:
            # До отправки: резерв проверки, пока строка свежая
            if created_at < moment - PENDING_RESERVE:
                continue
        else:
            sent = _submitted_at(metrics, created_at)
            since = collectable_since if state == SUBMITTED else month
            if sent < since:
                continue
        try:
            reserved += Decimal(str(metrics.get("worst_usd") or 0))
        except ArithmeticError:
            continue
    reserved += await reserved_usd(db, CHECK_RUN_KINDS, moment)
    return EvalBudget(
        budget_usd=Decimal(budget or 0), spent_usd=Decimal(spent or 0), reserved_usd=reserved
    )


def _submitted_at(metrics: dict[str, object], created_at: datetime) -> datetime:
    """Когда пакет отправлен (metrics.submitted_at), без этой метки — создание строки."""
    raw = metrics.get("submitted_at")
    if isinstance(raw, str):
        try:
            return datetime.fromisoformat(raw)
        except ValueError:
            pass
    return created_at
