"""Ключи Claude, лимиты и бюджет на экранах: «Личный кабинет → Ключ Claude» участника и
«Администрирование → Ключ и бюджет» (Р7, Р9, Р12, Р13).

Здесь — сводки для экранов и действия маршрутов поверх app/services/ai_access.py
(расчет доступа и бюджета) и app/services/ai_keys.py (свой ключ, режимы, лимиты):
расход месяца и запреты считаются там же, где их проверяет запуск анализа, поэтому
экран и запуск не расходятся.

Администратор всегда работает на ключе администратора: свой ключ, свой потолок и личный
лимит ему не нужны (маршруты отвечают ai.admin_key_only, ai.admin_no_limit). Ключ
администратора меняется только с текущим кодом 2FA (PLAN.md, раздел 7) и только
проверенным: сначала код 2FA (принятый код фиксируется сразу), затем проверка ключа по
сети без открытой транзакции, затем сохранение и журнал key_change. С угнанного сеанса без
телефона администратора чужие ключи не проверить; неверный ключ тратит код.

Границы лимитов — как в формах макета (app/schemas/ai.py); здесь — то, что зависит от
других полей и от расхода: потолок анализа не выше месячного лимита, бюджет не меньше
потраченного за месяц. Лимиты по умолчанию меняют только то, что получат новые участники:
жесткий и мягкий потолки анализа программы они не трогают.
"""

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import anthropic
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import default_per_analysis, load_agent_config
from app.core.errors import AppError
from app.core.ratelimit import RateRule, hit_ip_limit
from app.core.redis import redis_key
from app.db.models import DEFAULT_TZ, AgentRun, AiLimit, Analysis, AppSettings, User, UserSecret
from app.schemas.admin import LimitOut
from app.schemas.ai import (
    AdminBudgetOut,
    AdminKeyOut,
    AdminLimitsOut,
    AiBudgetOut,
    KeyCheckResult,
    KeyModelOut,
    LimitDefaultsOut,
    LimitIn,
    LimitPatchIn,
    MemberLimitOut,
    OwnKeyInfoOut,
    OwnKeyOut,
)
from app.services import ai_keys
from app.services.admin_confirm import TotpConfirm, check_totp
from app.services.admin_key import save_admin_key
from app.services.admin_users import CHECK_RUN_KINDS, month_start, month_usage
from app.services.ai_access import CENT, Limits, access_for, budget_overview, limits_of, usd_text
from app.services.app_settings import SETTINGS_ROW_ID
from app.services.audit import write_audit
from app.services.claude_key import SECRET_KIND, KeyCheck, check_anthropic_key, looks_like_key
from app.services.sessions import utcnow

AVG_STEP = Decimal("0.0001")
# Проверок своего ключа (сохранение и «Проверить») в час на участника и на IP
KEY_CHECKS = 10
KEY_CHECK_WINDOW_SECONDS = 3600
KEY_CHECK_IP_RULE = RateRule("ai_key_check", KEY_CHECKS, KEY_CHECK_WINDOW_SECONDS)
# Самый восточный пояс опережает UTC на 14 ч: анализы «сегодня» любого пояса — за 2 суток
_TODAY_WINDOW = timedelta(days=2)


# --- общее ---


async def _settings(db: AsyncSession) -> AppSettings:
    row = await db.scalar(
        select(AppSettings)
        .where(AppSettings.id == SETTINGS_ROW_ID)
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise AppError(500, "admin.settings_missing")
    return row


def _member_only(user: User) -> None:
    """Свой ключ и свой потолок — только у участника: администратор работает на ключе
    администратора и меняет его в своем кабинете."""
    if user.role == "admin":
        raise AppError(409, "ai.admin_key_only")


async def _limit_target(db: AsyncSession, user_id: int, *, admin_code: str) -> User:
    """Участник, чей лимит или режим меняет администратор. Удаленный — 404; администратор —
    409 admin_code: личного лимита у него нет, на ключ администратора он переходит сам."""
    user = await db.scalar(
        select(User).where(User.id == user_id).execution_options(populate_existing=True)
    )
    if user is None or user.status == "deleted":
        raise AppError(404, "common.not_found")
    if user.role == "admin":
        raise AppError(409, admin_code)
    return user


def _check_cap(monthly_usd: Decimal, per_analysis_usd: Decimal) -> None:
    """Потолок одного анализа не выше месячного лимита (как в форме макета)."""
    if per_analysis_usd > monthly_usd:
        raise AppError(
            400,
            "ai.cap_above_month",
            cap=usd_text(per_analysis_usd),
            limit=usd_text(monthly_usd),
        )


def _day_start(now: datetime, tz_name: str) -> datetime:
    """Начало календарного дня в поясе пользователя (счет «анализов сегодня»)."""
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo(DEFAULT_TZ)
    return now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)


