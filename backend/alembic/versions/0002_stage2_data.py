"""Этап 2: архивы Сакманна и tennis-data.co.uk.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-09

- tournaments: источник турнира (source, source_ref) и UNIQUE по ним, чтобы повторная
  загрузка архива находила свой турнир. Турниры, которые уже есть в базе, создал импорт
  старого бота: им source = legacy, source_ref пустой. Исключение — повторный upgrade
  после отката (см. downgrade): турниры с матчами из архивов остаются с пустым source;
- matches: день матча match_date (у tennis-data дата матча есть, у Сакманна — нет);
- odds_snapshots: вид кэфа archive и частичный уникальный индекс, по которому повторная
  загрузка обновляет кэф, а не добавляет строку;
- admin_audit_log: действия confirm_failed (неверный код 2FA при подтверждении
  опасного действия), player_merge и player_edit (правка игроков из терминала).
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ODDS_KINDS_OLD = "kind IN ('user', 'opening', 'closing', 'api')"
_ODDS_KINDS_NEW = "kind IN ('user', 'opening', 'closing', 'api', 'archive')"
_AUDIT_ACTIONS_OLD = (
    "'invite', 'invite_revoke', 'reset_code', 'reset_code_revoke', 'reset_2fa', 'block',"
    " 'unblock', 'delete', 'role_change', 'sessions_revoke', 'limit_change', 'key_change',"
    " 'currency_change', 'create_admin', 'import', 'message'"
)
_AUDIT_ACTIONS_NEW = f"{_AUDIT_ACTIONS_OLD}, 'confirm_failed', 'player_merge', 'player_edit'"


def upgrade() -> None:
    op.add_column("tournaments", sa.Column("source", sa.String(length=16), nullable=True))
    op.add_column("tournaments", sa.Column("source_ref", sa.String(length=64), nullable=True))
    # До этапа 2 турниры создавал только импорт истории старого бота. Турниры с матчами
    # из архивов бывают только после отката 0002: legacy им не ставим, иначе они
    # смешаются с турнирами бота (source и source_ref архива откат уже стер)
    op.execute(
        "UPDATE tournaments t SET source = 'legacy' WHERE NOT EXISTS ("
        " SELECT 1 FROM matches m"
        " WHERE m.tournament_id = t.id AND m.source IN ('sackmann', 'tennis_data'))"
    )
    op.create_unique_constraint(
        op.f("uq_tournaments_source_source_ref"), "tournaments", ["source", "source_ref"]
    )
    op.create_check_constraint(
        op.f("ck_tournaments_source"),
        "tournaments",
        "source IN ('sackmann', 'tennis_data', 'legacy')",
    )

    op.add_column("matches", sa.Column("match_date", sa.Date(), nullable=True))
    op.create_index("ix_matches_match_date", "matches", ["match_date"], unique=False)

    op.drop_constraint(op.f("ck_odds_snapshots_kind"), "odds_snapshots", type_="check")
    op.create_check_constraint(op.f("ck_odds_snapshots_kind"), "odds_snapshots", _ODDS_KINDS_NEW)
    op.create_index(
        "uq_odds_snapshots_archive",
        "odds_snapshots",
        ["match_id", "market", "selection", "bookmaker"],
        unique=True,
        postgresql_where=sa.text("kind = 'archive'"),
    )

    op.drop_constraint(op.f("ck_admin_audit_log_action"), "admin_audit_log", type_="check")
    op.create_check_constraint(
        op.f("ck_admin_audit_log_action"), "admin_audit_log", f"action IN ({_AUDIT_ACTIONS_NEW})"
    )


def downgrade() -> None:
    """Откат после загрузки архивов теряет данные, вернуть их может только полная
    перезагрузка (python -m app.ingest.update --full) после нового upgrade:
    - у турниров Сакманна и tennis-data пропадают source и source_ref. Новый upgrade
      оставит у них пустой source (не legacy), а загрузка их уже не найдет и создаст
      турниры заново: старые турниры с пустым source станут дублями, их разбирают вручную;
    - кэфы archive удаляются. Чтобы загрузка их вернула, у запусков Сакманна и
      tennis-data стираются хеши файлов (details.files): иначе неизменившийся файл
      не разбирается заново (last_ok_file_hashes).
    """
    # Записи журнала не удаляются: старое ограничение действует только на новые строки
    # (NOT VALID), а записи confirm_failed, player_merge и player_edit остаются
    op.drop_constraint(op.f("ck_admin_audit_log_action"), "admin_audit_log", type_="check")
    op.execute(
        "ALTER TABLE admin_audit_log ADD CONSTRAINT ck_admin_audit_log_action"
        f" CHECK (action IN ({_AUDIT_ACTIONS_OLD})) NOT VALID"
    )

    # Кэфы из архива без вида archive не имеют смысла, их заново даст загрузка архива
    op.drop_index("uq_odds_snapshots_archive", table_name="odds_snapshots")
    op.execute("DELETE FROM odds_snapshots WHERE kind = 'archive'")
    op.execute(
        "UPDATE ingestion_runs SET details = details - 'files'"
        " WHERE source IN ('sackmann', 'tennis_data')"
    )
    op.drop_constraint(op.f("ck_odds_snapshots_kind"), "odds_snapshots", type_="check")
    op.create_check_constraint(op.f("ck_odds_snapshots_kind"), "odds_snapshots", _ODDS_KINDS_OLD)

    op.drop_index("ix_matches_match_date", table_name="matches")
    op.drop_column("matches", "match_date")

    op.drop_constraint(op.f("ck_tournaments_source"), "tournaments", type_="check")
    op.drop_constraint(op.f("uq_tournaments_source_source_ref"), "tournaments", type_="unique")
    op.drop_column("tournaments", "source_ref")
    op.drop_column("tournaments", "source")
