"""Этап 4: смена часового пояса по умолчанию — в журнале администратора.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-14

admin_audit_log: новое действие settings_change (details — {field, from, to}), как в
макете «Администрирование → Журнал»: группа «Валюта, настройки, сообщения». Только
расширение CHECK: код до этой миграции такое действие не пишет.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
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
)
_AUDIT_ACTIONS_NEW = (*_AUDIT_ACTIONS_OLD, "settings_change")
_CHECK = "ck_admin_audit_log_action"


def _replace_check(condition: str) -> None:
    op.drop_constraint(op.f(_CHECK), "admin_audit_log", type_="check")
    op.create_check_constraint(op.f(_CHECK), "admin_audit_log", condition)


def upgrade() -> None:
    _replace_check(_in("action", _AUDIT_ACTIONS_NEW))


def downgrade() -> None:
    """Откат удаляет записи о смене настроек: прежний CHECK их не пропустит."""
    op.execute("DELETE FROM admin_audit_log WHERE action = 'settings_change'")
    _replace_check(_in("action", _AUDIT_ACTIONS_OLD))
