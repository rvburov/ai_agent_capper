"""Подключение к PostgreSQL: асинхронный движок и фабрика сеансов.

В веб-приложении движок создается в lifespan (app.main), сеанс на запрос дает
зависимость deps.get_db. Командам терминала, импорту и воркерам — get_session().

Правило транзакций: сервис, который выполняет действие целиком, сам вызывает commit().
Вспомогательные функции сервисов делают только flush(). Маршрут commit не вызывает.
expire_on_commit=False: после commit объекты можно читать без нового запроса к БД.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.ext.asyncio import create_async_engine as _create_async_engine

from app.core.config import get_settings


def create_engine(url: str | None = None, *, echo: bool = False) -> AsyncEngine:
    return _create_async_engine(
        url or get_settings().database_url,
        echo=echo,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        # Параметры запросов (хеши паролей, email, IP) не попадают в текст ошибок и в логи
        hide_parameters=True,
    )


def create_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


@asynccontextmanager
async def get_session(url: str | None = None) -> AsyncIterator[AsyncSession]:
    """Сеанс БД со своим движком: для команд терминала, импорта и скриптов.

    async with get_session() as db:
        ...
        await db.commit()
    """
    engine = create_engine(url)
    try:
        async with create_sessionmaker(engine)() as session:
            yield session
    finally:
        await engine.dispose()
