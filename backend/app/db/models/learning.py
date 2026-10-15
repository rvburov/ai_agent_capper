"""Обучение: уроки из разборов, свои ML-модели, разборы ставок, пакеты Batch, замороженные
eval-наборы, прогоны и их сравнения, еженедельные отчеты (PLAN.md, раздел 5;
LLM_LEARNING.md; этап 5 — миграция 0008)."""

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Double,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy import text as sa_text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    Base,
    BigIntPK,
    CreatedAtMixin,
    UpdatedAtMixin,
    UsdCost,
    check_in,
)

LESSON_KINDS = ("numeric", "process")
# ready — проверен на истории и ждет решения администратора (этап 5)
LESSON_STATUSES = ("hypothesis", "ready", "confirmed", "rejected", "retired")
EVAL_VERSION_KINDS = ("strategy", "ml_model")
EVAL_SPLITS = ("train", "validation", "test")
# Срез события замороженного набора: smoke — быстрая проверка на 40 матчах
EVAL_ITEM_SPLITS = (*EVAL_SPLITS, "smoke")
EVAL_RUN_STATUSES = ("pending", "running", "done", "failed", "abandoned")
EVAL_RULES = ("improve", "non_inferior")
# Версии своей модели (Т12, Т13): rejected — перекалибровка хуже прежней, не включена
ML_MODEL_STATUSES = ("candidate", "active", "archived", "rejected")
# Разбор ставки: вывод — прогноз подтвердился, повезло (CLV против нас), невезение,
# ошибка модели, не хватило данных (макет, VERDICTS)
POSTMORTEM_STATUSES = ("queued", "submitted", "done", "failed")
POSTMORTEM_VERDICTS = ("fine", "lucky", "luck", "model_error", "data_gap")
BATCH_KINDS = ("postmortem", "eval", "shadow")
BATCH_STATUSES = ("pending", "submitted", "collected", "failed", "lost", "abandoned")


class Lesson(CreatedAtMixin, UpdatedAtMixin, Base):
    """Урок из разборов. user_id пустой — общий урок (Р25: уроки общие, ведет
    администратор); свой — только у участника. Условие (scope) — JSON из словаря признаков,
    SQL по нему собирает код (Т7). Эффект — средний остаток y − p и ДИ [низ, верх];
    effect_shrunk — с усадкой effect · n / (n + k); holdout_* — на отложенной части.
    Основание — прогнозы (source_prediction_ids, общие) и свои ставки (source_bet_ids,
    видит только их владелец, Т21)."""

    __tablename__ = "lessons"
    __table_args__ = (
        UniqueConstraint("user_id", "code", postgresql_nulls_not_distinct=True),
        Index("ix_lessons_user_id_status", "user_id", "status"),
        check_in("kind", LESSON_KINDS, "kind"),
        check_in("status", LESSON_STATUSES, "status"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE")
    )
    # Например L-017
    code: Mapped[str] = mapped_column(String(16))
    text: Mapped[str]
    scope: Mapped[dict[str, Any] | None]
    kind: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), server_default="hypothesis")
    n_cases: Mapped[int] = mapped_column(server_default="0")
    # Случаев в истории (архив и прогнозы), на которых проверен урок
    n_hist: Mapped[int] = mapped_column(server_default="0")
    effect: Mapped[float | None]
    effect_ci: Mapped[list[float] | None] = mapped_column(ARRAY(Double))
    effect_shrunk: Mapped[float | None]
    holdout_effect: Mapped[float | None]
    holdout_ci: Mapped[list[float] | None] = mapped_column(ARRAY(Double))
    source_bet_ids: Mapped[list[int]] = mapped_column(
        ARRAY(BigInteger), server_default=sa_text("'{}'::bigint[]")
    )
    source_prediction_ids: Mapped[list[int]] = mapped_column(
        ARRAY(BigInteger), server_default=sa_text("'{}'::bigint[]")
    )
    validated_at: Mapped[datetime | None]
    in_prompt: Mapped[bool] = mapped_column(server_default=sa_text("false"))
    decided_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    decided_at: Mapped[datetime | None]
    retired_at: Mapped[datetime | None]
    rechecked_at: Mapped[datetime | None]


