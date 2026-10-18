"""Настройки программы и журнал действий администратора (PLAN.md, раздел 7)."""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import CURRENCIES, Base, BigIntPK, CurrencyCode, IpAddress, UsdLimit, check_in
from app.db.models.auth import DEFAULT_TZ

AUDIT_ACTIONS = (
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
    # Неверный код 2FA при подтверждении опасного действия (app/services/admin_confirm.py)
    "confirm_failed",
    # Ручная правка игроков командами терминала (этап 2)
    "player_merge",
    "player_edit",
    # Этап 3: режим ключа участника (Р12), общий бюджет и лимиты по умолчанию,
    # настройки агента (команда agent-config)
    "ai_mode_change",
    "budget_change",
    "agent_config_change",
    # Этап 4: смена настроек программы (часовой пояс по умолчанию)
    "settings_change",
    # Этап 5: загружен файл tennis-data, заморожен набор, запущен прогон, включены версия
    # инструкций, урок, версия базовой модели
    "data_upload",
    "eval_set",
    "eval_run",
    "version_on",
    "lesson_on",
    "model_on",
    # Этап 5, волна 2: урок выключен из анализа
    "lesson_off",
    # Р27: администратор открыл данные участника (экран) и выгрузил их в CSV
    "member_view",
    "member_export",
)
# Порог предупреждения о расходе, % от лимита или бюджета
BUDGET_ALERT_PCTS = (50, 70, 80, 90)


class AppSettings(Base):
    """Настройки, которые меняет администратор. Ровно одна строка (id = 1), ее создает
    миграция: валюта RUB, бюджет $60 в месяц, участнику по умолчанию $10 в месяц,
    3 анализа в день, мягкий и жесткий потолок анализа $0,50 и $1 (Р9, Р13, Р17).

    Ключ Claude администратора хранится зашифрованным (aad: app_settings.anthropic_key:1),
    наружу показываются только последние 4 символа.

    agent_config — только измененные настройки агента поверх значений по умолчанию из кода
    (app/agent/config.py). budget_alert_pct — порог предупреждения о расходе (limit_80,
    budget_80). eval_budget_usd — отдельный бюджет проверок (eval) на месяц (Р22).
    """

    __tablename__ = "app_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        check_in("currency", CURRENCIES, "currency"),
        CheckConstraint(
            "monthly_budget_usd >= 0 AND default_member_limit_usd >= 0"
            " AND default_daily_analyses >= 0 AND per_analysis_soft_usd >= 0"
            " AND per_analysis_hard_usd >= 0",
            name="non_negative",
        ),
        CheckConstraint("per_analysis_soft_usd <= per_analysis_hard_usd", name="soft_le_hard"),
        check_in("budget_alert_pct", BUDGET_ALERT_PCTS, "budget_alert_pct"),
        CheckConstraint("eval_budget_usd >= 0", name="eval_budget_non_negative"),
        CheckConstraint(
            "express_markets <@ ARRAY['shcp', 'stot', 'ghcp', 'gtot']::text[]",
            name="express_markets_known",
        ),
    )

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True, autoincrement=False)
    currency: Mapped[CurrencyCode] = mapped_column(server_default="RUB")
    anthropic_key_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    # Версия мастер-ключа, которым зашифрован anthropic_key_enc
    key_version: Mapped[int | None]
    key_last4: Mapped[str | None] = mapped_column(String(4))
    key_verified_at: Mapped[datetime | None]
    monthly_budget_usd: Mapped[UsdLimit] = mapped_column(server_default="60")
    default_member_limit_usd: Mapped[UsdLimit] = mapped_column(server_default="10")
    default_daily_analyses: Mapped[int] = mapped_column(server_default="3")
    per_analysis_soft_usd: Mapped[UsdLimit] = mapped_column(server_default="0.5")
    per_analysis_hard_usd: Mapped[UsdLimit] = mapped_column(server_default="1")
    agent_config: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    budget_alert_pct: Mapped[int] = mapped_column(SmallInteger, server_default="80")
    eval_budget_usd: Mapped[UsdLimit] = mapped_column(server_default="25")
    # Часовой пояс новых участников по умолчанию (у каждого участника свой users.tz)
    default_tz: Mapped[str] = mapped_column(String(64), server_default=DEFAULT_TZ)
    # Р28: семейства новых рынков, которые администратор перевел в экспресс (было «для
    # сравнения»): shcp, stot, ghcp, gtot (app/ml/markets.py)
    express_markets: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'::text[]")
    )
    # Семейства, о пройденном пороге которых администраторы уже получили уведомление
    # market_ready (одно на семейство)
    markets_notified: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'::text[]")
    )
    updated_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class AdminAuditLog(Base):
    """Журнал действий администратора и команд терминала.

    actor_id пустой — действие из терминала (в details.source = "terminal").
    В details — подробности действия, без паролей, кодов и ключей.
    """

    __tablename__ = "admin_audit_log"
    __table_args__ = (check_in("action", AUDIT_ACTIONS, "action"),)

    id: Mapped[BigIntPK]
    at: Mapped[datetime] = mapped_column(server_default=func.now())
    actor_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    action: Mapped[str] = mapped_column(String(32))
    target_user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    details: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    ip: Mapped[IpAddress | None]


Index("ix_admin_audit_log_at", AdminAuditLog.at.desc())
Index(
    "ix_admin_audit_log_target_user_id_at",
    AdminAuditLog.target_user_id,
    AdminAuditLog.at.desc(),
)
