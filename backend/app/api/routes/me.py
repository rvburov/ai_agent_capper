"""Личный кабинет вошедшего пользователя: /api/me/* (профиль, пароль, сеансы,
журнал входов, резервные коды, доверенные устройства, уведомления).

Каждый маршрут берет пользователя из сеанса (CurrentAuth / CurrentUser) и видит только
свои данные: чужой id отвечает 404, как несуществующий.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request, Response, status

from app.api.routes.auth import RequestClient, read_cookie
from app.core.cookies import clear_cookie, set_cookie
from app.core.deps import CurrentAuth, CurrentUser, DbSession, RedisClient
from app.schemas.me import (
    LoginEventOut,
    MeOut,
    NotificationOut,
    NotificationsOut,
    PasswordChangeIn,
    RecoveryCodesIn,
    RecoveryCodesOut,
    SessionOut,
    TrustedDeviceOut,
)
from app.services import account as account_service
from app.services import devices as devices_service

router = APIRouter(prefix="/me", tags=["me"])

ListLimit = Annotated[int, Query(ge=1, le=account_service.MAX_LIST_LIMIT)]
# id строки в пути: BIGINT. Число вне диапазона — 422, а не ошибка базы (500)
RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


def _no_content() -> Response:
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("")
async def me(user: CurrentUser) -> MeOut:
    return MeOut.model_validate(user)


@router.post("/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordChangeIn,
    auth: CurrentAuth,
    db: DbSession,
    redis: RedisClient,
    client: RequestClient,
) -> Response:
    """Смена пароля: остальные сеансы завершаются, токен этого сеанса заменяется."""
    token = await account_service.change_password(
        db,
        redis,
        user=auth.user,
        current_password=body.current_password,
        new_password=body.new_password,
        client=client,
    )
    response = _no_content()
    set_cookie(response, "session", token)
    return response


@router.get("/sessions")
async def list_sessions(auth: CurrentAuth, db: DbSession) -> list[SessionOut]:
    rows = await account_service.list_sessions(db, auth.user.id)
    return [
        SessionOut.model_validate(row).model_copy(update={"current": row.id == auth.session.id})
        for row in rows
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def end_session(session_id: RowId, auth: CurrentAuth, db: DbSession) -> Response:
    """Завершает свой сеанс. Если это текущий — cookie сеанса стирается."""
    await account_service.end_session(db, user_id=auth.user.id, session_id=session_id)
    response = _no_content()
    if session_id == auth.session.id:
        clear_cookie(response, "session")
    return response


@router.post("/sessions/revoke-others", status_code=status.HTTP_204_NO_CONTENT)
async def end_other_sessions(auth: CurrentAuth, db: DbSession) -> Response:
    await account_service.end_other_sessions(
        db, user_id=auth.user.id, current_session_id=auth.session.id
    )
    return _no_content()


@router.get("/login-events")
async def login_events(
    user: CurrentUser, db: DbSession, limit: ListLimit = 50
) -> list[LoginEventOut]:
    """Журнал входов за 90 дней, новые сверху."""
    rows = await account_service.list_login_events(db, user.id, limit=limit)
    return [LoginEventOut.from_row(row) for row in rows]


@router.post("/recovery-codes")
async def reissue_recovery_codes(
    body: RecoveryCodesIn,
    auth: CurrentAuth,
    db: DbSession,
    redis: RedisClient,
    client: RequestClient,
) -> RecoveryCodesOut:
    """Новые резервные коды по текущему коду 2FA; прежние перестают действовать.
    После 5 неверных кодов сеанс завершается (401)."""
    codes = await account_service.reissue_recovery_codes(
        db, redis, user=auth.user, session_id=auth.session.id, code=body.code, client=client
    )
    return RecoveryCodesOut(recovery_codes=codes)


@router.get("/trusted-devices")
async def list_trusted_devices(
    request: Request, user: CurrentUser, db: DbSession
) -> list[TrustedDeviceOut]:
    rows = await devices_service.list_trusted_devices(db, user.id)
    current = await devices_service.current_device_id(db, user.id, read_cookie(request, "device"))
    return [
        TrustedDeviceOut.model_validate(row).model_copy(update={"current": row.id == current})
        for row in rows
    ]


@router.delete("/trusted-devices/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def forget_trusted_device(
    device_id: RowId, request: Request, user: CurrentUser, db: DbSession
) -> Response:
    """Отзывает доверенное устройство. Если это этот браузер — cookie устройства стирается."""
    current = await devices_service.current_device_id(db, user.id, read_cookie(request, "device"))
    await account_service.forget_device(db, user_id=user.id, device_id=device_id)
    response = _no_content()
    if device_id == current:
        clear_cookie(response, "device")
    return response


@router.get("/notifications")
async def notifications(
    user: CurrentUser, db: DbSession, limit: ListLimit = 50
) -> NotificationsOut:
    rows, unread = await account_service.list_notifications(db, user.id, limit=limit)
    return NotificationsOut(
        items=[NotificationOut.model_validate(row) for row in rows], unread=unread
    )


@router.post("/notifications/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def read_all_notifications(user: CurrentUser, db: DbSession) -> Response:
    await account_service.mark_all_notifications_read(db, user_id=user.id)
    return _no_content()


@router.post("/notifications/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def read_notification(notification_id: RowId, user: CurrentUser, db: DbSession) -> Response:
    await account_service.mark_notification_read(
        db, user_id=user.id, notification_id=notification_id
    )
    return _no_content()