def _raise_for_check(check: KeyCheck) -> None:
    """Ключ не прошел проверку — ошибка с кодом (текст ответа Anthropic не показываем)."""
    if check.result == "rejected":
        raise AppError(400, "ai.key_rejected", status=check.status_code)
    if check.result == "unavailable":
        raise AppError(503, "ai.key_unavailable")
    if check.result == "error":
        raise AppError(502, "ai.key_check_failed", status=check.status_code)
    if check.missing_models:
        raise AppError(400, "ai.key_models", models=", ".join(check.missing_models))


# --- участник: свой ключ, режим, потолок ---


def _check_result(status: ai_keys.OwnKeyStatus) -> KeyCheckResult:
    """Итог проверки сохраненного ключа по записи last_error (rejected:401, error:500,
    models:…); пусто — ключ рабочий."""
    error = status.last_error
    if error is None:
        return "ok"
    if error.startswith("rejected"):
        return "rejected"
    if error.startswith("models:"):
        return "models"
    return "error"


def own_key_out(status: ai_keys.OwnKeyStatus, check: KeyCheckResult | None = None) -> OwnKeyOut:
    return OwnKeyOut(
        mode=status.mode,  # type: ignore[arg-type]
        has_key=status.has_key,
        last4=status.last4,
        verified_at=status.verified_at,
        last_error=status.last_error,
        check=check,
        models=[KeyModelOut(model=name, available=ok) for name, ok in status.models],
    )


async def hit_key_check_limit(redis: Redis, user_id: int, ip: str) -> None:
    """Проверка ключа — 4 запроса к Anthropic с адреса сервера (список моделей и три
    модели): не больше KEY_CHECKS в час на участника и на IP. Иначе сервер становится
    проверяльщиком чужих ключей, а поток запросов идет с его адреса. Сверх — 429
    common.rate_limited с retry_after."""
    wait = await hit_ip_limit(redis, ip, KEY_CHECK_IP_RULE)
    key = redis_key("rl", "ai_key_check", user_id)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, KEY_CHECK_WINDOW_SECONDS, nx=True)
        count = int((await pipe.execute())[0])
    if count > KEY_CHECKS:
        wait = max(wait, int(await redis.ttl(key)), 1)
    if wait:
        raise AppError(429, "common.rate_limited", retry_after=wait)


async def save_own_key(
    db: AsyncSession,
    redis: Redis,
    user: User,
    key: str,
    *,
    ip: str,
    http_client: anthropic.DefaultAsyncHttpxClient | None = None,
) -> OwnKeyOut:
    """Свой ключ участника: сохраняется только проверенный, режим становится own (Р7).
    Не прошел проверку — AppError (ai.key_format, ai.key_rejected, ai.key_models,
    ai.key_check_failed, ai.key_unavailable), ничего не сохраняется. Проверок ключа — не
    больше KEY_CHECKS в час (429 common.rate_limited)."""
    _member_only(user)
    await hit_key_check_limit(redis, user.id, ip)
    status = await ai_keys.save_own_key(db, user, key, http_client=http_client)
    return own_key_out(status, "ok")


async def check_own_key(
    db: AsyncSession,
    redis: Redis,
    user: User,
    *,
    ip: str,
    http_client: anthropic.DefaultAsyncHttpxClient | None = None,
) -> OwnKeyOut:
    """Кнопка «Проверить»: итог пишется к ключу (verified_at или last_error). Проверок
    ключа — не больше KEY_CHECKS в час (429 common.rate_limited)."""
    await hit_key_check_limit(redis, user.id, ip)
    status = await ai_keys.check_own_key(db, user, http_client=http_client)
    return own_key_out(status, _check_result(status))


