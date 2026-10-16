"""Личный кабинет вошедшего пользователя: /api/me/* (профиль и согласие, пароль, сеансы,
журнал входов, резервные коды, доверенные устройства, уведомления и что присылать,
ответственная игра, экспорт своих данных, удаление аккаунта).

Каждый маршрут берет пользователя из сеанса (CurrentAuth / CurrentUser) и видит только
свои данные: чужой id отвечает 404, как несуществующий. Пока участник ждет удаления
аккаунта, открыты только GET /api/me и DELETE /api/me/deletion (app/core/deps.py).
"""

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request, Response, status
from fastapi.responses import StreamingResponse

from app.api.routes.auth import RequestClient, read_cookie
from app.core.cookies import clear_cookie, set_cookie
from app.core.deps import CurrentAuth, CurrentUser, DbSession, RedisClient
from app.db.models import User
from app.schemas.cabinet import (
    DeletionIn,
    DeletionOut,
    ExportFormat,
    ExportSummaryOut,
    NotificationPrefsIn,
    NotificationPrefsOut,
    PauseIn,
    PlayLimitsIn,
    PlayLimitsOut,
)
from app.schemas.me import (
    LoginEventOut,
    LoginResult,
    MeOut,
    NotificationsOut,
    PasswordChangeIn,
    ProfileUpdateIn,
    RecoveryCodesIn,
    RecoveryCodesOut,
    RecoveryCodesStatusOut,
    SessionOut,
    TrustedDeviceOut,
)
from app.services import account as account_service
from app.services import data_export
from app.services import devices as devices_service
from app.services import notification_prefs as prefs_service
from app.services import play_limits as play_service
from app.services import profile as profile_service
from app.services.notifications import notification_out

router = APIRouter(prefix="/me", tags=["me"])

ListLimit = Annotated[int, Query(ge=1, le=account_service.MAX_LIST_LIMIT)]
# id строки в пути: BIGINT. Число вне диапазона — 422, а не ошибка базы (500)
RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


def _no_content() -> Response:
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _me_out(user: User) -> MeOut:
    return MeOut.model_validate(user)


@router.get("")
async def me(user: CurrentUser) -> MeOut:
    """Вошедший пользователь. deletion_at задан — аккаунт будет удален в этот момент, до
    него открыта только отмена (DELETE /api/me/deletion)."""
    return _me_out(user)


@router.patch("")
async def update_me(body: ProfileUpdateIn, user: CurrentUser, db: DbSession) -> MeOut:
    """Имя, часовой пояс и согласие на обезличенные прогнозы (consent_training, Р15).
    Пояс — только из базы IANA (zoneinfo), иначе 422."""
    updated = await profile_service.update_profile(
        db,
        user,
        display_name=body.display_name,
        tz=body.tz,
        consent_training=body.consent_training,
    )
    return _me_out(updated)


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
        session_id=auth.session.id,
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
    user: CurrentUser,
    db: DbSession,
    limit: ListLimit = 50,
    result: Annotated[list[LoginResult] | None, Query()] = None,
) -> list[LoginEventOut]:
    """Журнал входов за 90 дней, новые сверху. result (можно несколько раз) — только
    такие попытки: по ok, bad_totp и bad_recovery интерфейс ищет подозрительный вход,
    и тысячи неудачных паролей от чужих людей его не вытеснят."""
    rows = await account_service.list_login_events(db, user.id, limit=limit, results=result)
    return [LoginEventOut.from_row(row) for row in rows]


@router.get("/recovery-codes")
async def recovery_codes_status(user: CurrentUser, db: DbSession) -> RecoveryCodesStatusOut:
    """Сколько резервных кодов осталось. Сами коды не показываются: в БД только хеши."""
    codes = await profile_service.recovery_codes_status(db, user.id)
    return RecoveryCodesStatusOut(left=codes.left, total=codes.total, created_at=codes.created_at)


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
    return NotificationsOut(items=[notification_out(row) for row in rows], unread=unread)


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


# --- что присылать ---


@router.get("/notification-prefs")
async def notification_prefs(user: CurrentUser, db: DbSession) -> NotificationPrefsOut:
    """Виды уведомлений, которые человек может получать (у администратора — еще архив
    матчей и сигналы расхода ИИ), с «на сайте», «push» и признаком «обязательное»;
    push_available — есть ли активная подписка push; тихие часы push."""
    return await prefs_service.get_prefs(db, user)


