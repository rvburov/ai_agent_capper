"""Claude: свои ключи участников, лимиты, учет каждого вызова и цены моделей
(PLAN.md, разделы 5 и 7; TOKEN_ECONOMY.md, раздел 1)."""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, BigIntPK, CreatedAtMixin, UpdatedAtMixin, UsdCost, UsdLimit, check_in

SECRET_KINDS = ("anthropic_key",)
KEY_SOURCES = ("admin", "own")
AGENT_RUN_KINDS = ("parse", "news", "analysis", "refresh", "postmortem", "eval", "shadow")


class UserSecret(CreatedAtMixin, UpdatedAtMixin, Base):
    """Свой ключ Claude участника (режим «свой ключ», Р7). Хранится зашифрованным
    (aad: user_secrets.<kind>:<user_id>), в браузер не попадает, видны последние 4 символа."""

    __tablename__ = "user_secrets"
    __table_args__ = (
        UniqueConstraint("user_id", "kind"),
        check_in("kind", SECRET_KINDS, "kind"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32))
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)
    key_version: Mapped[int]
    last4: Mapped[str] = mapped_column(String(4))
    verified_at: Mapped[datetime | None]
    last_error: Mapped[str | None]


class AiLimit(Base):
    """Лимиты участника на ключе администратора (Р9, Р13). Пустой allowed_models —
    доступны все модели из настроек. paused — анализы на ключе администратора остановлены.

    own_per_analysis_usd — потолок одного анализа на своем ключе (участник ставит сам).
    return_requested_at — участник на своем ключе просит вернуть ключ администратора (Р12),
    решение за администратором.
    """

    __tablename__ = "ai_limits"
    __table_args__ = (
        CheckConstraint(
            "monthly_usd >= 0 AND daily_analyses >= 0 AND per_analysis_usd >= 0",
            name="non_negative",
        ),
        CheckConstraint("own_per_analysis_usd > 0", name="own_per_analysis_positive"),
    )

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    monthly_usd: Mapped[UsdLimit]
    daily_analyses: Mapped[int]
    per_analysis_usd: Mapped[UsdLimit]
    allowed_models: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'::text[]")
    )
    paused: Mapped[bool] = mapped_column(server_default=text("false"))
    own_per_analysis_usd: Mapped[UsdLimit] = mapped_column(server_default="1")
    return_requested_at: Mapped[datetime | None]
    updated_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class AgentRun(CreatedAtMixin, Base):
    """Один вызов Claude: токены, стоимость, длительность (TOKEN_ECONOMY.md, раздел 1.1).

    Строки не удаляются вместе с участником: user_id становится пустым, а расход остается
    в бюджете месяца. Лимиты считаются только по key_source = 'admin'.
    input_tokens — вход без кэша, как usage.input_tokens в API.
    """

    __tablename__ = "agent_runs"
    __table_args__ = (
        Index("ix_agent_runs_created_at", "created_at"),
        Index("ix_agent_runs_kind_created_at", "kind", "created_at"),
        Index("ix_agent_runs_analysis_id", "analysis_id"),
        Index("ix_agent_runs_user_id_created_at", "user_id", "created_at"),
        check_in("key_source", KEY_SOURCES, "key_source"),
        check_in("kind", AGENT_RUN_KINDS, "kind"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    key_source: Mapped[str] = mapped_column(String(8))
    analysis_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("analyses.id", ondelete="SET NULL")
    )
    eval_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("eval_runs.id", ondelete="SET NULL")
    )
    kind: Mapped[str] = mapped_column(String(16))
    step: Mapped[int] = mapped_column(server_default="0")
    model: Mapped[str] = mapped_column(String(64))
    effort: Mapped[str | None] = mapped_column(String(16))
    prompt_version: Mapped[str | None] = mapped_column(String(64))
    schema_version: Mapped[str | None] = mapped_column(String(32))
    input_tokens: Mapped[int] = mapped_column(server_default="0")
    cache_write_tokens: Mapped[int] = mapped_column(server_default="0")
    cache_write_5m_tokens: Mapped[int] = mapped_column(server_default="0")
    cache_write_1h_tokens: Mapped[int] = mapped_column(server_default="0")
    cache_read_tokens: Mapped[int] = mapped_column(server_default="0")
    output_tokens: Mapped[int] = mapped_column(server_default="0")
    thinking_tokens: Mapped[int | None]
    web_searches: Mapped[int] = mapped_column(server_default="0")
    batch: Mapped[bool] = mapped_column(server_default=text("false"))
    cost_usd: Mapped[UsdCost] = mapped_column(server_default="0")
    duration_ms: Mapped[int | None]
    stop_reason: Mapped[str | None] = mapped_column(String(32))
    error: Mapped[str | None]
    request_id: Mapped[str | None] = mapped_column(String(128))


class ModelPrice(Base):
    """Цены моделей в долларах за 1 млн токенов и за один веб-поиск: по ним код
    считает agent_runs.cost_usd. Новая цена — новая строка с valid_from.

    Вторая ступень цены (Haiku 5.5): если весь вход запроса (вход, запись и чтение кэша)
    больше long_input_threshold токенов, все цены токенов умножаются на long_multiplier.
    """

    __tablename__ = "model_prices"

    model: Mapped[str] = mapped_column(String(64), primary_key=True)
    valid_from: Mapped[datetime] = mapped_column(primary_key=True)
    input: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    output: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    cache_read: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    cache_write_5m: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    cache_write_1h: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    search_price: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    long_input_threshold: Mapped[int | None] = mapped_column(Integer)
    long_multiplier: Mapped[Decimal | None] = mapped_column(Numeric(4, 2))