async def delete_own_key(db: AsyncSession, user: User, *, ip: str | None) -> OwnKeyOut:
    return own_key_out(await ai_keys.delete_own_key(db, user, ip=ip))


async def set_mode(db: AsyncSession, user: User, mode: str, *, ip: str | None) -> OwnKeyOut:
    """Участник переходит на свой ключ (нужен проверенный ключ). Обратно — только
    просьбой администратору (ai.return_needs_admin). Администратору на свой ключ нельзя;
    если он на нем оказался раньше, он может вернуться на ключ администратора сам."""
    if mode == "own":
        _member_only(user)
    return own_key_out(await ai_keys.set_ai_mode(db, user, mode, ip=ip))


async def set_own_cap(db: AsyncSession, user: User, cap_usd: Decimal) -> Decimal:
    _member_only(user)
    return await ai_keys.set_own_cap(db, user, cap_usd)


async def cancel_return_request(db: AsyncSession, user: User) -> None:
    """Отмена просьбы вернуть ключ администратора. У администратора просьбы не бывает:
    строку ai_limits ему не создаем."""
    if user.role == "admin":
        return
    await ai_keys.cancel_return_request(db, user)


# --- бюджет ---


async def admin_budget(db: AsyncSession, now: datetime | None = None) -> AdminBudgetOut:
    """Общий бюджет ключа администратора на месяц и бюджет проверочных прогонов."""
    now = now or utcnow()
    overview = await budget_overview(db, now)
    background = await db.scalar(
        select(func.sum(AgentRun.cost_usd)).where(
            AgentRun.key_source == "admin",
            AgentRun.user_id.is_(None),
            AgentRun.created_at >= month_start(now),
            AgentRun.kind.not_in(CHECK_RUN_KINDS),
        )
    )
    # Вызовы участников (не администраторов) на ключе администратора за месяц
    members = await db.scalar(
        select(func.sum(AgentRun.cost_usd))
        .join(User, User.id == AgentRun.user_id)
        .where(
            AgentRun.key_source == "admin",
            AgentRun.created_at >= month_start(now),
            AgentRun.kind.not_in(CHECK_RUN_KINDS),
            User.role != "admin",
        )
    )
    budget_share = (
        float(overview.spent_usd / overview.budget_usd) if overview.budget_usd > 0 else None
    )
    return AdminBudgetOut(
        month_start=overview.month_start,
        days_in_month=overview.days_in_month,
        days_left=overview.days_left,
        budget_usd=overview.budget_usd,
        spent_usd=overview.spent_usd,
        background_usd=Decimal(background or 0),
        reserved_usd=overview.reserved_usd,
        left_usd=overview.left_usd,
        forecast_usd=overview.forecast_usd,
        members_limits_usd=overview.members_limits_usd,
        members_usd=Decimal(members or 0),
        budget_share=budget_share,
        alert_pct=overview.alert_pct,
        eval_budget_usd=overview.eval_budget_usd,
        eval_spent_usd=overview.eval_spent_usd,
    )


async def member_budget(db: AsyncSession, user: User) -> AiBudgetOut:
    """Лимит и расход вошедшего пользователя на ИИ; администратору — и общий бюджет.
    Причина запрета — та же, что у запуска анализа без оценки цены."""
    now = utcnow()
    start = month_start(now)
    access = await access_for(db, user, estimate_usd=None)
    settings = await _settings(db)
    limit_row = await db.scalar(select(AiLimit).where(AiLimit.user_id == user.id))
    limits = limits_of(limit_row, settings)
    own = await ai_keys.own_key_status(db, user)
    count, avg = (
        await db.execute(
            select(
                func.count(),
                func.avg(Analysis.cost_usd).filter(Analysis.status == "done"),
            ).where(
                Analysis.user_id == user.id,
                Analysis.key_source == access.key_source,
                Analysis.started_at >= start,
            )
        )
    ).one()
    return AiBudgetOut(
        mode=access.mode,  # type: ignore[arg-type]
        key_source=access.key_source,  # type: ignore[arg-type]
        has_key=access.has_key,
        month_start=start,
        monthly_usd=access.monthly_limit_usd,
        spent_usd=access.spent_month_usd,
        limit_share=(
            float(access.spent_month_usd / access.monthly_limit_usd)
            if access.monthly_limit_usd
            else None
        ),
        reserved_usd=access.reserved_usd,
        left_usd=access.left_month_usd,
        daily_analyses=access.daily_limit,
        analyses_today=access.analyses_today,
        analyses_month=int(count or 0),
        per_analysis_usd=access.cap_usd,
        soft_cap_usd=access.soft_cap_usd,
        paused=access.paused,
        alert_pct=settings.budget_alert_pct,
        own_key=(
            OwnKeyInfoOut(last4=own.last4, verified_at=own.verified_at, last_error=own.last_error)
            if own.has_key
            else None
        ),
        own_cap_usd=limits.own_per_analysis_usd,
        avg_analysis_usd=Decimal(avg).quantize(AVG_STEP) if avg is not None else None,
        return_requested_at=access.return_requested_at,
        reason_code=access.reason,
        reason_params=access.reason_params,
        budget=await admin_budget(db, now) if user.role == "admin" else None,
    )


