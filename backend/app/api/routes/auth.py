"""Вход, регистрация по приглашению, 2FA, выход, сброс пароля: /api/auth/*.

Маршрут разбирает запрос, вызывает сервис (app/services/auth.py, registration.py)
и ставит или стирает cookie по итогу. Логика входа и лимиты попыток — в сервисах.
"""

import re
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status

from app.core.cookies import CookieKind, clear_cookie, cookie_name, set_cookie
from app.core.deps import ClientIp, DbSession, RedisClient
from app.core.security.tokens import new_token
from app.schemas.auth import (
    CsrfOut,
    LoginIn,
    LoginOut,
    RegisterIn,
    ResetIn,
    StatusOut,
    TotpSetupConfirmIn,
    TotpSetupDoneOut,
    TotpSetupOut,
    TwoFactorIn,
)
from app.schemas.me import MeOut
from app.services import auth as auth_service
from app.services import registration as registration_service
from app.services.app_settings import get_app_settings
from app.services.auth import ClientInfo, LoginOutcome

router = APIRouter(prefix="/auth", tags=["auth"])

# Токен CSRF из cookie переиспользуется, если похож на выданный нами (base64url)
_CSRF_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


def get_client_info(request: Request, ip: ClientIp) -> ClientInfo:
    return ClientInfo(ip=ip, user_agent=request.headers.get("user-agent"))


RequestClient = Annotated[ClientInfo, Depends(get_client_info)]


def read_cookie(request: Request, kind: CookieKind) -> str | None:
    return request.cookies.get(cookie_name(kind)) or None


def _login_out(outcome: LoginOutcome) -> LoginOut:
    user = MeOut.model_validate(outcome.user) if outcome.status == "ok" else None
    return LoginOut(status=outcome.status, user=user)


def _apply_cookies(response: Response, outcome: LoginOutcome) -> None:
    """Cookie по итогу шага: незавершенный вход, сеанс, доверенное устройство."""
    if outcome.login_token:
        set_cookie(response, "login", outcome.login_token)
    if outcome.session_token:
        set_cookie(response, "session", outcome.session_token)
        clear_cookie(response, "login")
    if outcome.device_token:
        set_cookie(response, "device", outcome.device_token)


@router.get("/csrf")
async def csrf(request: Request, response: Response) -> CsrfOut:
    """CSRF-токен в cookie и в ответе. Уже выданный токен не меняется: другие вкладки
    продолжают работать."""
    token = request.cookies.get(cookie_name("csrf"), "")
    if not _CSRF_TOKEN_RE.match(token):
        token = new_token()
    set_cookie(response, "csrf", token)
    return CsrfOut(csrf_token=token)


@router.post("/login")
async def login(
    body: LoginIn,
    request: Request,
    response: Response,
    db: DbSession,
    redis: RedisClient,
    client: RequestClient,
) -> LoginOut:
    """Шаг 1: email и пароль. Дальше — код 2FA, его настройка или сразу вход
    (доверенное устройство)."""
    outcome = await auth_service.login_with_password(
        db,
        redis,
        email=body.email,
        password=body.password,
        client=client,
        device_token=read_cookie(request, "device"),
        old_login_token=read_cookie(request, "login"),
        old_session_token=read_cookie(request, "session"),
    )
    _apply_cookies(response, outcome)
    return _login_out(outcome)


@router.post("/2fa")
async def two_factor(
    body: TwoFactorIn,
    request: Request,
    response: Response,
    db: DbSession,
    redis: RedisClient,
    client: RequestClient,
) -> LoginOut:
    """Шаг 2: код из приложения или резервный код."""
    outcome = await auth_service.verify_second_factor(
        db,
        redis,
        login_token=read_cookie(request, "login"),
        code=body.code,
        recovery_code=body.recovery_code,
        remember_device=body.remember_device,
        client=client,
        old_session_token=read_cookie(request, "session"),
    )
    _apply_cookies(response, outcome)
    return _login_out(outcome)


@router.post("/2fa/setup")
async def two_factor_setup(
    request: Request, db: DbSession, redis: RedisClient, client: RequestClient
) -> TotpSetupOut:
    """Секрет 2FA для настройки: только после пароля, когда 2FA еще не включена."""
    setup = await auth_service.start_totp_setup(
        db, redis, login_token=read_cookie(request, "login"), client=client
    )
    return TotpSetupOut(secret=setup.secret, otpauth_uri=setup.otpauth_uri, qr_svg=setup.qr_svg)


@router.post("/2fa/setup/confirm")
async def two_factor_setup_confirm(
    body: TotpSetupConfirmIn,
    request: Request,
    response: Response,
    db: DbSession,
    redis: RedisClient,
    client: RequestClient,
) -> TotpSetupDoneOut:
    """Код из приложения включает 2FA и завершает вход; 8 резервных кодов — один раз."""
    outcome = await auth_service.confirm_totp_setup(
        db,
        redis,
        login_token=read_cookie(request, "login"),
        code=body.code,
        client=client,
        old_session_token=read_cookie(request, "session"),
    )
    _apply_cookies(response, outcome)
    return TotpSetupDoneOut(
        status="ok",
        user=MeOut.model_validate(outcome.user),
        recovery_codes=outcome.recovery_codes,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, db: DbSession, redis: RedisClient) -> Response:
    """Выход из этого браузера. Без сеанса — тоже 204."""
    await auth_service.logout(
        db,
        redis,
        session_token=read_cookie(request, "session"),
        login_token=read_cookie(request, "login"),
    )
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_cookie(response, "session")
    clear_cookie(response, "login")
    return response


@router.post("/register")
async def register(
    body: RegisterIn,
    response: Response,
    db: DbSession,
    redis: RedisClient,
    client: RequestClient,
) -> LoginOut:
    """Регистрация по коду приглашения. Следующий шаг — настройка 2FA. Без tz — часовой
    пояс по умолчанию из «Администрирование → Настройки»."""
    tz = body.tz or (await get_app_settings(db)).default_tz
    outcome = await registration_service.register(
        db,
        redis,
        invite_code=body.invite_code,
        email=body.email,
        display_name=body.display_name,
        password=body.password,
        accept_terms=body.accept_terms,
        consent_training=body.consent_training,
        tz=tz,
        client=client,
    )
    _apply_cookies(response, outcome)
    return _login_out(outcome)


@router.post("/reset")
async def reset(
    body: ResetIn, db: DbSession, redis: RedisClient, client: RequestClient
) -> StatusOut:
    """Новый пароль по коду сброса от администратора. Все сеансы завершаются."""
    await registration_service.reset_password(
        db,
        redis,
        email=body.email,
        code=body.code,
        new_password=body.new_password,
        client=client,
    )
    return StatusOut(status="ok")
