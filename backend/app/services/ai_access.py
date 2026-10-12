"""Доступ к Claude: можно ли запустить анализ, резерв бюджета, проверка перед каждым
вызовом и предупреждения о расходе (Р7, Р9, Р12, Р13).

Источник правды о деньгах — agent_runs.cost_usd в базе. Расход месяца считается по UTC
(как в кабинете администратора), «анализов в день» — по календарному дню в поясе
участника: анализы на ключе администратора по analyses.started_at. started_at ставится
при первом запуске, а после запусков на своем ключе — при первом перезапуске на ключе
администратора; повторный запуск на нем started_at не меняет и второй раз не считается.
Проверки (eval и теневые прогоны shadow) идут из своего бюджета
(app_settings.eval_budget_usd) и в расход месяца не входят.

Резерв: при запуске анализа в analyses.budget_reserved_usd пишется расход анализа плюс
оценка запуска. Пока анализ в работе (ANALYSIS_ACTIVE_STATUSES), неизрасходованная часть
резерва (резерв минус analyses.cost_usd) считается занятой: параллельные анализы не
превышают лимит. Резерв берется под FOR UPDATE (users → app_settings → ai_limits →
analyses — один порядок во всех функциях), commit — за вызывающим вместе со сменой
статуса анализа.

Порядок причин отказа — как в макете (mockup/js/data.js, access): свой ключ — нет ключа,
дороже своего потолка; ключ администратора — пауза, анализы на сегодня, дороже потолка
анализа, лимит месяца, общий бюджет; затем нет ключа администратора и нет цены модели.
У администратора на ключе администратора нет личных лимитов (как в макете), но потолок
анализа (per_analysis_hard_usd) действует.

Лимит месяца и общий бюджет до запуска проверяются той же мерой, что перед вызовом
(check_before_call): свободным должен быть не только расход по оценке, но и худший случай
одного вызова оценки матча (весь max_tokens Opus, около $0,36). Иначе анализ запускался
по оценке ($0,12) и останавливался на первом же вызове Opus, а перезапуск упирался в то же.
"""

import calendar
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_UP, Decimal
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import ColumnElement, and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import AgentConfig, default_per_analysis, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.runs import worst_case_usd
from app.core.errors import AppError
from app.db.models import (
    ANALYSIS_ACTIVE_STATUSES,
    DEFAULT_TZ,
    AgentRun,
    AiLimit,
    Analysis,
    AppSettings,
    ModelPrice,
    Notification,
    User,
    UserSecret,
)
from app.services.admin_users import CHECK_RUN_KINDS, month_start
from app.services.app_settings import SETTINGS_ROW_ID
from app.services.claude_key import SECRET_KIND
from app.services.notifications import notify
from app.services.sessions import utcnow

ACCESS_REASONS = (
    "ai.no_own_key",
    "ai.own_cap",
    "ai.paused",
    "ai.daily_limit",
    "ai.analysis_cap",
    "ai.monthly_limit",
    "ai.budget_exhausted",
    "ai.no_admin_key",
    "ai.no_price",
)
# Статус ответа API при отказе в запуске: запрос верный, но состояние лимитов не дает
ACCESS_STATUS = 409
CENT = Decimal("0.01")
ESTIMATE_STEP = Decimal("0.0001")
ZERO = Decimal(0)
# Куда ведут уведомления о расходе: участнику — «Личный кабинет → Ключ Claude» (лимит и
# расход), администратору — «Администрирование → Ключ и бюджет»: к лимитам участников или
# к общему бюджету. Экраны «ИИ и расходы» и «Расход ИИ» — этап 4, пока там заглушки
MEMBER_LIMIT_LINK = "/profile/key"
ADMIN_LIMITS_LINK = "/admin/key#adm-limits"
ADMIN_BUDGET_LINK = "/admin/key"
# pg_advisory_xact_lock: предупреждения о расходе не дублируются параллельными анализами
AI_ALERTS_LOCK = 0x61695F616C657274  # "ai_alert"


def usd_text(value: Decimal) -> str:
    """Сумма в долларах для текста уведомления или ошибки: 8,40."""
    return f"{value.quantize(CENT):.2f}".replace(".", ",")


@dataclass(frozen=True)
class Limits:
    """Лимиты участника на ключе администратора (строка ai_limits или значения по
    умолчанию из app_settings, если строки нет)."""

    monthly_usd: Decimal
    daily_analyses: int
    per_analysis_usd: Decimal
    paused: bool
    own_per_analysis_usd: Decimal
    return_requested_at: datetime | None


