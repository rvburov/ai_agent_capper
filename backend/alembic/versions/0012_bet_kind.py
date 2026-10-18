"""Р29: вид ставки — экспресс стратегии, ординар из вариантов анализа, своя ставка.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-17

bets.kind: strategy (экспресс стратегии), single (ординар из вариантов анализа), own (своя
ставка: «В свою ставку», «Собрать свою», «Экспресс из лучших»), legacy (история старого
бота). Прежние строки заполняются по данным: ставки бота — legacy; ставки приложения с
одним событием — single (до Р29 приложение записывало только экспресс, одиночные — у
проверочных и тестовых данных), остальные — strategy. Откат убирает колонку, строки
остаются.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KINDS = ("strategy", "single", "own", "legacy")


def upgrade() -> None:
    op.add_column(
        "bets",
        sa.Column("kind", sa.String(length=8), server_default="strategy", nullable=False),
    )
    op.execute("UPDATE bets SET kind = 'legacy' WHERE source = 'legacy'")
    op.execute(
        "UPDATE bets SET kind = 'single' WHERE source = 'app'"
        " AND (SELECT count(*) FROM bet_legs WHERE bet_legs.bet_id = bets.id) = 1"
    )
    kinds = ", ".join(f"'{kind}'" for kind in _KINDS)
    op.create_check_constraint(op.f("ck_bets_kind"), "bets", f"kind IN ({kinds})")


def downgrade() -> None:
    op.drop_constraint(op.f("ck_bets_kind"), "bets", type_="check")
    op.drop_column("bets", "kind")