async def update_budget(
    db: AsyncSession,
    *,
    monthly_usd: Decimal,
    alert_pct: int,
    eval_budget_usd: Decimal | None,
    actor: User,
    ip: str | None,
) -> AdminBudgetOut:
    """Общий бюджет на месяц и порог предупреждения; журнал budget_change. Новый бюджет
    меньше потраченного за месяц — 400 ai.budget_below_spent: анализы на ключе
    администратора остановились бы сразу (тот же бюджет можно оставить)."""
    settings = await _settings(db)
    if monthly_usd != settings.monthly_budget_usd:
        spent = (await budget_overview(db, utcnow())).spent_usd
        if monthly_usd < spent:
            raise AppError(400, "ai.budget_below_spent", spent=usd_text(spent))
    await ai_keys.set_budget(
        db,
        monthly_budget_usd=monthly_usd,
        budget_alert_pct=alert_pct,
        eval_budget_usd=eval_budget_usd,
        actor=actor,
        ip=ip,
    )
    return await admin_budget(db)


# --- ключ администратора ---


async def admin_key_info(db: AsyncSession) -> AdminKeyOut:
    settings = await _settings(db)
    users = await db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.status == "active", User.ai_mode == "shared")
    )
    if settings.anthropic_key_enc is None:
        status = "missing"
    elif settings.key_verified_at is None:
        status = "unverified"
    else:
        status = "ok"
    return AdminKeyOut(
        status=status,  # type: ignore[arg-type]
        last4=settings.key_last4 if settings.anthropic_key_enc is not None else None,
        verified_at=settings.key_verified_at,
        users_on_key=int(users or 0),
    )


async def replace_admin_key(
    db: AsyncSession,
    key: str,
    *,
    actor: User,
    confirm: TotpConfirm,
    ip: str | None,
    http_client: anthropic.DefaultAsyncHttpxClient | None = None,
) -> AdminKeyOut:
    """Замена ключа администратора из кабинета: формат, код 2FA, проверка ключа и доступа к
    моделям из настроек агента, сохранение (журнал key_change). Анализы, которые уже
    идут, ключ берут перед каждым вызовом и переходят на новый сразу."""
    key = key.strip()
    if not looks_like_key(key):
        raise AppError(400, "ai.key_format")
    models = (await load_agent_config(db)).models()
    # Код 2FA — до запросов к Anthropic (как в брифе и макете): иначе с угнанного сеанса
    # можно проверять чужие ключи без телефона администратора. Принятый код фиксируем
    # сразу: соединение с базой не держим, пока идет проверка по сети
    await check_totp(db, actor, confirm, action="key_change")
    await db.commit()
    check = await check_anthropic_key(key, models=models, http_client=http_client)
    _raise_for_check(check)
    await save_admin_key(db, key, verified=True, actor=actor, ip=ip)
    return await admin_key_info(db)


# --- лимиты участников ---


def _defaults_out(settings: AppSettings) -> LimitDefaultsOut:
    return LimitDefaultsOut(
        monthly_usd=settings.default_member_limit_usd,
        daily_analyses=settings.default_daily_analyses,
        per_analysis_usd=default_per_analysis(settings),
        soft_cap_usd=settings.per_analysis_soft_usd,
    )


def _limit_out(limits: Limits) -> LimitOut:
    return LimitOut(
        monthly_usd=limits.monthly_usd,
        daily_analyses=limits.daily_analyses,
        per_analysis_usd=limits.per_analysis_usd,
        paused=limits.paused,
    )


