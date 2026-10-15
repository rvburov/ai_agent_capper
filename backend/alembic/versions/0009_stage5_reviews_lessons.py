"""Этап 5, волна 2: разборы ставок и уроки.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-15

Только новые колонки с DEFAULT или NULL, новая таблица и расширенный CHECK:
- lessons: откуда урок (origin: разбор или вручную), кто предложил вручную (created_by,
  обнуляется при удалении участника), подробности проверок (metrics: история, отложенная
  часть, быстрая проверка);
- postmortems: «почему» разбора (why), сторона общего разбора матча (side — фаворит
  базовой модели) и победитель по архиву, на котором он построен (winner: изменился —
  разбор устарел и снова в очереди);
- batch_jobs: модель, effort, версии промпта и схемы пакета (params) — по ним пишется
  agent_runs при сборе результатов;
- lesson_watches: «сообщить, когда наберется» — кто ждет урок и когда ему сообщили;
- admin_audit_log: действие lesson_off (урок выключен из анализа).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | Sequence[str] | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


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
    "data_upload",
    "eval_set",
    "eval_run",
    "version_on",
    "lesson_on",
    "model_on",
)
_AUDIT_ACTIONS_NEW = (*_AUDIT_ACTIONS_OLD, "lesson_off")
_LESSON_ORIGINS = ("postmortem", "manual")


def _replace_check(table: str, name: str, condition: str) -> None:
    op.drop_constraint(op.f(name), table, type_="check")
    op.create_check_constraint(op.f(name), table, condition)


def _jsonb(name: str) -> "sa.Column[object]":
    return sa.Column(
        name,
        postgresql.JSONB(astext_type=sa.Text()),
        server_default=sa.text("'{}'::jsonb"),
        nullable=False,
    )


def upgrade() -> None:
    op.add_column(
        "lessons",
        sa.Column("origin", sa.String(length=16), server_default="postmortem", nullable=False),
    )
    op.add_column("lessons", sa.Column("created_by", sa.BigInteger(), nullable=True))
    op.add_column("lessons", _jsonb("metrics"))
    op.create_check_constraint(op.f("ck_lessons_origin"), "lessons", _in("origin", _LESSON_ORIGINS))
    op.create_foreign_key(
        op.f("fk_lessons_created_by_users"),
        "lessons",
        "users",
        ["created_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column("postmortems", sa.Column("why", sa.Text(), nullable=True))
    op.add_column("postmortems", sa.Column("side", sa.SmallInteger(), nullable=True))
    op.add_column("postmortems", sa.Column("winner", sa.SmallInteger(), nullable=True))
    op.create_check_constraint(
        op.f("ck_postmortems_side"), "postmortems", "side IS NULL OR side IN (1, 2)"
    )
    op.create_check_constraint(
        op.f("ck_postmortems_winner"), "postmortems", "winner IS NULL OR winner IN (1, 2)"
    )
    op.add_column("batch_jobs", _jsonb("params"))

    op.create_table(
        "lesson_watches",
        sa.Column("lesson_id", sa.BigInteger(), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["lesson_id"],
            ["lessons.id"],
            name=op.f("fk_lesson_watches_lesson_id_lessons"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_lesson_watches_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("lesson_id", "user_id", name=op.f("pk_lesson_watches")),
    )
    op.create_index("ix_lesson_watches_user_id", "lesson_watches", ["user_id"], unique=False)

    _replace_check(
        "admin_audit_log", "ck_admin_audit_log_action", _in("action", _AUDIT_ACTIONS_NEW)
    )


def downgrade() -> None:
    """Откат теряет подписки «сообщить, когда наберется», подробности проверок уроков и
    записи журнала lesson_off."""
    op.execute("DELETE FROM admin_audit_log WHERE action = 'lesson_off'")
    _replace_check(
        "admin_audit_log", "ck_admin_audit_log_action", _in("action", _AUDIT_ACTIONS_OLD)
    )
    op.drop_index("ix_lesson_watches_user_id", table_name="lesson_watches")
    op.drop_table("lesson_watches")
    op.drop_column("batch_jobs", "params")
    op.drop_constraint(op.f("ck_postmortems_winner"), "postmortems", type_="check")
    op.drop_constraint(op.f("ck_postmortems_side"), "postmortems", type_="check")
    op.drop_column("postmortems", "winner")
    op.drop_column("postmortems", "side")
    op.drop_column("postmortems", "why")
    op.drop_constraint(op.f("fk_lessons_created_by_users"), "lessons", type_="foreignkey")
    op.drop_constraint(op.f("ck_lessons_origin"), "lessons", type_="check")
    op.drop_column("lessons", "metrics")
    op.drop_column("lessons", "created_by")
    op.drop_column("lessons", "origin")