@dataclass(frozen=True)
class Access:
    """Состояние доступа участника к Claude и причина отказа (None — можно).

    mode — режим участника (shared, own), key_source — чей ключ платит (admin, own).
    spent_month_usd — расход за месяц (UTC) на ключе этого режима, reserved_usd —
    занятый резерв активных анализов участника на ключе администратора.
    monthly_limit_usd, daily_limit — пусто, если личных лимитов нет (свой ключ,
    администратор). budget_* — общий бюджет ключа администратора (пусто на своем ключе).
    """

    mode: str
    key_source: str
    has_key: bool
    key_last4: str | None
    monthly_limit_usd: Decimal | None
    spent_month_usd: Decimal
    reserved_usd: Decimal
    daily_limit: int | None
    analyses_today: int
    cap_usd: Decimal
    soft_cap_usd: Decimal
    paused: bool
    budget_usd: Decimal | None
    budget_spent_usd: Decimal | None
    budget_reserved_usd: Decimal | None
    estimate_usd: Decimal | None
    return_requested_at: datetime | None
    reason: str | None
    reason_params: dict[str, Any]

    @property
    def allowed(self) -> bool:
        return self.reason is None

    @property
    def left_month_usd(self) -> Decimal | None:
        if self.monthly_limit_usd is None:
            return None
        return max(ZERO, self.monthly_limit_usd - self.spent_month_usd - self.reserved_usd)

    @property
    def budget_left_usd(self) -> Decimal | None:
        if self.budget_usd is None or self.budget_spent_usd is None:
            return None
        reserved = self.budget_reserved_usd or ZERO
        return max(ZERO, self.budget_usd - self.budget_spent_usd - reserved)


@dataclass(frozen=True)
class Reservation:
    """Итог резерва при запуске анализа."""

    key_source: str
    reserved_usd: Decimal
    cap_usd: Decimal
    estimate_usd: Decimal
    started_at: datetime
    access: Access


@dataclass(frozen=True)
class BudgetOverview:
    """Общий бюджет ключа администратора на месяц (UTC). forecast_usd — прогноз на конец
    месяца по темпу (как в макете: участник на 100% лимита и на паузе дальше не тратит).
    members_limits_usd — сумма месячных лимитов активных участников на ключе
    администратора. eval_* — отдельный бюджет проверок."""

    month_start: datetime
    days_in_month: int
    days_left: int
    budget_usd: Decimal
    spent_usd: Decimal
    reserved_usd: Decimal
    left_usd: Decimal
    forecast_usd: Decimal
    members_limits_usd: Decimal
    alert_pct: int
    eval_budget_usd: Decimal
    eval_spent_usd: Decimal


# --- чтение ---


def _day_start(now: datetime, tz_name: str) -> datetime:
    """Начало календарного дня в поясе участника (для «анализов в день»)."""
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo(DEFAULT_TZ)
    local = now.astimezone(tz)
    return local.replace(hour=0, minute=0, second=0, microsecond=0)


def _month_runs(now: datetime) -> ColumnElement[bool]:
    """Вызовы на ключе администратора за месяц, без проверок (eval, shadow)."""
    return and_(
        AgentRun.key_source == "admin",
        AgentRun.created_at >= month_start(now),
        AgentRun.kind.not_in(CHECK_RUN_KINDS),
    )


def _outstanding() -> ColumnElement[Decimal]:
    """Неизрасходованная часть резерва анализа."""
    return func.greatest(Analysis.budget_reserved_usd - Analysis.cost_usd, 0)


async def _sum(db: AsyncSession, stmt: Any) -> Decimal:
    value = await db.scalar(stmt)
    return Decimal(value or 0)


async def member_spent(
    db: AsyncSession, user_id: int, now: datetime, *, key_source: str = "admin"
) -> Decimal:
    """Расход участника за месяц на ключе key_source (без проверок)."""
    stmt = select(func.sum(AgentRun.cost_usd)).where(
        AgentRun.user_id == user_id,
        AgentRun.key_source == key_source,
        AgentRun.created_at >= month_start(now),
        AgentRun.kind.not_in(CHECK_RUN_KINDS),
    )
    return await _sum(db, stmt)


async def _budget_spent(db: AsyncSession, now: datetime) -> Decimal:
    return await _sum(db, select(func.sum(AgentRun.cost_usd)).where(_month_runs(now)))


