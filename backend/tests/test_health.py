import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx2
import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.db.session import create_engine
from app.services import health as health_service
from tests.support import ClientFactory, create_database, drop_database, temp_database_url


@asynccontextmanager
async def temp_db(settings: Settings, label: str) -> AsyncIterator[str]:
    """Пустая временная база без миграций."""
    name = f"capper_test_{label}_{os.getpid()}_{secrets.token_hex(3)}"
    await create_database(settings.test_admin_database_url, name)
    try:
        yield temp_database_url(settings.test_admin_database_url, name)
    finally:
        await drop_database(settings.test_admin_database_url, name)


async def test_health_ok(client: httpx2.AsyncClient) -> None:
    response = await client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["db"] == "ok"
    assert body["redis"] == "ok"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_health_degraded_without_details(
    client: httpx2.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken(*args: object) -> bool:
        return False

    monkeypatch.setattr(health_service, "check_redis", broken)
    response = await client.get("/api/health")
    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "version": response.json()["version"],
        "db": "ok",
        "redis": "fail",
    }


async def test_health_without_csrf_for_any_method(make_client: ClientFactory) -> None:
    # Проверка здоровья не требует CSRF-токена даже для POST (метода нет — 405, но не 403)
    plain = await make_client(csrf=False)
    response = await plain.post("/api/health")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "common.method_not_allowed"


async def test_database_without_migrations_is_not_healthy(settings: Settings) -> None:
    """Пустая база (миграции не применены): /api/health не должен отвечать ok."""
    async with temp_db(settings, "health") as url:
        engine = create_engine(url)
        try:
            async with AsyncSession(engine) as db:
                assert await health_service.check_database(db) is False
                await db.rollback()
                await db.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
                assert await health_service.check_database(db) is False
                await db.execute(text("INSERT INTO alembic_version VALUES ('0001')"))
                assert await health_service.check_database(db) is True
        finally:
            await engine.dispose()