class MlModel(CreatedAtMixin, Base):
    """Своя ML-модель (Эло, регрессия, бустинг, стэкинг, калибратор). id — текст,
    например elo-v1 или версия с датой elo-v1@2026-10-19 (Т13). В params — в том числе
    коэффициенты стэкинга. Активная версия одного вида — одна (status = active);
    parent_id — от какой версии перекалибрована, activated_* — кто и когда включил."""

    __tablename__ = "ml_models"
    __table_args__ = (
        Index(
            "uq_ml_models_kind_active",
            "kind",
            unique=True,
            postgresql_where=sa_text("status = 'active'"),
        ),
        check_in("status", ML_MODEL_STATUSES, "status"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    kind: Mapped[str] = mapped_column(String(32))
    train_from: Mapped[date | None]
    train_to: Mapped[date | None]
    feature_set: Mapped[str | None] = mapped_column(String(32))
    params: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))
    metrics: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))
    artifact_path: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), server_default="active")
    parent_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("ml_models.id", ondelete="SET NULL")
    )
    activated_at: Mapped[datetime | None]
    activated_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )


class EvalRun(CreatedAtMixin, Base):
    """Прогон eval-набора или бэктеста одной версии: метрики с ДИ и стоимость проверки.

    Версия — стратегия (strategy_version_id) или ML-модель (ml_model_id), заполнено
    ровно одно поле по version_kind.
    """

    __tablename__ = "eval_runs"
    __table_args__ = (
        check_in("version_kind", EVAL_VERSION_KINDS, "version_kind"),
        check_in("split", EVAL_SPLITS, "split"),
        check_in("status", EVAL_RUN_STATUSES, "status"),
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
    # Этап 5 (Т9, Т10): замороженный набор, номер повтора той же версии (порог шума),
    # статус прогона, его пакет и предел ответа
    eval_set_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("eval_sets.id", ondelete="SET NULL")
    )
    repeat_no: Mapped[int] = mapped_column(SmallInteger, server_default="0")
    status: Mapped[str | None] = mapped_column(String(16))
    batch_job_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("batch_jobs.id", ondelete="SET NULL")
    )
    max_tokens: Mapped[int | None]


class BatchJob(CreatedAtMixin, Base):
    """Пакет Message Batches API (разборы, eval, тень): худший случай держится в резерве
    бюджета, пока результаты не забраны (app/services/check_runs.py)."""

    __tablename__ = "batch_jobs"
    __table_args__ = (
        Index("ix_batch_jobs_kind_status", "kind", "status"),
        check_in("kind", BATCH_KINDS, "kind"),
        check_in("status", BATCH_STATUSES, "status"),
        CheckConstraint("worst_usd >= 0 AND cost_usd >= 0", name="money_non_negative"),
    )

    id: Mapped[BigIntPK]
    kind: Mapped[str] = mapped_column(String(16))
    # id пакета у Anthropic; пусто — еще не отправлен
    batch_id: Mapped[str | None] = mapped_column(String(128), unique=True)
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    requests: Mapped[int] = mapped_column(server_default="0")
    worst_usd: Mapped[UsdCost] = mapped_column(server_default="0")
    cost_usd: Mapped[UsdCost] = mapped_column(server_default="0")
    submitted_at: Mapped[datetime | None]
    ended_at: Mapped[datetime | None]
    error: Mapped[str | None]


