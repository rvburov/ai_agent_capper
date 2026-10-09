"""Коды доступа от администратора: приглашения (CAP-, 7 дней) и коды сброса пароля
(RST-, 24 часа). Здесь создание, список и отзыв; прием кода при регистрации и сбросе
пароля — в app/services/registration.py.

Код показывается один раз, в ответе на создание; в БД лежит только HMAC-хеш.
Статус считается из полей: used (использован) важнее revoked (отозван), тот важнее
expired (истек), иначе active.

actor — администратор из кабинета; None — команда терминала (в журнале source=terminal).
Приглашение с ролью admin из кабинета подтверждается текущим кодом 2FA администратора.
Функции-действия фиксируют транзакцию сами: действие и запись в журнал — одним commit.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, and_, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.i18n import t
from app.core.security.tokens import gen_invite_code, gen_reset_code, hash_code
from app.db.models import AccessCode, AppSettings, User
from app.schemas.admin import (
    CodeStatus,
    InviteCreatedOut,
    InviteIn,
    InviteLimitOut,
    InviteOut,
    ResetCodeCreatedOut,
    ResetCodeOut,
)
from app.services.admin_confirm import TotpConfirm, check_totp
from app.services.audit import write_audit
from app.services.sessions import utcnow

INVITE = "invite"
PASSWORD_RESET = "password_reset"
# Ключ рекомендательной блокировки PostgreSQL (pg_advisory_xact_lock) для действий
# администратора над участниками и кодами: они выполняются по одному. Иначе два
# администратора, заблокировав друг друга одновременно, оставили бы программу без
# администратора, а два одновременных кода сброса одному человеку оба остались бы
# действующими. Действия администратора редки, очередь им не мешает
ADMIN_ACTIONS_LOCK = 0x43415050  # "CAPP"
_MAX_CODE_ATTEMPTS = 5


async def lock_admin_actions(db: AsyncSession) -> None:
    """Ставит действие администратора в очередь до конца транзакции."""
    await db.execute(select(func.pg_advisory_xact_lock(ADMIN_ACTIONS_LOCK)))


def code_status(code: AccessCode, now: datetime) -> CodeStatus:
    if code.used_at is not None:
        return "used"
    if code.revoked_at is not None:
        return "revoked"
    if code.expires_at <= now:
        return "expired"
    return "active"


def _status_filter(status: CodeStatus, now: datetime) -> ColumnElement[bool]:
    if status == "used":
        return AccessCode.used_at.is_not(None)
    if status == "revoked":
        return and_(AccessCode.used_at.is_(None), AccessCode.revoked_at.is_not(None))
    open_code = and_(AccessCode.used_at.is_(None), AccessCode.revoked_at.is_(None))
    if status == "expired":
        return and_(open_code, AccessCode.expires_at <= now)
    return and_(open_code, AccessCode.expires_at > now)


async def _new_code(db: AsyncSession, kind: str) -> tuple[str, str]:
    """Новый код и его хеш. Совпадение хеша с уже выданным кодом (40 бит случайности)
    почти невозможно, но проверяется: code_hash уникален."""
    for _ in range(_MAX_CODE_ATTEMPTS):
        code = gen_invite_code() if kind == INVITE else gen_reset_code()
        digest = hash_code(code)
        exists = await db.scalar(select(AccessCode.id).where(AccessCode.code_hash == digest))
        if exists is None:
            return code, digest
    raise RuntimeError("не удалось подобрать уникальный код")


def _actor_name(actor: User | None) -> str:
    return actor.display_name if actor is not None else ""


def person_name(user_id: int | None, name: str | None, status: str | None) -> str:
    """Имя автора или участника в списках кабинета. "" — человека нет (действие команды
    терминала). У удаленного имя стерто по Р15, пустым его не отдаем: пустое имя по
    контракту значит «терминал». Вместо него — подпись из локали."""
    if user_id is None:
        return ""
    if status == "deleted":
        return t("users.deleted")
    return name or ""


# --- приглашения ---


def _invite_limit(code: AccessCode) -> InviteLimitOut | None:
    if (
        code.limit_monthly_usd is None
        or code.limit_daily_analyses is None
        or code.limit_per_analysis_usd is None
    ):
        return None
    return InviteLimitOut(
        monthly_usd=code.limit_monthly_usd,
        daily_analyses=code.limit_daily_analyses,
        per_analysis_usd=code.limit_per_analysis_usd,
    )


def _invite_out(
    code: AccessCode, *, created_by_name: str, used_by_name: str | None, now: datetime
) -> InviteOut:
    return InviteOut.model_validate(
        {
            "id": code.id,
            "email": code.email or "",
            "role": code.role,
            "ai_mode": code.ai_mode,
            "limit": _invite_limit(code),
            "created_at": code.created_at,
            "expires_at": code.expires_at,
            "used_at": code.used_at,
            "used_by_name": used_by_name,
            "revoked_at": code.revoked_at,
            "created_by_name": created_by_name,
            "status": code_status(code, now),
        }
    )


async def list_invites(db: AsyncSession, *, status: CodeStatus | None = None) -> list[InviteOut]:
    """Приглашения, новые сверху. status — только с этим статусом."""
    now = utcnow()
    creator = aliased(User)
    used_by = aliased(User)
    stmt = (
        select(
            AccessCode,
            creator.display_name,
            creator.status,
            used_by.display_name,
            used_by.status,
        )
        .outerjoin(creator, creator.id == AccessCode.created_by)
        .outerjoin(used_by, used_by.id == AccessCode.used_by)
        .where(AccessCode.kind == INVITE)
        .order_by(AccessCode.created_at.desc(), AccessCode.id.desc())
    )
    if status is not None:
        stmt = stmt.where(_status_filter(status, now))
    rows = (await db.execute(stmt)).all()
    return [
        _invite_out(
            code,
            created_by_name=person_name(code.created_by, creator_name, creator_status),
            used_by_name=(
                person_name(code.used_by, used_name, used_status)
                if code.used_by is not None
                else None
            ),
            now=now,
        )
        for code, creator_name, creator_status, used_name, used_status in rows
    ]


@dataclass(frozen=True)
class _Limit:
    monthly_usd: Decimal
    daily_analyses: int
    per_analysis_usd: Decimal


async def _start_limit(db: AsyncSession, data: InviteIn) -> _Limit | None:
    """Стартовый лимит приглашения: из запроса или по умолчанию из настроек программы.
    Для своего ключа (own) лимита на ключе администратора нет."""
    if data.ai_mode != "shared":
        return None
    if data.limit is not None:
        return _Limit(
            data.limit.monthly_usd, data.limit.daily_analyses, data.limit.per_analysis_usd
        )
    defaults = await db.get_one(AppSettings, 1)
    return _Limit(
        defaults.default_member_limit_usd,
        defaults.default_daily_analyses,
        defaults.per_analysis_hard_usd,
    )


async def create_invite(
    db: AsyncSession,
    data: InviteIn,
    *,
    actor: User | None,
    ip: str | None,
    confirm: TotpConfirm | None = None,
) -> InviteCreatedOut:
    """Новое приглашение на email. Уже зарегистрированный email — 409 email_taken,
    действующее приглашение на этот email — 409 invite_exists. Приглашение
    администратора из кабинета — только с кодом 2FA (confirm), иначе 403 totp_required:
    с угнанным сеансом без телефона нельзя завести себе вторую учетную запись
    администратора."""
    await lock_admin_actions(db)
    now = utcnow()
    email = data.email.strip().lower()
    taken = await db.scalar(select(User.id).where(func.lower(User.email) == email))
    if taken is not None:
        raise AppError(409, "admin.email_taken")
    pending = await db.scalar(
        select(AccessCode.id).where(
            AccessCode.kind == INVITE,
            func.lower(AccessCode.email) == email,
            _status_filter("active", now),
        )
    )
    if pending is not None:
        raise AppError(409, "admin.invite_exists")
    if actor is not None and data.role == "admin":
        await check_totp(db, actor, confirm, action="invite")

    limit = await _start_limit(db, data)
    code, digest = await _new_code(db, INVITE)
    invite = AccessCode(
        kind=INVITE,
        code_hash=digest,
        email=email,
        role=data.role,
        ai_mode=data.ai_mode,
        limit_monthly_usd=limit.monthly_usd if limit else None,
        limit_daily_analyses=limit.daily_analyses if limit else None,
        limit_per_analysis_usd=limit.per_analysis_usd if limit else None,
        created_by=actor.id if actor else None,
        created_at=now,
        expires_at=now + timedelta(days=get_settings().invite_days),
    )
    db.add(invite)
    await db.flush()
    details: dict[str, Any] = {
        "invite_id": invite.id,
        "email": email,
        "role": data.role,
        "ai_mode": data.ai_mode,
        "expires_at": invite.expires_at.isoformat(),
    }
    if limit is not None:
        details["limit"] = {
            "monthly_usd": str(limit.monthly_usd),
            "daily_analyses": limit.daily_analyses,
            "per_analysis_usd": str(limit.per_analysis_usd),
        }
    await write_audit(
        db, action="invite", actor_id=actor.id if actor else None, details=details, ip=ip
    )
    await db.commit()
    out = _invite_out(invite, created_by_name=_actor_name(actor), used_by_name=None, now=now)
    return InviteCreatedOut(invite=out, code=code)


async def _load_code(db: AsyncSession, code_id: int, kind: str) -> AccessCode:
    code = await db.scalar(
        select(AccessCode)
        .where(AccessCode.id == code_id, AccessCode.kind == kind)
        .with_for_update()
    )
    if code is None:
        raise AppError(404, "common.not_found")
    return code


async def revoke_invite(
    db: AsyncSession, invite_id: int, *, actor: User | None, ip: str | None
) -> None:
    """Отзыв действующего приглашения. Использованное или истекшее — 409 code_inactive."""
    await lock_admin_actions(db)
    now = utcnow()
    invite = await _load_code(db, invite_id, INVITE)
    if code_status(invite, now) != "active":
        raise AppError(409, "admin.code_inactive")
    invite.revoked_at = now
    await write_audit(
        db,
        action="invite_revoke",
        actor_id=actor.id if actor else None,
        details={"invite_id": invite.id, "email": invite.email},
        ip=ip,
    )
    await db.commit()


# --- коды сброса пароля ---


def _reset_out(
    code: AccessCode, *, user: User, created_by_name: str, now: datetime
) -> ResetCodeOut:
    return ResetCodeOut(
        id=code.id,
        user_id=user.id,
        user_name=user.display_name,
        user_email=user.email,
        created_at=code.created_at,
        expires_at=code.expires_at,
        used_at=code.used_at,
        revoked_at=code.revoked_at,
        created_by_name=created_by_name,
        status=code_status(code, now),
    )


async def list_reset_codes(
    db: AsyncSession, *, status: CodeStatus | None = None
) -> list[ResetCodeOut]:
    """Коды сброса пароля, новые сверху. status — только с этим статусом."""
    now = utcnow()
    creator = aliased(User)
    stmt = (
        select(AccessCode, User, creator.display_name, creator.status)
        .join(User, User.id == AccessCode.user_id)
        .outerjoin(creator, creator.id == AccessCode.created_by)
        .where(AccessCode.kind == PASSWORD_RESET)
        .order_by(AccessCode.created_at.desc(), AccessCode.id.desc())
    )
    if status is not None:
        stmt = stmt.where(_status_filter(status, now))
    rows = (await db.execute(stmt)).all()
    return [
        _reset_out(
            code,
            user=user,
            created_by_name=person_name(code.created_by, creator_name, creator_status),
            now=now,
        )
        for code, user, creator_name, creator_status in rows
    ]


async def revoke_active_reset_codes(
    db: AsyncSession, user_id: int, *, now: datetime | None = None
) -> int:
    """Отзывает действующие коды сброса пользователя. Возвращает их число. Без commit."""
    now = now or utcnow()
    result = await db.execute(
        update(AccessCode)
        .where(
            AccessCode.kind == PASSWORD_RESET,
            AccessCode.user_id == user_id,
            _status_filter("active", now),
        )
        .values(revoked_at=now)
    )
    return int(getattr(result, "rowcount", 0))


async def create_reset_code(
    db: AsyncSession, user_id: int, *, actor: User | None, ip: str | None
) -> ResetCodeCreatedOut:
    """Новый код сброса пароля на 24 часа; прежние действующие коды этого
    пользователя отзываются. Администратору код выдает только терминал (Р6):
    из кабинета — 403 reset_code_terminal_only."""
    await lock_admin_actions(db)
    now = utcnow()
    user = await db.scalar(select(User).where(User.id == user_id).with_for_update())
    if user is None or user.status == "deleted":
        raise AppError(404, "common.not_found")
    if actor is not None and user.role == "admin":
        raise AppError(403, "admin.reset_code_terminal_only")
    replaced = await revoke_active_reset_codes(db, user.id, now=now)
    code, digest = await _new_code(db, PASSWORD_RESET)
    reset = AccessCode(
        kind=PASSWORD_RESET,
        code_hash=digest,
        user_id=user.id,
        created_by=actor.id if actor else None,
        created_at=now,
        expires_at=now + timedelta(hours=get_settings().reset_code_hours),
    )
    db.add(reset)
    await db.flush()
    await write_audit(
        db,
        action="reset_code",
        actor_id=actor.id if actor else None,
        target_user_id=user.id,
        details={
            "reset_code_id": reset.id,
            "expires_at": reset.expires_at.isoformat(),
            "replaced": replaced,
        },
        ip=ip,
    )
    await db.commit()
    out = _reset_out(reset, user=user, created_by_name=_actor_name(actor), now=now)
    return ResetCodeCreatedOut(reset_code=out, code=code)


async def revoke_reset_code(
    db: AsyncSession, code_id: int, *, actor: User | None, ip: str | None
) -> None:
    """Отзыв действующего кода сброса. Использованный или истекший — 409 code_inactive."""
    await lock_admin_actions(db)
    now = utcnow()
    reset = await _load_code(db, code_id, PASSWORD_RESET)
    if code_status(reset, now) != "active":
        raise AppError(409, "admin.code_inactive")
    reset.revoked_at = now
    await write_audit(
        db,
        action="reset_code_revoke",
        actor_id=actor.id if actor else None,
        target_user_id=reset.user_id,
        details={"reset_code_id": reset.id},
        ip=ip,
    )
    await db.commit()
