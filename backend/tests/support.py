"""Типы, константы и помощники для тестов. Фикстуры — в conftest.py, здесь то,
что тесты импортируют явно:

    from tests.support import ClientFactory, LoginFn, MadeUser, SettingsOverride, UserFactory

Помощники для баз данных (create_database, drop_database, temp_database_url,
alembic_config) нужны тестам миграций, которым требуется своя чистая база.
"""

import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import asyncpg
import httpx2
from alembic import command
from alembic.config import Config
from redis.asyncio import Redis
from sqlalchemy.engine import Connection, make_url

from app.core.config import Settings
from app.core.security.totp import code_at_step, current_step
from app.db.models import DEFAULT_TZ, User

BACKEND_DIR = Path(__file__).resolve().parent.parent
BASE_URL = "http://capper.test"
COOKIE_DOMAIN = "capper.test"
DEFAULT_IP = "10.0.0.1"
DEFAULT_PASSWORD = "correct-horse-battery-staple"
TEST_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
)


@dataclass
class MadeUser:
    """Пользователь из make_user: строка БД, пароль в открытом виде и секрет 2FA."""

    user: User
    password: str
    totp_secret: str | None

    @property
    def id(self) -> int:
        return self.user.id

    @property
    def email(self) -> str:
        return self.user.email

    def current_totp(self, offset_steps: int = 0) -> str:
        """Код 2FA на текущем шаге (offset_steps=1 — следующий: для второго входа подряд)."""
        assert self.totp_secret is not None, "у пользователя нет 2FA"
        return code_at_step(self.totp_secret, current_step() + offset_steps)


class ClientFactory(Protocol):
    async def __call__(self, ip: str = DEFAULT_IP, *, csrf: bool = True) -> httpx2.AsyncClient: ...


class UserFactory(Protocol):
    async def __call__(
        self,
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
    ) -> MadeUser: ...


class LoginFn(Protocol):
    async def __call__(
        self, client: httpx2.AsyncClient, user: MadeUser | User, *, ip: str | None = None
    ) -> httpx2.AsyncClient: ...


# totp_code(user): годный код 2FA для любого числа проверок подряд (см. conftest.totp_code)
TotpCodeFn = Callable[[MadeUser], Awaitable[str]]

# override_settings(hibp_enabled=True): поменять поля настроек до конца теста
SettingsOverride = Callable[..., Settings]


# --- базы данных для тестов ---


def run_alembic_upgrade(connection: Connection, revision: str = "head") -> None:
    """alembic upgrade в уже открытом соединении (см. alembic/env.py)."""
    config = alembic_config(connection)
    command.upgrade(config, revision)


def alembic_config(connection: Connection) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    config.attributes["connection"] = connection
    config.attributes["configure_logger"] = False
    return config


# Временные базы тестов: capper_test_<pid>_<hex> и capper_test_<метка>_<pid>_<hex>
_TEST_DB_NAME = re.compile(r"^capper_test_(?:[a-z]+_)?(\d+)_[0-9a-f]+$")


def temp_database_url(admin_url: str, name: str) -> str:
    """Адрес временной базы для asyncpg на том же сервере и с той же учетной записью,
    что служебный адрес CAPPER_TEST_ADMIN_DATABASE_URL, через который база создается."""
    url = make_url(admin_url).set(drivername="postgresql+asyncpg", database=name)
    return url.render_as_string(hide_password=False)


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def drop_stale_test_databases(admin_url: str) -> list[str]:
    """Удаляет временные базы тестов, процесс которых уже завершился (его убили SIGTERM
    или SIGKILL, и удалить свою базу он не успел). Базу с открытыми соединениями
    не трогает. Тесты и PostgreSQL на одной машине, поэтому pid из имени базы проверяется
    здесь же."""
    conn = await asyncpg.connect(admin_url)
    try:
        rows = await conn.fetch(
            "SELECT d.datname FROM pg_database d WHERE NOT EXISTS"
            " (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)"
        )
        dropped: list[str] = []
        for row in rows:
            name = str(row["datname"])
            match = _TEST_DB_NAME.match(name)
            if match is None:
                continue
            pid = int(match.group(1))
            if pid == os.getpid() or _process_alive(pid):
                continue
            await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            dropped.append(name)
        return dropped
    finally:
        await conn.close()


async def create_database(admin_url: str, name: str) -> None:
    conn = await asyncpg.connect(admin_url)
    try:
        await conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await conn.close()


async def drop_database(admin_url: str, name: str) -> None:
    conn = await asyncpg.connect(admin_url)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    finally:
        await conn.close()


async def clear_redis(client: Redis, prefix: str) -> None:
    keys = [key async for key in client.scan_iter(match=prefix + "*", count=500)]
    if keys:
        await client.delete(*keys)