class Postmortem(CreatedAtMixin, Base):
    """Разбор рассчитанного прогноза (В3, Р25): один на прогноз матча, общий. bet_id и
    user_id — чья ставка его вызвала: видит только ее владелец (Т21); при удалении
    участника обнуляются (app/services/admin_users.py)."""

    __tablename__ = "postmortems"
    __table_args__ = (
        UniqueConstraint("prediction_id"),
        Index("ix_postmortems_match_id", "match_id"),
        Index("ix_postmortems_bet_id", "bet_id"),
        Index("ix_postmortems_user_id", "user_id"),
        check_in("status", POSTMORTEM_STATUSES, "status"),
        check_in("verdict", POSTMORTEM_VERDICTS, "verdict"),
    )

    id: Mapped[BigIntPK]
    match_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("matches.id"))
    prediction_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("predictions.id", ondelete="CASCADE")
    )
    bet_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("bets.id", ondelete="SET NULL")
    )
    user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    batch_job_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("batch_jobs.id", ondelete="SET NULL")
    )
    agent_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("agent_runs.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(16), server_default="queued")
    verdict: Mapped[str | None] = mapped_column(String(16))
    summary: Mapped[str | None]
    hypothesis: Mapped[str | None]
    scope: Mapped[dict[str, Any] | None]
    lesson_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("lessons.id", ondelete="SET NULL")
    )


class EvalSet(CreatedAtMixin, Base):
    """Замороженный eval-набор (Т9): sha256 списка событий; повторная заморозка того же
    кода — отказ. rules — как выбраны события (срез, доля трудных)."""

    __tablename__ = "eval_sets"

    id: Mapped[BigIntPK]
    code: Mapped[str] = mapped_column(String(64), unique=True)
    frozen_at: Mapped[datetime | None]
    sha256: Mapped[str | None] = mapped_column(String(64))
    n_events: Mapped[int] = mapped_column(server_default="0")
    since: Mapped[date | None]
    rules: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))


class EvalSetItem(Base):
    """Событие набора: матч, досье на день матча, срез, «трудный хвост», с новостями."""

    __tablename__ = "eval_set_items"
    __table_args__ = (
        UniqueConstraint("eval_set_id", "match_id"),
        Index("ix_eval_set_items_match_id", "match_id"),
        check_in("split", EVAL_ITEM_SPLITS, "split"),
    )

    id: Mapped[BigIntPK]
    eval_set_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("eval_sets.id", ondelete="CASCADE")
    )
    match_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("matches.id"))
    dossier_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("dossiers.id", ondelete="SET NULL")
    )
    split: Mapped[str] = mapped_column(String(16), server_default="test")
    hard: Mapped[bool] = mapped_column(server_default=sa_text("false"))
    with_news: Mapped[bool] = mapped_column(server_default=sa_text("false"))


class EvalComparison(CreatedAtMixin, Base):
    """Сравнение прогона кандидата с базой (Т10): правило improve или non_inferior,
    разницы с ДИ и решение кода (passed). noise_run_id — повтор базы для порога шума."""

    __tablename__ = "eval_comparisons"
    __table_args__ = (
        Index("ix_eval_comparisons_candidate_run_id", "candidate_run_id"),
        check_in("rule", EVAL_RULES, "rule"),
    )

    id: Mapped[BigIntPK]
    candidate_run_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("eval_runs.id", ondelete="CASCADE")
    )
    baseline_run_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("eval_runs.id", ondelete="CASCADE")
    )
    noise_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("eval_runs.id", ondelete="SET NULL")
    )
    rule: Mapped[str] = mapped_column(String(16))
    metrics: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))
    passed: Mapped[bool | None]


class WeeklyReport(CreatedAtMixin, Base):
    """Еженедельный отчет участника (В8): неделя с понедельника по его поясу."""

    __tablename__ = "weekly_reports"
    __table_args__ = (UniqueConstraint("user_id", "week_start"),)

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"))
    week_start: Mapped[date]
    payload: Mapped[dict[str, Any]] = mapped_column(server_default=sa_text("'{}'::jsonb"))


Index("ix_ml_models_kind_created_at", MlModel.kind, MlModel.created_at.desc())
Index(
    "ix_eval_runs_strategy_version_id_created_at",
    EvalRun.strategy_version_id,
    EvalRun.created_at.desc(),
)
Index("ix_eval_runs_ml_model_id_created_at", EvalRun.ml_model_id, EvalRun.created_at.desc())
