"""Кабинет администратора: /api/admin/*.

Доступ только у роли admin: зависимость require_admin стоит на уровне роутера,
поэтому любой маршрут здесь без сеанса отвечает 401, участнику — 403 (это проверяет
параметризованный тест по всем маршрутам роутера). Р14: ставок, банка и стратегии
участников здесь нет.
Опасные действия (роль, сброс 2FA, удаление, приглашение администратора) требуют в теле
totp_code — текущий код 2FA администратора.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from app.core.deps import AdminUser, ClientIp, DbSession, RedisClient, require_admin
from app.schemas.admin import (
    AdminUserDetailOut,
    AdminUserOut,
    AuditAction,
    AuditOut,
    CodeStatus,
    InviteCreatedOut,
    InviteIn,
    InviteOut,
    ResetCodeCreatedOut,
    ResetCodeIn,
    ResetCodeOut,
    RoleChangeIn,
    TotpConfirmIn,
    UserDeleteIn,
)
from app.services import access_codes, admin_users
from app.services.admin_confirm import TotpConfirm

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])

# Номер строки в БД: BIGINT, больше не бывает
RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


# --- участники ---


@router.get("/users")
async def list_users(db: DbSession, include_deleted: bool = False) -> list[AdminUserOut]:
    """Участники: учетная запись, расход на ИИ за месяц и лимит. Удаленные —
    только с include_deleted=true."""
    return await admin_users.list_users(db, include_deleted=include_deleted)


@router.get("/users/{user_id}")
async def get_user(db: DbSession, user_id: RowId) -> AdminUserDetailOut:
    return await admin_users.get_user_detail(db, user_id)


@router.post("/users/{user_id}/block")
async def block_user(db: DbSession, admin: AdminUser, ip: ClientIp, user_id: RowId) -> AdminUserOut:
    return await admin_users.block_user(db, user_id, actor=admin, ip=ip)


@router.post("/users/{user_id}/unblock")
async def unblock_user(
    db: DbSession, admin: AdminUser, ip: ClientIp, user_id: RowId
) -> AdminUserOut:
    return await admin_users.unblock_user(db, user_id, actor=admin, ip=ip)


@router.post("/users/{user_id}/role")
async def change_role(
    db: DbSession,
    redis: RedisClient,
    admin: AdminUser,
    ip: ClientIp,
    user_id: RowId,
    body: RoleChangeIn,
) -> AdminUserOut:
    return await admin_users.change_role(
        db,
        user_id,
        body.role,
        actor=admin,
        ip=ip,
        confirm=TotpConfirm(redis=redis, code=body.totp_code),
    )


@router.post("/users/{user_id}/sessions/revoke", status_code=204)
async def revoke_sessions(db: DbSession, admin: AdminUser, ip: ClientIp, user_id: RowId) -> None:
    await admin_users.revoke_sessions(db, user_id, actor=admin, ip=ip)


@router.post("/users/{user_id}/2fa-reset", status_code=204)
async def reset_two_factor(
    db: DbSession,
    redis: RedisClient,
    admin: AdminUser,
    ip: ClientIp,
    user_id: RowId,
    body: TotpConfirmIn,
) -> None:
    await admin_users.reset_two_factor(
        db, user_id, actor=admin, ip=ip, confirm=TotpConfirm(redis=redis, code=body.totp_code)
    )


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    db: DbSession,
    redis: RedisClient,
    admin: AdminUser,
    ip: ClientIp,
    user_id: RowId,
    body: UserDeleteIn,
) -> None:
    await admin_users.delete_user(
        db,
        user_id,
        confirm_email=body.confirm_email,
        actor=admin,
        ip=ip,
        confirm=TotpConfirm(redis=redis, code=body.totp_code),
    )


# --- приглашения ---


@router.get("/invites")
async def list_invites(db: DbSession, status: CodeStatus | None = None) -> list[InviteOut]:
    return await access_codes.list_invites(db, status=status)


@router.post("/invites", status_code=201)
async def create_invite(
    db: DbSession, redis: RedisClient, admin: AdminUser, ip: ClientIp, body: InviteIn
) -> InviteCreatedOut:
    """Код CAP-XXXX-XXXX на 7 дней. Показывается один раз, в базе только хеш.
    Приглашение с ролью admin — только с totp_code."""
    confirm = None
    if body.totp_code is not None:
        confirm = TotpConfirm(redis=redis, code=body.totp_code)
    return await access_codes.create_invite(db, body, actor=admin, ip=ip, confirm=confirm)


@router.delete("/invites/{invite_id}", status_code=204)
async def revoke_invite(db: DbSession, admin: AdminUser, ip: ClientIp, invite_id: RowId) -> None:
    await access_codes.revoke_invite(db, invite_id, actor=admin, ip=ip)


# --- коды сброса пароля ---


@router.get("/reset-codes")
async def list_reset_codes(db: DbSession, status: CodeStatus | None = None) -> list[ResetCodeOut]:
    return await access_codes.list_reset_codes(db, status=status)


@router.post("/reset-codes", status_code=201)
async def create_reset_code(
    db: DbSession, admin: AdminUser, ip: ClientIp, body: ResetCodeIn
) -> ResetCodeCreatedOut:
    """Код RST-XXXX-XXXX на 24 часа; прежние действующие коды участника отзываются."""
    return await access_codes.create_reset_code(db, body.user_id, actor=admin, ip=ip)


@router.delete("/reset-codes/{code_id}", status_code=204)
async def revoke_reset_code(db: DbSession, admin: AdminUser, ip: ClientIp, code_id: RowId) -> None:
    await access_codes.revoke_reset_code(db, code_id, actor=admin, ip=ip)


# --- журнал ---


@router.get("/audit")
async def list_audit(
    db: DbSession,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before_id: Annotated[int | None, Query(ge=1, le=2**63 - 1)] = None,
    action: Annotated[list[AuditAction] | None, Query()] = None,
) -> list[AuditOut]:
    """Журнал, новые сверху. Следующая страница: before_id = id последней записи.
    action (можно несколько раз) — только эти действия."""
    return await admin_users.list_audit(db, limit=limit, before_id=before_id, actions=action)
