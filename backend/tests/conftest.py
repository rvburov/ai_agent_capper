"""Общие фикстуры тестов backend.

Изоляция (тесты могут идти одновременно в нескольких процессах):
- База: на сеанс тестов создается своя база capper_test_<pid>_<random> на сервере и с
  учетной записью из CAPPER_TEST_ADMIN_DATABASE_URL, к ней применяются миграции
  Alembic — так проверяется и сама миграция. После сеанса (и если настройка упала)
  база удаляется. Базы прошлых сеансов, процесс которых убит, удаляются при старте.
- Перед каждым тестом, который трогает БД или Redis: TRUNCATE всех таблиц с
  RESTART IDENTITY и восстановлением строки app_settings; ключи Redis с префиксом сеанса
  удаляются.
- Redis: у сеанса свой префикс ключей (CAPPER_REDIS_PREFIX).

Асинхронные тесты — pytest-asyncio в режиме auto: пишите `async def test_...`, маркер
не нужен. Цикл событий один на весь сеанс.

Фикстуры:
- settings — настройки тестов (env=test, cookie без Secure, HIBP выключен);
  override_settings(**поля) — поменять настройки на время теста.
- db — AsyncSession к тестовой базе; redis — клиент Redis.
- app — приложение с открытым lifespan.
- client — httpx2.AsyncClient с IP 10.0.0.1, заголовком Origin и CSRF;
  make_client(ip=..., csrf=True) — еще клиенты (другой IP, без CSRF). Заголовок
  X-CSRF-Token берется из текущей cookie csrf перед каждым запросом, как во фронтенде,
  если тест не задал заголовок сам.
- make_user(role=, totp=, password=, status=, ...) → MadeUser: user, password,
  totp_secret, current_totp(offset_steps=0).
- login(client, user, ip=None) → тот же client, вошедший как user (сеанс прямо в БД).
- totp_code(user) → годный код 2FA для любого числа проверок подряд.
"""

import os
import secrets


def _prepare_environment() -> None:
    """Настройки тестов задаются до импорта приложения (get_settings кэшируется)."""
    if os.environ.get("CAPPER_TEST_SESSION") == str(os.getpid()):
        return
    os.environ["CAPPER_TEST_SESSION"] = str(os.getpid())
    os.environ["CAPPER_ENV"] = "test"
    from app.core.config import Settings
    from tests.support import temp_database_url

    base = Settings()
    suffix = f"{os.getpid()}_{secrets.token_hex(3)}"
    # Сервер и учетная запись — те же, через которые база создается (служебный адрес)
    os.environ["CAPPER_DATABASE_URL"] = temp_database_url(
        base.test_admin_database_url, f"capper_test_{suffix}"
    )
    os.environ["CAPPER_REDIS_PREFIX"] = f"capper-test:{suffix}:"
    os.environ["CAPPER_COOKIE_SECURE"] = "false"
    os.environ["CAPPER_HIBP_ENABLED"] = "false"
    os.environ["CAPPER_PUBLIC_ORIGIN"] = "http://localhost:5173"


_prepare_environment()

import weakref
from collections.abc import AsyncIterator
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from redis.asyncio import Redis
from sqlalchemy import text, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import Settings, get_settings
from app.core.cookies import CSRF_HEADER, cookie_name
from app.core.redis import create_redis
from app.core.security import crypto
from app.core.security.passwords import hash_password
from app.core.security.tokens import new_token
from app.core.security.totp import new_totp_secret
from app.db.base import Base
from app.db.models import DEFAULT_TZ, User
from app.db.session import create_engine, create_sessionmaker
from app.main import create_app
from app.services.sessions import create_session
from tests.support import (
    BASE_URL,
    COOKIE_DOMAIN,
    DEFAULT_IP,
    DEFAULT_PASSWORD,
    TEST_USER_AGENT,
    ClientFactory,
    LoginFn,
    MadeUser,
    SettingsOverride,
    TotpCodeFn,
    UserFactory,
    clear_redis,
    create_database,
    drop_database,
    drop_stale_test_databases,
    run_alembic_upgrade,
)

get_settings.cache_clear()

_password_hashes: dict[str, str] = {}


# --- база и Redis на сеанс тестов ---


@pytest.fixture
def settings() -> Settings:
    return get_settings()


