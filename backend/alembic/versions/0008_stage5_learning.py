"""Этап 5: петля обучения.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-15

Одна миграция на весь этап (волны 1–4): новые колонки с NULL или DEFAULT, новые таблицы и
расширенные CHECK — код этапа 4 работает на новой схеме.
- data_uploads: файл tennis-data, загруженный администратором на сайте (В1, Р25);
- bets: запуск расчета по архиву, которым рассчитана ставка (settle_run_id),
  напоминание «ставка ждет результата» (result_reminded_at) и последнее исправление
  результата участником (reversed_at: такую ставку авторасчет не трогает);
- bet_legs: исход и счет по архиву, когда он разошелся с ручным расчетом (Т3);
- notifications, notification_prefs: виды bet_needs_result, settle_conflict,
  weekly_report, learning;
- admin_audit_log: действия data_upload, eval_set, eval_run, version_on, lesson_on,
  model_on;
- lessons: условие scope (jsonb) вместо scope_sql (колонка пуста, Т7), общие уроки
  (user_id пустой, Р25), основание прогнозами, эффект с усадкой и на отложенной части,
  решение и перепроверка; статус ready — ждет решения;
- strategy_versions: общая линия инструкций (user_id пустой), кандидат от версии
  (parent_id), цель, изменения, кто решил, когда стала архивной; статус rejected;
- ml_models: версии модели со статусом и одной активной на вид (Т12, Т13);
- postmortems, batch_jobs, eval_sets, eval_set_items, eval_comparisons, weekly_reports;
- eval_runs: набор, номер повтора, статус, пакет, предел ответа (Т9, Т10).
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


_NOTIFICATION_KINDS_OLD = (
    "bet_settled",
    "data_stale",
    "limit_80",
    "limit_100",
    "new_device",
    "admin_message",
    "login_failures",
    "ai_key_failed",
    "ai_mode_request",
    "ai_mode_decision",
    "budget_80",
    "budget_100",
    "ai_alert",
)
_NOTIFICATION_KINDS_ADDED = ("bet_needs_result", "settle_conflict", "weekly_report", "learning")
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
    "ai_mode_change",
    "budget_change",
    "agent_config_change",
    "settings_change",
)
_AUDIT_ACTIONS_ADDED = (
    "data_upload",
    "eval_set",
    "eval_run",
    "version_on",
    "lesson_on",
    "model_on",
)
_AUDIT_ACTIONS_NEW = (*_AUDIT_ACTIONS_OLD, *_AUDIT_ACTIONS_ADDED)
_LEG_RESULTS = ("win", "loss", "void")
_LESSON_STATUSES_OLD = ("hypothesis", "confirmed", "rejected", "retired")
_LESSON_STATUSES_NEW = ("hypothesis", "ready", "confirmed", "rejected", "retired")
_STRATEGY_STATUSES_OLD = ("candidate", "active", "archived")
_STRATEGY_STATUSES_NEW = ("candidate", "active", "archived", "rejected")
_STRATEGY_GOALS = ("quality", "saving", "rules")
_ML_MODEL_STATUSES = ("candidate", "active", "archived", "rejected")
_UPLOAD_STATUSES = ("queued", "running", "done", "failed")
_POSTMORTEM_STATUSES = ("queued", "submitted", "done", "failed")
_POSTMORTEM_VERDICTS = ("fine", "lucky", "luck", "model_error", "data_gap")
_BATCH_KINDS = ("postmortem", "eval", "shadow")
_BATCH_STATUSES = ("pending", "submitted", "collected", "failed", "lost", "abandoned")
_EVAL_ITEM_SPLITS = ("train", "validation", "test", "smoke")
_EVAL_RUN_STATUSES = ("pending", "running", "done", "failed", "abandoned")
_EVAL_RULES = ("improve", "non_inferior")


def _replace_check(table: str, name: str, condition: str) -> None:
    op.drop_constraint(op.f(name), table, type_="check")
    op.create_check_constraint(op.f(name), table, condition)


def _timestamp(name: str, *, nullable: bool = True) -> "sa.Column[Any]":
    if nullable:
        return sa.Column(name, sa.DateTime(timezone=True), nullable=True)
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _id() -> "sa.Column[Any]":
    return sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False)


def _fk(column: str, table: str, target: str, ondelete: str | None = None) -> Any:
    return sa.ForeignKeyConstraint(
        [column],
        [f"{target}.id"],
        name=op.f(f"fk_{table}_{column}_{target}"),
        ondelete=ondelete,
    )


def _jsonb(name: str) -> "sa.Column[Any]":
    return sa.Column(
        name,
        postgresql.JSONB(astext_type=sa.Text()),
        server_default=sa.text("'{}'::jsonb"),
        nullable=False,
    )


def _upgrade_settlement() -> None:
    op.create_table(
        "data_uploads",
        _id(),
        sa.Column("uploaded_by", sa.BigInteger(), nullable=True),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("year", sa.SmallInteger(), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="queued", nullable=False),
        sa.Column("step", sa.String(length=32), nullable=True),
        sa.Column("content", sa.LargeBinary(), nullable=True),
        _jsonb("report"),
        sa.Column("error", sa.Text(), nullable=True),
        _timestamp("started_at"),
        _timestamp("finished_at"),
        _timestamp("created_at", nullable=False),
        sa.CheckConstraint(_in("status", _UPLOAD_STATUSES), name=op.f("ck_data_uploads_status")),
        sa.CheckConstraint("size_bytes >= 0", name=op.f("ck_data_uploads_size_non_negative")),
        _fk("uploaded_by", "data_uploads", "users", "SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_data_uploads")),
    )
    op.create_index(
        "ix_data_uploads_created_at",
        "data_uploads",
        [sa.literal_column("created_at DESC")],
        unique=False,
    )

    op.add_column("bets", sa.Column("settle_run_id", sa.BigInteger(), nullable=True))
    op.add_column("bets", _timestamp("result_reminded_at"))
    op.add_column("bets", _timestamp("reversed_at"))
    op.create_foreign_key(
        op.f("fk_bets_settle_run_id_ingestion_runs"),
        "bets",
        "ingestion_runs",
        ["settle_run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column("bet_legs", sa.Column("archive_result", sa.String(length=8), nullable=True))
    op.add_column("bet_legs", sa.Column("archive_score", sa.String(length=32), nullable=True))
    op.create_check_constraint(
        op.f("ck_bet_legs_archive_result"), "bet_legs", _in("archive_result", _LEG_RESULTS)
    )

    _replace_check("notifications", "ck_notifications_kind", _in("kind", _NOTIFICATION_KINDS_NEW))
    _replace_check(
        "notification_prefs", "ck_notification_prefs_kind", _in("kind", _NOTIFICATION_KINDS_NEW)
    )
    _replace_check(
        "admin_audit_log", "ck_admin_audit_log_action", _in("action", _AUDIT_ACTIONS_NEW)
    )


def _upgrade_lessons_and_versions() -> None:
    # Колонка пуста: кода, который пишет уроки, до этапа 5 не было (Т7)
    op.drop_column("lessons", "scope_sql")
    op.add_column(
        "lessons", sa.Column("scope", postgresql.JSONB(astext_type=sa.Text()), nullable=True)
    )
    op.alter_column("lessons", "user_id", existing_type=sa.BigInteger(), nullable=True)
    for column in (
        sa.Column("n_hist", sa.Integer(), server_default="0", nullable=False),
        sa.Column("effect_shrunk", sa.Double(), nullable=True),
        sa.Column("holdout_effect", sa.Double(), nullable=True),
        sa.Column("holdout_ci", postgresql.ARRAY(sa.Double()), nullable=True),
        sa.Column(
            "source_prediction_ids",
            postgresql.ARRAY(sa.BigInteger()),
            server_default=sa.text("'{}'::bigint[]"),
            nullable=False,
        ),
        sa.Column("decided_by", sa.BigInteger(), nullable=True),
        _timestamp("decided_at"),
        _timestamp("retired_at"),
        _timestamp("rechecked_at"),
    ):
        op.add_column("lessons", column)
    op.create_foreign_key(
        op.f("fk_lessons_decided_by_users"),
        "lessons",
        "users",
        ["decided_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.drop_constraint(op.f("uq_lessons_user_id_code"), "lessons", type_="unique")
    op.create_unique_constraint(
        op.f("uq_lessons_user_id_code"),
        "lessons",
        ["user_id", "code"],
        postgresql_nulls_not_distinct=True,
    )
    _replace_check("lessons", "ck_lessons_status", _in("status", _LESSON_STATUSES_NEW))

    op.alter_column("strategy_versions", "user_id", existing_type=sa.BigInteger(), nullable=True)
    for column in (
        sa.Column("parent_id", sa.BigInteger(), nullable=True),
        sa.Column("goal", sa.String(length=16), nullable=True),
        sa.Column(
            "changes",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
        sa.Column("decided_by", sa.BigInteger(), nullable=True),
        _timestamp("archived_at"),
    ):
        op.add_column("strategy_versions", column)
    op.create_foreign_key(
        op.f("fk_strategy_versions_parent_id_strategy_versions"),
        "strategy_versions",
        "strategy_versions",
        ["parent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_strategy_versions_decided_by_users"),
        "strategy_versions",
        "users",
        ["decided_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        op.f("ck_strategy_versions_goal"), "strategy_versions", _in("goal", _STRATEGY_GOALS)
    )
    _replace_check(
        "strategy_versions", "ck_strategy_versions_status", _in("status", _STRATEGY_STATUSES_NEW)
    )
    op.drop_constraint(
        op.f("uq_strategy_versions_user_id_code"), "strategy_versions", type_="unique"
    )
    op.create_unique_constraint(
        op.f("uq_strategy_versions_user_id_code"),
        "strategy_versions",
        ["user_id", "code"],
        postgresql_nulls_not_distinct=True,
    )
    op.drop_index("uq_strategy_versions_user_id_active", table_name="strategy_versions")
    op.create_index(
        "uq_strategy_versions_user_id_active",
        "strategy_versions",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        postgresql_nulls_not_distinct=True,
    )

    for column in (
        sa.Column("status", sa.String(length=16), server_default="active", nullable=False),
        sa.Column("parent_id", sa.String(length=64), nullable=True),
        _timestamp("activated_at"),
        sa.Column("activated_by", sa.BigInteger(), nullable=True),
    ):
        op.add_column("ml_models", column)
    # Активная версия вида — одна: из прежних строк вида активна самая новая
    op.execute(
        "UPDATE ml_models m SET status = 'archived' WHERE EXISTS (SELECT 1 FROM ml_models o"
        " WHERE o.kind = m.kind AND (o.created_at, o.id) > (m.created_at, m.id))"
    )
    op.create_check_constraint(
        op.f("ck_ml_models_status"), "ml_models", _in("status", _ML_MODEL_STATUSES)
    )
    op.create_foreign_key(
        op.f("fk_ml_models_parent_id_ml_models"),
        "ml_models",
        "ml_models",
        ["parent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        op.f("fk_ml_models_activated_by_users"),
        "ml_models",
        "users",
        ["activated_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "uq_ml_models_kind_active",
        "ml_models",
        ["kind"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )


def _upgrade_learning_tables() -> None:
    op.create_table(
        "batch_jobs",
        _id(),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("batch_id", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("requests", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "worst_usd", sa.Numeric(precision=12, scale=6), server_default="0", nullable=False
        ),
        sa.Column(
            "cost_usd", sa.Numeric(precision=12, scale=6), server_default="0", nullable=False
        ),
        _timestamp("submitted_at"),
        _timestamp("ended_at"),
        sa.Column("error", sa.Text(), nullable=True),
        _timestamp("created_at", nullable=False),
        sa.CheckConstraint(_in("kind", _BATCH_KINDS), name=op.f("ck_batch_jobs_kind")),
        sa.CheckConstraint(_in("status", _BATCH_STATUSES), name=op.f("ck_batch_jobs_status")),
        sa.CheckConstraint(
            "worst_usd >= 0 AND cost_usd >= 0", name=op.f("ck_batch_jobs_money_non_negative")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_batch_jobs")),
        sa.UniqueConstraint("batch_id", name=op.f("uq_batch_jobs_batch_id")),
    )
    op.create_index("ix_batch_jobs_kind_status", "batch_jobs", ["kind", "status"], unique=False)

    op.create_table(
        "eval_sets",
        _id(),
        sa.Column("code", sa.String(length=64), nullable=False),
        _timestamp("frozen_at"),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("n_events", sa.Integer(), server_default="0", nullable=False),
        sa.Column("since", sa.Date(), nullable=True),
        _jsonb("rules"),
        _timestamp("created_at", nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_eval_sets")),
        sa.UniqueConstraint("code", name=op.f("uq_eval_sets_code")),
    )
    op.create_table(
        "eval_set_items",
        _id(),
        sa.Column("eval_set_id", sa.BigInteger(), nullable=False),
        sa.Column("match_id", sa.BigInteger(), nullable=False),
        sa.Column("dossier_id", sa.BigInteger(), nullable=True),
        sa.Column("split", sa.String(length=16), server_default="test", nullable=False),
        sa.Column("hard", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("with_news", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.CheckConstraint(_in("split", _EVAL_ITEM_SPLITS), name=op.f("ck_eval_set_items_split")),
        _fk("eval_set_id", "eval_set_items", "eval_sets", "CASCADE"),
        _fk("match_id", "eval_set_items", "matches"),
        _fk("dossier_id", "eval_set_items", "dossiers", "SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_eval_set_items")),
        sa.UniqueConstraint(
            "eval_set_id", "match_id", name=op.f("uq_eval_set_items_eval_set_id_match_id")
        ),
    )
    op.create_index("ix_eval_set_items_match_id", "eval_set_items", ["match_id"], unique=False)

    for column in (
        sa.Column("eval_set_id", sa.BigInteger(), nullable=True),
        sa.Column("repeat_no", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("status", sa.String(length=16), nullable=True),
        sa.Column("batch_job_id", sa.BigInteger(), nullable=True),
        sa.Column("max_tokens", sa.Integer(), nullable=True),
    ):
        op.add_column("eval_runs", column)
    op.create_check_constraint(
        op.f("ck_eval_runs_status"), "eval_runs", _in("status", _EVAL_RUN_STATUSES)
    )
    for name, target in (("eval_set_id", "eval_sets"), ("batch_job_id", "batch_jobs")):
        op.create_foreign_key(
            op.f(f"fk_eval_runs_{name}_{target}"),
            "eval_runs",
            target,
            [name],
            ["id"],
            ondelete="SET NULL",
        )

    op.create_table(
        "eval_comparisons",
        _id(),
        sa.Column("candidate_run_id", sa.BigInteger(), nullable=False),
        sa.Column("baseline_run_id", sa.BigInteger(), nullable=False),
        sa.Column("noise_run_id", sa.BigInteger(), nullable=True),
        sa.Column("rule", sa.String(length=16), nullable=False),
        _jsonb("metrics"),
        sa.Column("passed", sa.Boolean(), nullable=True),
        _timestamp("created_at", nullable=False),
        sa.CheckConstraint(_in("rule", _EVAL_RULES), name=op.f("ck_eval_comparisons_rule")),
        _fk("candidate_run_id", "eval_comparisons", "eval_runs", "CASCADE"),
        _fk("baseline_run_id", "eval_comparisons", "eval_runs", "CASCADE"),
        _fk("noise_run_id", "eval_comparisons", "eval_runs", "SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_eval_comparisons")),
    )
    op.create_index(
        "ix_eval_comparisons_candidate_run_id",
        "eval_comparisons",
        ["candidate_run_id"],
        unique=False,
    )

    op.create_table(
        "postmortems",
        _id(),
        sa.Column("match_id", sa.BigInteger(), nullable=False),
        sa.Column("prediction_id", sa.BigInteger(), nullable=False),
        sa.Column("bet_id", sa.BigInteger(), nullable=True),
        sa.Column("user_id", sa.BigInteger(), nullable=True),
        sa.Column("batch_job_id", sa.BigInteger(), nullable=True),
        sa.Column("agent_run_id", sa.BigInteger(), nullable=True),
        sa.Column("status", sa.String(length=16), server_default="queued", nullable=False),
        sa.Column("verdict", sa.String(length=16), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("hypothesis", sa.Text(), nullable=True),
        sa.Column("scope", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("lesson_id", sa.BigInteger(), nullable=True),
        _timestamp("created_at", nullable=False),
        sa.CheckConstraint(_in("status", _POSTMORTEM_STATUSES), name=op.f("ck_postmortems_status")),
        sa.CheckConstraint(
            _in("verdict", _POSTMORTEM_VERDICTS), name=op.f("ck_postmortems_verdict")
        ),
        _fk("match_id", "postmortems", "matches"),
        _fk("prediction_id", "postmortems", "predictions", "CASCADE"),
        _fk("bet_id", "postmortems", "bets", "SET NULL"),
        _fk("user_id", "postmortems", "users", "SET NULL"),
        _fk("batch_job_id", "postmortems", "batch_jobs", "SET NULL"),
        _fk("agent_run_id", "postmortems", "agent_runs", "SET NULL"),
        _fk("lesson_id", "postmortems", "lessons", "SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_postmortems")),
        sa.UniqueConstraint("prediction_id", name=op.f("uq_postmortems_prediction_id")),
    )
    for name in ("match_id", "bet_id", "user_id"):
        op.create_index(f"ix_postmortems_{name}", "postmortems", [name], unique=False)

    op.create_table(
        "weekly_reports",
        _id(),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("week_start", sa.Date(), nullable=False),
        _jsonb("payload"),
        _timestamp("created_at", nullable=False),
        _fk("user_id", "weekly_reports", "users", "CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_weekly_reports")),
        sa.UniqueConstraint(
            "user_id", "week_start", name=op.f("uq_weekly_reports_user_id_week_start")
        ),
    )


def upgrade() -> None:
    _upgrade_settlement()
    _upgrade_lessons_and_versions()
    _upgrade_learning_tables()


def downgrade() -> None:
    """Откат теряет данные этапа 5 в новых колонках и таблицах. Уведомления и записи
    журнала новых видов удаляются (прежний CHECK их не пропустит). Общие уроки и версии
    инструкций (user_id пустой) удаляются: у прежней схемы их нет. Уроки со статусом
    ready возвращаются в hypothesis, отклоненные кандидаты стратегии — в archived."""
    op.drop_table("weekly_reports")
    for column in ("user_id", "bet_id", "match_id"):
        op.drop_index(f"ix_postmortems_{column}", table_name="postmortems")
    op.drop_table("postmortems")
    op.drop_index("ix_eval_comparisons_candidate_run_id", table_name="eval_comparisons")
    op.drop_table("eval_comparisons")
    for column, target in (("batch_job_id", "batch_jobs"), ("eval_set_id", "eval_sets")):
        op.drop_constraint(op.f(f"fk_eval_runs_{column}_{target}"), "eval_runs", type_="foreignkey")
    op.drop_constraint(op.f("ck_eval_runs_status"), "eval_runs", type_="check")
    for column in ("max_tokens", "batch_job_id", "status", "repeat_no", "eval_set_id"):
        op.drop_column("eval_runs", column)
    op.drop_index("ix_eval_set_items_match_id", table_name="eval_set_items")
    op.drop_table("eval_set_items")
    op.drop_table("eval_sets")
    op.drop_index("ix_batch_jobs_kind_status", table_name="batch_jobs")
    op.drop_table("batch_jobs")

    op.drop_index("uq_ml_models_kind_active", table_name="ml_models")
    op.drop_constraint(op.f("fk_ml_models_activated_by_users"), "ml_models", type_="foreignkey")
    op.drop_constraint(op.f("fk_ml_models_parent_id_ml_models"), "ml_models", type_="foreignkey")
    op.drop_constraint(op.f("ck_ml_models_status"), "ml_models", type_="check")
    for column in ("activated_by", "activated_at", "parent_id", "status"):
        op.drop_column("ml_models", column)

    op.execute("DELETE FROM strategy_versions WHERE user_id IS NULL")
    op.execute("UPDATE strategy_versions SET status = 'archived' WHERE status = 'rejected'")
    op.drop_index("uq_strategy_versions_user_id_active", table_name="strategy_versions")
    op.create_index(
        "uq_strategy_versions_user_id_active",
        "strategy_versions",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.drop_constraint(
        op.f("uq_strategy_versions_user_id_code"), "strategy_versions", type_="unique"
    )
    op.create_unique_constraint(
        op.f("uq_strategy_versions_user_id_code"), "strategy_versions", ["user_id", "code"]
    )
    _replace_check(
        "strategy_versions", "ck_strategy_versions_status", _in("status", _STRATEGY_STATUSES_OLD)
    )
    op.drop_constraint(op.f("ck_strategy_versions_goal"), "strategy_versions", type_="check")
    op.drop_constraint(
        op.f("fk_strategy_versions_decided_by_users"), "strategy_versions", type_="foreignkey"
    )
    op.drop_constraint(
        op.f("fk_strategy_versions_parent_id_strategy_versions"),
        "strategy_versions",
        type_="foreignkey",
    )
    for column in ("archived_at", "decided_by", "changes", "goal", "parent_id"):
        op.drop_column("strategy_versions", column)
    op.alter_column("strategy_versions", "user_id", existing_type=sa.BigInteger(), nullable=False)

    op.execute("DELETE FROM lessons WHERE user_id IS NULL")
    op.execute("UPDATE lessons SET status = 'hypothesis' WHERE status = 'ready'")
    _replace_check("lessons", "ck_lessons_status", _in("status", _LESSON_STATUSES_OLD))
    op.drop_constraint(op.f("uq_lessons_user_id_code"), "lessons", type_="unique")
    op.create_unique_constraint(op.f("uq_lessons_user_id_code"), "lessons", ["user_id", "code"])
    op.drop_constraint(op.f("fk_lessons_decided_by_users"), "lessons", type_="foreignkey")
    for column in (
        "rechecked_at",
        "retired_at",
        "decided_at",
        "decided_by",
        "source_prediction_ids",
        "holdout_ci",
        "holdout_effect",
        "effect_shrunk",
        "n_hist",
        "scope",
    ):
        op.drop_column("lessons", column)
    op.alter_column("lessons", "user_id", existing_type=sa.BigInteger(), nullable=False)
    op.add_column("lessons", sa.Column("scope_sql", sa.Text(), nullable=True))

    added_kinds = ", ".join(repr(kind) for kind in _NOTIFICATION_KINDS_ADDED)
    op.execute(f"DELETE FROM notifications WHERE kind IN ({added_kinds})")
    op.execute(f"DELETE FROM notification_prefs WHERE kind IN ({added_kinds})")
    _replace_check("notifications", "ck_notifications_kind", _in("kind", _NOTIFICATION_KINDS_OLD))
    _replace_check(
        "notification_prefs", "ck_notification_prefs_kind", _in("kind", _NOTIFICATION_KINDS_OLD)
    )
    added_actions = ", ".join(repr(action) for action in _AUDIT_ACTIONS_ADDED)
    op.execute(f"DELETE FROM admin_audit_log WHERE action IN ({added_actions})")
    _replace_check(
        "admin_audit_log", "ck_admin_audit_log_action", _in("action", _AUDIT_ACTIONS_OLD)
    )

    op.drop_constraint(op.f("ck_bet_legs_archive_result"), "bet_legs", type_="check")
    op.drop_column("bet_legs", "archive_score")
    op.drop_column("bet_legs", "archive_result")
    op.drop_constraint(op.f("fk_bets_settle_run_id_ingestion_runs"), "bets", type_="foreignkey")
    op.drop_column("bets", "reversed_at")
    op.drop_column("bets", "result_reminded_at")
    op.drop_column("bets", "settle_run_id")
    op.drop_index("ix_data_uploads_created_at", table_name="data_uploads")
    op.drop_table("data_uploads")
