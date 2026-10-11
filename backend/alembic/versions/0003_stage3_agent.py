"""Этап 3: агент v2 и ввод событий.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-11

Только новые колонки с NULL или DEFAULT, новая таблица и расширенные CHECK: код этапа 2
работает на новой схеме.
- analyses: статусы анализа из PLAN.md (раздел 3), ввод (текст или форма), подтвержденные
  события, банк и букмекер из ввода, ключ запуска, чекпойнты, ошибка и шаг сбоя, деньги
  (расход, резерв бюджета, потолок, оценка), решение участника; индексы для «анализов
  за день» на ключе администратора и для поиска зависших анализов;
- match_assessments: проверенная оценка матча от Claude, общая для всех участников;
- matches и tournaments: источник user (матч из ввода участника);
- players.news_checked_at: когда новости игрока искали последний раз;
- player_news: вид result (свежий результат из поиска), вызов Claude и подробности;
- predictions: кэф, букмекер и валуй, по которым код считал прогноз;
- notifications и admin_audit_log: новые виды уведомлений и действия журнала;
- ai_limits: потолок анализа на своем ключе и просьба вернуть ключ администратора (Р12);
- app_settings: настройки агента, порог предупреждения о расходе, бюджет проверок;
- model_prices: вторая ступень цены (Haiku 5.5) и цены моделей на 01.10.2026.
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


_ANALYSIS_STATUSES_OLD = ("created", "queued", "running", "done", "failed", "cancelled")
_ANALYSIS_STATUSES_NEW = (
    *_ANALYSIS_STATUSES_OLD,
    "parsing",
    "needs_confirmation",
    "building_dossier",
    "modelling",
    "llm_review",
    "composing",
)
_ANALYSIS_ACTIVE = ("queued", "building_dossier", "modelling", "llm_review", "composing")
# Откат: новые статусы переводятся в ближайшие старые, иначе не сузить колонку
_ANALYSIS_STATUS_DOWN = {
    "parsing": "created",
    "needs_confirmation": "created",
    "building_dossier": "running",
    "modelling": "running",
    "llm_review": "running",
    "composing": "running",
}
_MATCH_SOURCES_OLD = ("sackmann", "tennis_data", "api", "web", "legacy")
_TOURNAMENT_SOURCES_OLD = ("sackmann", "tennis_data", "legacy")
_NEWS_KINDS_OLD = ("injury", "withdrawal", "motivation", "other")
_NOTIFICATION_KINDS_OLD = (
    "bet_settled",
    "data_stale",
    "limit_80",
    "limit_100",
    "new_device",
    "admin_message",
    "login_failures",
)
_NOTIFICATION_KINDS_ADDED = (
    "ai_key_failed",
    "ai_mode_request",
    "ai_mode_decision",
    "budget_80",
    "budget_100",
)
_NOTIFICATION_KINDS_NEW = (*_NOTIFICATION_KINDS_OLD, *_NOTIFICATION_KINDS_ADDED)
_AUDIT_ACTIONS_OLD = (
    "invite",
    "invite_revoke",
    "reset_code",
    "reset_code_revoke",
    "reset_2fa",
    "block",
    "unblock",
    "delete",
    "role_change",
    "sessions_revoke",
    "limit_change",
    "key_change",
    "currency_change",
    "create_admin",
    "import",
    "message",
    "confirm_failed",
    "player_merge",
    "player_edit",
)
_AUDIT_ACTIONS_NEW = (*_AUDIT_ACTIONS_OLD, "ai_mode_change", "budget_change", "agent_config_change")
_MATCH_SOURCE_REF_OLD = (
    "tournament_id IS NOT NULL OR (source IN ('legacy', 'web') AND source_ref IS NOT NULL)"
)
_MATCH_SOURCE_REF_NEW = (
    "tournament_id IS NOT NULL OR (source IN ('legacy', 'web', 'user') AND source_ref IS NOT NULL)"
)

# Цены на 01.10.2026, $ за 1 млн токенов и за один поиск (страница цен Anthropic на 11.10.2026).
# Haiku 5.5: весь вход запроса больше 100 тыс. токенов — все цены токенов × 5
_PRICES = (
    # model, input, output, cache_read, cache_write_5m, cache_write_1h, search, порог, множитель
    ("claude-opus-5-5", "4", "20", "0.20", "5", "8", "0.01", None, None),
    ("claude-sonnet-5-5", "2", "10", "0.10", "2.50", "4", "0.01", None, None),
    ("claude-haiku-5-5", "0.10", "0.50", "0.01", "0.125", "0.20", "0.01", 100000, "5"),
    ("claude-haiku-4-5", "1", "5", "0.10", "1.25", "2", "0.01", None, None),
)
_PRICES_FROM = "2026-10-01 00:00:00+00"


def _replace_check(table: str, name: str, condition: str) -> None:
    op.drop_constraint(op.f(name), table, type_="check")
    op.create_check_constraint(op.f(name), table, condition)


def _upgrade_analyses() -> None:
    op.alter_column(
        "analyses",
        "status",
        existing_type=sa.String(length=16),
        type_=sa.String(length=24),
        existing_nullable=False,
        existing_server_default="created",
    )
    _replace_check("analyses", "ck_analyses_status", _in("status", _ANALYSIS_STATUSES_NEW))
    columns: list[sa.Column[Any]] = [
        sa.Column("input_kind", sa.String(length=8), server_default="text", nullable=False),
        sa.Column("confirmed", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("bank_input", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column("bookmaker", sa.String(length=64), nullable=True),
        sa.Column("key_source", sa.String(length=8), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("attempt", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_params", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("failed_step", sa.String(length=24), nullable=True),
        sa.Column(
            "checkpoint",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "cost_usd", sa.Numeric(precision=12, scale=6), server_default="0", nullable=False
        ),
        sa.Column(
            "budget_reserved_usd",
            sa.Numeric(precision=10, scale=2),
            server_default="0",
            nullable=False,
        ),
        sa.Column("cost_cap_usd", sa.Numeric(precision=10, scale=2), nullable=True),
        sa.Column("estimate_usd", sa.Numeric(precision=10, scale=4), nullable=True),
        sa.Column("decision", sa.String(length=8), nullable=True),
    ]
    for column in columns:
        op.add_column("analyses", column)
    op.create_check_constraint(
        op.f("ck_analyses_input_kind"), "analyses", _in("input_kind", ("text", "form"))
    )
    op.create_check_constraint(
        op.f("ck_analyses_key_source"), "analyses", _in("key_source", ("admin", "own"))
    )
    op.create_check_constraint(
        op.f("ck_analyses_decision"), "analyses", _in("decision", ("bet", "skip"))
    )
    op.create_check_constraint(
        op.f("ck_analyses_money_non_negative"),
        "analyses",
        "cost_usd >= 0 AND budget_reserved_usd >= 0 AND cost_cap_usd >= 0 AND estimate_usd >= 0",
    )
    op.create_index(
        "ix_analyses_admin_key_started_at",
        "analyses",
        ["user_id", "started_at"],
        unique=False,
        postgresql_where=sa.text("key_source = 'admin'"),
    )
    op.create_index(
        "ix_analyses_active_updated_at",
        "analyses",
        ["status", "updated_at"],
        unique=False,
        postgresql_where=sa.text(_in("status", _ANALYSIS_ACTIVE)),
    )


def _upgrade_match_assessments() -> None:
    op.create_table(
        "match_assessments",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("dossier_id", sa.BigInteger(), nullable=False),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("effort", sa.String(length=16), nullable=False),
        sa.Column("prompt_version", sa.String(length=64), nullable=False),
        sa.Column("schema_version", sa.String(length=32), nullable=False),
        sa.Column("output", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("agent_run_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["agent_run_id"],
            ["agent_runs.id"],
            name=op.f("fk_match_assessments_agent_run_id_agent_runs"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["dossier_id"],
            ["dossiers.id"],
            name=op.f("fk_match_assessments_dossier_id_dossiers"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_match_assessments")),
        sa.UniqueConstraint(
            "dossier_id",
            "model",
            "effort",
            "prompt_version",
            "schema_version",
            name="uq_match_assessments_key",
        ),
    )


def _upgrade_tennis() -> None:
    _replace_check("matches", "ck_matches_source", _in("source", (*_MATCH_SOURCES_OLD, "user")))
    _replace_check("matches", "ck_matches_tournament_or_source_ref", _MATCH_SOURCE_REF_NEW)
    _replace_check(
        "tournaments", "ck_tournaments_source", _in("source", (*_TOURNAMENT_SOURCES_OLD, "user"))
    )
    op.add_column(
        "players", sa.Column("news_checked_at", sa.DateTime(timezone=True), nullable=True)
    )
    _replace_check("player_news", "ck_player_news_kind", _in("kind", (*_NEWS_KINDS_OLD, "result")))
    op.add_column("player_news", sa.Column("agent_run_id", sa.BigInteger(), nullable=True))
    op.add_column(
        "player_news",
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_player_news_agent_run_id_agent_runs"),
        "player_news",
        "agent_runs",
        ["agent_run_id"],
        ["id"],
        ondelete="SET NULL",
    )


def _upgrade_predictions() -> None:
    op.add_column(
        "predictions",
        sa.Column("odds_at_pred", sa.Numeric(precision=6, scale=3), nullable=True),
    )
    op.add_column(
        "predictions", sa.Column("bookmaker_at_pred", sa.String(length=64), nullable=True)
    )
    op.add_column("predictions", sa.Column("value_at_pred", sa.Double(), nullable=True))
    op.create_check_constraint(
        op.f("ck_predictions_odds_at_pred_min"), "predictions", "odds_at_pred >= 1"
    )


def _upgrade_settings() -> None:
    _replace_check("notifications", "ck_notifications_kind", _in("kind", _NOTIFICATION_KINDS_NEW))
    _replace_check(
        "admin_audit_log", "ck_admin_audit_log_action", _in("action", _AUDIT_ACTIONS_NEW)
    )

    op.add_column(
        "ai_limits",
        sa.Column(
            "own_per_analysis_usd",
            sa.Numeric(precision=10, scale=2),
            server_default="1",
            nullable=False,
        ),
    )
    op.add_column(
        "ai_limits",
        sa.Column("return_requested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_check_constraint(
        op.f("ck_ai_limits_own_per_analysis_positive"), "ai_limits", "own_per_analysis_usd > 0"
    )

    op.add_column(
        "app_settings",
        sa.Column(
            "agent_config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column("budget_alert_pct", sa.SmallInteger(), server_default="80", nullable=False),
    )
    op.add_column(
        "app_settings",
        sa.Column(
            "eval_budget_usd",
            sa.Numeric(precision=10, scale=2),
            server_default="25",
            nullable=False,
        ),
    )
    op.create_check_constraint(
        op.f("ck_app_settings_budget_alert_pct"),
        "app_settings",
        "budget_alert_pct IN (50, 70, 80, 90)",
    )
    op.create_check_constraint(
        op.f("ck_app_settings_eval_budget_non_negative"), "app_settings", "eval_budget_usd >= 0"
    )


def _upgrade_prices() -> None:
    op.add_column("model_prices", sa.Column("long_input_threshold", sa.Integer(), nullable=True))
    op.add_column(
        "model_prices",
        sa.Column("long_multiplier", sa.Numeric(precision=4, scale=2), nullable=True),
    )
    rows = ", ".join(
        f"('{model}', '{_PRICES_FROM}', {inp}, {out}, {read}, {w5}, {w1}, {search},"
        f" {'NULL' if threshold is None else threshold}, {'NULL' if mult is None else mult})"
        for model, inp, out, read, w5, w1, search, threshold, mult in _PRICES
    )
    # Повторный upgrade после отката: строки цен остались, вторую ступень надо вернуть
    op.execute(
        "INSERT INTO model_prices (model, valid_from, input, output, cache_read,"
        " cache_write_5m, cache_write_1h, search_price, long_input_threshold, long_multiplier)"
        f" VALUES {rows}"
        " ON CONFLICT (model, valid_from) DO UPDATE SET"
        " long_input_threshold = EXCLUDED.long_input_threshold,"
        " long_multiplier = EXCLUDED.long_multiplier"
    )


def upgrade() -> None:
    _upgrade_analyses()
    _upgrade_match_assessments()
    _upgrade_tennis()
    _upgrade_predictions()
    _upgrade_settings()
    _upgrade_prices()


def downgrade() -> None:
    """Откат теряет данные этапа 3 в новых колонках и оценки матчей. Строки цен моделей
    остаются (код этапа 2 их не читает).

    Строки с новыми значениями перечислений не оставляем под старым ограничением NOT VALID:
    PostgreSQL проверяет его при любом UPDATE строки (отметка «прочитано», SET NULL при
    удалении участника), и код этапа 2 падал бы на таких строках. Поэтому:
    - новые статусы анализов переводятся в ближайшие старые: created (до запуска) или
      running (в работе);
    - уведомления новых видов и свежие результаты из поиска (player_news, вид result)
      удаляются: это оповещения и кэш, этап 2 их не показывает;
    - матчи из ввода участника становятся web (в этапе 2 так называются матчи из
      веб-приложения), турниры из ввода — без источника (как турниры с неизвестным
      источником); повторный upgrade их не возвращает в user;
    - журнал администратора не меняется: записи с действиями этапа 3 остаются, и его
      ограничение остается в виде этапа 3 (код этапа 2 этих действий не пишет)."""
    op.drop_column("model_prices", "long_multiplier")
    op.drop_column("model_prices", "long_input_threshold")

    op.drop_constraint(
        op.f("ck_app_settings_eval_budget_non_negative"), "app_settings", type_="check"
    )
    op.drop_constraint(op.f("ck_app_settings_budget_alert_pct"), "app_settings", type_="check")
    op.drop_column("app_settings", "eval_budget_usd")
    op.drop_column("app_settings", "budget_alert_pct")
    op.drop_column("app_settings", "agent_config")
    op.drop_constraint(op.f("ck_ai_limits_own_per_analysis_positive"), "ai_limits", type_="check")
    op.drop_column("ai_limits", "return_requested_at")
    op.drop_column("ai_limits", "own_per_analysis_usd")
    op.execute(f"DELETE FROM notifications WHERE {_in('kind', _NOTIFICATION_KINDS_ADDED)}")
    _replace_check("notifications", "ck_notifications_kind", _in("kind", _NOTIFICATION_KINDS_OLD))

    op.drop_constraint(op.f("ck_predictions_odds_at_pred_min"), "predictions", type_="check")
    op.drop_column("predictions", "value_at_pred")
    op.drop_column("predictions", "bookmaker_at_pred")
    op.drop_column("predictions", "odds_at_pred")

    op.drop_constraint(
        op.f("fk_player_news_agent_run_id_agent_runs"), "player_news", type_="foreignkey"
    )
    op.drop_column("player_news", "details")
    op.drop_column("player_news", "agent_run_id")
    op.execute("DELETE FROM player_news WHERE kind = 'result'")
    _replace_check("player_news", "ck_player_news_kind", _in("kind", _NEWS_KINDS_OLD))
    op.drop_column("players", "news_checked_at")
    op.execute("UPDATE tournaments SET source = NULL WHERE source = 'user'")
    _replace_check("tournaments", "ck_tournaments_source", _in("source", _TOURNAMENT_SOURCES_OLD))
    op.execute("UPDATE matches SET source = 'web' WHERE source = 'user'")
    _replace_check("matches", "ck_matches_tournament_or_source_ref", _MATCH_SOURCE_REF_OLD)
    _replace_check("matches", "ck_matches_source", _in("source", _MATCH_SOURCES_OLD))

    op.drop_table("match_assessments")

    op.drop_index("ix_analyses_active_updated_at", table_name="analyses")
    op.drop_index("ix_analyses_admin_key_started_at", table_name="analyses")
    for name in ("money_non_negative", "decision", "key_source", "input_kind"):
        op.drop_constraint(op.f(f"ck_analyses_{name}"), "analyses", type_="check")
    for column in (
        "decision",
        "estimate_usd",
        "cost_cap_usd",
        "budget_reserved_usd",
        "cost_usd",
        "result",
        "checkpoint",
        "failed_step",
        "error_params",
        "error_code",
        "attempt",
        "updated_at",
        "started_at",
        "key_source",
        "bookmaker",
        "bank_input",
        "confirmed",
        "input_kind",
    ):
        op.drop_column("analyses", column)
    op.drop_constraint(op.f("ck_analyses_status"), "analyses", type_="check")
    for new, old in _ANALYSIS_STATUS_DOWN.items():
        op.execute(f"UPDATE analyses SET status = '{old}' WHERE status = '{new}'")
    op.alter_column(
        "analyses",
        "status",
        existing_type=sa.String(length=24),
        type_=sa.String(length=16),
        existing_nullable=False,
        existing_server_default="created",
    )
    op.create_check_constraint(
        op.f("ck_analyses_status"), "analyses", _in("status", _ANALYSIS_STATUSES_OLD)
    )
