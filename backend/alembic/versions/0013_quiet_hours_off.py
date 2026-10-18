"""Тихие часы push по умолчанию выключены (решение владельца 18 октября 2026, меняет Р26).

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-18

users.quiet_enabled: по умолчанию false. Всем, у кого тихие часы были включены, — тоже
false: включение по умолчанию было не их выбором, а прежнего правила. Время окна
(quiet_start, quiet_end) не меняется: включил — работает прежнее 23:00–08:00. Откат
возвращает только значение по умолчанию, выключенные строки не трогает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | Sequence[str] | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("users", "quiet_enabled", server_default=sa.text("false"))
    op.execute("UPDATE users SET quiet_enabled = false WHERE quiet_enabled")


def downgrade() -> None:
    op.alter_column("users", "quiet_enabled", server_default=sa.text("true"))
