"""Р27: просмотр и выгрузка данных участника администратором — в журнале администратора.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-17

admin_audit_log: новые действия member_view (details — {user_id, screen}) и member_export
({user_id, what}). Только расширение CHECK: код до этой миграции такие действия не пишет.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0011"
down_revision: str | Sequence[str] | None = "0010"
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
    "lesson_off",
)
_AUDIT_ACTIONS_ADDED = ("member_view", "member_export")
_AUDIT_ACTIONS_NEW = (*_AUDIT_ACTIONS_OLD, *_AUDIT_ACTIONS_ADDED)
_CHECK = "ck_admin_audit_log_action"


def _replace_check(condition: str) -> None:
    op.drop_constraint(op.f(_CHECK), "admin_audit_log", type_="check")
    op.create_check_constraint(op.f(_CHECK), "admin_audit_log", condition)


def upgrade() -> None:
    _replace_check(_in("action", _AUDIT_ACTIONS_NEW))


def downgrade() -> None:
    """Откат удаляет записи о просмотрах и выгрузках: прежний CHECK их не пропустит."""
    added = ", ".join(repr(action) for action in _AUDIT_ACTIONS_ADDED)
    op.execute(f"DELETE FROM admin_audit_log WHERE action IN ({added})")
    _replace_check(_in("action", _AUDIT_ACTIONS_OLD))
