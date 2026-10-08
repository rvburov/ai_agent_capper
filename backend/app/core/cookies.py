"""Cookie входа: имена и флаги.

В prod (cookie_secure=True) имена с префиксом __Host-: браузер примет такую cookie только
с Secure, Path=/ и без Domain, и поддомен ее не подменит. В dev сайт работает по http,
поэтому префикса и Secure нет.

| вид      | prod             | dev            | HttpOnly | срок                     |
|----------|------------------|----------------|----------|--------------------------|
| session  | __Host-session   | capper_session | да       | абсолютный срок сеанса   |
| login    | __Host-login     | capper_login   | да       | login_pending_minutes    |
| device   | __Host-device    | capper_device  | да       | trusted_device_days      |
| csrf     | __Host-csrf      | capper_csrf    | нет      | абсолютный срок сеанса   |

CSRF-cookie читает фронтенд и повторяет ее значение в заголовке X-CSRF-Token.
"""

from typing import Literal

from starlette.responses import Response

from app.core.config import Settings, get_settings

CookieKind = Literal["session", "login", "device", "csrf"]
CSRF_HEADER = "X-CSRF-Token"


def cookie_name(kind: CookieKind, settings: Settings | None = None) -> str:
    settings = settings or get_settings()
    return f"__Host-{kind}" if settings.cookie_secure else f"capper_{kind}"


def cookie_max_age(kind: CookieKind, settings: Settings | None = None) -> int:
    settings = settings or get_settings()
    day = 24 * 3600
    if kind == "login":
        return settings.login_pending_minutes * 60
    if kind == "device":
        return settings.trusted_device_days * day
    return settings.session_absolute_days * day


def set_cookie(
    response: Response,
    kind: CookieKind,
    value: str,
    settings: Settings | None = None,
) -> None:
    settings = settings or get_settings()
    response.set_cookie(
        key=cookie_name(kind, settings),
        value=value,
        max_age=cookie_max_age(kind, settings),
        path="/",
        secure=settings.cookie_secure,
        httponly=kind != "csrf",
        samesite="lax",
    )


def clear_cookie(response: Response, kind: CookieKind, settings: Settings | None = None) -> None:
    settings = settings or get_settings()
    response.delete_cookie(
        key=cookie_name(kind, settings),
        path="/",
        secure=settings.cookie_secure,
        httponly=kind != "csrf",
        samesite="lax",
    )
