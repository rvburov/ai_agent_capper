"""Миграции: схема на месте, строка app_settings есть, upgrade → downgrade → upgrade
проходит, и после upgrade модели не расходятся с базой. Миграция этапа 2 сохраняет
данные этапа 1 (турниры старого бота получают source = legacy), миграция этапа 3 —
данные этапа 2 (откат переводит новые статусы анализов в старые и не теряет строк),
миграция этапа 4 — данные этапа 3 (история бота помечена, букмекеры собраны из ставок,
правила роста ставки выключены у версий в работе), миграция этапа 5 — данные этапа 4
(версии модели, общие уроки и версии инструкций, новые виды уведомлений и журнала),
миграция этапа 6 — тихие часы и push по умолчанию у прежних строк.

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
    "player_elo_current",
    "bookmakers",
    "notification_prefs",
    "play_limits",
    "data_uploads",
    "batch_jobs",
    "postmortems",
    "eval_sets",
    "eval_set_items",
    "eval_comparisons",
    "weekly_reports",
    # Этап 5, волна 2 (0009): «сообщить, когда наберется»
    "lesson_watches",
}


def _table_names(connection: Connection) -> set[str]:
    return set(inspect(connection).get_table_names())


async def test_all_tables_exist(engine: AsyncEngine) -> None:
    async with engine.connect() as conn:
        names = await conn.run_sync(_table_names)
        extension = (
            await conn.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'"))
        ).scalar()
    assert len(EXPECTED_TABLES) == 46
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


async def test_stage4_migration_keeps_stage3_data(settings: Settings) -> None:
    """0003 → 0004: ставки и ноги старого бота помечены legacy (рассчитанные), букмекеры
    собраны из ставок и анализов участника (одно название без учета регистра), у версий
    стратегии в работе выключены «рост ставки» и «прибыльная неделя» (В7), архивные
    версии не тронуты. Новые ограничения действуют. Откат до 0003 удаляет уведомления
    ai_alert и не теряет ставок; повторный upgrade проходит."""
    async with _temp_database(settings, "stage4") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0003")
                await conn.execute(
                    text("INSERT INTO users (email) VALUES ('m@example.com'), ('o@example.com')")
                )
                await conn.execute(
                    text("INSERT INTO players (name) VALUES ('Sinner J.'), ('Alcaraz C.')")
                )
                await conn.execute(
                    text(
                        "INSERT INTO matches (player1_id, player2_id, source, source_ref)"
                        " VALUES (1, 2, 'legacy', 'b1')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bets (user_id, placed_at, bookmaker, stake, currency,"
                        " total_odds, status, profit, settled_at, source, source_ref) VALUES"
                        " (1, '2026-05-01', 'Fonbet', 100, 'RUB', 1.8, 'won', 80,"
                        " '2026-05-01', 'legacy', 'r1'),"
                        " (1, '2026-05-02', ' fonbet ', 100, 'RUB', 1.8, 'open', NULL,"
                        " NULL, 'legacy', 'r2'),"
                        " (1, '2026-10-01', 'Pari', 100, 'RUB', 1.8, 'open', NULL, NULL,"
                        " 'app', 'c1'),"
                        " (2, '2026-10-01', 'Fonbet', 50, 'RUB', 2, 'lost', -50,"
                        " '2026-10-02', 'app', 'c2'),"
                        " (2, '2026-10-03', 'Fonbet', 10, 'RUB', 2, 'open', NULL, NULL,"
                        " 'app', 'c3')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bet_legs (bet_id, match_id, market, selection, odds_taken,"
                        " result) VALUES (1, 1, 'ML', 1, 1.8, 'win'), (2, 1, 'ML', 2, 1.8, NULL),"
                        " (4, 1, 'ML', 1, 2, 'loss')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO analyses (user_id, input_text, status, bookmaker)"
                        " VALUES (1, 'x', 'done', 'Winline'), (1, 'y', 'done', 'PARI'),"
                        " (2, 'a', 'done', 'Fonbet'), (2, 'b', 'done', 'Fonbet'),"
                        " (2, 'c', 'done', 'FONBET'), (2, 'd', 'done', 'FONBET'),"
                        " (2, 'e', 'done', 'FONBET')"
                    )
                )
                adapt = (
                    '{"adapt": {"dd10": true, "dd20": true, "up15": true,'
                    ' "week_loss": true, "week_win": true}, "max_pct": "0.03"}'
                )
                await conn.execute(
                    text(
                        "INSERT INTO strategy_versions (user_id, code, status, params) VALUES"
                        f" (1, 'v3', 'active', '{adapt}'), (1, 'v2', 'archived', '{adapt}'),"
                        " (2, 'v3', 'candidate', '{}'), (1, 'legacy', 'archived', '{}')"
                    )
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                bets = await conn.execute(text("SELECT id, settled_by FROM bets ORDER BY id"))
                assert [tuple(row) for row in bets] == [
                    (1, "legacy"),
                    (2, None),
                    (3, None),
                    (4, None),
                    (5, None),
                ]
                legs = await conn.execute(
                    text(
                        "SELECT bet_id, result_source, settled_at, score, closing_source"
                        " FROM bet_legs ORDER BY id"
                    )
                )
                rows = [tuple(row) for row in legs]
                assert [row[:2] for row in rows] == [(1, "legacy"), (2, None), (4, None)]
                assert rows[0][2] is not None and rows[1][2] is None
                assert all(row[3] is None and row[4] is None for row in rows)
                books = await conn.execute(
                    text("SELECT user_id, name FROM bookmakers ORDER BY user_id, lower(name)")
                )
                # «Fonbet» и « fonbet » — один букмекер; «Pari» и «PARI» — тоже
                found = [tuple(row) for row in books]
                assert [row[0] for row in found] == [1, 1, 1, 2]
                assert {row[1].lower() for row in found if row[0] == 1} == {
                    "fonbet",
                    "pari",
                    "winline",
                }
                # Написание — самое частое по ставкам и анализам вместе (Fonbet: 2 + 2 против
                # FONBET: 3), добавлен — при первом упоминании в любом из источников
                second = await conn.execute(
                    text(
                        "SELECT name, created_at = (SELECT placed_at FROM bets"
                        " WHERE source_ref = 'c2') FROM bookmakers WHERE user_id = 2"
                    )
                )
                assert [tuple(row) for row in second] == [("Fonbet", True)]
                first_pari = await conn.scalar(
                    text(
                        "SELECT created_at = (SELECT placed_at FROM bets WHERE source_ref = 'c1')"
                        " FROM bookmakers WHERE user_id = 1 AND lower(name) = 'pari'"
                    )
                )
                assert first_pari is True
                versions = await conn.execute(
                    text(
                        "SELECT code, user_id, params -> 'adapt' FROM strategy_versions ORDER BY id"
                    )
                )
                adapt_by = {(row[0], row[1]): row[2] for row in versions}
                assert adapt_by[("v3", 1)] == {
                    "dd10": True,
                    "dd20": True,
                    "up15": False,
                    "week_loss": True,
                    "week_win": False,
                }
                assert adapt_by[("v2", 1)]["up15"] is True
                assert adapt_by[("v3", 2)] == {"up15": False, "week_win": False}
                assert adapt_by[("legacy", 1)] is None
                default_tz = await conn.scalar(text("SELECT default_tz FROM app_settings"))
                assert default_tz == "Europe/Helsinki"

                await conn.execute(
                    text(
                        "INSERT INTO notifications (user_id, kind, title)"
                        " VALUES (1, 'ai_alert', 'Доля кэша'), (1, 'new_device', 'Вход')"
                    )
                )
                await conn.execute(
                    text("INSERT INTO notification_prefs (user_id, kind) VALUES (1, 'ai_alert')")
                )
                await conn.execute(
                    text(
                        "INSERT INTO play_limits (user_id, bets_per_day, stake_per_day, currency)"
                        " VALUES (1, 3, 1000, 'RUB')"
                    )
                )
                for sql in (
                    "INSERT INTO bookmakers (user_id, name) VALUES (1, 'WINLINE')",
                    "INSERT INTO notification_prefs (user_id, kind) VALUES (1, 'hack')",
                    "INSERT INTO play_limits (user_id, bets_per_day) VALUES (2, 21)",
                    "INSERT INTO play_limits (user_id, stake_per_day) VALUES (2, 100)",
                    "UPDATE bet_legs SET q_close = 1.5",
                    "UPDATE bet_legs SET closing_opp_odds = 1.0",
                    "UPDATE bet_legs SET closing_source = 'guess'",
                    "UPDATE bets SET settled_by = 'robot'",
                ):
                    assert await _refused(conn, sql), sql
                assert not await _refused(
                    conn, "INSERT INTO bookmakers (user_id, name) VALUES (2, 'Winline')"
                )

            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0003")
            async with engine.begin() as conn:
                kinds = await conn.execute(text("SELECT kind FROM notifications"))
                assert list(kinds.scalars()) == ["new_device"]
                assert await conn.scalar(text("SELECT count(*) FROM bets")) == 5
                assert await _refused(
                    conn,
                    "INSERT INTO notifications (user_id, kind, title) VALUES (1, 'ai_alert', 'x')",
                )
                assert not await _refused(conn, "UPDATE notifications SET read_at = now()")
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
                assert await conn.scalar(text("SELECT count(*) FROM bookmakers")) == 4
        finally:
            await engine.dispose()


async def test_play_limits_day_tz_migration(settings: Settings) -> None:
    """0004 → 0005: лимиты участника не теряются, новые колонки пустые; прежний пояс суток
    задается только вместе с концом суток. Откат до 0004 и повторный upgrade проходят."""
    async with _temp_database(settings, "stage4tz") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0004")
                await conn.execute(text("INSERT INTO users (email) VALUES ('m@example.com')"))
                await conn.execute(
                    text(
                        "INSERT INTO play_limits (user_id, bets_per_day, stake_per_day, currency)"
                        " VALUES (1, 3, 1000, 'RUB')"
                    )
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                row = (
                    await conn.execute(
                        text(
                            "SELECT bets_per_day, stake_per_day, day_tz, day_tz_until"
                            " FROM play_limits"
                        )
                    )
                ).one()
                assert tuple(row) == (3, 1000, None, None)
                assert await _refused(conn, "UPDATE play_limits SET day_tz = 'UTC'")
                assert await _refused(conn, "UPDATE play_limits SET day_tz_until = now()")
                assert not await _refused(
                    conn, "UPDATE play_limits SET day_tz = 'UTC', day_tz_until = now()"
                )
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0004")
            async with engine.begin() as conn:
                assert await conn.scalar(text("SELECT bets_per_day FROM play_limits")) == 3
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()


_NAME_FORM_INDEXES = (
    "ix_players_name_plain_trgm",
    "ix_players_name_ru_plain_trgm",
    "ix_players_name_ru_skel_trgm",
    "ix_players_name_skel_trgm",
)


async def _player_indexes(conn: AsyncConnection) -> list[str]:
    rows = await conn.execute(
        text(
            "SELECT indexname FROM pg_indexes WHERE tablename = 'players'"
            " AND indexname LIKE 'ix_players_name%' ORDER BY indexname"
        )
    )
    return [str(name) for (name,) in rows]


async def test_player_name_form_indexes_migration(settings: Settings) -> None:
    """0005 → 0006: индексы триграмм по формам имени (поиск игроков) появляются, игроки не
    теряются; поиск по-русски с «е с двумя точками» в базе находит игрока через индекс-форму.
    Откат до 0005 убирает только эти индексы, повторный upgrade проходит."""
    async with _temp_database(settings, "s4idx") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0005")
                await conn.execute(
                    text(
                        "INSERT INTO players (name, name_ru) VALUES"
                        " ('Jannik Sinner', 'Янник Синнер'),"
                        " ('Petr Fedorov', 'Петр Ф\u0451доров')"
                    )
                )
                before = await _player_indexes(conn)
            assert before == ["ix_players_name_ru_trgm", "ix_players_name_trgm"]
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                assert await _player_indexes(conn) == sorted([*before, *_NAME_FORM_INDEXES])
                assert await conn.scalar(text("SELECT count(*) FROM players")) == 2
                # Индексы — по тем же выражениям, что ищет код: «е с двумя точками» → «е»
                await conn.execute(text("SET LOCAL enable_seqscan = off"))
                found = await conn.scalar(
                    text(
                        "SELECT name FROM players WHERE translate(name_ru,"
                        " '\u0451\u0401', 'еЕ') % 'федоров'"
                    )
                )
                assert found == "Petr Fedorov"
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0005")
            async with engine.begin() as conn:
                assert await _player_indexes(conn) == before
                await conn.run_sync(run_alembic_upgrade, "head")
                assert len(await _player_indexes(conn)) == 6
        finally:
            await engine.dispose()


async def test_settings_change_audit_migration(settings: Settings) -> None:
    """0006 → 0007: журнал принимает settings_change, прежние записи остаются. Откат до
    0006 удаляет только записи settings_change (прежний CHECK их не пропустит), повторный
    upgrade проходит."""
    insert = (
        "INSERT INTO admin_audit_log (action, details) VALUES"
        " ('settings_change', '{\"field\": \"default_tz\"}')"
    )
    async with _temp_database(settings, "s4audit") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0006")
                await conn.execute(
                    text("INSERT INTO admin_audit_log (action, details) VALUES ('message', '{}')")
                )
                assert await _refused(conn, insert)
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                assert not await _refused(conn, insert)
                await conn.execute(text(insert))
                assert await _refused(
                    conn, "INSERT INTO admin_audit_log (action, details) VALUES ('nope', '{}')"
                )
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0006")
            async with engine.begin() as conn:
                actions = await conn.scalars(text("SELECT action FROM admin_audit_log"))
                assert list(actions) == ["message"]
                assert await _refused(conn, insert)
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()


async def test_stage5_migration_keeps_stage4_data(settings: Settings) -> None:
    """0007 → 0008: ставки, уроки, версии стратегии и модели не теряются; у прежних строк
    модели одного вида активна самая новая. Новые ограничения действуют: одна активная
    общая версия инструкций, коды общих уроков уникальны, новые виды уведомлений и действия
    журнала. Откат до 0007 удаляет общие уроки и версии, уведомления новых видов, статусы
    ready и rejected возвращает в прежние; повторный upgrade проходит."""
    async with _temp_database(settings, "stage5") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0007")
                await conn.execute(text("INSERT INTO users (email) VALUES ('m@example.com')"))
                await conn.execute(
                    text("INSERT INTO players (name) VALUES ('Sinner J.'), ('Alcaraz C.')")
                )
                await conn.execute(
                    text(
                        "INSERT INTO matches (player1_id, player2_id, source, source_ref)"
                        " VALUES (1, 2, 'user', 'u1')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bets (user_id, placed_at, bookmaker, stake, currency,"
                        " total_odds, status) VALUES (1, now(), 'Fonbet', 100, 'RUB', 1.8,"
                        " 'open')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bet_legs (bet_id, match_id, market, selection, odds_taken)"
                        " VALUES (1, 1, 'ML', 1, 1.8)"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO lessons (user_id, code, text, kind, status) VALUES"
                        " (1, 'L-001', 'Грунт', 'numeric', 'hypothesis')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO strategy_versions (user_id, code, status) VALUES"
                        " (1, 'v3', 'active'), (1, 'v2', 'archived')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO ml_models (id, kind, created_at) VALUES"
                        " ('elo-v0', 'elo', now() - interval '1 day'), ('elo-v1', 'elo', now()),"
                        " ('platt-v1', 'calibrator', now())"
                    )
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                models = await conn.execute(text("SELECT id, status FROM ml_models ORDER BY id"))
                assert [tuple(row) for row in models] == [
                    ("elo-v0", "archived"),
                    ("elo-v1", "active"),
                    ("platt-v1", "active"),
                ]
                lesson = (
                    await conn.execute(text("SELECT user_id, scope, n_hist FROM lessons"))
                ).one()
                assert tuple(lesson) == (1, None, 0)
                bet = (
                    await conn.execute(
                        text("SELECT settle_run_id, result_reminded_at, reversed_at FROM bets")
                    )
                ).one()
                assert tuple(bet) == (None, None, None)
                assert await conn.scalar(text("SELECT count(*) FROM strategy_versions")) == 2
                await conn.execute(
                    text(
                        "INSERT INTO strategy_versions (user_id, code, status, goal) VALUES"
                        " (NULL, 'v3', 'active', 'quality'), (NULL, 'v4', 'candidate', 'saving'),"
                        " (1, 'r3', 'rejected', 'rules')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO lessons (user_id, code, text, kind, status) VALUES"
                        " (NULL, 'L-022', 'Хард', 'numeric', 'ready')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO notifications (user_id, kind, title) VALUES"
                        " (1, 'bet_needs_result', 'Ждет'), (1, 'new_device', 'Вход')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO admin_audit_log (action, details) VALUES ('data_upload', '{}')"
                    )
                )
                for sql in (
                    "INSERT INTO strategy_versions (user_id, code, status) VALUES"
                    " (NULL, 'v9', 'active')",
                    "INSERT INTO lessons (user_id, code, text, kind) VALUES"
                    " (NULL, 'L-022', 'x', 'process')",
                    "INSERT INTO ml_models (id, kind) VALUES ('elo-v2', 'elo')",
                    "UPDATE bet_legs SET archive_result = 'maybe'",
                    "INSERT INTO notifications (user_id, kind, title) VALUES (1, 'nope', 'x')",
                    "INSERT INTO data_uploads (filename, size_bytes, sha256, year, status)"
                    " VALUES ('2026.xlsx', 1, 'x', 2026, 'lost')",
                    "INSERT INTO postmortems (match_id, prediction_id, verdict) VALUES (1, 1, 'x')",
                    "INSERT INTO batch_jobs (kind) VALUES ('report')",
                ):
                    assert await _refused(conn, sql), sql
                assert not await _refused(
                    conn,
                    "INSERT INTO ml_models (id, kind, status)"
                    " VALUES ('elo-v2', 'elo', 'candidate')",
                )
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0007")
            async with engine.begin() as conn:
                versions = await conn.execute(
                    text("SELECT user_id, code, status FROM strategy_versions ORDER BY id")
                )
                assert [tuple(row) for row in versions] == [
                    (1, "v3", "active"),
                    (1, "v2", "archived"),
                    (1, "r3", "archived"),
                ]
                assert await conn.scalar(text("SELECT count(*) FROM lessons")) == 1
                kinds = await conn.execute(text("SELECT kind FROM notifications"))
                assert list(kinds.scalars()) == ["new_device"]
                assert await conn.scalar(text("SELECT count(*) FROM admin_audit_log")) == 0
                assert await conn.scalar(text("SELECT count(*) FROM bets")) == 1
                assert await conn.scalar(text("SELECT count(*) FROM ml_models")) == 3
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
                assert await conn.scalar(text("SELECT count(*) FROM bet_legs")) == 1
        finally:
            await engine.dispose()


async def test_stage5_wave2_migration(settings: Settings) -> None:
    """0008 → 0009: у прежних уроков origin — postmortem, metrics пустые; новая таблица
    lesson_watches; действие журнала lesson_off и CHECK origin. Откат до 0008 удаляет
    подписки и записи lesson_off; повторный upgrade проходит."""
    async with _temp_database(settings, "wave2") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0008")
                await conn.execute(text("INSERT INTO users (email) VALUES ('m@example.com')"))
                await conn.execute(
                    text(
                        "INSERT INTO lessons (user_id, code, text, kind) VALUES"
                        " (NULL, 'L-001', 'Грунт', 'numeric')"
                    )
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                lesson = (
                    await conn.execute(text("SELECT origin, created_by, metrics FROM lessons"))
                ).one()
                assert tuple(lesson) == ("postmortem", None, {})
                await conn.execute(
                    text("INSERT INTO lesson_watches (lesson_id, user_id) VALUES (1, 1)")
                )
                await conn.execute(
                    text(
                        "INSERT INTO admin_audit_log (action, details) VALUES ('lesson_off', '{}')"
                    )
                )
                for sql in (
                    "UPDATE lessons SET origin = 'chat'",
                    "INSERT INTO lesson_watches (lesson_id, user_id) VALUES (1, 1)",
                    "INSERT INTO admin_audit_log (action, details) VALUES ('lesson_x', '{}')",
                ):
                    assert await _refused(conn, sql), sql
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0008")
            async with engine.begin() as conn:
                assert "lesson_watches" not in await conn.run_sync(_table_names)
                assert await conn.scalar(text("SELECT count(*) FROM admin_audit_log")) == 0
                assert await conn.scalar(text("SELECT count(*) FROM lessons")) == 1
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()


async def test_stage6_migration_push_and_quiet_hours(settings: Settings) -> None:
    """0009 → 0010: у прежних пользователей тихие часы по умолчанию (включены, 23:00–08:00),
    у подписок push — пустое устройство и нет доставок; push в прежних строках настроек —
    по В2 (выключен только у learning и ai_alert); CHECK начала и конца тихих часов. Откат
    до 0009 убирает колонки, строки остаются; повторный upgrade проходит."""
    async with _temp_database(settings, "stage6") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0009")
                await conn.execute(text("INSERT INTO users (email) VALUES ('m@example.com')"))
                await conn.execute(
                    text(
                        "INSERT INTO notification_prefs (user_id, kind, on_site, push) VALUES"
                        " (1, 'bet_settled', false, false), (1, 'learning', true, false),"
                        " (1, 'ai_alert', true, false)"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)"
                        " VALUES (1, 'https://fcm.googleapis.com/x', 'p', 'a')"
                    )
                )
            async with engine.begin() as conn:
                # 0013 выключает тихие часы всем — здесь проверяется сама 0010
                await conn.run_sync(run_alembic_upgrade, "0012")
            async with engine.begin() as conn:
                user = (
                    await conn.execute(
                        text("SELECT quiet_enabled, quiet_start, quiet_end FROM users")
                    )
                ).one()
                assert (user[0], str(user[1]), str(user[2])) == (True, "23:00:00", "08:00:00")
                sub = (
                    await conn.execute(
                        text("SELECT device, last_sent_at, session_id FROM push_subscriptions")
                    )
                ).one()
                # Прежние подписки без сеанса: push не получают, пока их не включат заново
                assert tuple(sub) == ("", None, None)
                prefs: dict[str, bool] = dict(
                    (
                        await conn.execute(
                            text("SELECT kind, push FROM notification_prefs ORDER BY kind")
                        )
                    ).all()
                )
                assert prefs == {"ai_alert": False, "bet_settled": True, "learning": False}
                assert await _refused(
                    conn, "UPDATE users SET quiet_start = '07:00', quiet_end = '07:00'"
                )
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0009")
            async with engine.begin() as conn:
                columns = await conn.run_sync(
                    lambda sync: {item["name"] for item in inspect(sync).get_columns("users")}
                )
                assert not columns & {"quiet_enabled", "quiet_start", "quiet_end"}
                assert await conn.scalar(text("SELECT count(*) FROM push_subscriptions")) == 1
                assert await conn.scalar(text("SELECT count(*) FROM notification_prefs")) == 3
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()


async def test_member_view_audit_migration(settings: Settings) -> None:
    """0010 → 0011 (Р27): журнал принимает member_view и member_export, прежние записи
    остаются. Откат до 0010 удаляет только их (прежний CHECK их не пропустит), повторный
    upgrade проходит."""
    inserts = [
        f"INSERT INTO admin_audit_log (action, details) VALUES ('{action}', '{{\"user_id\": 1}}')"
        for action in ("member_view", "member_export")
    ]
    async with _temp_database(settings, "r27audit") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0010")
                await conn.execute(
                    text("INSERT INTO admin_audit_log (action, details) VALUES ('message', '{}')")
                )
                for insert in inserts:
                    assert await _refused(conn, insert)
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                for insert in inserts:
                    await conn.execute(text(insert))
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0010")
            async with engine.begin() as conn:
                actions = await conn.scalars(text("SELECT action FROM admin_audit_log"))
                assert list(actions) == ["message"]
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()


async def test_bet_kind_migration(settings: Settings) -> None:
    """0011 → 0012 (Р29): вид ставки по данным — у ставок бота legacy, у ставок приложения с
    одним событием single, у экспрессов strategy; CHECK пускает только четыре вида. Откат
    до 0011 убирает колонку, ставки остаются; повторный upgrade проходит."""
    async with _temp_database(settings, "betkind") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0011")
                await conn.execute(text("INSERT INTO users (email) VALUES ('m@example.com')"))
                await conn.execute(
                    text("INSERT INTO players (name) VALUES ('Sinner J.'), ('Alcaraz C.')")
                )
                await conn.execute(
                    text(
                        "INSERT INTO matches (player1_id, player2_id, source, source_ref)"
                        " VALUES (1, 2, 'user', 'm1'), (2, 1, 'user', 'm2')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bets (user_id, placed_at, bookmaker, stake, currency,"
                        " total_odds, status, source, source_ref) VALUES"
                        " (1, '2026-05-01', 'Fonbet', 100, 'RUB', 1.8, 'open', 'legacy', 'r1'),"
                        " (1, '2026-10-01', 'Fonbet', 100, 'RUB', 1.8, 'open', 'app', 'c1'),"
                        " (1, '2026-10-02', 'Fonbet', 100, 'RUB', 3.2, 'open', 'app', 'c2'),"
                        " (1, '2026-05-02', 'Fonbet', 100, 'RUB', 3.2, 'open', 'legacy', 'r2')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bet_legs (bet_id, match_id, market, selection, odds_taken)"
                        " VALUES (1, 1, 'ML', 1, 1.8), (2, 1, 'ML', 1, 1.8),"
                        " (3, 1, 'ML', 1, 1.8), (3, 2, 'ML', 2, 1.78),"
                        " (4, 1, 'ML', 1, 1.8), (4, 2, 'ML', 2, 1.78)"
                    )
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                rows = await conn.execute(text("SELECT id, kind FROM bets ORDER BY id"))
                assert [tuple(row) for row in rows] == [
                    (1, "legacy"),
                    (2, "single"),
                    (3, "strategy"),
                    (4, "legacy"),
                ]
                assert await _refused(conn, "UPDATE bets SET kind = 'bot' WHERE id = 1")
                await conn.execute(text("UPDATE bets SET kind = 'own' WHERE id = 3"))
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0011")
            async with engine.begin() as conn:
                columns = await conn.run_sync(
                    lambda sync: {item["name"] for item in inspect(sync).get_columns("bets")}
                )
                assert "kind" not in columns
                assert await conn.scalar(text("SELECT count(*) FROM bets")) == 4
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()


async def test_quiet_hours_off_migration(settings: Settings) -> None:
    """0012 → 0013: тихие часы выключены у всех и по умолчанию у новых; окно 23:00–08:00
    остается. Откат возвращает только значение по умолчанию."""
    async with _temp_database(settings, "quiet_off") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0012")
                await conn.execute(text("INSERT INTO users (email) VALUES ('a@example.com')"))
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
            async with engine.begin() as conn:
                await conn.execute(text("INSERT INTO users (email) VALUES ('b@example.com')"))
                rows = await conn.execute(
                    text("SELECT quiet_enabled, quiet_start FROM users ORDER BY id")
                )
                assert [(row[0], str(row[1])) for row in rows] == [
                    (False, "23:00:00"),
                    (False, "23:00:00"),
                ]
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0012")
            async with engine.begin() as conn:
                await conn.execute(text("INSERT INTO users (email) VALUES ('c@example.com')"))
                states = await conn.execute(text("SELECT quiet_enabled FROM users ORDER BY id"))
                assert list(states.scalars()) == [False, False, True]
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()


async def test_new_markets_migration(settings: Settings) -> None:
    """0013 → 0014 (Р28): счет ноги до 64 символов (счет по геймам), семейства новых рынков
    в экспрессе (только известные) и вид уведомления market_ready. Откат обрезает длинный
    счет, удаляет уведомления market_ready и столбцы настроек; повторный upgrade проходит."""
    async with _temp_database(settings, "markets") as url:
        engine = create_engine(url)
        try:
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "0013")
                await conn.execute(text("INSERT INTO users (email) VALUES ('m@example.com')"))
                await conn.execute(
                    text("INSERT INTO players (name) VALUES ('Sinner J.'), ('Alcaraz C.')")
                )
                await conn.execute(
                    text(
                        "INSERT INTO matches (player1_id, player2_id, source, source_ref)"
                        " VALUES (1, 2, 'user', 'm1')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bets (user_id, placed_at, bookmaker, stake, currency,"
                        " total_odds, status, source, source_ref) VALUES"
                        " (1, '2026-10-01', 'Fonbet', 100, 'RUB', 1.8, 'open', 'app', 'c1')"
                    )
                )
                await conn.execute(
                    text(
                        "INSERT INTO bet_legs (bet_id, match_id, market, selection, odds_taken,"
                        " score) VALUES (1, 1, 'ML', 1, 1.8, '2:1')"
                    )
                )
            async with engine.begin() as conn:
                await conn.run_sync(run_alembic_upgrade, "head")
                # Миграция не ждет блокировку дольше 5 с (SET LOCAL — до конца транзакции)
                assert await conn.scalar(text("SHOW lock_timeout")) == "5s"
            long_score = "7:6 6:7 7:6 6:7 13:11 extra-long-score"
            async with engine.begin() as conn:
                assert await conn.scalar(text("SELECT score FROM bet_legs")) == "2:1"
                await conn.execute(
                    text("UPDATE bet_legs SET market = 'GTOT_22', score = :score"),
                    {"score": long_score},
                )
                assert await conn.scalar(text("SELECT express_markets FROM app_settings")) == []
                await conn.execute(text("UPDATE app_settings SET express_markets = '{stot}'"))
                assert await _refused(conn, "UPDATE app_settings SET express_markets = '{ml}'")
                await conn.execute(
                    text(
                        "INSERT INTO notifications (user_id, kind, title) VALUES"
                        " (1, 'market_ready', 'x'), (1, 'learning', 'y')"
                    )
                )
                assert await _refused(
                    conn, "INSERT INTO notifications (user_id, kind, title) VALUES (1, 'z', 'z')"
                )
            async with engine.begin() as conn:
                await conn.run_sync(_alembic_downgrade, "0013")
                assert await conn.scalar(text("SHOW lock_timeout")) == "5s"
            async with engine.begin() as conn:
                assert await conn.scalar(text("SHOW lock_timeout")) == "0"
                assert await conn.scalar(text("SELECT score FROM bet_legs")) == long_score[:32]
                kinds = await conn.execute(text("SELECT kind FROM notifications"))
                assert list(kinds.scalars()) == ["learning"]
                columns = await conn.run_sync(
                    lambda sync: {
                        item["name"] for item in inspect(sync).get_columns("app_settings")
                    }
                )
                assert not {"express_markets", "markets_notified"} & columns
                await conn.run_sync(run_alembic_upgrade, "head")
        finally:
            await engine.dispose()
