"""Миграции: схема на месте, строка app_settings есть, upgrade → downgrade → upgrade
проходит, и после upgrade модели не расходятся с базой. Миграция этапа 2 сохраняет
данные этапа 1 (турниры старого бота получают source = legacy), миграция этапа 3 —
данные этапа 2 (откат переводит новые статусы анализов в старые и не теряет строк).

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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from app.core.config import Settings
from app.db.base import Base
from app.db.session import create_engine
from tests.support import (
    BACKEND_DIR,
    alembic_config,
    create_database,
    drop_database,
    run_alembic_upgrade,
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
    "match_assessments",
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
    assert len(EXPECTED_TABLES) == 34
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


def _alembic_downgrade(connection: Connection, revision: str) -> None:
    command.downgrade(alembic_config(connection), revision)


async def _refused(conn: AsyncConnection, sql: str) -> bool:
    """Запрос нарушает ограничение базы (UNIQUE или CHECK)."""
    savepoint = await conn.begin_nested()
    try:
        await conn.execute(text(sql))
    except IntegrityError:
        await savepoint.rollback()
        return True
    await savepoint.rollback()
    return False


async def test_stage2_migration_keeps_stage1_data(settings: Settings) -> None:
    """0001 → 0002: турниры старого бота получают source = legacy; новые ограничения
    действуют; откат до 0001 сохраняет журнал, убирает только кэфы из архива и хеши
    файлов архивов (следующая загрузка разберет файлы заново); повторный upgrade не
    выдает турниры архива за турниры бота."""
    async with _temp_database(settings, "stage") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0001")
                await conn.execute(
                    text(
                        "INSERT INTO tournaments (name, start_date) VALUES"
                        " ('Уимблдон', '2025-06-30'), ('Рим', '2025-05-07')"
                    )
                )
                await conn.execute(
                    text("INSERT INTO players (name) VALUES ('Sinner J.'), ('Alcaraz C.')")
                )
                await conn.execute(
                    text(
                        "INSERT INTO matches (tournament_id, round, player1_id, player2_id,"
                        " source, source_ref) VALUES (1, '', 1, 2, 'legacy', 'b1')"
                    )
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                rows = (
                    await conn.execute(
                        text("SELECT name, source, source_ref FROM tournaments ORDER BY id")
                    )
                ).all()
                assert [tuple(r) for r in rows] == [
                    ("Уимблдон", "legacy", None),
                    ("Рим", "legacy", None),
                ]
                assert await conn.scalar(text("SELECT match_date FROM matches")) is None

                await conn.execute(
                    text(
                        "INSERT INTO tournaments (name, source, source_ref)"
                        " VALUES ('Wimbledon', 'sackmann', '2025-540')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO matches (tournament_id, round, player1_id, player2_id,"
                        " source, source_ref) SELECT id, 'F', 1, 2, 'sackmann', '2025-540-701'"
                        " FROM tournaments WHERE source = 'sackmann'"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO ingestion_runs (source, status, details) VALUES"
                        """ ('sackmann', 'ok', '{"files": {"a.csv": "h1"}, "created": 1}'),"""
                        """ ('legacy', 'ok', '{"files": {"b.xlsx": "h2"}}')"""
                    )
                )
                assert await _refused(
                    conn,
                    "INSERT INTO tournaments (name, source, source_ref)"
                    " VALUES ('Wimbledon', 'sackmann', '2025-540')",
                )
                assert await _refused(
                    conn, "INSERT INTO tournaments (name, source) VALUES ('X', 'atp')"
                )
                # Пустой source_ref у legacy не мешает: NULL в UNIQUE не равны друг другу
                assert not await _refused(
                    conn, "INSERT INTO tournaments (name, source) VALUES ('Y', 'legacy')"
                )

                odds = (
                    "INSERT INTO odds_snapshots (match_id, market, selection, bookmaker, odds,"
                    " kind) VALUES (1, 'ML', 1, 'pinnacle', {odds}, '{kind}')"
                )
                await conn.execute(text(odds.format(odds="1.5", kind="archive")))
                await conn.execute(text(odds.format(odds="1.6", kind="user")))
                # Второй кэф архива на тот же исход и букмекера — нельзя, других видов — можно
                assert await _refused(conn, odds.format(odds="1.7", kind="archive"))
                assert not await _refused(conn, odds.format(odds="1.7", kind="user"))
                assert await _refused(conn, odds.format(odds="1.7", kind="guess"))
                for action in ("confirm_failed", "player_merge", "player_edit"):
                    await conn.execute(
                        text(f"INSERT INTO admin_audit_log (action) VALUES ('{action}')")
                    )
                assert await _refused(conn, "INSERT INTO admin_audit_log (action) VALUES ('hack')")

            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0001")
            async with engine.begin() as conn:
                kinds = (await conn.execute(text("SELECT kind FROM odds_snapshots"))).scalars()
                assert list(kinds) == ["user"]
                actions = await conn.execute(text("SELECT action FROM admin_audit_log ORDER BY id"))
                assert list(actions.scalars()) == ["confirm_failed", "player_merge", "player_edit"]
                # Новые записи — только со старыми действиями
                assert await _refused(
                    conn, "INSERT INTO admin_audit_log (action) VALUES ('confirm_failed')"
                )
                columns = await conn.run_sync(
                    lambda sync: {c["name"] for c in inspect(sync).get_columns("tournaments")}
                )
                assert "source" not in columns and "source_ref" not in columns
                details = await conn.execute(
                    text("SELECT source, details FROM ingestion_runs ORDER BY id")
                )
                assert [tuple(r) for r in details] == [
                    ("sackmann", {"created": 1}),
                    ("legacy", {"files": {"b.xlsx": "h2"}}),
                ]
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
                assert await conn.scalar(text("SELECT count(*) FROM admin_audit_log")) == 3
                rows = (
                    await conn.execute(
                        text("SELECT name, source, source_ref FROM tournaments ORDER BY id")
                    )
                ).all()
                assert [tuple(r) for r in rows] == [
                    ("Уимблдон", "legacy", None),
                    ("Рим", "legacy", None),
                    ("Wimbledon", None, None),
                ]
        finally:
            await engine.dispose()


async def test_stage3_migration_keeps_stage2_data(settings: Settings) -> None:
    """0002 → 0003: старые анализы и уведомления остаются, новые колонки получают значения
    по умолчанию, цены моделей на месте. Новые ограничения действуют. Откат до 0002
    не оставляет строк, которые старые ограничения не дали бы обновить: новые статусы
    анализов — в старые, уведомления новых видов и результаты из поиска удаляются, матчи
    и турниры из ввода — в источники этапа 2, журнал администратора остается как есть.
    Повторный upgrade не дублирует цены и возвращает вторую ступень цены Haiku 5.5."""
    async with _temp_database(settings, "stage3") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0002")
                await conn.execute(
                    text("INSERT INTO users (email) VALUES ('m@example.com'), ('o@example.com')")
                )
                await conn.execute(
                    text(
                        "INSERT INTO analyses (user_id, input_text, status) VALUES"
                        " (1, 'Синнер — Алькарас 1.80', 'done')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO ai_limits (user_id, monthly_usd, daily_analyses,"
                        " per_analysis_usd) VALUES (1, 10, 3, 1)"
                    )
                )
                await conn.execute(
                    text("INSERT INTO players (name) VALUES ('Sinner J.'), ('Alcaraz C.')")
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                row = (
                    (
                        await conn.execute(
                            text(
                                "SELECT status, input_kind, attempt, checkpoint, cost_usd,"
                                " budget_reserved_usd, key_source, started_at FROM analyses"
                            )
                        )
                    )
                    .mappings()
                    .one()
                )
                assert dict(row) == {
                    "status": "done",
                    "input_kind": "text",
                    "attempt": 0,
                    "checkpoint": {},
                    "cost_usd": Decimal("0"),
                    "budget_reserved_usd": Decimal("0"),
                    "key_source": None,
                    "started_at": None,
                }
                limit = await conn.scalar(text("SELECT own_per_analysis_usd FROM ai_limits"))
                assert limit == Decimal("1.00")
                app = (
                    (
                        await conn.execute(
                            text(
                                "SELECT agent_config, budget_alert_pct, eval_budget_usd"
                                " FROM app_settings"
                            )
                        )
                    )
                    .mappings()
                    .one()
                )
                assert dict(app) == {
                    "agent_config": {},
                    "budget_alert_pct": 80,
                    "eval_budget_usd": Decimal("25.00"),
                }
                prices = (
                    await conn.execute(
                        text(
                            "SELECT model, input, output, cache_read, cache_write_5m,"
                            " cache_write_1h, search_price, long_input_threshold,"
                            " long_multiplier FROM model_prices ORDER BY model"
                        )
                    )
                ).all()
                assert [tuple(p) for p in prices] == [
                    (
                        "claude-haiku-4-5",
                        Decimal("1.0000"),
                        Decimal("5.0000"),
                        Decimal("0.1000"),
                        Decimal("1.2500"),
                        Decimal("2.0000"),
                        Decimal("0.0100"),
                        None,
                        None,
                    ),
                    (
                        "claude-haiku-5-5",
                        Decimal("0.1000"),
                        Decimal("0.5000"),
                        Decimal("0.0100"),
                        Decimal("0.1250"),
                        Decimal("0.2000"),
                        Decimal("0.0100"),
                        100000,
                        Decimal("5.00"),
                    ),
                    (
                        "claude-opus-5-5",
                        Decimal("4.0000"),
                        Decimal("20.0000"),
                        Decimal("0.2000"),
                        Decimal("5.0000"),
                        Decimal("8.0000"),
                        Decimal("0.0100"),
                        None,
                        None,
                    ),
                    (
                        "claude-sonnet-5-5",
                        Decimal("2.0000"),
                        Decimal("10.0000"),
                        Decimal("0.1000"),
                        Decimal("2.5000"),
                        Decimal("4.0000"),
                        Decimal("0.0100"),
                        None,
                        None,
                    ),
                ]

                for status in ("needs_confirmation", "modelling", "parsing"):
                    await conn.execute(
                        text(
                            "INSERT INTO analyses (user_id, input_text, status)"
                            f" VALUES (1, 'x', '{status}')"
                        )
                    )
                assert await _refused(
                    conn,
                    "INSERT INTO analyses (user_id, input_text, status) VALUES (1, 'x', 'hack')",
                )
                assert await _refused(
                    conn, "UPDATE analyses SET budget_reserved_usd = -1 WHERE id = 1"
                )
                assert await _refused(conn, "UPDATE analyses SET key_source = 'guest'")
                assert await _refused(conn, "UPDATE ai_limits SET own_per_analysis_usd = 0")
                assert await _refused(conn, "UPDATE app_settings SET budget_alert_pct = 75")
                # Матч из ввода участника: без турнира, но с source_ref; турнир из ввода
                await conn.execute(
                    text(
                        "INSERT INTO matches (player1_id, player2_id, source, source_ref)"
                        " VALUES (1, 2, 'user', 'user:2026-10-14:1:2')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO tournaments (name, source, source_ref)"
                        " VALUES ('Кубок Кремля', 'user', 'user:2026:kremlin')"
                    )
                )
                assert await _refused(
                    conn,
                    "INSERT INTO matches (player1_id, player2_id, source) VALUES (1, 2, 'user')",
                )
                await conn.execute(
                    text(
                        "INSERT INTO player_news (player_id, published_at, kind, summary,"
                        " source_url, details) VALUES (1, now(), 'result', 'Победа 6:3 6:4',"
                        """ 'https://www.atptour.com/x', '{"score": "6-3 6-4"}')"""
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO notifications (user_id, kind, title)"
                        " VALUES (1, 'budget_80', 'Бюджет'), (1, 'admin_message', 'Привет')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO admin_audit_log (action, target_user_id)"
                        " VALUES ('agent_config_change', NULL), ('ai_mode_change', 2)"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO dossiers (match_id, as_of, content, sha256, feature_set)"
                        " VALUES (1, now(), '{}', repeat('a', 64), 'd1')"
                    )
                )
                assessment = (
                    "INSERT INTO match_assessments (dossier_id, model, effort, prompt_version,"
                    " schema_version, output) VALUES (1, 'claude-opus-5-5', 'medium',"
                    " 'analysis.v1', 'a1', '{}')"
                )
                await conn.execute(text(assessment))
                # Оценка с тем же ключом (досье, модель, effort, версии) — одна
                assert await _refused(conn, assessment)

            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0002")
            async with engine.begin() as conn:
                statuses = await conn.execute(text("SELECT status FROM analyses ORDER BY id"))
                assert list(statuses.scalars()) == ["done", "created", "running", "created"]
                kinds = await conn.execute(text("SELECT kind FROM notifications"))
                assert list(kinds.scalars()) == ["admin_message"]
                assert await conn.scalar(text("SELECT count(*) FROM player_news")) == 0
                match = (await conn.execute(text("SELECT source, source_ref FROM matches"))).one()
                assert tuple(match) == ("web", "user:2026-10-14:1:2")
                source = await conn.scalar(
                    text("SELECT source FROM tournaments WHERE name = 'Кубок Кремля'")
                )
                assert source is None
                actions = await conn.execute(text("SELECT action FROM admin_audit_log ORDER BY id"))
                assert list(actions.scalars()) == ["agent_config_change", "ai_mode_change"]
                # Код этапа 2 обновляет оставшиеся строки: отметка «прочитано», матч,
                # удаление участника (SET NULL в журнале)
                for sql in (
                    "UPDATE notifications SET read_at = now()",
                    "UPDATE matches SET status = 'finished'",
                    "UPDATE tournaments SET city = 'Москва'",
                    "DELETE FROM users WHERE id = 2",
                ):
                    assert not await _refused(conn, sql), sql
                # Новые строки — только со старыми значениями (кроме журнала администратора)
                assert await _refused(
                    conn,
                    "INSERT INTO notifications (user_id, kind, title)"
                    " VALUES (1, 'budget_100', 'x')",
                )
                assert await _refused(
                    conn,
                    "INSERT INTO analyses (user_id, input_text, status)"
                    " VALUES (1, 'x', 'modelling')",
                )
                assert await _refused(
                    conn,
                    "INSERT INTO matches (player1_id, player2_id, source, source_ref)"
                    " VALUES (1, 2, 'user', 'user:x')",
                )
                news = (
                    "INSERT INTO player_news (player_id, published_at, kind, summary, source_url)"
                    " VALUES (1, now(), '{kind}', 'x', 'https://www.atptour.com/y')"
                )
                assert await _refused(conn, news.format(kind="result"))
                assert not await _refused(conn, news.format(kind="injury"))
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
                assert await conn.scalar(text("SELECT count(*) FROM model_prices")) == 4
                threshold = await conn.scalar(
                    text(
                        "SELECT long_input_threshold FROM model_prices"
                        " WHERE model = 'claude-haiku-5-5'"
                    )
                )
                assert threshold == 100000
        finally:
            await engine.dispose()