async def _member_rows(db: AsyncSession, users: list[User]) -> list[MemberLimitOut]:
    """Строки таблицы лимитов: расход и анализы за месяц, анализы сегодня, лимиты —
    несколькими запросами на всех сразу."""
    if not users:
        return []
    now = utcnow()
    start = month_start(now)
    ids = [user.id for user in users]
    settings = await _settings(db)
    usage = await month_usage(db, ids, now)
    own_spent = {
        uid: Decimal(total or 0)
        for uid, total in (
            await db.execute(
                select(AgentRun.user_id, func.sum(AgentRun.cost_usd))
                .where(
                    AgentRun.user_id.in_(ids),
                    AgentRun.key_source == "own",
                    AgentRun.created_at >= start,
                    AgentRun.kind.not_in(CHECK_RUN_KINDS),
                )
                .group_by(AgentRun.user_id)
            )
        ).all()
    }
    limit_rows = {
        row.user_id: row
        for row in await db.scalars(select(AiLimit).where(AiLimit.user_id.in_(ids)))
    }
    last4 = {
        uid: value
        for uid, value in (
            await db.execute(
                select(UserSecret.user_id, UserSecret.last4).where(
                    UserSecret.user_id.in_(ids), UserSecret.kind == SECRET_KIND
                )
            )
        ).all()
    }
    started: dict[int, list[datetime]] = {}
    for uid, at in (
        await db.execute(
            select(Analysis.user_id, Analysis.started_at).where(
                Analysis.user_id.in_(ids),
                Analysis.key_source == "admin",
                Analysis.started_at >= now - _TODAY_WINDOW,
            )
        )
    ).all():
        if at is not None:
            started.setdefault(uid, []).append(at)
    rows: list[MemberLimitOut] = []
    for user in users:
        limits = limits_of(limit_rows.get(user.id), settings)
        day = _day_start(now, user.tz)
        spent, analyses = usage.get(user.id, (Decimal(0), 0))
        rows.append(
            MemberLimitOut(
                id=user.id,
                display_name=user.display_name,
                email=user.email,
                role=user.role,  # type: ignore[arg-type]
                status=user.status,  # type: ignore[arg-type]
                ai_mode=user.ai_mode,  # type: ignore[arg-type]
                limit=_limit_out(limits) if user.role != "admin" else None,
                own_cap_usd=limits.own_per_analysis_usd,
                own_key_last4=last4.get(user.id),
                spent_month_usd=spent,
                own_spent_month_usd=own_spent.get(user.id, Decimal(0)),
                analyses_today=sum(1 for at in started.get(user.id, []) if at >= day),
                analyses_month=analyses,
                return_requested_at=limits.return_requested_at,
            )
        )
    return rows


async def limits_view(db: AsyncSession) -> AdminLimitsOut:
    """Лимиты по умолчанию и все пользователи, кроме удаленных, по порядку регистрации."""
    users = list(
        await db.scalars(
            select(User)
            .where(User.status != "deleted")
            .order_by(User.id)
            .execution_options(populate_existing=True)
        )
    )
    return AdminLimitsOut(
        defaults=_defaults_out(await _settings(db)),
        members=await _member_rows(db, users),
    )


async def member_limit(db: AsyncSession, user_id: int) -> MemberLimitOut:
    user = await db.scalar(
        select(User).where(User.id == user_id).execution_options(populate_existing=True)
    )
    if user is None or user.status == "deleted":
        raise AppError(404, "common.not_found")
    [row] = await _member_rows(db, [user])
    return row