@pytest.fixture(scope="session")
async def database() -> AsyncIterator[str]:
    """Тестовая база с примененными миграциями. Возвращает ее адрес."""
    settings = get_settings()
    name = make_url(settings.database_url).database
    assert name and name.startswith("capper_test_")
    await drop_stale_test_databases(settings.test_admin_database_url)
    await create_database(settings.test_admin_database_url, name)
    try:
        engine = create_engine(settings.database_url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade)
        finally:
            await engine.dispose()
        yield settings.database_url
    finally:
        # И после сеанса, и если миграция или подключение упали до yield
        await drop_database(settings.test_admin_database_url, name)


@pytest.fixture(scope="session")
async def engine(database: str) -> AsyncIterator[AsyncEngine]:
    eng = create_engine(database)
    yield eng
    await eng.dispose()


@pytest.fixture(scope="session")
async def redis_client() -> AsyncIterator[Redis]:
    settings = get_settings()
    client = create_redis(settings.redis_url)
    yield client
    await clear_redis(client, settings.redis_prefix)
    await client.aclose()


_TRUNCATE_SQL = "TRUNCATE {} RESTART IDENTITY CASCADE".format(
    ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
)


@pytest.fixture
async def clean_state(engine: AsyncEngine, redis_client: Redis) -> None:
    """Пустые таблицы (кроме строки app_settings по умолчанию) и пустой Redis сеанса."""
    async with engine.begin() as conn:
        await conn.execute(text(_TRUNCATE_SQL))
        # Значения по умолчанию у колонок те же, что вставляет миграция
        await conn.execute(text("INSERT INTO app_settings (id) VALUES (1)"))
    await clear_redis(redis_client, get_settings().redis_prefix)


@pytest.fixture
async def db(engine: AsyncEngine, clean_state: None) -> AsyncIterator[AsyncSession]:
    async with create_sessionmaker(engine)() as session:
        yield session


@pytest.fixture
async def redis(redis_client: Redis, clean_state: None) -> Redis:
    return redis_client


@pytest.fixture
def override_settings(monkeypatch: pytest.MonkeyPatch) -> SettingsOverride:
    """override_settings(hibp_enabled=True) — поле настроек меняется до конца теста."""

    def apply(**fields: Any) -> Settings:
        current = get_settings()
        for key, value in fields.items():
            assert key in Settings.model_fields, key
            monkeypatch.setattr(current, key, value)
        return current

    return apply


# --- приложение и клиенты ---

# IP каждого клиента из make_client: login пишет его в сеанс
_client_ips: "weakref.WeakKeyDictionary[httpx2.AsyncClient, str]" = weakref.WeakKeyDictionary()


def _cookie_value(cookie_header: str, name: str) -> str | None:
    for part in cookie_header.split(";"):
        key, sep, value = part.strip().partition("=")
        if sep and key == name:
            return value
    return None


def _sync_csrf_header(client: httpx2.AsyncClient) -> Any:
    """Перед запросом подставляет в X-CSRF-Token текущую cookie csrf, как фронтенд.
    Заголовок, который тест задал в самом запросе, не трогается."""

    async def hook(request: httpx2.Request) -> None:
        default = client.headers.get(CSRF_HEADER)
        if default is None or request.headers.get(CSRF_HEADER) != default:
            return
        current = _cookie_value(request.headers.get("cookie", ""), cookie_name("csrf"))
        if current and current != default:
            request.headers[CSRF_HEADER] = current
            client.headers[CSRF_HEADER] = current

    return hook


@pytest.fixture
async def app(clean_state: None) -> AsyncIterator[FastAPI]:
    application = create_app()
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def make_client(app: FastAPI, settings: Settings) -> AsyncIterator[ClientFactory]:
    """Фабрика клиентов. Каждый клиент — как отдельный браузер со своим IP и cookie."""
    clients: list[httpx2.AsyncClient] = []

    async def factory(ip: str = DEFAULT_IP, *, csrf: bool = True) -> httpx2.AsyncClient:
        transport = httpx2.ASGITransport(app=app, client=(ip, 51000))
        client = httpx2.AsyncClient(
            transport=transport,
            base_url=BASE_URL,
            headers={"Origin": settings.public_origin, "User-Agent": TEST_USER_AGENT},
        )
        if csrf:
            # Как после GET /api/auth/csrf: cookie и тот же токен в заголовке
            token = new_token()
            client.cookies.set(cookie_name("csrf"), token, domain=COOKIE_DOMAIN)
            client.headers[CSRF_HEADER] = token
            client.event_hooks["request"].append(_sync_csrf_header(client))
        _client_ips[client] = ip
        clients.append(client)
        return client

    yield factory
    for client in clients:
        await client.aclose()


