"""Участники в кабинете администратора и в командах терминала: список, блокировка,
роль, сеансы, сброс 2FA, удаление по Р15, журнал действий.

Р14: администратор видит об участнике только учетную запись, расход на ИИ и активность.
Ставки, банк и стратегию эти функции не читают.

actor — администратор из кабинета; None — команда терминала (журнал пишет
source=terminal, код 2FA не нужен: доступ к серверу уже подтверждает владельца).
Опасные действия из кабинета (смена роли, сброс 2FA, удаление, блокировка администратора
и завершение его сеансов) подтверждаются текущим кодом 2FA администратора
(app/services/admin_confirm.py). Действия идут по одному (lock_admin_actions), поэтому
проверка «последний активный администратор» не обходится параллельными запросами.
Функции-действия фиксируют транзакцию сами: действие и запись в журнал — одним commit.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    ColumnElement,
    Delete,
    Update,
    and_,
    delete,
    distinct,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import get_settings
from app.core.errors import AppError
from app.db.models import (
    DEFAULT_TZ,
    AccessCode,
    AdminAuditLog,
    AgentRun,
    AiLimit,
    Analysis,
    BankrollLedger,
    Bet,
    Lesson,
    LoginEvent,
    Notification,
    Prediction,
    PushSubscription,
    RecoveryCode,
    StrategyVersion,
    TrustedDevice,
    User,
    UserSecret,
    UserSession,
)
from app.schemas.admin import (
    AdminUserDetailOut,
    AdminUserOut,
    AuditAction,
    AuditOut,
    LimitOut,
)
from app.schemas.me import LoginEventOut
from app.services.access_codes import (
    lock_admin_actions,
    person_name,
    revoke_active_reset_codes,
)
from app.services.admin_confirm import TotpConfirm, check_totp
from app.services.audit import write_audit
from app.services.sessions import revoke_user_sessions, utcnow

RECENT_LOGINS = 20
DELETED_EMAIL = "deleted-{id}@deleted.invalid"


# --- чтение: список и карточка ---


def month_start(now: datetime) -> datetime:
    """Начало текущего месяца по UTC: с него считаются расход и анализы."""
    now = now.astimezone(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def _usage(
    db: AsyncSession, user_ids: Sequence[int], now: datetime
) -> dict[int, tuple[Decimal, int]]:
    """Расход в долларах и число анализов за месяц на ключе администратора.

    Анализ — разные analysis_id среди вызовов kind = 'analysis' (у одного анализа
    несколько шагов, каждый — своя строка agent_runs).
    """
    if not user_ids:
        return {}
    analyses = func.count(distinct(AgentRun.analysis_id)).filter(AgentRun.kind == "analysis")
    rows = await db.execute(
        select(AgentRun.user_id, func.coalesce(func.sum(AgentRun.cost_usd), 0), analyses)
        .where(
            AgentRun.user_id.in_(user_ids),
            AgentRun.key_source == "admin",
            AgentRun.created_at >= month_start(now),
        )
        .group_by(AgentRun.user_id)
    )
    return {
        int(uid): (Decimal(spent), int(count))
        for uid, spent, count in rows.all()
        if uid is not None
    }


async def _limits(db: AsyncSession, user_ids: Sequence[int]) -> dict[int, AiLimit]:
    if not user_ids:
        return {}
    rows = await db.scalars(select(AiLimit).where(AiLimit.user_id.in_(user_ids)))
    return {row.user_id: row for row in rows}


def _limit_out(limit: AiLimit | None) -> LimitOut | None:
    if limit is None:
        return None
    return LimitOut(
        monthly_usd=limit.monthly_usd,
        daily_analyses=limit.daily_analyses,
        per_analysis_usd=limit.per_analysis_usd,
        paused=limit.paused,
    )


def _user_fields(
    user: User, usage: tuple[Decimal, int] | None, limit: AiLimit | None
) -> dict[str, Any]:
    spent, analyses = usage or (Decimal(0), 0)
    return {
        "id": user.id,
        "display_name": user.display_name,
        "email": user.email,
        "role": user.role,
        "status": user.status,
        "ai_mode": user.ai_mode,
        "totp_enabled": user.totp_enabled,
        "created_at": user.created_at,
        "last_login_at": user.last_login_at,
        "ai_spent_month_usd": spent,
        "analyses_month": analyses,
        "limit": _limit_out(limit),
    }


async def list_users(db: AsyncSession, *, include_deleted: bool = False) -> list[AdminUserOut]:
    """Все пользователи по порядку регистрации. Удаленные — только с include_deleted:
    их расход за месяц остается в бюджете ключа администратора."""
    stmt = select(User).order_by(User.id)
    if not include_deleted:
        stmt = stmt.where(User.status != "deleted")
    users = list(await db.scalars(stmt))
    ids = [u.id for u in users]
    usage = await _usage(db, ids, utcnow())
    limits = await _limits(db, ids)
    return [
        AdminUserOut.model_validate(_user_fields(u, usage.get(u.id), limits.get(u.id)))
        for u in users
    ]


async def user_out(db: AsyncSession, user: User) -> AdminUserOut:
    usage = await _usage(db, [user.id], utcnow())
    limits = await _limits(db, [user.id])
    return AdminUserOut.model_validate(_user_fields(user, usage.get(user.id), limits.get(user.id)))


async def get_user_detail(db: AsyncSession, user_id: int) -> AdminUserDetailOut:
    """Карточка: строка списка, число действующих сеансов и последние 20 входов."""
    user = await db.get(User, user_id)
    if user is None:
        raise AppError(404, "common.not_found")
    now = utcnow()
    usage = await _usage(db, [user.id], now)
    limits = await _limits(db, [user.id])
    idle_since = now - timedelta(days=get_settings().session_idle_days)
    active_sessions = await db.scalar(
        select(func.count())
        .select_from(UserSession)
        .where(
            UserSession.user_id == user.id,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > now,
            UserSession.last_seen_at > idle_since,
        )
    )
    events = await db.scalars(
        select(LoginEvent)
        .where(LoginEvent.user_id == user.id)
        .order_by(LoginEvent.at.desc(), LoginEvent.id.desc())
        .limit(RECENT_LOGINS)
    )
    fields = _user_fields(user, usage.get(user.id), limits.get(user.id))
    fields["active_sessions"] = int(active_sessions or 0)
    fields["recent_logins"] = [LoginEventOut.from_row(event) for event in events]
    return AdminUserDetailOut.model_validate(fields)


# --- действия ---


async def _load_target(db: AsyncSession, user_id: int) -> User:
    """Пользователь, над которым действие, с блокировкой строки. Удаленный — 404."""
    user = await db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None or user.status == "deleted":
        raise AppError(404, "common.not_found")
    return user


async def _ensure_not_last_admin(db: AsyncSession, target: User) -> None:
    """Действие лишит target роли активного администратора: проверяем, что останется
    другой. Вызывать после lock_admin_actions."""
    if target.role != "admin" or target.status != "active":
        return
    others = await db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.role == "admin", User.status == "active", User.id != target.id)
    )
    if not others:
        raise AppError(409, "admin.last_admin")


def _actor_id(actor: User | None) -> int | None:
    return actor.id if actor is not None else None


async def find_user_by_email(db: AsyncSession, email: str) -> User | None:
    """Пользователь по email без учета регистра (для команд терминала)."""
    return await db.scalar(
        select(User).where(
            func.lower(User.email) == email.strip().lower(), User.status != "deleted"
        )
    )


async def create_admin(
    db: AsyncSession, *, email: str, display_name: str, password_hash: str
) -> User:
    """Новый администратор (команда терминала create-admin). 2FA он настроит при первом
    входе. Email уже есть — 409 email_taken."""
    await lock_admin_actions(db)
    email = email.strip().lower()
    taken = await db.scalar(select(User.id).where(func.lower(User.email) == email))
    if taken is not None:
        raise AppError(409, "admin.email_taken")
    user = User(
        email=email,
        display_name=display_name,
        password_hash=password_hash,
        role="admin",
        status="active",
    )
    db.add(user)
    await db.flush()
    await write_audit(
        db, action="create_admin", actor_id=None, target_user_id=user.id, details={"email": email}
    )
    await db.commit()
    return user


async def block_user(
    db: AsyncSession,
    user_id: int,
    *,
    actor: User | None,
    ip: str | None,
    confirm: TotpConfirm | None = None,
) -> AdminUserOut:
    """Блокировка: вход закрыт, сеансы завершены, действующие коды сброса отозваны.
    Нельзя себя и последнего активного администратора. Администратора из кабинета —
    только с кодом 2FA: блокировка снимает права так же, как смена роли."""
    await lock_admin_actions(db)
    target = await _load_target(db, user_id)
    if actor is not None and target.id == actor.id:
        raise AppError(400, "admin.cannot_block_self")
    if target.status == "blocked":
        return await user_out(db, target)
    await _ensure_not_last_admin(db, target)
    if actor is not None and target.role == "admin":
        await check_totp(db, actor, confirm)
    now = utcnow()
    target.status = "blocked"
    target.blocked_at = now
    sessions = await revoke_user_sessions(db, target.id, now=now)
    codes = await revoke_active_reset_codes(db, target.id, now=now)
    await write_audit(
        db,
        action="block",
        actor_id=_actor_id(actor),
        target_user_id=target.id,
        details={"sessions_revoked": sessions, "reset_codes_revoked": codes},
        ip=ip,
    )
    await db.commit()
    return await user_out(db, target)


async def unblock_user(
    db: AsyncSession, user_id: int, *, actor: User | None, ip: str | None
) -> AdminUserOut:
    """Разблокировка. Если пользователь не заблокирован — ничего не меняется."""
    await lock_admin_actions(db)
    target = await _load_target(db, user_id)
    if target.status != "blocked":
        return await user_out(db, target)
    target.status = "active"
    target.blocked_at = None
    await write_audit(
        db, action="unblock", actor_id=_actor_id(actor), target_user_id=target.id, ip=ip
    )
    await db.commit()
    return await user_out(db, target)


async def change_role(
    db: AsyncSession,
    user_id: int,
    role: str,
    *,
    actor: User | None,
    ip: str | None,
    confirm: TotpConfirm | None = None,
) -> AdminUserOut:
    """Смена роли. Из кабинета — с кодом 2FA. Последнего активного администратора
    понизить нельзя (в том числе самому себе)."""
    await lock_admin_actions(db)
    target = await _load_target(db, user_id)
    if actor is not None:
        await check_totp(db, actor, confirm)
    if target.role == role:
        return await user_out(db, target)
    if role != "admin":
        await _ensure_not_last_admin(db, target)
    previous = target.role
    target.role = role
    await write_audit(
        db,
        action="role_change",
        actor_id=_actor_id(actor),
        target_user_id=target.id,
        details={"from": previous, "to": role},
        ip=ip,
    )
    await db.commit()
    return await user_out(db, target)


async def revoke_sessions(
    db: AsyncSession,
    user_id: int,
    *,
    actor: User | None,
    ip: str | None,
    confirm: TotpConfirm | None = None,
) -> int:
    """Завершает все сеансы пользователя. Возвращает их число. Сеансы администратора
    из кабинета — только с кодом 2FA."""
    await lock_admin_actions(db)
    target = await _load_target(db, user_id)
    if actor is not None and target.role == "admin":
        await check_totp(db, actor, confirm)
    count = await revoke_user_sessions(db, target.id)
    await write_audit(
        db,
        action="sessions_revoke",
        actor_id=_actor_id(actor),
        target_user_id=target.id,
        details={"sessions_revoked": count},
        ip=ip,
    )
    await db.commit()
    return count


async def _delete_rows(db: AsyncSession, stmt: Delete) -> int:
    result = await db.execute(stmt)
    return int(getattr(result, "rowcount", 0))


@dataclass(frozen=True)
class TwoFactorReset:
    sessions_revoked: int
    recovery_codes_deleted: int
    trusted_devices_deleted: int


async def reset_two_factor(
    db: AsyncSession,
    user_id: int,
    *,
    actor: User | None,
    ip: str | None,
    confirm: TotpConfirm | None = None,
) -> TwoFactorReset:
    """Сброс 2FA: секрет, резервные коды и доверенные устройства удаляются, сеансы
    завершаются; при следующем входе 2FA настраивается заново. Из кабинета — только
    участнику и с кодом 2FA; администратору — только командой терминала (Р6)."""
    await lock_admin_actions(db)
    target = await _load_target(db, user_id)
    if actor is not None:
        if target.role == "admin":
            raise AppError(403, "admin.reset_2fa_terminal_only")
        await check_totp(db, actor, confirm)
    target.totp_enabled = False
    target.totp_secret_enc = None
    target.totp_key_version = None
    target.totp_last_step = None
    result = TwoFactorReset(
        sessions_revoked=await revoke_user_sessions(db, target.id),
        recovery_codes_deleted=await _delete_rows(
            db, delete(RecoveryCode).where(RecoveryCode.user_id == target.id)
        ),
        trusted_devices_deleted=await _delete_rows(
            db, delete(TrustedDevice).where(TrustedDevice.user_id == target.id)
        ),
    )
    await write_audit(
        db,
        action="reset_2fa",
        actor_id=_actor_id(actor),
        target_user_id=target.id,
        details={
            "sessions_revoked": result.sessions_revoked,
            "recovery_codes_deleted": result.recovery_codes_deleted,
            "trusted_devices_deleted": result.trusted_devices_deleted,
        },
        ip=ip,
    )
    await db.commit()
    return result


async def _erase_personal_data(db: AsyncSession, user: User) -> None:
    """Удаляет личные данные по Р15.

    Строка users остается, поэтому ON DELETE CASCADE не срабатывает: каждая таблица
    с личными данными чистится здесь явно (тест сверяет это со всеми таблицами, у
    которых внешний ключ на users с CASCADE). agent_runs остаются: деньги уже
    потрачены и считаются в бюджете месяца.
    Сколько удалено ставок, записей банка и прочего, не возвращается и не пишется
    в журнал: журнал видят администраторы, а им это знать не положено (Р14).
    """
    uid = user.id
    own_analyses = select(Analysis.id).where(Analysis.user_id == uid)
    own_predictions: ColumnElement[bool] = or_(
        Prediction.user_id == uid, Prediction.analysis_id.in_(own_analyses)
    )
    statements: list[Update | Delete] = []
    if user.consent_training:
        # Обезличивание: от прогноза не должно остаться пути к человеку. analysis_id и
        # strategy_version_id обнулятся сами, когда ниже удалятся анализы и стратегии
        statements.append(
            update(Prediction).where(own_predictions).values(user_id=None, agent_run_id=None)
        )
    else:
        statements.append(delete(Prediction).where(own_predictions))
    statements += [
        # Журнал банка раньше ставок: bankroll_ledger.bet_id без каскада
        delete(BankrollLedger).where(BankrollLedger.user_id == uid),
        # События ставок (bet_legs) удаляются каскадом вместе со ставками
        delete(Bet).where(Bet.user_id == uid),
        delete(Analysis).where(Analysis.user_id == uid),
        delete(Lesson).where(Lesson.user_id == uid),
        # Прогоны eval этих стратегий удаляются каскадом
        delete(StrategyVersion).where(StrategyVersion.user_id == uid),
        delete(UserSecret).where(UserSecret.user_id == uid),
        delete(AiLimit).where(AiLimit.user_id == uid),
        delete(Notification).where(Notification.user_id == uid),
        delete(PushSubscription).where(PushSubscription.user_id == uid),
        delete(LoginEvent).where(LoginEvent.user_id == uid),
        delete(UserSession).where(UserSession.user_id == uid),
        delete(TrustedDevice).where(TrustedDevice.user_id == uid),
        delete(RecoveryCode).where(RecoveryCode.user_id == uid),
        delete(AccessCode).where(
            or_(
                AccessCode.user_id == uid,
                AccessCode.used_by == uid,
                and_(
                    AccessCode.kind == "invite",
                    func.lower(AccessCode.email) == user.email.lower(),
                ),
            )
        ),
    ]
    for stmt in statements:
        await db.execute(stmt)


async def delete_user(
    db: AsyncSession,
    user_id: int,
    *,
    confirm_email: str,
    actor: User | None,
    ip: str | None,
    confirm: TotpConfirm | None = None,
) -> None:
    """Удаление участника по Р15. Строка users остается со status = deleted и
    обезличенным email; прогнозы обезличиваются при согласии на обучение, иначе
    удаляются; agent_runs остаются. Нельзя себя и последнего администратора."""
    await lock_admin_actions(db)
    target = await _load_target(db, user_id)
    if actor is not None and target.id == actor.id:
        raise AppError(400, "admin.cannot_delete_self")
    if confirm_email.strip().lower() != target.email.lower():
        raise AppError(400, "admin.confirm_email_mismatch")
    if actor is not None:
        await check_totp(db, actor, confirm)
    await _ensure_not_last_admin(db, target)
    name, email, consent = target.display_name, target.email, target.consent_training
    await _erase_personal_data(db, target)
    now = utcnow()
    target.status = "deleted"
    target.deleted_at = now
    target.email = DELETED_EMAIL.format(id=target.id)
    target.display_name = ""
    target.password_hash = None
    target.totp_enabled = False
    target.totp_secret_enc = None
    target.totp_key_version = None
    target.totp_last_step = None
    target.role = "member"
    target.tz = DEFAULT_TZ
    target.blocked_at = None
    target.last_login_at = None
    # Запись журнала «кто, когда и кого удалил»: имя и email только здесь. Без счетчиков
    # удаленных ставок и записей банка: журнал видят администраторы (Р14)
    await write_audit(
        db,
        action="delete",
        actor_id=_actor_id(actor),
        target_user_id=target.id,
        details={"display_name": name, "email": email, "consent_training": consent},
        ip=ip,
    )
    await db.commit()


# --- журнал ---


async def list_audit(
    db: AsyncSession,
    *,
    limit: int = 50,
    before_id: int | None = None,
    actions: Sequence[AuditAction] | None = None,
) -> list[AuditOut]:
    """Журнал действий, новые сверху. Следующая страница — before_id = id последней
    записи предыдущей. actions — только эти действия."""
    actor = aliased(User)
    target = aliased(User)
    stmt = (
        select(
            AdminAuditLog,
            actor.display_name,
            actor.status,
            target.display_name,
            target.status,
        )
        .outerjoin(actor, actor.id == AdminAuditLog.actor_id)
        .outerjoin(target, target.id == AdminAuditLog.target_user_id)
        .order_by(AdminAuditLog.id.desc())
        .limit(limit)
    )
    if before_id is not None:
        stmt = stmt.where(AdminAuditLog.id < before_id)
    if actions:
        stmt = stmt.where(AdminAuditLog.action.in_(list(actions)))
    rows = (await db.execute(stmt)).all()
    return [
        AuditOut.model_validate(
            {
                "id": entry.id,
                "at": entry.at,
                "actor_id": entry.actor_id,
                "actor_name": person_name(entry.actor_id, actor_name, actor_status),
                "action": entry.action,
                "target_user_id": entry.target_user_id,
                "target_name": person_name(entry.target_user_id, target_name, target_status),
                "details": entry.details,
                "ip": entry.ip,
            }
        )
        for entry, actor_name, actor_status, target_name, target_status in rows
    ]