async def update_member_limit(
    db: AsyncSession, user_id: int, body: LimitPatchIn, *, actor: User, ip: str | None
) -> MemberLimitOut:
    """Лимит участника на ключе администратора и пауза; журнал limit_change. Потолок
    анализа не выше месячного лимита (с учетом действующего, если месяц не передан).
    Администратору — 409 ai.admin_no_limit: личного лимита у него нет."""
    await _limit_target(db, user_id, admin_code="ai.admin_no_limit")
    if body.monthly_usd is not None or body.per_analysis_usd is not None:
        row = await db.scalar(
            select(AiLimit)
            .where(AiLimit.user_id == user_id)
            .execution_options(populate_existing=True)
        )
        current = limits_of(row, await _settings(db))
        _check_cap(
            body.monthly_usd if body.monthly_usd is not None else current.monthly_usd,
            (
                body.per_analysis_usd
                if body.per_analysis_usd is not None
                else current.per_analysis_usd
            ),
        )
    await ai_keys.set_member_limit(
        db,
        user_id,
        monthly_usd=body.monthly_usd,
        daily_analyses=body.daily_analyses,
        per_analysis_usd=body.per_analysis_usd,
        paused=body.paused,
        actor=actor,
        ip=ip,
    )
    return await member_limit(db, user_id)


async def update_defaults(
    db: AsyncSession, body: LimitIn, *, actor: User, ip: str | None
) -> LimitDefaultsOut:
    """Лимиты по умолчанию для новых участников (Р13), одним commit с журналом
    budget_change: месяц и анализы в день — в app_settings, потолок анализа — в
    app_settings.agent_config (default_per_analysis_usd). Зарегистрированных, анализы
    администратора (жесткий потолок программы) и мягкий потолок это не меняет."""
    _check_cap(body.monthly_usd, body.per_analysis_usd)
    row = await db.scalar(
        select(AppSettings)
        .where(AppSettings.id == SETTINGS_ROW_ID)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is None:
        raise AppError(500, "admin.settings_missing")
    monthly = body.monthly_usd.quantize(CENT)
    cap = body.per_analysis_usd.quantize(CENT)
    old_cap = default_per_analysis(row).quantize(CENT)
    changes: dict[str, dict[str, object]] = {}
    if row.default_member_limit_usd != monthly:
        changes["default_member_limit_usd"] = {
            "from": str(row.default_member_limit_usd),
            "to": str(monthly),
        }
        row.default_member_limit_usd = monthly
    if row.default_daily_analyses != body.daily_analyses:
        changes["default_daily_analyses"] = {
            "from": row.default_daily_analyses,
            "to": body.daily_analyses,
        }
        row.default_daily_analyses = body.daily_analyses
    if old_cap != cap:
        changes["default_per_analysis_usd"] = {"from": str(old_cap), "to": str(cap)}
        row.agent_config = {**(row.agent_config or {}), "default_per_analysis_usd": str(cap)}
    if changes:
        row.updated_by = actor.id
        row.updated_at = utcnow()
        await write_audit(
            db, action="budget_change", actor_id=actor.id, details={"changes": changes}, ip=ip
        )
    await db.commit()
    return _defaults_out(row)


async def decide_mode(
    db: AsyncSession,
    user_id: int,
    *,
    approve: bool,
    limit: LimitIn | None,
    actor: User,
    ip: str | None,
) -> MemberLimitOut:
    """Решение по просьбе вернуть ключ администратора (Р12). При одобрении сначала
    ставится лимит (с limit — новый) и снимается пауза (журнал limit_change), чтобы
    уведомление участнику назвало действующий лимит: раз администратор вернул участника
    на свой ключ, анализы снова идут (как в макете, approveReturn); затем режим (журнал
    ai_mode_change, уведомление ai_mode_decision), свой ключ участника удаляется. Просьбы
    нет — 409 ai.no_return_request, и лимит не меняется. Администратор возвращается на
    ключ администратора сам — 409 ai.return_not_needed."""
    target = await _limit_target(db, user_id, admin_code="ai.return_not_needed")
    if approve:
        row = await db.scalar(
            select(AiLimit)
            .where(AiLimit.user_id == user_id)
            .execution_options(populate_existing=True)
        )
        if target.ai_mode != "own" or row is None or row.return_requested_at is None:
            raise AppError(409, "ai.no_return_request")
        if limit is not None:
            _check_cap(limit.monthly_usd, limit.per_analysis_usd)
        await ai_keys.set_member_limit(
            db,
            user_id,
            monthly_usd=limit.monthly_usd if limit is not None else None,
            daily_analyses=limit.daily_analyses if limit is not None else None,
            per_analysis_usd=limit.per_analysis_usd if limit is not None else None,
            paused=False,
            actor=actor,
            ip=ip,
        )
    await ai_keys.decide_return(db, user_id, approve=approve, actor=actor, ip=ip)
    return await member_limit(db, user_id)
