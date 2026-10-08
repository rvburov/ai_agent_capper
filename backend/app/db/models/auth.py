"""Пользователи и вход: учетные записи, сеансы, 2FA, журнал входов, коды доступа,
уведомления и подписки на push (PLAN.md, разделы 5 и 7)."""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    Base,
    BigIntPK,
    CreatedAtMixin,
    Hash64,
    IpAddress,
    UpdatedAtMixin,
    UsdLimit,
    check_in,
)

ROLES = ("admin", "member")
USER_STATUSES = ("active", "blocked", "deleted")
AI_MODES = ("shared", "own")
LOGIN_RESULTS = ("ok", "bad_password", "bad_totp", "bad_recovery", "rate_limited", "blocked")
LOGIN_METHODS = ("password", "totp", "recovery", "trusted_device")
ACCESS_CODE_KINDS = ("invite", "password_reset")
NOTIFICATION_KINDS = (
    "bet_settled",
    "data_stale",
    "limit_80",
    "limit_100",
    "new_device",
    "admin_message",
    "login_failures",
)
DEFAULT_TZ = "Europe/Helsinki"


def _user_fk(ondelete: str = "CASCADE") -> ForeignKey:
    return ForeignKey("users.id", ondelete=ondelete)


class User(CreatedAtMixin, UpdatedAtMixin, Base):
    """Учетная запись администратора или участника.

    Строка не удаляется: при удалении участника (Р15) личные данные стираются, email
    заменяется на deleted-<id>@deleted.invalid, status = deleted. Так в бюджете месяца
    и журнале остаются ссылки на него. Валюты здесь нет: она одна на программу (Р17).
    """

    __tablename__ = "users"
    __table_args__ = (
        Index("uq_users_email_lower", func.lower(text("email")), unique=True),
        check_in("role", ROLES, "role"),
        check_in("status", USER_STATUSES, "status"),
        check_in("ai_mode", AI_MODES, "ai_mode"),
    )

    id: Mapped[BigIntPK]
    email: Mapped[str] = mapped_column(String(320))
    display_name: Mapped[str] = mapped_column(String(100), server_default="")
    # Argon2id; NULL у удаленного пользователя
    password_hash: Mapped[str | None]
    # Секрет TOTP, зашифрованный AES-GCM (aad: users.totp_secret:<id>)
    totp_secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    totp_key_version: Mapped[int | None]
    totp_enabled: Mapped[bool] = mapped_column(server_default=text("false"))
    # Номер шага последнего принятого кода: повтор того же кода запрещен
    totp_last_step: Mapped[int | None] = mapped_column(BigInteger)
    role: Mapped[str] = mapped_column(String(16), server_default="member")
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    ai_mode: Mapped[str] = mapped_column(String(16), server_default="shared")
    tz: Mapped[str] = mapped_column(String(64), server_default=DEFAULT_TZ)
    # Согласие на обезличенное использование прогнозов для обучения (Р15)
    consent_training: Mapped[bool] = mapped_column(server_default=text("false"))
    terms_accepted_at: Mapped[datetime | None]
    created_by: Mapped[int | None] = mapped_column(BigInteger, _user_fk("SET NULL"))
    last_login_at: Mapped[datetime | None]
    blocked_at: Mapped[datetime | None]
    deleted_at: Mapped[datetime | None]


class UserSession(CreatedAtMixin, Base):
    """Сеанс входа. В cookie — случайный токен, здесь только его sha256 (id_hash).

    Сеанс действует, пока не отозван, не прошел абсолютный срок (expires_at, 30 дней)
    и не было бездействия дольше 14 дней (last_seen_at).
    """

    __tablename__ = "sessions"
    __table_args__ = (
        Index("ix_sessions_user_id", "user_id"),
        Index("ix_sessions_expires_at", "expires_at"),
    )

    id: Mapped[BigIntPK]
    id_hash: Mapped[Hash64] = mapped_column(unique=True)
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    last_seen_at: Mapped[datetime] = mapped_column(server_default=func.now())
    expires_at: Mapped[datetime]
    ip: Mapped[IpAddress | None]
    user_agent: Mapped[str | None]
    # Короткое имя устройства для списка сеансов, например «Chrome · Windows»
    device_label: Mapped[str] = mapped_column(String(100), server_default="")
    revoked_at: Mapped[datetime | None]


class TrustedDevice(CreatedAtMixin, Base):
    """«Запомнить устройство на 30 дней»: при действующей cookie шаг 2FA пропускается."""

    __tablename__ = "trusted_devices"
    __table_args__ = (Index("ix_trusted_devices_user_id", "user_id"),)

    id: Mapped[BigIntPK]
    token_hash: Mapped[Hash64] = mapped_column(unique=True)
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    expires_at: Mapped[datetime]
    ip: Mapped[IpAddress | None]
    user_agent: Mapped[str | None]
    device_label: Mapped[str] = mapped_column(String(100), server_default="")
    last_used_at: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]


