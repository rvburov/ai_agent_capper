"""Этап 4: дашборд и аналитика.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-13

Одна миграция на весь этап (волны 1–5): только новые колонки с NULL или DEFAULT, индексы,
новые таблицы и расширенные CHECK — код этапа 3 работает на новой схеме.
- bet_legs: счет по сетам, кто и когда рассчитал ногу, закрывающий кэф обратного исхода,
  чей кэф закрытия и откуда он, вероятность закрытия без маржи; индекс открытых ног
  по матчу (авторасчет этапа 5);
- bets: кто рассчитал ставку; индекс рассчитанных ставок по времени расчета (периоды);
- ставки и ноги старого бота помечаются settled_by / result_source = legacy;
- match_stats: индекс по игроку (подача в карточке игрока);
- player_elo_current: текущее Эло и место по Эло (список игроков);
- bookmakers: «Мои букмекеры» (В9), заполняются из ставок и анализов участника;
- notification_prefs: что присылать (на сайте, push — этап 6);
- play_limits: ответственная игра (В8);
- users.deletion_requested_at: удаление аккаунта самим участником (В10);
- app_settings.default_tz: часовой пояс по умолчанию;
- notifications: вид ai_alert (сигналы расхода ИИ, TOKEN_ECONOMY.md, раздел 6);
- strategy_versions: правила «рост ставки при росте банка» (up15) и «прибыльная неделя»
  (week_win) выключаются у действующих и кандидатных версий участников (В7, Р24).
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


_SETTLED_BY = ("manual", "auto", "legacy")
_CLOSING_SOURCES = ("user", "archive")
_CURRENCIES = ("RUB", "USD", "EUR")
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
)
_NOTIFICATION_KINDS_NEW = (*_NOTIFICATION_KINDS_OLD, "ai_alert")
_DEFAULT_TZ = "Europe/Helsinki"
# Правила адаптации, выключенные решением В7: ключи params.adapt
_ADAPT_OFF = '{"up15": false, "week_win": false}'


def _replace_check(table: str, name: str, condition: str) -> None:
    op.drop_constraint(op.f(name), table, type_="check")
    op.create_check_constraint(op.f(name), table, condition)


def _timestamp(name: str, *, nullable: bool = True) -> "sa.Column[Any]":
    if nullable:
        return sa.Column(name, sa.DateTime(timezone=True), nullable=True)
    return sa.Column(
        name, sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _upgrade_bets() -> None:
    for column in (
        sa.Column("score", sa.String(length=32), nullable=True),
        _timestamp("settled_at"),
        sa.Column("result_source", sa.String(length=8), nullable=True),
        sa.Column("closing_opp_odds", sa.Numeric(precision=6, scale=3), nullable=True),
        sa.Column("closing_bookmaker", sa.String(length=64), nullable=True),
        sa.Column("closing_source", sa.String(length=8), nullable=True),
        sa.Column("q_close", sa.Double(), nullable=True),
    ):
        op.add_column("bet_legs", column)
    op.create_check_constraint(
        op.f("ck_bet_legs_result_source"), "bet_legs", _in("result_source", _SETTLED_BY)
    )
    op.create_check_constraint(
        op.f("ck_bet_legs_closing_source"), "bet_legs", _in("closing_source", _CLOSING_SOURCES)
    )
    op.create_check_constraint(
        op.f("ck_bet_legs_q_close_range"), "bet_legs", "q_close >= 0 AND q_close <= 1"
    )
    op.create_check_constraint(
        op.f("ck_bet_legs_closing_opp_odds_min"), "bet_legs", "closing_opp_odds >= 1.01"
    )
    op.create_index(
        "ix_bet_legs_open_match_id",
        "bet_legs",
        ["match_id"],
        unique=False,
        postgresql_where=sa.text("result IS NULL"),
    )

    op.add_column("bets", sa.Column("settled_by", sa.String(length=8), nullable=True))
    op.create_check_constraint(op.f("ck_bets_settled_by"), "bets", _in("settled_by", _SETTLED_BY))
    op.create_index(
        "ix_bets_user_id_settled_at",
        "bets",
        ["user_id", "settled_at"],
        unique=False,
        postgresql_where=sa.text("status <> 'open'"),
    )
    # История старого бота: кто рассчитал — импорт, момент расчета ноги — расчет ставки
    op.execute("UPDATE bets SET settled_by = 'legacy' WHERE source = 'legacy' AND status <> 'open'")
    op.execute(
        "UPDATE bet_legs l SET result_source = 'legacy', settled_at = b.settled_at"
        " FROM bets b WHERE b.id = l.bet_id AND b.source = 'legacy' AND l.result IS NOT NULL"
    )


def _upgrade_players() -> None:
    op.create_index("ix_match_stats_player_id", "match_stats", ["player_id"], unique=False)
    op.create_table(
        "player_elo_current",
        sa.Column("player_id", sa.BigInteger(), nullable=False),
        sa.Column("elo_all", sa.Double(), nullable=True),
        sa.Column("elo_hard", sa.Double(), nullable=True),
        sa.Column("elo_clay", sa.Double(), nullable=True),
        sa.Column("elo_grass", sa.Double(), nullable=True),
        sa.Column("n_all", sa.Integer(), server_default="0", nullable=False),
        sa.Column("n_hard", sa.Integer(), server_default="0", nullable=False),
        sa.Column("n_clay", sa.Integer(), server_default="0", nullable=False),
        sa.Column("n_grass", sa.Integer(), server_default="0", nullable=False),
        sa.Column("rank_all", sa.Integer(), nullable=True),
        sa.Column("last_match", sa.Date(), nullable=True),
        sa.Column("matches_52w", sa.Integer(), server_default="0", nullable=False),
        sa.Column("as_of", sa.Date(), nullable=False),
        sa.ForeignKeyConstraint(
            ["player_id"],
            ["players.id"],
            name=op.f("fk_player_elo_current_player_id_players"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("player_id", name=op.f("pk_player_elo_current")),
    )
    op.create_index(
        "ix_player_elo_current_rank_all", "player_elo_current", ["rank_all"], unique=False
    )


def _upgrade_member_tables() -> None:
    op.create_table(
        "bookmakers",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=64), nullable=False),
        _timestamp("archived_at"),
        _timestamp("created_at", nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_bookmakers_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_bookmakers")),
    )
    op.create_index(
        "uq_bookmakers_user_id_name",
        "bookmakers",
        ["user_id", sa.literal_column("lower(name)")],
        unique=True,
    )
    # Букмекеры из ставок и анализов участника: одно название без учета регистра, из
    # написаний — самое частое по ставкам и анализам вместе, добавлен — при первом упоминании
    op.execute(
        """
        INSERT INTO bookmakers (user_id, name, created_at)
        SELECT DISTINCT ON (user_id, lower(name)) user_id, name,
               min(first_at) OVER (PARTITION BY user_id, lower(name))
        FROM (
            SELECT user_id, name, sum(uses) AS uses, min(first_at) AS first_at
            FROM (
                SELECT user_id, btrim(bookmaker) AS name, count(*) AS uses,
                       min(placed_at) AS first_at
                FROM bets WHERE btrim(bookmaker) <> '' GROUP BY user_id, btrim(bookmaker)
                UNION ALL
                SELECT user_id, btrim(bookmaker), count(*), min(created_at)
                FROM analyses WHERE btrim(bookmaker) <> '' GROUP BY user_id, btrim(bookmaker)
            ) AS by_source
            GROUP BY user_id, name
        ) AS used
        ORDER BY user_id, lower(name), uses DESC, name
        """
    )

    op.create_table(
        "notification_prefs",
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("on_site", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("push", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.CheckConstraint(
            _in("kind", _NOTIFICATION_KINDS_NEW), name=op.f("ck_notification_prefs_kind")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_notification_prefs_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "kind", name=op.f("pk_notification_prefs")),
    )

    op.create_table(
        "play_limits",
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("bets_per_day", sa.SmallInteger(), nullable=True),
        sa.Column("stake_per_day", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column("currency", sa.CHAR(length=3), nullable=True),
        sa.Column("pending_bets_per_day", sa.SmallInteger(), nullable=True),
        sa.Column("pending_stake_per_day", sa.Numeric(precision=12, scale=2), nullable=True),
        _timestamp("pending_from"),
        _timestamp("paused_until"),
        _timestamp("updated_at", nullable=False),
        sa.CheckConstraint(
            "bets_per_day BETWEEN 1 AND 20", name=op.f("ck_play_limits_bets_per_day_range")
        ),
        sa.CheckConstraint(
            "pending_bets_per_day BETWEEN 1 AND 20",
            name=op.f("ck_play_limits_pending_bets_per_day_range"),
        ),
        sa.CheckConstraint(
            "stake_per_day > 0 AND pending_stake_per_day > 0",
            name=op.f("ck_play_limits_stake_per_day_positive"),
        ),
        sa.CheckConstraint(
            "(stake_per_day IS NULL AND pending_stake_per_day IS NULL) OR currency IS NOT NULL",
            name=op.f("ck_play_limits_stake_currency"),
        ),
        sa.CheckConstraint(_in("currency", _CURRENCIES), name=op.f("ck_play_limits_currency")),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_play_limits_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_play_limits")),
    )

    op.add_column("users", _timestamp("deletion_requested_at"))


def _upgrade_settings() -> None:
    op.add_column(
        "app_settings",
        sa.Column("default_tz", sa.String(length=64), server_default=_DEFAULT_TZ, nullable=False),
    )
    _replace_check("notifications", "ck_notifications_kind", _in("kind", _NOTIFICATION_KINDS_NEW))
    # В7: у версий стратегии в работе рост ставки и прибыльная неделя выключаются. Старые
    # (archived) версии и история бота — как были: они описывают прошлое
    op.execute(
        "UPDATE strategy_versions"
        " SET params = params || jsonb_build_object('adapt',"
        f" COALESCE(params -> 'adapt', '{{}}'::jsonb) || '{_ADAPT_OFF}'::jsonb)"
        " WHERE status IN ('active', 'candidate') AND code <> 'legacy'"
    )


def upgrade() -> None:
    _upgrade_bets()
    _upgrade_players()
    _upgrade_member_tables()
    _upgrade_settings()


def downgrade() -> None:
    """Откат теряет данные этапа 4 в новых колонках и таблицах. Уведомления вида ai_alert
    удаляются (это оповещения, код этапа 3 их не показывает), иначе старое ограничение не
    дало бы обновлять эти строки. Выключенные правила адаптации остаются выключенными:
    код этапа 3 читает params.adapt так же."""
    op.execute("DELETE FROM notifications WHERE kind = 'ai_alert'")
    _replace_check("notifications", "ck_notifications_kind", _in("kind", _NOTIFICATION_KINDS_OLD))
    op.drop_column("app_settings", "default_tz")

    op.drop_column("users", "deletion_requested_at")
    op.drop_table("play_limits")
    op.drop_table("notification_prefs")
    op.drop_index("uq_bookmakers_user_id_name", table_name="bookmakers")
    op.drop_table("bookmakers")

    op.drop_index("ix_player_elo_current_rank_all", table_name="player_elo_current")
    op.drop_table("player_elo_current")
    op.drop_index("ix_match_stats_player_id", table_name="match_stats")

    op.drop_index("ix_bets_user_id_settled_at", table_name="bets")
    op.drop_constraint(op.f("ck_bets_settled_by"), "bets", type_="check")
    op.drop_column("bets", "settled_by")
    op.drop_index("ix_bet_legs_open_match_id", table_name="bet_legs")
    for name in ("closing_opp_odds_min", "q_close_range", "closing_source", "result_source"):
        op.drop_constraint(op.f(f"ck_bet_legs_{name}"), "bet_legs", type_="check")
    for column in (
        "q_close",
        "closing_source",
        "closing_bookmaker",
        "closing_opp_odds",
        "result_source",
        "settled_at",
        "score",
    ):
        op.drop_column("bet_legs", column)
