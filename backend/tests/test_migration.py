"""Миграции: схема на месте, строка app_settings есть, upgrade → downgrade → upgrade
проходит, и после upgrade модели не расходятся с базой.

Расхождение моделей и миграции ловится двумя способами:
- compare_metadata, как alembic check: таблицы, колонки, типы, DEFAULT, индексы, FK;
- сверка каталога PostgreSQL двух баз, после alembic upgrade head и после
  Base.metadata.create_all: так видны CHECK и условия частичных индексов, которые
  alembic не сравнивает.
"""

import asyncio
import os
import secrets
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from decimal import Decimal
from typing import Any

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncEngine

from app.core.config import Settings
from app.db.base import Base
from app.db.session import create_engine
from tests.support import (
    BACKEND_DIR,
    alembic_config,
    create_database,
    drop_database,
    temp_database_url,
)

EXPECTED_TABLES = {
    "users",
    "sessions",
    "trusted_devices",
    "recovery_codes",
    "login_events",
    "access_codes",
    "user_secrets",
    "app_settings",
    "ai_limits",
    "notifications",
    "push_subscriptions",
    "admin_audit_log",
    "players",
    "player_profiles",
    "player_ratings",
    "player_news",
    "tournaments",
    "matches",
    "match_stats",
    "odds_snapshots",
    "dossiers",
    "analyses",
    "predictions",
    "bets",
    "bet_legs",
    "bankroll_ledger",
    "strategy_versions",
    "lessons",
    "ml_models",
    "eval_runs",
    "agent_runs",
    "model_prices",
    "ingestion_runs",
}


def _table_names(connection: Connection) -> set[str]:
    return set(inspect(connection).get_table_names())


async def test_all_tables_exist(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        names = await conn.run_sync(_table_names)
        extension = (
            await conn.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"))
        ).scalar()
    assert len(EXPECTED_TABLES) == 33
    assert names == EXPECTED_TABLES | {"alembic_version"}
    assert set(Base.metadata.tables) == EXPECTED_TABLES
    assert extension == 1


@asynccontextmanager
async def _temp_database(settings: Settings, label: str) -> AsyncIterator[str]:
    """Пустая временная база на время блока. Возвращает ее адрес для asyncpg."""
    name = f"capper_test_{label}_{os.getpid()}_{secrets.token_hex(3)}"
    await create_database(settings.test_admin_database_url, name)
    try:
        yield temp_database_url(settings.test_admin_database_url, name)
    finally:
        await drop_database(settings.test_admin_database_url, name)


def _alembic_cli_upgrade(url: str) -> None:
    """alembic upgrade head отдельным процессом, как при деплое: env.py без готового
    соединения, свой цикл событий и адрес из CAPPER_DATABASE_URL."""
    env = {**os.environ, "CAPPER_DATABASE_URL": url}
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr[-2000:]


_CATALOG_QUERIES = {
    "columns": """
        SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
               a.attidentity, pg_get_expr(d.adbin, d.adrelid)
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped AND c.relname <> 'alembic_version'
    """,
    "constraints": """
        SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE connamespace = 'public'::regnamespace
          AND conrelid::regclass::text <> 'alembic_version'
    """,
    "indexes": """
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename <> 'alembic_version'
    """,
}


async def _catalog(engine: AsyncEngine) -> dict[str, set[tuple[Any, ...]]]:
    """Колонки, ограничения (с текстом CHECK) и индексы (с условием WHERE) схемы public."""
    async with engine.connect() as conn:
        return {
            kind: {tuple(row) for row in (await conn.execute(text(sql))).all()}
            for kind, sql in _CATALOG_QUERIES.items()
        }


def _upgrade_downgrade_upgrade_and_compare(connection: Connection) -> list[object]:
    config = alembic_config(connection)
    command.downgrade(config, "base")
    assert _table_names(connection) == {"alembic_version"}
    command.upgrade(config, "head")
    context = MigrationContext.configure(
        connection, opts={"compare_type": True, "compare_server_default": True}
    )
    diff: list[object] = list(compare_metadata(context, Base.metadata))
    return diff


async def test_migration_roundtrip_and_no_drift(settings: Settings) -> None:
    async with (
        _temp_database(settings, "mig") as migrated_url,
        _temp_database(settings, "meta") as metadata_url,
    ):
        await asyncio.to_thread(_alembic_cli_upgrade, migrated_url)
        migrated = create_engine(migrated_url)
        from_metadata = create_engine(metadata_url)
        try:
            # Строку app_settings вставляет сама миграция; значения — из решений Р9, Р13, Р17
            async with migrated.connect() as conn:
                row = (
                    (
                        await conn.execute(
                            text(
                                "SELECT id, currency, monthly_budget_usd,"
                                " default_member_limit_usd, default_daily_analyses,"
                                " per_analysis_soft_usd, per_analysis_hard_usd,"
                                " anthropic_key_enc FROM app_settings"
                            )
                        )
                    )
                    .mappings()
                    .all()
                )
            assert [dict(r) for r in row] == [
                {
                    "id": 1,
                    "currency": "RUB",
                    "monthly_budget_usd": Decimal("60.00"),
                    "default_member_limit_usd": Decimal("10.00"),
                    "default_daily_analyses": 3,
                    "per_analysis_soft_usd": Decimal("0.50"),
                    "per_analysis_hard_usd": Decimal("1.00"),
                    "anthropic_key_enc": None,
                }
            ]

            async with migrated.begin() as conn:
                diff = await conn.run_sync(_upgrade_downgrade_upgrade_and_compare)
            assert diff == []

            async with from_metadata.begin() as conn:
                await conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
                await conn.run_sync(Base.metadata.create_all)
            expected = await _catalog(from_metadata)
            actual = await _catalog(migrated)
        finally:
            await migrated.dispose()
            await from_metadata.dispose()
    for kind in _CATALOG_QUERIES:
        assert actual[kind] == expected[kind], (
            kind,
            sorted(actual[kind] - expected[kind]),
            sorted(expected[kind] - actual[kind]),
        )


def _migrate_service(url: str) -> subprocess.CompletedProcess[str]:
    """python -m app.db.migrate отдельным процессом, как сервис migrate в compose."""
    env = {**os.environ, "CAPPER_DATABASE_URL": url}
    return subprocess.run(
        [sys.executable, "-m", "app.db.migrate"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


async def test_migrate_service_creates_schema_and_skips_newer_database(
    settings: Settings,
) -> None:
    """Сервис migrate: на пустой базе создает схему (docker compose up с нуля), повторный
    запуск ничего не делает, а базу со схемой новее кода (после отката deploy.sh) не
    трогает и не мешает запуску api."""
    async with _temp_database(settings, "svc") as url:
        first = await asyncio.to_thread(_migrate_service, url)
        assert first.returncode == 0, first.stderr[-2000:]
        engine = create_engine(url)
        try:
            async with engine.connect() as conn:
                assert await conn.run_sync(_table_names) >= EXPECTED_TABLES
                head = await conn.scalar(text("SELECT version_num FROM alembic_version"))
            again = await asyncio.to_thread(_migrate_service, url)
            assert again.returncode == 0, again.stderr[-2000:]

            async with engine.begin() as conn:
                await conn.execute(text("UPDATE alembic_version SET version_num = '9999_future'"))
            newer = await asyncio.to_thread(_migrate_service, url)
            assert newer.returncode == 0, newer.stderr[-2000:]
            assert "9999_future" in newer.stderr
            async with engine.connect() as conn:
                kept = await conn.scalar(text("SELECT version_num FROM alembic_version"))
            assert kept == "9999_future" and head != kept
        finally:
            await engine.dispose()