@router.put("/notification-prefs")
async def update_notification_prefs(
    body: NotificationPrefsIn, user: CurrentUser, db: DbSession
) -> NotificationPrefsOut:
    """Частичное обновление «на сайте» и «push» по видам и тихих часов. Обязательный вид
    выключить на сайте нельзя — 422 notification.required (push — можно); вида нет у
    человека — 422 notification.kind_unavailable; начало тихих часов равно концу — 422
    notification.quiet_same."""
    return await prefs_service.update_prefs(db, user, body.items, body.quiet_hours)


# --- ответственная игра ---


@router.get("/play-limits")
async def play_limits(user: CurrentUser, db: DbSession) -> PlayLimitsOut:
    """Лимиты ставок в день (число и сумма), ждущее повышение, пауза и сколько поставлено
    сегодня по поясу участника; blocked — что сейчас не дает поставить и запустить анализ."""
    return await play_service.get_limits(db, user)


@router.put("/play-limits")
async def update_play_limits(body: PlayLimitsIn, user: CurrentUser, db: DbSession) -> PlayLimitsOut:
    """Лимиты целиком (null — без лимита): строже — сразу, мягче — через 24 часа (pending).
    Запрос без смягчений отменяет ждущее повышение. currency формы не валюта программы —
    409 common.currency_changed."""
    return await play_service.set_limits(
        db,
        user,
        bets_per_day=body.bets_per_day,
        stake_per_day=body.stake_per_day,
        currency=body.currency,
    )


@router.post("/pause")
async def take_pause(body: PauseIn, user: CurrentUser, db: DbSession) -> PlayLimitsOut:
    """Пауза на 1, 7, 30 или 90 дней (до полуночи по поясу участника после последнего дня):
    ставки и анализы на любом ключе недоступны, досрочно не снимается. Короче действующей —
    409 play.pause_shorter."""
    return await play_service.pause(db, user, body.days)


# --- экспорт и удаление ---


@router.get("/export/summary")
async def export_summary(user: CurrentUser, db: DbSession) -> ExportSummaryOut:
    """Числа кабинета «Данные»: ставки (в игре, из старого бота), события, свои вызовы
    Claude; период ставок бота и ноги его экспрессов без исхода. Только свое."""
    return await data_export.summary(db, user)


@router.get(
    "/export",
    response_class=Response,
    responses={
        200: {
            "content": {"application/json": {}, "application/zip": {}},
            "description": "JSON — один файл, CSV — архив ZIP по файлу на таблицу",
        }
    },
)
async def export_data(user: CurrentUser, db: DbSession, format: ExportFormat = "json") -> Response:
    """Все свои данные сразу скачиванием (GDPR): профиль, ставки и события, журнал банка,
    анализы и прогнозы, свои вызовы Claude, уведомления и настройки, букмекеры, лимиты,
    входы. Без паролей, кодов 2FA и ключей Claude. Файл отдается частями."""
    name = data_export.filename(user, format)
    if format == "json":
        chunks = data_export.json_chunks(db, user)
        media = "application/json"
    else:
        chunks = data_export.zip_chunks(db, user)
        media = "application/zip"
    return StreamingResponse(
        chunks,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/deletion")
async def request_deletion(
    body: DeletionIn,
    auth: CurrentAuth,
    db: DbSession,
    redis: RedisClient,
    client: RequestClient,
    response: Response,
) -> DeletionOut:
    """Удалить свой аккаунт через 7 дней: пароль и код 2FA (лимит попыток — как у входа).
    Все сеансы завершаются, cookie сеанса стирается: войти снова можно только для отмены.
    Единственный администратор удалить себя не может — 409 account.last_admin."""
    request = await account_service.request_deletion(
        db, redis, user=auth.user, password=body.password, code=body.code, client=client
    )
    clear_cookie(response, "session")
    return DeletionOut(requested_at=request.requested_at, delete_at=request.delete_at)


@router.delete("/deletion", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_deletion(user: CurrentUser, db: DbSession) -> Response:
    """Отменить удаление (в течение 7 дней). Запроса нет — 409 account.no_deletion."""
    await account_service.cancel_deletion(db, user)
    return _no_content()
