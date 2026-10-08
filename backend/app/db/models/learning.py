"""Обучение: уроки из разборов, свои ML-модели и прогоны eval-набора
(PLAN.md, раздел 5; LLM_LEARNING.md)."""

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Double,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy import text as sa_text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, BigIntPK, CreatedAtMixin, UpdatedAtMixin, UsdCost, check_in

LESSON_KINDS = ("numeric", "process")
LESSON_STATUSES = ("hypothesis", "confirmed", "rejected", "retired")
EVAL_VERSION_KINDS = ("strategy", "ml_model")
EVAL_SPLITS = ("train", "validation", "test")


class Lesson(CreatedAtMixin, UpdatedAtMixin, Base):
    """Урок из разбора ставок участника. Применимость (scope_sql) проверяет код;
    эффект — средний остаток y − p и его доверительный интервал [низ, верх]."""

    __tablename__ = "lessons"
    __table_args__ = (
        UniqueConstraint("user_id", "code"),
        Index("ix_lessons_user_id_status", "user_id", "status"),
        check_in("kind", LESSON_KINDS, "kind"),
        check_in("status", LESSON_STATUSES, "status"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"))
    # Например L-017
    code: Mapped[str] = mapped_column(String(16))
    text: Mapped[str]
    scope_sql: Mapped[str | None]
    kind: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), server_default="hypothesis")
    n_cases: Mapped[int] = mapped_column(server_default="0")
    effect: Mapped[float | None]
    effect_ci: Mapped[list[float] | None] = mapped_column(ARRAY(Double))
    source_bet_ids: Mapped[list[int]] = mapped_column(
        ARRAY(BigInteger), server_default=sa_text("'{}'::bigint[]")
    )
    validated_at: Mapped[datetime | None]
    in_prompt: Mapped[bool] = mapped_column(server_default=sa_text("false"))


class MlModel(CreatedAtMixin, Base):
    """Своя ML-модель (Эло, регрессия, бустинг, стэкинг, калибратор). id — текст,
    например elo-2026-10. В params — в том числе коэффициенты стэкинга."""

    __tablename__ = "ml_models"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    train_from: Mapped[date | None]
    train_to: Mapped[date | None]
    feature_set: Mapped[str | None] = mapped_column(String(32))
    params: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))
    metrics: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))
    artifact_path: Mapped[str | None] = mapped_column(Text)


class EvalRun(CreatedAtMixin, Base):
    """Прогон eval-набора или бэктеста одной версии: метрики с ДИ и стоимость проверки.

    Версия — стратегия (strategy_version_id) или ML-модель (ml_model_id), заполнено
    ровно одно поле по version_kind.
    """

    __tablename__ = "eval_runs"
    __table_args__ = (
        check_in("version_kind", EVAL_VERSION_KINDS, "version_kind"),
        check_in("split", EVAL_SPLITS, "split"),
        CheckConstraint(
            "(version_kind = 'strategy' AND strategy_version_id IS NOT NULL"
            " AND ml_model_id IS NULL)"
            " OR (version_kind = 'ml_model' AND ml_model_id IS NOT NULL"
            " AND strategy_version_id IS NULL)",
            name="version_ref",
        ),
    )

    id: Mapped[BigIntPK]
    version_kind: Mapped[str] = mapped_column(String(16))
    strategy_version_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("strategy_versions.id", ondelete="CASCADE")
    )
    ml_model_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("ml_models.id", ondelete="CASCADE")
    )
    # Версия замороженного eval-набора
    eval_set: Mapped[str] = mapped_column(String(64))
    split: Mapped[str] = mapped_column(String(16))
    n_events: Mapped[int] = mapped_column(server_default="0")
    metrics: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))
    cost_usd: Mapped[UsdCost] = mapped_column(server_default="0")


Index("ix_ml_models_kind_created_at", MlModel.kind, MlModel.created_at.desc())
Index(
    "ix_eval_runs_strategy_version_id_created_at",
    EvalRun.strategy_version_id,
    EvalRun.created_at.desc(),
)
Index("ix_eval_runs_ml_model_id_created_at", EvalRun.ml_model_id, EvalRun.created_at.desc())