async def _reserved(
    db: AsyncSession, *, user_id: int | None, exclude_analysis_id: int | None
) -> Decimal:
    """Занятый резерв активных анализов на ключе администратора (одного участника или
    всех), кроме exclude_analysis_id."""
    stmt = select(func.sum(_outstanding())).where(
        Analysis.key_source == "admin", Analysis.status.in_(ANALYSIS_ACTIVE_STATUSES)
    )
    if user_id is not None:
        stmt = stmt.where(Analysis.user_id == user_id)
    if exclude_analysis_id is not None:
        stmt = stmt.where(Analysis.id != exclude_analysis_id)
    return await _sum(db, stmt)


async def _analyses_today(db: AsyncSession, user: User, now: datetime) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(Analysis)
        .where(
            Analysis.user_id == user.id,
            Analysis.key_source == "admin",
            Analysis.started_at >= _day_start(now, user.tz),
        )
    )
    return int(count or 0)


def limits_of(row: AiLimit | None, settings: AppSettings) -> Limits:
    """Лимиты участника: строка ai_limits, а если ее нет — значения по умолчанию."""
    if row is None:
        cap = default_per_analysis(settings)
        return Limits(
            monthly_usd=settings.default_member_limit_usd,
            daily_analyses=settings.default_daily_analyses,
            per_analysis_usd=cap,
            paused=False,
            own_per_analysis_usd=cap,
            return_requested_at=None,
        )
    return Limits(
        monthly_usd=row.monthly_usd,
        daily_analyses=row.daily_analyses,
        per_analysis_usd=row.per_analysis_usd,
        paused=row.paused,
        own_per_analysis_usd=row.own_per_analysis_usd,
        return_requested_at=row.return_requested_at,
    )


async def missing_prices(
    db: AsyncSession, config: AgentConfig, now: datetime | None = None
) -> list[str]:
    """Модели из настроек агента, для которых нет действующей цены."""
    models = config.models()
    priced = set(
        await db.scalars(
            select(ModelPrice.model)
            .where(ModelPrice.model.in_(models), ModelPrice.valid_from <= (now or utcnow()))
            .distinct()
        )
    )
    return [model for model in models if model not in priced]


async def call_need_usd(db: AsyncSession, config: AgentConfig, now: datetime) -> Decimal:
    """Сколько должно быть свободно, чтобы check_before_call пропустил вызов оценки матча:
    худший случай самого дорогого вызова анализа (вход по оценке estimate_analysis_input_tokens,
    выход — весь analysis_max_tokens). Нет цены модели — 0: тогда отказ ai.no_price."""
    price = await db.scalar(
        select(ModelPrice)
        .where(ModelPrice.model == config.analysis_model, ModelPrice.valid_from <= now)
        .order_by(ModelPrice.valid_from.desc())
        .limit(1)
    )
    if price is None:
        return ZERO
    return worst_case_usd(
        price,
        input_tokens=config.estimate_analysis_input_tokens,
        max_tokens=config.analysis_max_tokens,
    )


async def _settings(db: AsyncSession, *, lock: bool) -> AppSettings:
    stmt = select(AppSettings).where(AppSettings.id == SETTINGS_ROW_ID)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = await db.scalar(stmt)
    if row is None:
        raise AppError(500, "admin.settings_missing")
    return row


