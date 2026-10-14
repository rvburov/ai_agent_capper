"""Этап 4: индексы триграмм по формам имени игрока для поиска.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-14

Поиск игроков (app/services/players.py, ввод анализа и подсказки) сравнивает запрос с
формами имени: как есть, с «е» вместо «е с двумя точками», и в упрощенном написании
(c, q → k; z → s; w → v; y, j → i). Раньше сходство считалось для всех 2 800 игроков
(около 50–80 мс на запрос), теперь кандидаты находятся по этим индексам операторами % и
<% (около 10–15 мс), результаты те же. Выражения — как в app/db/models/tennis.py
(plain_name_form, skel_name_form и индексы в конце модуля): индекс по выражению подходит
только к тому же выражению. Только индексы: данные не меняются, код до этой миграции их
не использует.
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_YO = "\u0451\u0401"
_YE = "еЕ"
_INDEXES = {
    "ix_players_name_plain_trgm": f"translate(name, '{_YO}', '{_YE}')",
    "ix_players_name_ru_plain_trgm": f"translate(name_ru, '{_YO}', '{_YE}')",
    "ix_players_name_skel_trgm": "translate(lower(name), 'cqzwyj', 'kksvii')",
    "ix_players_name_ru_skel_trgm": "translate(lower(name_ru), 'cqzwyj', 'kksvii')",
}


def upgrade() -> None:
    for name, expression in _INDEXES.items():
        op.execute(f"CREATE INDEX {name} ON players USING gin ({expression} gin_trgm_ops)")


def downgrade() -> None:
    for name in _INDEXES:
        op.execute(f"DROP INDEX IF EXISTS {name}")