class RecoveryCode(CreatedAtMixin, Base):
    """Резервный код 2FA (8 штук на пользователя). Хранится только HMAC-хеш."""

    __tablename__ = "recovery_codes"
    __table_args__ = (Index("ix_recovery_codes_user_id", "user_id"),)

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    code_hash: Mapped[Hash64]
    used_at: Mapped[datetime | None]


class LoginEvent(Base):
    """Журнал попыток входа: для участника («Журнал входов») и администратора.

    user_id пустой, если email не найден. Хранится 90 дней.
    """

    __tablename__ = "login_events"
    __table_args__ = (
        Index("ix_login_events_at", "at"),
        check_in("result", LOGIN_RESULTS, "result"),
        check_in("method", LOGIN_METHODS, "method"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int | None] = mapped_column(BigInteger, _user_fk())
    at: Mapped[datetime] = mapped_column(server_default=func.now())
    ip: Mapped[IpAddress | None]
    user_agent: Mapped[str | None]
    result: Mapped[str] = mapped_column(String(16))
    method: Mapped[str] = mapped_column(String(16))


class AccessCode(CreatedAtMixin, Base):
    """Одноразовый код от администратора: приглашение (CAP-, 7 дней) или сброс пароля
    (RST-, 24 часа). В БД только HMAC-хеш кода.

    Приглашение несет email, роль, режим ключа и стартовый лимит; сброс — user_id.
    """

    __tablename__ = "access_codes"
    __table_args__ = (
        Index("ix_access_codes_kind_expires_at", "kind", "expires_at"),
        Index("ix_access_codes_user_id", "user_id"),
        check_in("kind", ACCESS_CODE_KINDS, "kind"),
        check_in("role", ROLES, "role"),
        check_in("ai_mode", AI_MODES, "ai_mode"),
        CheckConstraint(
            "(kind = 'invite' AND email IS NOT NULL AND role IS NOT NULL AND ai_mode IS NOT NULL)"
            " OR (kind = 'password_reset' AND user_id IS NOT NULL)",
            name="kind_fields",
        ),
        # Лимиты приглашения копируются в ai_limits, где отрицательные запрещены
        CheckConstraint(
            "limit_monthly_usd >= 0 AND limit_daily_analyses >= 0 AND limit_per_analysis_usd >= 0",
            name="limits_non_negative",
        ),
    )

    id: Mapped[BigIntPK]
    kind: Mapped[str] = mapped_column(String(16))
    code_hash: Mapped[Hash64] = mapped_column(unique=True)
    # Для сброса пароля: чей пароль
    user_id: Mapped[int | None] = mapped_column(BigInteger, _user_fk())
    # Для приглашения: на какой email, роль, режим ключа и стартовый лимит
    email: Mapped[str | None] = mapped_column(String(320))
    role: Mapped[str | None] = mapped_column(String(16))
    ai_mode: Mapped[str | None] = mapped_column(String(16))
    limit_monthly_usd: Mapped[UsdLimit | None]
    limit_daily_analyses: Mapped[int | None]
    limit_per_analysis_usd: Mapped[UsdLimit | None]
    # NULL — код выдан командой терминала
    created_by: Mapped[int | None] = mapped_column(BigInteger, _user_fk("SET NULL"))
    expires_at: Mapped[datetime]
    used_at: Mapped[datetime | None]
    used_by: Mapped[int | None] = mapped_column(BigInteger, _user_fk("SET NULL"))
    revoked_at: Mapped[datetime | None]


class Notification(CreatedAtMixin, Base):
    """Центр уведомлений (колокольчик). title и body — готовый текст на языке по умолчанию,
    params — параметры этого текста, чтобы перевести его на другой язык."""

    __tablename__ = "notifications"
    __table_args__ = (
        Index(
            "ix_notifications_user_id_unread",
            "user_id",
            postgresql_where=text("read_at IS NULL"),
        ),
        check_in("kind", NOTIFICATION_KINDS, "kind"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    kind: Mapped[str] = mapped_column(String(32))
    title: Mapped[str]
    body: Mapped[str] = mapped_column(server_default="")
    params: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    link: Mapped[str | None] = mapped_column(String(500))
    read_at: Mapped[datetime | None]


class PushSubscription(CreatedAtMixin, Base):
    """Подписка браузера на push-уведомления (Web Push, этап 6)."""

    __tablename__ = "push_subscriptions"
    __table_args__ = (Index("ix_push_subscriptions_user_id", "user_id"),)

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    endpoint: Mapped[str] = mapped_column(unique=True)
    p256dh: Mapped[str]
    auth: Mapped[str]
    user_agent: Mapped[str | None]
    revoked_at: Mapped[datetime | None]


# Индексы с сортировкой по убыванию задаются после классов: нужны объекты колонок
Index("ix_login_events_user_id_at", LoginEvent.user_id, LoginEvent.at.desc())
Index(
    "ix_notifications_user_id_created_at",
    Notification.user_id,
    Notification.created_at.desc(),
)
