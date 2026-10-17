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
- ViewDashboard, ViewBets, ViewAnalytics, ViewBank, ViewAnalyses, ViewLearning, ViewAi,
  ViewExport — чьи данные отдает маршрут чтения (Р27, app/services/member_view.py): свои
  или, у администратора с query-параметром as_user=<id>, участника. Просмотр пишется в
  журнал по экрану маршрута (ViewExport не пишет: выгрузку записывает сам маршрут).
  Маршрут с такой зависимостью добавляет в схему параметр: openapi_extra=AS_USER_DOC.

as_user — только для чтения: на любом другом запросе (не GET или GET без зависимости
просмотра) — 403 common.forbidden. Это проверяет current_auth, в одном месте.

Пока участник ждет удаления своего аккаунта (В10, users.deletion_requested_at), вход
возможен, но открыты только GET /api/me и отмена DELETE /api/me/deletion (выход и вход
сеанс не спрашивают). Остальные маршруты со входом — 403 account.deletion_pending: это
проверяется здесь, в одном месте, а не в каждом маршруте.
"""

import ipaddress
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any, cast

from fastapi import Depends, Request
from fastapi.exceptions import RequestValidationError
from pydantic import Field, TypeAdapter, ValidationError
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.cookies import cookie_name
from app.core.errors import AppError
from app.core.timing import route_template
from app.db.models import ACCOUNT_DELETION_DELAY, User, UserSession
from app.services import member_view
from app.services import sessions as sessions_service
from app.services.member_view import Viewed, ViewScreen

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
    if AS_USER in request.query_params and (
        request.method != "GET" or not accepts_as_user(request.scope.get("route"))
    ):
        # Чужие данные — только чтение и только на маршрутах просмотра (Р27)
        raise AppError(403, "common.forbidden")
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


# --- просмотр данных участника администратором (Р27) ---

AS_USER = "as_user"
# Метка зависимости просмотра: по ней current_auth узнает маршрут, который принимает as_user
_VIEW_MARK = "_capper_member_view"
_AS_USER_ID: TypeAdapter[int] = TypeAdapter(Annotated[int, Field(ge=1, le=2**63 - 1)])
# Параметр as_user в схеме OpenAPI. Объявить его обычным Query нельзя: у маршрутов с
# моделью фильтров (BetFiltersIn, AnalyticsFiltersIn) второй query-параметр ломает
# разворот модели в отдельные параметры схемы
AS_USER_DOC: dict[str, Any] = {
    "parameters": [
        {
            "name": AS_USER,
            "in": "query",
            "required": False,
            "description": (
                "Только администратор: id участника, чьи данные показать (только просмотр, "
                "запись в журнал администратора). Не задан или свой id — свои данные"
            ),
            "schema": {
                "anyOf": [
                    {"type": "integer", "minimum": 1, "maximum": 2**63 - 1},
                    {"type": "null"},
                ],
                "title": "As User",
            },
        }
    ]
}


def accepts_as_user(route: object) -> bool:
    """Маршрут читает данные через зависимость просмотра (view_of)."""
    dependant = getattr(route, "dependant", None)
    stack = list(dependant.dependencies) if dependant is not None else []
    while stack:
        dependency = stack.pop()
        if getattr(dependency.call, _VIEW_MARK, False):
            return True
        stack.extend(dependency.dependencies)
    return False


def _as_user_id(raw: str) -> int:
    try:
        return _AS_USER_ID.validate_python(raw)
    except ValidationError as exc:
        raise RequestValidationError(
            [{**error, "loc": ("query", AS_USER)} for error in exc.errors(include_input=False)]
        ) from exc


def view_of(screen: ViewScreen | None) -> Callable[..., Awaitable[Viewed]]:
    """Зависимость маршрута чтения: чьи данные отдать. screen — экран для журнала
    (None — не писать просмотр). as_user принимает только администратор (иначе 403);
    удаленный участник — 404."""

    async def viewed_user(
        request: Request, auth: CurrentAuth, db: DbSession, redis: RedisClient, ip: ClientIp
    ) -> Viewed:
        viewer = auth.user
        raw = request.query_params.get(AS_USER)
        if raw is None:
            return Viewed(user=viewer, viewer=viewer, ip=ip)
        if viewer.role != "admin":
            raise AppError(403, "common.forbidden")
        user_id = _as_user_id(raw)
        if user_id == viewer.id:
            return Viewed(user=viewer, viewer=viewer, ip=ip)
        user = await member_view.find_member(db, user_id)
        if screen is not None:
            await member_view.log_view(
                db, redis, viewer_id=viewer.id, user_id=user.id, screen=screen, ip=ip
            )
        return Viewed(user=user, viewer=viewer, ip=ip)

    setattr(viewed_user, _VIEW_MARK, True)
    return viewed_user


ViewDashboard = Annotated[Viewed, Depends(view_of("dashboard"))]
ViewBets = Annotated[Viewed, Depends(view_of("bets"))]
ViewAnalytics = Annotated[Viewed, Depends(view_of("analytics"))]
ViewBank = Annotated[Viewed, Depends(view_of("bank"))]
ViewAnalyses = Annotated[Viewed, Depends(view_of("analyses"))]
ViewLearning = Annotated[Viewed, Depends(view_of("learning"))]
ViewAi = Annotated[Viewed, Depends(view_of("ai"))]
# Выгрузка CSV: просмотр не пишется, маршрут пишет member_export (member_view.log_export)
ViewExport = Annotated[Viewed, Depends(view_of(None))]
