"""Начальная схема: все таблицы из PLAN.md, раздел 5.

Revision ID: 0001
Revises:
Create Date: 2026-10-08

Создана autogenerate и вычитана вручную: расширение pg_trgm для поиска игроков,
GIN-индексы по триграммам, частичные уникальные индексы, CHECK-ограничения и
единственная строка app_settings с настройками по умолчанию (Р9, Р13, Р17).
Примененную миграцию не правим: изменения схемы — следующей миграцией.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Триграммы для поиска игроков по имени с опечатками. Расширение «доверенное»
    # (PostgreSQL 13+): его может создать владелец базы без прав суперпользователя
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "ingestion_runs",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rows", sa.Integer(), server_default="0", nullable=False),
        sa.Column("status", sa.String(length=16), server_default="running", nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('running', 'ok', 'failed')", name=op.f("ck_ingestion_runs_status")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ingestion_runs")),
    )
    op.create_index(
        "ix_ingestion_runs_source_started_at",
        "ingestion_runs",
        ["source", sa.literal_column("started_at DESC")],
        unique=False,
    )
    op.create_table(
        "ml_models",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("train_from", sa.Date(), nullable=True),
        sa.Column("train_to", sa.Date(), nullable=True),
        sa.Column("feature_set", sa.String(length=32), nullable=True),
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "metrics",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("artifact_path", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ml_models")),
    )
    op.create_index(
        "ix_ml_models_kind_created_at",
        "ml_models",
        ["kind", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "model_prices",
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("input", sa.Numeric(precision=10, scale=4), nullable=False),
        sa.Column("output", sa.Numeric(precision=10, scale=4), nullable=False),
        sa.Column("cache_read", sa.Numeric(precision=10, scale=4), nullable=False),
        sa.Column("cache_write_5m", sa.Numeric(precision=10, scale=4), nullable=False),
        sa.Column("cache_write_1h", sa.Numeric(precision=10, scale=4), nullable=False),
        sa.Column("search_price", sa.Numeric(precision=10, scale=4), nullable=False),
        sa.PrimaryKeyConstraint("model", "valid_from", name=op.f("pk_model_prices")),
    )
    op.create_table(
        "players",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("name_ru", sa.String(length=200), nullable=True),
        sa.Column(
            "aliases",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column("country", sa.String(length=3), nullable=True),
        sa.Column("hand", sa.String(length=1), nullable=True),
        sa.Column("backhand", sa.String(length=3), nullable=True),
        sa.Column("birth_date", sa.Date(), nullable=True),
        sa.Column("sackmann_id", sa.Integer(), nullable=True),
        sa.Column("provider_id", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("backhand IN ('one', 'two')", name=op.f("ck_players_backhand")),
        sa.CheckConstraint("hand IN ('R', 'L', 'A', 'U')", name=op.f("ck_players_hand")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_players")),
        sa.UniqueConstraint("sackmann_id", name=op.f("uq_players_sackmann_id")),
    )
    op.create_index(
        "ix_players_aliases", "players", ["aliases"], unique=False, postgresql_using="gin"
    )
    op.create_index(
        "ix_players_name_ru_trgm",
        "players",
        ["name_ru"],
        unique=False,
        postgresql_using="gin",
        postgresql_ops={"name_ru": "gin_trgm_ops"},
    )
    op.create_index(
        "ix_players_name_trgm",
        "players",
        ["name"],
        unique=False,
        postgresql_using="gin",
        postgresql_ops={"name": "gin_trgm_ops"},
    )
    op.create_table(
        "tournaments",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=True),
        sa.Column("surface", sa.String(length=8), nullable=True),
        sa.Column("indoor", sa.Boolean(), nullable=True),
        sa.Column("best_of", sa.SmallInteger(), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("city", sa.String(length=100), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "surface IN ('hard', 'clay', 'grass', 'carpet')", name=op.f("ck_tournaments_surface")
        ),
        sa.CheckConstraint("best_of IN (3, 5)", name=op.f("ck_tournaments_best_of")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tournaments")),
    )
    op.create_index("ix_tournaments_start_date", "tournaments", ["start_date"], unique=False)
    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("display_name", sa.String(length=100), server_default="", nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=True),
        sa.Column("totp_secret_enc", sa.LargeBinary(), nullable=True),
        sa.Column("totp_key_version", sa.Integer(), nullable=True),
        sa.Column("totp_enabled", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("totp_last_step", sa.BigInteger(), nullable=True),
        sa.Column("role", sa.String(length=16), server_default="member", nullable=False),
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("ai_mode", sa.String(length=16), server_default="shared", nullable=False),
        sa.Column("tz", sa.String(length=64), server_default="Europe/Helsinki", nullable=False),
        sa.Column(
            "consent_training", sa.Boolean(), server_default=sa.text("false"), nullable=False
        ),
        sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("blocked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("ai_mode IN ('shared', 'own')", name=op.f("ck_users_ai_mode")),
        sa.CheckConstraint("role IN ('admin', 'member')", name=op.f("ck_users_role")),
        sa.CheckConstraint(
            "status IN ('active', 'blocked', 'deleted')", name=op.f("ck_users_status")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_users_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
    )
    op.create_index(
        "uq_users_email_lower", "users", [sa.literal_column("lower(email)")], unique=True
    )
    op.create_table(
        "access_codes",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column("email", sa.String(length=320), nullable=True),
        sa.Column("role", sa.String(length=16), nullable=True),
        sa.Column("ai_mode", sa.String(length=16), nullable=True),
        sa.Column("limit_monthly_usd", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("limit_daily_analyses", sa.Integer(), nullable=True),
        sa.Column("limit_per_analysis_usd", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("used_by", sa.BigInteger(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(kind = 'invite' AND email IS NOT NULL AND role IS NOT NULL AND ai_mode IS NOT NULL) OR (kind = 'password_reset' AND user_id IS NOT NULL)",
            name=op.f("ck_access_codes_kind_fields"),
        ),
        sa.CheckConstraint("ai_mode IN ('shared', 'own')", name=op.f("ck_access_codes_ai_mode")),
        sa.CheckConstraint(
            "kind IN ('invite', 'password_reset')", name=op.f("ck_access_codes_kind")
        ),
        sa.CheckConstraint("role IN ('admin', 'member')", name=op.f("ck_access_codes_role")),
        sa.CheckConstraint(
            "limit_monthly_usd >= 0 AND limit_daily_analyses >= 0 AND limit_per_analysis_usd >= 0",
            name=op.f("ck_access_codes_limits_non_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_access_codes_created_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["used_by"],
            ["users.id"],
            name=op.f("fk_access_codes_used_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_access_codes_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_access_codes")),
        sa.UniqueConstraint("code_hash", name=op.f("uq_access_codes_code_hash")),
    )
    op.create_index(
        "ix_access_codes_kind_expires_at", "access_codes", ["kind", "expires_at"], unique=False
    )
    op.create_index("ix_access_codes_user_id", "access_codes", ["user_id"], unique=False)
    op.create_table(
        "admin_audit_log",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("actor_id", sa.BigInteger(), nullable=True),
        sa.Column("action", sa.String(length=32), nullable=False),
        sa.Column("target_user_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.CheckConstraint(
            "action IN ('invite', 'invite_revoke', 'reset_code', 'reset_code_revoke', 'reset_2fa', 'block', 'unblock', 'delete', 'role_change', 'sessions_revoke', 'limit_change', 'key_change', 'currency_change', 'create_admin', 'import', 'message')",
            name=op.f("ck_admin_audit_log_action"),
        ),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["users.id"],
            name=op.f("fk_admin_audit_log_actor_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["target_user_id"],
            ["users.id"],
            name=op.f("fk_admin_audit_log_target_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_admin_audit_log")),
    )
    op.create_index(
        "ix_admin_audit_log_at", "admin_audit_log", [sa.literal_column("at DESC")], unique=False
    )
    op.create_index(
        "ix_admin_audit_log_target_user_id_at",
        "admin_audit_log",
        ["target_user_id", sa.literal_column("at DESC")],
        unique=False,
    )
    op.create_table(
        "ai_limits",
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("monthly_usd", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column("daily_analyses", sa.Integer(), nullable=False),
        sa.Column("per_analysis_usd", sa.Numeric(precision=10, scale=2), nullable=False),
        sa.Column(
            "allowed_models",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column("paused", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("updated_by", sa.BigInteger(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "monthly_usd >= 0 AND daily_analyses >= 0 AND per_analysis_usd >= 0",
            name=op.f("ck_ai_limits_non_negative"),
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name=op.f("fk_ai_limits_updated_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_ai_limits_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_ai_limits")),
    )
    op.create_table(
        "app_settings",
        sa.Column("id", sa.SmallInteger(), autoincrement=False, nullable=False),
        sa.Column("currency", sa.CHAR(length=3), server_default="RUB", nullable=False),
        sa.Column("anthropic_key_enc", sa.LargeBinary(), nullable=True),
        sa.Column("key_version", sa.Integer(), nullable=True),
        sa.Column("key_last4", sa.String(length=4), nullable=True),
        sa.Column("key_verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "monthly_budget_usd",
            sa.Numeric(precision=10, scale=2),
            server_default="60",
            nullable=False,
        ),
        sa.Column(
            "default_member_limit_usd",
            sa.Numeric(precision=10, scale=2),
            server_default="10",
            nullable=False,
        ),
        sa.Column("default_daily_analyses", sa.Integer(), server_default="3", nullable=False),
        sa.Column(
            "per_analysis_soft_usd",
            sa.Numeric(precision=10, scale=2),
            server_default="0.5",
            nullable=False,
        ),
        sa.Column(
            "per_analysis_hard_usd",
            sa.Numeric(precision=10, scale=2),
            server_default="1",
            nullable=False,
        ),
        sa.Column("updated_by", sa.BigInteger(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "currency IN ('RUB', 'USD', 'EUR')", name=op.f("ck_app_settings_currency")
        ),
        sa.CheckConstraint("id = 1", name=op.f("ck_app_settings_single_row")),
        sa.CheckConstraint(
            "monthly_budget_usd >= 0 AND default_member_limit_usd >= 0"
            " AND default_daily_analyses >= 0 AND per_analysis_soft_usd >= 0"
            " AND per_analysis_hard_usd >= 0",
            name=op.f("ck_app_settings_non_negative"),
        ),
        sa.CheckConstraint(
            "per_analysis_soft_usd <= per_analysis_hard_usd",
            name=op.f("ck_app_settings_soft_le_hard"),
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            name=op.f("fk_app_settings_updated_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_app_settings")),
    )
    op.create_table(
        "lessons",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("code", sa.String(length=16), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("scope_sql", sa.Text(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="hypothesis", nullable=False),
        sa.Column("n_cases", sa.Integer(), server_default="0", nullable=False),
        sa.Column("effect", sa.Double(), nullable=True),
        sa.Column("effect_ci", postgresql.ARRAY(sa.Double()), nullable=True),
        sa.Column(
            "source_bet_ids",
            postgresql.ARRAY(sa.BigInteger()),
            server_default=sa.text("'{}'::bigint[]"),
            nullable=False,
        ),
        sa.Column("validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("in_prompt", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("kind IN ('numeric', 'process')", name=op.f("ck_lessons_kind")),
        sa.CheckConstraint(
            "status IN ('hypothesis', 'confirmed', 'rejected', 'retired')",
            name=op.f("ck_lessons_status"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_lessons_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_lessons")),
        sa.UniqueConstraint("user_id", "code", name=op.f("uq_lessons_user_id_code")),
    )
    op.create_index("ix_lessons_user_id_status", "lessons", ["user_id", "status"], unique=False)
    op.create_table(
        "login_events",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("result", sa.String(length=16), nullable=False),
        sa.Column("method", sa.String(length=16), nullable=False),
        sa.CheckConstraint(
            "method IN ('password', 'totp', 'recovery', 'trusted_device')",
            name=op.f("ck_login_events_method"),
        ),
        sa.CheckConstraint(
            "result IN ('ok', 'bad_password', 'bad_totp', 'bad_recovery', 'rate_limited', 'blocked')",
            name=op.f("ck_login_events_result"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_login_events_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_login_events")),
    )
    op.create_index("ix_login_events_at", "login_events", ["at"], unique=False)
    op.create_index(
        "ix_login_events_user_id_at",
        "login_events",
        ["user_id", sa.literal_column("at DESC")],
        unique=False,
    )
    op.create_table(
        "matches",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("tournament_id", sa.BigInteger(), nullable=True),
        sa.Column("round", sa.String(length=16), server_default="", nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("player1_id", sa.BigInteger(), nullable=False),
        sa.Column("player2_id", sa.BigInteger(), nullable=False),
        sa.Column("winner_id", sa.BigInteger(), nullable=True),
        sa.Column("score", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="scheduled", nullable=False),
        sa.Column("best_of", sa.SmallInteger(), nullable=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("source_ref", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source IN ('sackmann', 'tennis_data', 'api', 'web', 'legacy')",
            name=op.f("ck_matches_source"),
        ),
        # У матча без турнира UNIQUE(tournament_id, ...) не работает (NULL не равны),
        # поэтому повторы ловит UNIQUE(source, source_ref)
        sa.CheckConstraint(
            "tournament_id IS NOT NULL OR (source IN ('legacy', 'web') AND source_ref IS NOT NULL)",
            name=op.f("ck_matches_tournament_or_source_ref"),
        ),
        sa.CheckConstraint(
            "status IN ('scheduled', 'finished', 'retired', 'walkover')",
            name=op.f("ck_matches_status"),
        ),
        sa.CheckConstraint("best_of IN (3, 5)", name=op.f("ck_matches_best_of")),
        sa.CheckConstraint("player1_id <> player2_id", name=op.f("ck_matches_distinct_players")),
        sa.CheckConstraint(
            "winner_id IS NULL OR winner_id = player1_id OR winner_id = player2_id",
            name=op.f("ck_matches_winner_is_player"),
        ),
        sa.ForeignKeyConstraint(
            ["player1_id"], ["players.id"], name=op.f("fk_matches_player1_id_players")
        ),
        sa.ForeignKeyConstraint(
            ["player2_id"], ["players.id"], name=op.f("fk_matches_player2_id_players")
        ),
        sa.ForeignKeyConstraint(
            ["tournament_id"], ["tournaments.id"], name=op.f("fk_matches_tournament_id_tournaments")
        ),
        sa.ForeignKeyConstraint(
            ["winner_id"], ["players.id"], name=op.f("fk_matches_winner_id_players")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_matches")),
        sa.UniqueConstraint(
            "tournament_id",
            "round",
            "player1_id",
            "player2_id",
            name=op.f("uq_matches_tournament_id_round_player1_id_player2_id"),
        ),
        sa.UniqueConstraint("source", "source_ref", name=op.f("uq_matches_source_source_ref")),
    )
    op.create_index("ix_matches_player1_id", "matches", ["player1_id"], unique=False)
    op.create_index("ix_matches_player2_id", "matches", ["player2_id"], unique=False)
    op.create_index("ix_matches_scheduled_at", "matches", ["scheduled_at"], unique=False)
    op.create_table(
        "notifications",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), server_default="", nullable=False),
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("link", sa.String(length=500), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('bet_settled', 'data_stale', 'limit_80', 'limit_100', 'new_device', 'admin_message', 'login_failures')",
            name=op.f("ck_notifications_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_notifications_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notifications")),
    )
    op.create_index(
        "ix_notifications_user_id_created_at",
        "notifications",
        ["user_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_notifications_user_id_unread",
        "notifications",
        ["user_id"],
        unique=False,
        postgresql_where=sa.text("read_at IS NULL"),
    )
    op.create_table(
        "player_news",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("player_id", sa.BigInteger(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("source_url", sa.Text(), nullable=False),
        sa.Column("source_name", sa.String(length=200), nullable=True),
        sa.Column(
            "fetched_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('injury', 'withdrawal', 'motivation', 'other')",
            name=op.f("ck_player_news_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_player_news_player_id_players"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_player_news")),
        sa.UniqueConstraint(
            "player_id", "source_url", name=op.f("uq_player_news_player_id_source_url")
        ),
    )
    op.create_index(
        "ix_player_news_player_id_published_at",
        "player_news",
        ["player_id", sa.literal_column("published_at DESC")],
        unique=False,
    )
    op.create_table(
        "player_profiles",
        sa.Column("player_id", sa.BigInteger(), nullable=False),
        sa.Column("profile", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_player_profiles_player_id_players"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("player_id", name=op.f("pk_player_profiles")),
    )
    op.create_table(
        "player_ratings",
        sa.Column("player_id", sa.BigInteger(), nullable=False),
        sa.Column("surface", sa.String(length=8), nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.Column("elo", sa.Double(), nullable=False),
        sa.Column("matches", sa.Integer(), server_default="0", nullable=False),
        sa.CheckConstraint(
            "surface IN ('hard', 'clay', 'grass', 'carpet', 'all')",
            name=op.f("ck_player_ratings_surface"),
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_player_ratings_player_id_players"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("player_id", "surface", "as_of", name=op.f("pk_player_ratings")),
    )
    op.create_table(
        "push_subscriptions",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("endpoint", sa.Text(), nullable=False),
        sa.Column("p256dh", sa.Text(), nullable=False),
        sa.Column("auth", sa.Text(), nullable=False),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_push_subscriptions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_push_subscriptions")),
        sa.UniqueConstraint("endpoint", name=op.f("uq_push_subscriptions_endpoint")),
    )
    op.create_index(
        "ix_push_subscriptions_user_id", "push_subscriptions", ["user_id"], unique=False
    )
    op.create_table(
        "recovery_codes",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_recovery_codes_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recovery_codes")),
    )
    op.create_index("ix_recovery_codes_user_id", "recovery_codes", ["user_id"], unique=False)
    op.create_table(
        "sessions",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("id_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "last_seen_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("device_label", sa.String(length=100), server_default="", nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_sessions_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sessions")),
        sa.UniqueConstraint("id_hash", name=op.f("uq_sessions_id_hash")),
    )
    op.create_index("ix_sessions_expires_at", "sessions", ["expires_at"], unique=False)
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"], unique=False)
    op.create_table(
        "strategy_versions",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("code", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=100), server_default="", nullable=False),
        sa.Column(
            "params",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("prompt_version", sa.String(length=64), nullable=True),
        sa.Column(
            "lessons",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=16), server_default="candidate", nullable=False),
        sa.Column(
            "metrics",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("approved_by", sa.BigInteger(), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('candidate', 'active', 'archived')",
            name=op.f("ck_strategy_versions_status"),
        ),
        sa.ForeignKeyConstraint(
            ["approved_by"],
            ["users.id"],
            name=op.f("fk_strategy_versions_approved_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_strategy_versions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_strategy_versions")),
        sa.UniqueConstraint("user_id", "code", name=op.f("uq_strategy_versions_user_id_code")),
    )
    op.create_index(
        "uq_strategy_versions_user_id_active",
        "strategy_versions",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_table(
        "trusted_devices",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("device_label", sa.String(length=100), server_default="", nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_trusted_devices_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trusted_devices")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_trusted_devices_token_hash")),
    )
    op.create_index("ix_trusted_devices_user_id", "trusted_devices", ["user_id"], unique=False)
    op.create_table(
        "user_secrets",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("last4", sa.String(length=4), nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("kind IN ('anthropic_key')", name=op.f("ck_user_secrets_kind")),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_secrets_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_secrets")),
        sa.UniqueConstraint("user_id", "kind", name=op.f("uq_user_secrets_user_id_kind")),
    )
    op.create_table(
        "analyses",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("input_text", sa.Text(), nullable=False),
        sa.Column("parsed", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="created", nullable=False),
        sa.Column("strategy_version_id", sa.BigInteger(), nullable=True),
        sa.Column("prompt_version", sa.String(length=64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('created', 'queued', 'running', 'done', 'failed', 'cancelled')",
            name=op.f("ck_analyses_status"),
        ),
        sa.ForeignKeyConstraint(
            ["strategy_version_id"],
            ["strategy_versions.id"],
            name=op.f("fk_analyses_strategy_version_id_strategy_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_analyses_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_analyses")),
    )
    op.create_index(
        "ix_analyses_user_id_created_at",
        "analyses",
        ["user_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "dossiers",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("match_id", sa.BigInteger(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("feature_set", sa.String(length=32), nullable=False),
        sa.Column("news_version", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["match_id"],
            ["matches.id"],
            name=op.f("fk_dossiers_match_id_matches"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_dossiers")),
        sa.UniqueConstraint("sha256", name=op.f("uq_dossiers_sha256")),
    )
    op.create_index("ix_dossiers_match_id_as_of", "dossiers", ["match_id", "as_of"], unique=False)
    op.create_table(
        "eval_runs",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("version_kind", sa.String(length=16), nullable=False),
        sa.Column("strategy_version_id", sa.BigInteger(), nullable=True),
        sa.Column("ml_model_id", sa.String(length=64), nullable=True),
        sa.Column("eval_set", sa.String(length=64), nullable=False),
        sa.Column("split", sa.String(length=16), nullable=False),
        sa.Column("n_events", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "metrics",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "cost_usd", sa.Numeric(precision=12, scale=6), server_default="0", nullable=False
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(version_kind = 'strategy' AND strategy_version_id IS NOT NULL AND ml_model_id IS NULL) OR (version_kind = 'ml_model' AND ml_model_id IS NOT NULL AND strategy_version_id IS NULL)",
            name=op.f("ck_eval_runs_version_ref"),
        ),
        sa.CheckConstraint(
            "split IN ('train', 'validation', 'test')", name=op.f("ck_eval_runs_split")
        ),
        sa.CheckConstraint(
            "version_kind IN ('strategy', 'ml_model')", name=op.f("ck_eval_runs_version_kind")
        ),
        sa.ForeignKeyConstraint(
            ["ml_model_id"],
            ["ml_models.id"],
            name=op.f("fk_eval_runs_ml_model_id_ml_models"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["strategy_version_id"],
            ["strategy_versions.id"],
            name=op.f("fk_eval_runs_strategy_version_id_strategy_versions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_eval_runs")),
    )
    op.create_index(
        "ix_eval_runs_ml_model_id_created_at",
        "eval_runs",
        ["ml_model_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_index(
        "ix_eval_runs_strategy_version_id_created_at",
        "eval_runs",
        ["strategy_version_id", sa.literal_column("created_at DESC")],
        unique=False,
    )
    op.create_table(
        "match_stats",
        sa.Column("match_id", sa.BigInteger(), nullable=False),
        sa.Column("player_id", sa.BigInteger(), nullable=False),
        sa.Column("aces", sa.Integer(), nullable=True),
        sa.Column("double_faults", sa.Integer(), nullable=True),
        sa.Column("serve_points", sa.Integer(), nullable=True),
        sa.Column("first_in", sa.Integer(), nullable=True),
        sa.Column("first_won", sa.Integer(), nullable=True),
        sa.Column("second_won", sa.Integer(), nullable=True),
        sa.Column("bp_saved", sa.Integer(), nullable=True),
        sa.Column("bp_faced", sa.Integer(), nullable=True),
        sa.Column("serve_games", sa.Integer(), nullable=True),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.ForeignKeyConstraint(
            ["match_id"],
            ["matches.id"],
            name=op.f("fk_match_stats_match_id_matches"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_match_stats_player_id_players"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("match_id", "player_id", name=op.f("pk_match_stats")),
    )
    op.create_table(
        "odds_snapshots",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("match_id", sa.BigInteger(), nullable=False),
        sa.Column("market", sa.String(length=32), nullable=False),
        sa.Column("selection", sa.SmallInteger(), nullable=False),
        sa.Column("bookmaker", sa.String(length=64), nullable=False),
        sa.Column("odds", sa.Numeric(precision=6, scale=3), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column(
            "taken_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint(
            "kind IN ('user', 'opening', 'closing', 'api')", name=op.f("ck_odds_snapshots_kind")
        ),
        sa.CheckConstraint("odds >= 1", name=op.f("ck_odds_snapshots_odds_min")),
        sa.CheckConstraint("selection IN (1, 2)", name=op.f("ck_odds_snapshots_selection")),
        sa.ForeignKeyConstraint(
            ["match_id"],
            ["matches.id"],
            name=op.f("fk_odds_snapshots_match_id_matches"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_odds_snapshots")),
    )
    op.create_index(
        "ix_odds_snapshots_match_id_market_taken_at",
        "odds_snapshots",
        ["match_id", "market", "taken_at"],
        unique=False,
    )
    op.create_table(
        "agent_runs",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column("key_source", sa.String(length=8), nullable=False),
        sa.Column("analysis_id", sa.BigInteger(), nullable=True),
        sa.Column("eval_run_id", sa.BigInteger(), nullable=True),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("step", sa.Integer(), server_default="0", nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("effort", sa.String(length=16), nullable=True),
        sa.Column("prompt_version", sa.String(length=64), nullable=True),
        sa.Column("schema_version", sa.String(length=32), nullable=True),
        sa.Column("input_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cache_write_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cache_write_5m_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cache_write_1h_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("cache_read_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("output_tokens", sa.Integer(), server_default="0", nullable=False),
        sa.Column("thinking_tokens", sa.Integer(), nullable=True),
        sa.Column("web_searches", sa.Integer(), server_default="0", nullable=False),
        sa.Column("batch", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "cost_usd", sa.Numeric(precision=12, scale=6), server_default="0", nullable=False
        ),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("stop_reason", sa.String(length=32), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("request_id", sa.String(length=128), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("key_source IN ('admin', 'own')", name=op.f("ck_agent_runs_key_source")),
        sa.CheckConstraint(
            "kind IN ('parse', 'news', 'analysis', 'refresh', 'postmortem', 'eval', 'shadow')",
            name=op.f("ck_agent_runs_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["analysis_id"],
            ["analyses.id"],
            name=op.f("fk_agent_runs_analysis_id_analyses"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["eval_run_id"],
            ["eval_runs.id"],
            name=op.f("fk_agent_runs_eval_run_id_eval_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_agent_runs_user_id_users"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_runs")),
    )
    op.create_index("ix_agent_runs_analysis_id", "agent_runs", ["analysis_id"], unique=False)
    op.create_index("ix_agent_runs_created_at", "agent_runs", ["created_at"], unique=False)
    op.create_index(
        "ix_agent_runs_kind_created_at", "agent_runs", ["kind", "created_at"], unique=False
    )
    op.create_index(
        "ix_agent_runs_user_id_created_at", "agent_runs", ["user_id", "created_at"], unique=False
    )
    op.create_table(
        "bets",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("analysis_id", sa.BigInteger(), nullable=True),
        sa.Column("placed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("bookmaker", sa.String(length=64), nullable=False),
        sa.Column("stake", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("total_odds", sa.Numeric(precision=6, scale=3), nullable=False),
        sa.Column("status", sa.String(length=8), server_default="open", nullable=False),
        sa.Column("profit", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("source", sa.String(length=8), server_default="app", nullable=False),
        sa.Column("source_ref", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("currency IN ('RUB', 'USD', 'EUR')", name=op.f("ck_bets_currency")),
        sa.CheckConstraint("source IN ('app', 'legacy')", name=op.f("ck_bets_source")),
        sa.CheckConstraint(
            "status IN ('open', 'won', 'lost', 'void')", name=op.f("ck_bets_status")
        ),
        sa.CheckConstraint("stake > 0", name=op.f("ck_bets_stake_positive")),
        sa.CheckConstraint("total_odds >= 1", name=op.f("ck_bets_total_odds_min")),
        sa.ForeignKeyConstraint(
            ["analysis_id"],
            ["analyses.id"],
            name=op.f("fk_bets_analysis_id_analyses"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_bets_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bets")),
        sa.UniqueConstraint(
            "user_id", "source", "source_ref", name=op.f("uq_bets_user_id_source_source_ref")
        ),
    )
    op.create_index(
        "ix_bets_user_id_placed_at",
        "bets",
        ["user_id", sa.literal_column("placed_at DESC")],
        unique=False,
    )
    op.create_index("ix_bets_user_id_status", "bets", ["user_id", "status"], unique=False)
    op.create_table(
        "bankroll_ledger",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("amount", sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column("currency", sa.CHAR(length=3), nullable=False),
        sa.Column("bet_id", sa.BigInteger(), nullable=True),
        sa.Column("reversed_by", sa.BigInteger(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "(kind IN ('deposit', 'payout', 'refund') AND amount > 0) OR (kind IN ('withdrawal', 'stake') AND amount < 0) OR (kind IN ('reversal', 'correction') AND amount <> 0)",
            name=op.f("ck_bankroll_ledger_amount_sign"),
        ),
        sa.CheckConstraint(
            "currency IN ('RUB', 'USD', 'EUR')", name=op.f("ck_bankroll_ledger_currency")
        ),
        sa.CheckConstraint(
            "kind IN ('deposit', 'withdrawal', 'stake', 'payout', 'refund', 'reversal', 'correction')",
            name=op.f("ck_bankroll_ledger_kind"),
        ),
        sa.CheckConstraint(
            "kind NOT IN ('stake', 'payout', 'refund') OR bet_id IS NOT NULL",
            name=op.f("ck_bankroll_ledger_bet_required"),
        ),
        # Без CASCADE: удалить ставку с записями журнала нельзя (журнал не стирается)
        sa.ForeignKeyConstraint(
            ["bet_id"], ["bets.id"], name=op.f("fk_bankroll_ledger_bet_id_bets")
        ),
        sa.ForeignKeyConstraint(
            ["reversed_by"],
            ["bankroll_ledger.id"],
            name=op.f("fk_bankroll_ledger_reversed_by_bankroll_ledger"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_bankroll_ledger_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bankroll_ledger")),
    )
    op.create_index(
        "ix_bankroll_ledger_user_id_at", "bankroll_ledger", ["user_id", "at"], unique=False
    )
    op.create_index(
        "uq_bankroll_ledger_bet_id_payout",
        "bankroll_ledger",
        ["bet_id"],
        unique=True,
        postgresql_where=sa.text("kind IN ('payout', 'refund') AND reversed_by IS NULL"),
    )
    op.create_index(
        "uq_bankroll_ledger_bet_id_stake",
        "bankroll_ledger",
        ["bet_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'stake'"),
    )
    op.create_table(
        "predictions",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column("analysis_id", sa.BigInteger(), nullable=True),
        sa.Column("match_id", sa.BigInteger(), nullable=False),
        sa.Column("market", sa.String(length=32), nullable=False),
        sa.Column("selection", sa.SmallInteger(), nullable=False),
        sa.Column("as_of", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dossier_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "features",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("feature_set", sa.String(length=32), nullable=True),
        sa.Column("strategy_version_id", sa.BigInteger(), nullable=True),
        sa.Column("ml_model_id", sa.String(length=64), nullable=True),
        sa.Column("llm_model", sa.String(length=64), nullable=True),
        sa.Column("effort", sa.String(length=16), nullable=True),
        sa.Column("prompt_version", sa.String(length=64), nullable=True),
        sa.Column(
            "lessons_applied",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column("p_base", sa.Double(), nullable=True),
        sa.Column("p_claude", sa.Double(), nullable=True),
        sa.Column("p_final", sa.Double(), nullable=True),
        sa.Column("q_market_at_pred", sa.Double(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("agent_run_id", sa.BigInteger(), nullable=True),
        sa.Column("supersedes", sa.BigInteger(), nullable=True),
        sa.Column("is_eval", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("eval_run_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "eval_run_id IS NULL OR is_eval", name=op.f("ck_predictions_eval_run_is_eval")
        ),
        sa.CheckConstraint("p_base >= 0 AND p_base <= 1", name=op.f("ck_predictions_p_base_range")),
        sa.CheckConstraint(
            "p_claude >= 0 AND p_claude <= 1", name=op.f("ck_predictions_p_claude_range")
        ),
        sa.CheckConstraint(
            "p_final >= 0 AND p_final <= 1", name=op.f("ck_predictions_p_final_range")
        ),
        sa.CheckConstraint(
            "q_market_at_pred >= 0 AND q_market_at_pred <= 1",
            name=op.f("ck_predictions_q_market_at_pred_range"),
        ),
        sa.CheckConstraint("selection IN (1, 2)", name=op.f("ck_predictions_selection")),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name=op.f("fk_predictions_agent_run_id_agent_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["analysis_id"],
            ["analyses.id"],
            name=op.f("fk_predictions_analysis_id_analyses"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["dossier_id"],
            ["dossiers.id"],
            name=op.f("fk_predictions_dossier_id_dossiers"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["eval_run_id"],
            ["eval_runs.id"],
            name=op.f("fk_predictions_eval_run_id_eval_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["match_id"], ["matches.id"], name=op.f("fk_predictions_match_id_matches")
        ),
        sa.ForeignKeyConstraint(
            ["ml_model_id"],
            ["ml_models.id"],
            name=op.f("fk_predictions_ml_model_id_ml_models"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["strategy_version_id"],
            ["strategy_versions.id"],
            name=op.f("fk_predictions_strategy_version_id_strategy_versions"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["supersedes"],
            ["predictions.id"],
            name=op.f("fk_predictions_supersedes_predictions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_predictions_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_predictions")),
        sa.UniqueConstraint(
            "eval_run_id",
            "match_id",
            "market",
            "selection",
            name=op.f("uq_predictions_eval_run_id_match_id_market_selection"),
        ),
        sa.UniqueConstraint("supersedes", name=op.f("uq_predictions_supersedes")),
    )
    op.create_index("ix_predictions_match_id", "predictions", ["match_id"], unique=False)
    op.create_index(
        "ix_predictions_strategy_version_id_created_at",
        "predictions",
        ["strategy_version_id", "created_at"],
        unique=False,
    )
    op.create_index("ix_predictions_user_id", "predictions", ["user_id"], unique=False)
    op.create_index(
        "uq_predictions_analysis_id_match_id_market_selection",
        "predictions",
        ["analysis_id", "match_id", "market", "selection"],
        unique=True,
        postgresql_where=sa.text("supersedes IS NULL"),
    )
    op.create_table(
        "bet_legs",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("bet_id", sa.BigInteger(), nullable=False),
        sa.Column("match_id", sa.BigInteger(), nullable=False),
        sa.Column("market", sa.String(length=32), nullable=False),
        sa.Column("selection", sa.SmallInteger(), nullable=False),
        sa.Column("odds_taken", sa.Numeric(precision=6, scale=3), nullable=False),
        sa.Column("closing_odds", sa.Numeric(precision=6, scale=3), nullable=True),
        sa.Column("prediction_id", sa.BigInteger(), nullable=True),
        sa.Column("result", sa.String(length=8), nullable=True),
        sa.Column("clv", sa.Double(), nullable=True),
        sa.CheckConstraint("result IN ('win', 'loss', 'void')", name=op.f("ck_bet_legs_result")),
        sa.CheckConstraint("closing_odds >= 1", name=op.f("ck_bet_legs_closing_odds_min")),
        sa.CheckConstraint("odds_taken >= 1", name=op.f("ck_bet_legs_odds_taken_min")),
        sa.CheckConstraint("selection IN (1, 2)", name=op.f("ck_bet_legs_selection")),
        sa.ForeignKeyConstraint(
            ["bet_id"], ["bets.id"], name=op.f("fk_bet_legs_bet_id_bets"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["match_id"], ["matches.id"], name=op.f("fk_bet_legs_match_id_matches")
        ),
        sa.ForeignKeyConstraint(
            ["prediction_id"],
            ["predictions.id"],
            name=op.f("fk_bet_legs_prediction_id_predictions"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bet_legs")),
    )
    op.create_index("ix_bet_legs_bet_id", "bet_legs", ["bet_id"], unique=False)
    op.create_index("ix_bet_legs_match_id", "bet_legs", ["match_id"], unique=False)
    # Единственная строка настроек администратора
    op.execute(
        "INSERT INTO app_settings (id, currency, monthly_budget_usd, default_member_limit_usd,"
        " default_daily_analyses, per_analysis_soft_usd, per_analysis_hard_usd)"
        " VALUES (1, 'RUB', 60, 10, 3, 0.5, 1)"
    )


def downgrade() -> None:
    # Индексы и ограничения удаляются вместе с таблицами. Расширение pg_trgm остается:
    # его мог создать суперпользователь, и оно не мешает
    op.drop_table("bet_legs")
    op.drop_table("predictions")
    op.drop_table("bankroll_ledger")
    op.drop_table("bets")
    op.drop_table("agent_runs")
    op.drop_table("odds_snapshots")
    op.drop_table("match_stats")
    op.drop_table("eval_runs")
    op.drop_table("dossiers")
    op.drop_table("analyses")
    op.drop_table("user_secrets")
    op.drop_table("trusted_devices")
    op.drop_table("strategy_versions")
    op.drop_table("sessions")
    op.drop_table("recovery_codes")
    op.drop_table("push_subscriptions")
    op.drop_table("player_ratings")
    op.drop_table("player_profiles")
    op.drop_table("player_news")
    op.drop_table("notifications")
    op.drop_table("matches")
    op.drop_table("login_events")
    op.drop_table("lessons")
    op.drop_table("app_settings")
    op.drop_table("ai_limits")
    op.drop_table("admin_audit_log")
    op.drop_table("access_codes")
    op.drop_table("users")
    op.drop_table("tournaments")
    op.drop_table("players")
    op.drop_table("model_prices")
    op.drop_table("ml_models")
    op.drop_table("ingestion_runs")
