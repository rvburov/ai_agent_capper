"""Этап 4: сутки лимитов ответственной игры после смены часового пояса.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-14

play_limits.day_tz и day_tz_until: участник сменил пояс — текущие сутки лимитов
досчитываются по прежнему поясу до их конца (day_tz_until), и только потом сутки идут по
новому поясу. Иначе смена пояса обнуляла бы ставки и сумму за день (В8, Р24). Новые
колонки — с NULL, код до этой миграции их не читает.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("play_limits", sa.Column("day_tz", sa.String(length=64), nullable=True))
    op.add_column(
        "play_limits", sa.Column("day_tz_until", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_check_constraint(
        op.f("ck_play_limits_day_tz_pair"),
        "play_limits",
        "(day_tz IS NULL) = (day_tz_until IS NULL)",
    )


def downgrade() -> None:
    """Откат забывает прежний пояс суток: сутки сразу считаются по поясу участника."""
    op.drop_constraint(op.f("ck_play_limits_day_tz_pair"), "play_limits", type_="check")
    op.drop_column("play_limits", "day_tz_until")
    op.drop_column("play_limits", "day_tz")