@pytest.fixture
async def client(make_client: ClientFactory) -> httpx2.AsyncClient:
    return await make_client()


# --- пользователи и вход ---


@pytest.fixture
def make_user(db: AsyncSession) -> UserFactory:
    """Создает пользователя прямо в БД (без маршрутов) и делает commit."""
    counter = iter(range(1, 1_000_000))

    async def factory(
        *,
        role: str = "member",
        totp: bool = True,
        password: str = DEFAULT_PASSWORD,
        status: str = "active",
        email: str | None = None,
        display_name: str | None = None,
        ai_mode: str = "shared",
        consent_training: bool = False,
        tz: str = DEFAULT_TZ,
    ) -> MadeUser:
        n = next(counter)
        if password not in _password_hashes:
            _password_hashes[password] = hash_password(password)
        user = User(
            email=email or f"{role}{n}@example.com",
            display_name=display_name if display_name is not None else f"{role.title()} {n}",
            password_hash=_password_hashes[password],
            role=role,
            status=status,
            ai_mode=ai_mode,
            consent_training=consent_training,
            tz=tz,
        )
        db.add(user)
        await db.flush()
        secret: str | None = None
        if totp:
            secret = new_totp_secret()
            enc, version = crypto.encrypt_str(
                secret, crypto.aad_for(crypto.AAD_TOTP_SECRET, user.id)
            )
            user.totp_secret_enc = enc
            user.totp_key_version = version
            user.totp_enabled = True
        await db.commit()
        return MadeUser(user=user, password=password, totp_secret=secret)

    return factory


@pytest.fixture
def login(engine: AsyncEngine) -> LoginFn:
    """Делает клиента вошедшим: создает сеанс прямо в БД и ставит cookie сеанса.

    Так и остается, на настоящий вход не менять. Код 2FA защищен от повтора
    (users.totp_last_step, окно ±1 шаг), поэтому через маршруты один пользователь
    входит не больше двух раз за 30 секунд, и тесты с несколькими входами зависели бы
    от времени. Сами маршруты входа проверяют свои тесты (tests/test_auth_*.py, помощник
    tests/helpers_auth.py). IP сеанса — IP клиента из make_client, если не задан ip.
    """

    async def do_login(
        client: httpx2.AsyncClient, user: MadeUser | User, *, ip: str | None = None
    ) -> httpx2.AsyncClient:
        row = user.user if isinstance(user, MadeUser) else user
        async with create_sessionmaker(engine)() as session:
            new = await create_session(
                session,
                user_id=row.id,
                ip=ip or _client_ips.get(client, DEFAULT_IP),
                user_agent=client.headers.get("User-Agent"),
            )
            await session.commit()
        client.cookies.set(cookie_name("session"), new.token, domain=COOKIE_DOMAIN)
        return client

    return do_login


@pytest.fixture
def totp_code(engine: AsyncEngine) -> TotpCodeFn:
    """totp_code(user) — годный код 2FA текущего шага. Сбрасывает users.totp_last_step,
    поэтому подходит для любого числа проверок подряд (опасные действия администратора,
    повторные входы одного пользователя). current_totp() без сброса годится только
    дважды за 30 секунд."""

    async def make(user: MadeUser) -> str:
        async with create_sessionmaker(engine)() as session:
            await session.execute(
                update(User).where(User.id == user.id).values(totp_last_step=None)
            )
            await session.commit()
        return user.current_totp()

    return make


@pytest.fixture
def suspend_plus(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ф(+1.5) на проверке: механизм SUSPENDED_MARKETS (сейчас список пуст) проверяется
    на этом рынке. Имя импортировано в нескольких модулях — подменяется в каждом."""
    from app.ml import strategy, variants
    from app.services import analysis_result, analysis_view

    markets = frozenset({"HCP_+1.5"})
    for module in (strategy, variants, analysis_result, analysis_view):
        monkeypatch.setattr(module, "SUSPENDED_MARKETS", markets)