async def _limit_row(db: AsyncSession, user_id: int, *, lock: bool) -> AiLimit | None:
    stmt = select(AiLimit).where(AiLimit.user_id == user_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row: AiLimit | None = await db.scalar(stmt)
    return row


async def _evaluate(
    db: AsyncSession,
    user: User,
    *,
    settings: AppSettings,
    limit_row: AiLimit | None,
    estimate_usd: Decimal | None,
    now: datetime,
    check_daily: bool = True,
    exclude_analysis_id: int | None = None,
    analysis_spent_usd: Decimal = ZERO,
) -> Access:
    """analysis_spent_usd — уже потраченное анализом при повторном запуске: потолок анализа
    сравнивается с ним плюс оценкой (как в check_before_call), лимиты месяца — с оценкой
    (потраченное уже в расходе месяца). Для лимита месяца и общего бюджета нужна еще и
    свобода на худший случай одного вызова оценки матча (call_need_usd), если вызовы
    Claude впереди: оценка больше нуля или не задана (можно ли сейчас запустить анализ).
    Оценка 0 — все оценки матчей уже есть (перезапуск после них): вызовов не будет."""
    config = await load_agent_config(db)
    limits = limits_of(limit_row, settings)
    cost = estimate_usd if estimate_usd is not None else ZERO
    total = analysis_spent_usd + cost
    calls_ahead = estimate_usd is None or estimate_usd > 0
    need = max(cost, await call_need_usd(db, config, now)) if calls_ahead else cost
    reason: str | None = None
    params: dict[str, Any] = {}

    def refuse(code: str, **values: Any) -> None:
        nonlocal reason, params
        if reason is None:
            reason, params = code, values

    if user.ai_mode == "own":
        secret = await db.scalar(
            select(UserSecret).where(UserSecret.user_id == user.id, UserSecret.kind == SECRET_KIND)
        )
        has_key = secret is not None and secret.verified_at is not None
        cap = limits.own_per_analysis_usd
        if not has_key:
            refuse("ai.no_own_key")
        if total > cap:
            refuse("ai.own_cap", cap=usd_text(cap), estimate=usd_text(total))
        access_fields: dict[str, Any] = {
            "mode": "own",
            "key_source": "own",
            "has_key": has_key,
            "key_last4": secret.last4 if secret is not None else None,
            "monthly_limit_usd": None,
            "spent_month_usd": await member_spent(db, user.id, now, key_source="own"),
            "reserved_usd": ZERO,
            "daily_limit": None,
            "analyses_today": 0,
            "cap_usd": cap,
            "paused": False,
            "budget_usd": None,
            "budget_spent_usd": None,
            "budget_reserved_usd": None,
        }
    else:
        member = user.role != "admin"
        spent = await member_spent(db, user.id, now)
        reserved = await _reserved(db, user_id=user.id, exclude_analysis_id=exclude_analysis_id)
        today = await _analyses_today(db, user, now)
        cap = limits.per_analysis_usd if member else settings.per_analysis_hard_usd
        if member:
            if limits.paused:
                refuse("ai.paused")
            if check_daily and today >= limits.daily_analyses:
                refuse("ai.daily_limit", daily=limits.daily_analyses)
        if total > cap:
            refuse("ai.analysis_cap", cap=usd_text(cap), estimate=usd_text(total))
        if member:
            left = limits.monthly_usd - spent - reserved
            if left <= 0 or need > left:
                refuse("ai.monthly_limit", limit=usd_text(limits.monthly_usd))
        budget_spent = await _budget_spent(db, now)
        budget_reserved = await _reserved(db, user_id=None, exclude_analysis_id=exclude_analysis_id)
        budget_left = settings.monthly_budget_usd - budget_spent - budget_reserved
        if budget_left <= 0 or need > budget_left:
            refuse("ai.budget_exhausted")
        has_key = settings.anthropic_key_enc is not None
        if not has_key:
            refuse("ai.no_admin_key")
        access_fields = {
            "mode": "shared",
            "key_source": "admin",
            "has_key": has_key,
            "key_last4": settings.key_last4,
            "monthly_limit_usd": limits.monthly_usd if member else None,
            "spent_month_usd": spent,
            "reserved_usd": reserved,
            "daily_limit": limits.daily_analyses if member else None,
            "analyses_today": today,
            "cap_usd": cap,
            "paused": limits.paused if member else False,
            "budget_usd": settings.monthly_budget_usd,
            "budget_spent_usd": budget_spent,
            "budget_reserved_usd": budget_reserved,
        }
    missing = await missing_prices(db, config, now)
    if missing:
        refuse("ai.no_price", model=missing[0])
    return Access(
        **access_fields,
        soft_cap_usd=settings.per_analysis_soft_usd,
        estimate_usd=estimate_usd,
        return_requested_at=limits.return_requested_at,
        reason=reason,
        reason_params=params,
    )


async def access_for(db: AsyncSession, user: User, *, estimate_usd: Decimal | None) -> Access:
    """Состояние доступа участника и причина отказа. estimate_usd — оценка анализа;
    None — без оценки (экран «ИИ и расходы»): проверки «дороже потолка» не срабатывают."""
    now = utcnow()
    settings = await _settings(db, lock=False)
    limit_row = await _limit_row(db, user.id, lock=False)
    return await _evaluate(
        db, user, settings=settings, limit_row=limit_row, estimate_usd=estimate_usd, now=now
    )


def estimate_cost(config: AgentConfig, prices: dict[str, ModelPrice], *, matches: int) -> Decimal:
    """Оценка анализа до запуска (для резерва): на каждый матч — новости (если включены)
    и один вызов анализа по estimate_* из настроек, вход — по цене записи кэша.
    prices — цены моделей по имени (price_for)."""
    analysis = prices[config.analysis_model]
    per_input = max(analysis.input, analysis.cache_write_5m)
    total = (
        config.estimate_analysis_input_tokens * per_input
        + config.estimate_analysis_output_tokens * analysis.output
    ) / Decimal(1_000_000)
    if config.news_enabled:
        news = prices[config.news_model]
        news_input = max(news.input, news.cache_write_5m)
        total += (
            config.estimate_news_input_tokens * news_input
            + config.estimate_news_output_tokens * news.output
        ) / Decimal(1_000_000) + config.estimate_news_searches * news.search_price
    return (total * matches).quantize(ESTIMATE_STEP, rounding=ROUND_UP)


# --- резерв ---


async def reserve_for_run(
    db: AsyncSession, user: User, analysis: Analysis, *, estimate_usd: Decimal
) -> Reservation:
    """Резерв бюджета при запуске (и повторном запуске) анализа. Под FOR UPDATE заново
    считает доступ с оценкой estimate_usd; отказ — AppError(409, код причины).
    Пишет в анализ key_source (режим участника сейчас), estimate_usd, резерв (уже
    потраченное анализом плюс оценка, с округлением вверх до цента), потолок анализа и
    started_at. Потолок проверяется с уже потраченным: перезапуск, которому не хватит
    потолка, получает отказ сразу, а не на первом вызове. «Анализы за день» проверяются
    и started_at ставится, пока анализ не запускался на ключе администратора: повторный
    запуск на нем второй раз не считается, а первый перезапуск после своего ключа
    считается запуском этого дня. Делает flush; commit — за вызывающим, вместе со сменой
    статуса анализа (до commit блокировки держатся)."""
    now = utcnow()
    locked_user = await db.scalar(
        select(User)
        .where(User.id == user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if locked_user is None:
        raise AppError(404, "common.not_found")
    settings = await _settings(db, lock=locked_user.ai_mode != "own")
    limit_row = await _limit_row(db, locked_user.id, lock=True)
    row = await db.scalar(
        select(Analysis)
        .where(Analysis.id == analysis.id, Analysis.user_id == locked_user.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise AppError(404, "common.not_found")
    estimate = estimate_usd.quantize(ESTIMATE_STEP, rounding=ROUND_UP)
    # Анализ уже в «анализах за день»: запускался на ключе администратора
    counted = row.started_at is not None and row.key_source == "admin"
    access = await _evaluate(
        db,
        locked_user,
        settings=settings,
        limit_row=limit_row,
        estimate_usd=estimate,
        now=now,
        check_daily=not counted,
        exclude_analysis_id=row.id,
        analysis_spent_usd=row.cost_usd,
    )
    if access.reason is not None:
        raise AppError(ACCESS_STATUS, access.reason, **access.reason_params)
    reserved = (row.cost_usd + estimate).quantize(CENT, rounding=ROUND_UP)
    if row.started_at is None or (access.key_source == "admin" and not counted):
        row.started_at = now
    row.key_source = access.key_source
    row.estimate_usd = estimate
    row.budget_reserved_usd = reserved
    row.cost_cap_usd = access.cap_usd
    await db.flush()
    return Reservation(
        key_source=access.key_source,
        reserved_usd=reserved,
        cap_usd=access.cap_usd,
        estimate_usd=estimate,
        started_at=row.started_at,
        access=access,
    )


async def release_reservation(db: AsyncSession, analysis: Analysis) -> None:
    """Снимает резерв (анализ закончился: done, failed, cancelled). flush; commit — за
    вызывающим. Анализ не в работе резерв и так не занимает: это для отчетов."""
    analysis.budget_reserved_usd = ZERO
    await db.flush()


async def check_before_call(db: AsyncSession, analysis: Analysis, worst_case_usd: Decimal) -> None:
    """Перед каждым вызовом Claude в анализе: расход анализа плюс худший случай вызова
    (runs.worst_case_usd) не больше потолка анализа; на ключе администратора — еще пауза,
    лимит месяца участника и общий бюджет с учетом резервов других анализов. Нельзя —
    ClaudeStepError с кодом причины: анализ останавливается до вызова."""
    now = utcnow()
    spent = await _sum(
        db, select(func.sum(AgentRun.cost_usd)).where(AgentRun.analysis_id == analysis.id)
    )
    settings = await _settings(db, lock=False)
    cap = analysis.cost_cap_usd
    if cap is None:
        cap = settings.per_analysis_hard_usd
    if spent + worst_case_usd > cap:
        raise ClaudeStepError("ai.analysis_cap", cap=usd_text(cap))
    if analysis.key_source != "admin":
        return
    user = await db.get(User, analysis.user_id)
    if user is not None and user.role != "admin":
        limits = limits_of(await _limit_row(db, user.id, lock=False), settings)
        if limits.paused:
            raise ClaudeStepError("ai.paused")
        member = await member_spent(db, user.id, now)
        others = await _reserved(db, user_id=user.id, exclude_analysis_id=analysis.id)
        if member + others + worst_case_usd > limits.monthly_usd:
            raise ClaudeStepError("ai.monthly_limit", limit=usd_text(limits.monthly_usd))
    total = await _budget_spent(db, now)
    others_all = await _reserved(db, user_id=None, exclude_analysis_id=analysis.id)
    if total + others_all + worst_case_usd > settings.monthly_budget_usd:
        raise ClaudeStepError("ai.budget_exhausted")


# --- предупреждения о расходе ---


async def _active_admins(db: AsyncSession) -> list[User]:
    return list(
        await db.scalars(
            select(User).where(User.role == "admin", User.status == "active").order_by(User.id)
        )
    )


async def _already_sent(
    db: AsyncSession, recipient: int, kinds: tuple[str, ...], subject: str, since: datetime
) -> bool:
    found = await db.scalar(
        select(Notification.id)
        .where(
            Notification.user_id == recipient,
            Notification.kind.in_(kinds),
            Notification.created_at >= since,
            Notification.params["subject"].astext == subject,
        )
        .limit(1)
    )
    return found is not None


def _threshold(spent: Decimal, total: Decimal, pct: int) -> str | None:
    """Пройденный порог: 100 — израсходовано все, alert — budget_alert_pct процентов."""
    if total <= 0:
        return None
    if spent >= total:
        return "100"
    if spent * 100 >= total * pct:
        return "80"
    return None


async def _send_once(
    db: AsyncSession,
    *,
    recipients: list[int],
    level: str,
    family: str,
    subject: str,
    since: datetime,
    params: dict[str, Any],
    admin_ids: set[int],
) -> list[Notification]:
    """Уведомление порога level (80 или 100) каждому получателю, если в этом месяце он
    его (или более высокий порог) еще не получал по этому subject."""
    kind = f"{family}_{level}"
    # Порог 100 уже был — 80 не нужен
    seen = (kind, f"{family}_100") if level == "80" else (kind,)
    created: list[Notification] = []
    for recipient in recipients:
        if await _already_sent(db, recipient, seen, subject, since):
            continue
        to_admin = recipient in admin_ids
        variant = "admin" if family == "limit" and to_admin else None
        if not to_admin:
            link = MEMBER_LIMIT_LINK
        else:
            link = ADMIN_LIMITS_LINK if family == "limit" else ADMIN_BUDGET_LINK
        if kind == "limit_80":
            note = await notify(
                db, user_id=recipient, kind="limit_80", variant=variant, link=link, **params
            )
        elif kind == "limit_100":
            note = await notify(
                db, user_id=recipient, kind="limit_100", variant=variant, link=link, **params
            )
        elif kind == "budget_80":
            note = await notify(db, user_id=recipient, kind="budget_80", link=link, **params)
        else:
            note = await notify(db, user_id=recipient, kind="budget_100", link=link, **params)
        created.append(note)
    return created


async def after_run_notifications(db: AsyncSession, user_id: int | None) -> list[Notification]:
    """После вызова Claude на ключе администратора: предупреждения о расходе.
    limit_80 и limit_100 — участнику и администраторам (порог — budget_alert_pct и 100%
    личного лимита), budget_80 и budget_100 — администраторам (общий бюджет). Каждый
    порог — не чаще раза в месяц на получателя. flush; commit — за вызывающим."""
    now = utcnow()
    since = month_start(now)
    await db.execute(select(func.pg_advisory_xact_lock(AI_ALERTS_LOCK)))
    settings = await _settings(db, lock=False)
    admins = await _active_admins(db)
    admin_ids = {admin.id for admin in admins}
    created: list[Notification] = []
    user = await db.get(User, user_id) if user_id is not None else None
    if (
        user is not None
        and user.role != "admin"
        and user.ai_mode == "shared"
        and user.status == "active"
    ):
        limits = limits_of(await _limit_row(db, user.id, lock=False), settings)
        spent = await member_spent(db, user.id, now)
        level = _threshold(spent, limits.monthly_usd, settings.budget_alert_pct)
        if level is not None:
            created += await _send_once(
                db,
                recipients=[user.id, *sorted(admin_ids)],
                level=level,
                family="limit",
                subject=str(user.id),
                since=since,
                params={
                    "subject": user.id,
                    "name": user.display_name or user.email,
                    "pct": settings.budget_alert_pct,
                    "spent": usd_text(spent),
                    "limit": usd_text(limits.monthly_usd),
                },
                admin_ids=admin_ids,
            )
    spent_all = await _budget_spent(db, now)
    level = _threshold(spent_all, settings.monthly_budget_usd, settings.budget_alert_pct)
    if level is not None:
        created += await _send_once(
            db,
            recipients=sorted(admin_ids),
            level=level,
            family="budget",
            subject="budget",
            since=since,
            params={
                "subject": "budget",
                "pct": settings.budget_alert_pct,
                "spent": usd_text(spent_all),
                "budget": usd_text(settings.monthly_budget_usd),
            },
            admin_ids=admin_ids,
        )
    return created


# --- общий бюджет ---


def _pace(value: Decimal, day: int, days: int) -> Decimal:
    return value / day * days


async def budget_overview(db: AsyncSession, now: datetime) -> BudgetOverview:
    """Общий бюджет ключа администратора на месяц: потрачено, резервы, прогноз, сумма
    личных лимитов, бюджет проверок."""
    start = month_start(now)
    days = calendar.monthrange(start.year, start.month)[1]
    day = now.astimezone(start.tzinfo).day
    settings = await _settings(db, lock=False)
    rows = await db.execute(
        select(AgentRun.user_id, func.sum(AgentRun.cost_usd))
        .where(_month_runs(now))
        .group_by(AgentRun.user_id)
    )
    by_user: dict[int | None, Decimal] = {uid: Decimal(total or 0) for uid, total in rows.all()}
    known_ids = [uid for uid in by_user if uid is not None]
    users = {user.id: user for user in await db.scalars(select(User).where(User.id.in_(known_ids)))}
    members = list(
        await db.scalars(
            select(User).where(
                User.role == "member", User.status == "active", User.ai_mode == "shared"
            )
        )
    )
    limit_rows = {
        row.user_id: row
        for row in await db.scalars(
            select(AiLimit).where(AiLimit.user_id.in_([m.id for m in members]))
        )
    }
    forecast = ZERO
    for uid, spent in by_user.items():
        user = users.get(uid) if uid is not None else None
        if user is None:
            # Общие фоновые вызовы без участника растут по темпу
            forecast += _pace(spent, day, days)
            continue
        if user.ai_mode != "shared" or user.status != "active":
            forecast += spent
        elif user.role == "admin":
            forecast += _pace(spent, day, days)
        else:
            limits = limits_of(limit_rows.get(user.id), settings)
            forecast += spent if limits.paused else min(limits.monthly_usd, _pace(spent, day, days))
    spent_all = sum(by_user.values(), ZERO)
    members_limits = sum(
        (limits_of(limit_rows.get(m.id), settings).monthly_usd for m in members), ZERO
    )
    eval_spent = await _sum(
        db,
        select(func.sum(AgentRun.cost_usd)).where(
            AgentRun.kind.in_(CHECK_RUN_KINDS), AgentRun.created_at >= start
        ),
    )
    return BudgetOverview(
        month_start=start,
        days_in_month=days,
        days_left=days - day,
        budget_usd=settings.monthly_budget_usd,
        spent_usd=spent_all,
        reserved_usd=await _reserved(db, user_id=None, exclude_analysis_id=None),
        left_usd=max(ZERO, settings.monthly_budget_usd - spent_all),
        forecast_usd=forecast.quantize(CENT, rounding=ROUND_UP),
        members_limits_usd=members_limits,
        alert_pct=settings.budget_alert_pct,
        eval_budget_usd=settings.eval_budget_usd,
        eval_spent_usd=eval_spent,
    )
