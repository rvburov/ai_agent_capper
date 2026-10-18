"""Новые рынки ставок (Р28): счет по геймам в ноге, рынки в экспрессе, уведомление о пороге.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-18

- bet_legs.score и archive_score: VARCHAR(32) → VARCHAR(64), с запасом. У рынков по геймам
  там счет по геймам без очков тай-брейка (games_text: «7:6 6:7 7:6 6:7 13:11» — до 5
  сетов не больше 29 символов); ввод с очками («6:4 7:6(5) 6:7(10)…») в базу не попадает.
  Расширение VARCHAR в PostgreSQL меняет только описание столбца, строки не
  переписываются, но берет ACCESS EXCLUSIVE на bet_legs.
- app_settings.express_markets: семейства новых рынков, которые администратор перевел в
  экспресс (было «для сравнения»), по умолчанию пусто; CHECK — только известные семейства.
  app_settings.markets_notified: семейства, о пройденном пороге которых уже ушло
  уведомление (одно на семейство).
  Столбец с постоянным значением по умолчанию добавляется без перезаписи таблицы.
- Вид уведомления market_ready (рынок прошел порог 150 событий и CLV) в CHECK уведомлений
  и настроек уведомлений.

Коды рынков с линией (HCP_-2.5, STOT_2.5, GHCP_-3.5, GTOT_22) живут в прежних столбцах
market VARCHAR(32): проверяет их код (app/ml/markets.py), CHECK в базе не нужен — при
обмене игроков местами к рынку прогноза на время добавляется метка (app/ingest/sackmann.py).

Блокировки: замена CHECK на notifications проверяет всю таблицу, ALTER на bet_legs берет
ACCESS EXCLUSIVE. Чтобы миграция не встала в очередь за долгим запросом аналитики и не
задержала все чтения ставок, в начале upgrade и downgrade — lock_timeout 5 с: не дождалась
блокировки — падает, повторить позже.

Откат: уведомления market_ready и их настройки удаляются, столбцы express_markets и
markets_notified удаляются. Счет длиннее 32 символов обрезается — страховка: хранимый
счет по геймам не длиннее 29 символов, так что на деле обрезки нет.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014"
down_revision: str | Sequence[str] | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_KINDS_OLD = (
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
    "bet_needs_result",
    "settle_conflict",
    "weekly_report",
    "learning",
)
_KINDS_NEW = (*_KINDS_OLD, "market_ready")
_FAMILIES = ("shcp", "stot", "ghcp", "gtot")


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _replace_check(table: str, name: str, condition: str) -> None:
    op.drop_constraint(op.f(name), table, type_="check")
    op.create_check_constraint(op.f(name), table, condition)


# Сколько ждать блокировку таблицы (docstring модуля)
_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(_LOCK_TIMEOUT)
    for column in ("score", "archive_score"):
        op.alter_column(
            "bet_legs",
            column,
            type_=sa.String(length=64),
            existing_type=sa.String(length=32),
            existing_nullable=True,
        )
    op.add_column(
        "app_settings",
        sa.Column(
            "express_markets",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
    )
    op.add_column(
        "app_settings",
        sa.Column(
            "markets_notified",
            postgresql.ARRAY(sa.Text()),
            server_default=sa.text("'{}'::text[]"),
            nullable=False,
        ),
    )
    families = ", ".join(repr(value) for value in _FAMILIES)
    op.create_check_constraint(
        op.f("ck_app_settings_express_markets_known"),
        "app_settings",
        f"express_markets <@ ARRAY[{families}]::text[]",
    )
    _replace_check("notifications", "ck_notifications_kind", _in("kind", _KINDS_NEW))
    _replace_check("notification_prefs", "ck_notification_prefs_kind", _in("kind", _KINDS_NEW))


def downgrade() -> None:
    op.execute(_LOCK_TIMEOUT)
    op.execute("DELETE FROM notifications WHERE kind = 'market_ready'")
    op.execute("DELETE FROM notification_prefs WHERE kind = 'market_ready'")
    _replace_check("notifications", "ck_notifications_kind", _in("kind", _KINDS_OLD))
    _replace_check("notification_prefs", "ck_notification_prefs_kind", _in("kind", _KINDS_OLD))
    op.drop_constraint(op.f("ck_app_settings_express_markets_known"), "app_settings", type_="check")
    op.drop_column("app_settings", "markets_notified")
    op.drop_column("app_settings", "express_markets")
    for column in ("score", "archive_score"):
        op.execute(f"UPDATE bet_legs SET {column} = left({column}, 32) WHERE length({column}) > 32")
        op.alter_column(
            "bet_legs",
            column,
            type_=sa.String(length=32),
            existing_type=sa.String(length=64),
            existing_nullable=True,
        )
