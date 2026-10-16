"""Этап 6: push-уведомления и тихие часы.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-16

Только новые колонки с DEFAULT или NULL и одно ограничение:
- users: тихие часы push (quiet_enabled, quiet_start, quiet_end; по умолчанию включены,
  23:00–08:00 по поясу пользователя, В3) и CHECK, что начало не совпадает с концом;
- push_subscriptions: устройство из User-Agent при подписке (device), время последней
  доставки (last_sent_at) и сеанс, в котором push включили (session_id: отзыв сеанса
  отзывает подписку, удаление сеанса ночной очисткой оставляет NULL — push не уходит);
  прежние подписки без сеанса push не получают, их включают заново;
- notification_prefs: до этапа 6 push был только показом и в строках стоял false. Значение
  по умолчанию теперь — В2: push включен у всех видов, кроме обучения модели и сигналов
  расхода ИИ; прежние строки получают его.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | Sequence[str] | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("quiet_enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("quiet_start", sa.Time(), server_default=sa.text("'23:00'"), nullable=False),
    )
    op.add_column(
        "users",
        sa.Column("quiet_end", sa.Time(), server_default=sa.text("'08:00'"), nullable=False),
    )
    op.create_check_constraint(op.f("ck_users_quiet_range"), "users", "quiet_start <> quiet_end")
    op.add_column(
        "push_subscriptions",
        sa.Column("device", sa.String(length=100), server_default="", nullable=False),
    )
    op.add_column(
        "push_subscriptions",
        sa.Column("last_sent_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column("push_subscriptions", sa.Column("session_id", sa.BigInteger(), nullable=True))
    op.create_foreign_key(
        op.f("fk_push_subscriptions_session_id_sessions"),
        "push_subscriptions",
        "sessions",
        ["session_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_push_subscriptions_session_id", "push_subscriptions", ["session_id"], unique=False
    )
    op.execute("UPDATE notification_prefs SET push = kind NOT IN ('learning', 'ai_alert')")


def downgrade() -> None:
    """Откат теряет тихие часы, устройства, сеансы и время доставки подписок; push в настройках
    снова только показ (false)."""
    op.execute("UPDATE notification_prefs SET push = false")
    op.drop_index("ix_push_subscriptions_session_id", table_name="push_subscriptions")
    op.drop_constraint(
        op.f("fk_push_subscriptions_session_id_sessions"), "push_subscriptions", type_="foreignkey"
    )
    op.drop_column("push_subscriptions", "session_id")
    op.drop_column("push_subscriptions", "last_sent_at")
    op.drop_column("push_subscriptions", "device")
    op.drop_constraint(op.f("ck_users_quiet_range"), "users", type_="check")
    op.drop_column("users", "quiet_end")
    op.drop_column("users", "quiet_start")
    op.drop_column("users", "quiet_enabled")
