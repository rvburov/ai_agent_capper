"""Зависимости FastAPI для маршрутов.

    from app.core.deps import AdminUser, ClientIp, CurrentUser, DbSession, RedisClient

    @router.get("/me")
    async def me(user: CurrentUser) -> MeOut: ...

- DbSession — сеанс БД на запрос (commit делает сервис).
- RedisClient — общий клиент Redis (ключи через app.core.redis.redis_key).
- ClientIp — IP клиента, полный адрес. За Caddy его берет из X-Forwarded-For
  ProxyHeadersMiddleware (app/main.py), и только если запрос пришел от адреса из
  CAPPER_TRUSTED_PROXIES. Лимиты попыток сворачивают IPv6 в сеть /64 сами (ratelimit).
- CurrentAuth / CurrentSession / CurrentUser — вошедший пользователь по cookie сеанса,
  иначе 401 errors.auth.not_authenticated.
- AdminUser — только роль admin, иначе 403 errors.common.forbidden.

Пока участник ждет удаления своего аккаунта (В10, users.deletion_requested_at), вход
возможен, но открыты только GET /api/me и отмена DELETE /api/me/deletion (выход и вход
сеанс не спрашивают). Остальные маршруты со входом — 403 account.deletion_pending: это
проверяется здесь, в одном месте, а не в каждом маршруте.
"""

import ipaddress
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated, cast

from fastapi import Depends, Request
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.cookies import cookie_name
from app.core.errors import AppError
from app.core.timing import route_template
from app.db.models import ACCOUNT_DELETION_DELAY, User, UserSession
from app.services import sessions as sessions_service

UNKNOWN_IP = "0.0.0.0"
# Маршруты, открытые участнику, который ждет удаления аккаунта: метод и полный шаблон
DELETION_ALLOWED = frozenset({("GET", "/api/me"), ("DELETE", "/api/me/deletion")})


async def get_db(request: Request) -> AsyncIterator[AsyncSession]:
    maker = cast(async_sessionmaker[AsyncSession], request.app.state.sessionmaker)
    async with maker() as session:
        yield session


def get_redis(request: Request) -> Redis:
    return cast(Redis, request.app.state.redis)


def client_ip(request: Request) -> str:
    """IP клиента строкой в каноническом виде. Неизвестный или испорченный — 0.0.0.0."""
    host = request.client.host if request.client else ""
    try:
        address = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return UNKNOWN_IP
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return str(address.ipv4_mapped)
    return str(address)


DbSession = Annotated[AsyncSession, Depends(get_db)]
RedisClient = Annotated[Redis, Depends(get_redis)]
ClientIp = Annotated[str, Depends(client_ip)]


@dataclass(frozen=True)
class Auth:
    session: UserSession
    user: User


async def current_auth(request: Request, db: DbSession) -> Auth:
    """Сеанс и пользователь по cookie. Продлевает last_seen_at не чаще раза в 5 минут."""
    token = request.cookies.get(cookie_name("session"), "")
    found = await sessions_service.get_active_session(db, token)
    if found is None:
        raise AppError(401, "auth.not_authenticated")
    session, user = found
    await sessions_service.touch_session(db, session)
    request.state.session_id = session.id
    if user.deletion_requested_at is not None:
        route = (request.method, route_template(request.scope) or "")
        if route not in DELETION_ALLOWED:
            delete_at = user.deletion_requested_at + ACCOUNT_DELETION_DELAY
            raise AppError(403, "account.deletion_pending", delete_at=delete_at.isoformat())
    return Auth(session=session, user=user)


CurrentAuth = Annotated[Auth, Depends(current_auth)]


async def current_session(auth: CurrentAuth) -> UserSession:
    return auth.session


async def current_user(auth: CurrentAuth) -> User:
    return auth.user


CurrentSession = Annotated[UserSession, Depends(current_session)]
CurrentUser = Annotated[User, Depends(current_user)]


async def require_admin(user: CurrentUser) -> User:
    if user.role != "admin":
        raise AppError(403, "common.forbidden")
    return user


AdminUser = Annotated[User, Depends(require_admin)]
