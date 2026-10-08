"""Личные данные участника о ставках: стратегия, анализы, прогнозы, ставки и журнал
банка (PLAN.md, раздел 5). Видит только сам участник (Р14)."""

from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    CURRENCIES,
    Base,
    BigIntPK,
    CreatedAtMixin,
    CurrencyCode,
    Money,
    Odds,
    UpdatedAtMixin,
    check_in,
    check_probability,
)

STRATEGY_STATUSES = ("candidate", "active", "archived")
ANALYSIS_STATUSES = ("created", "queued", "running", "done", "failed", "cancelled")
BET_STATUSES = ("open", "won", "lost", "void")
BET_SOURCES = ("app", "legacy")
LEG_RESULTS = ("win", "loss", "void")
LEDGER_KINDS = ("deposit", "withdrawal", "stake", "payout", "refund", "reversal", "correction")


def _user_fk(ondelete: str = "CASCADE") -> ForeignKey:
    return ForeignKey("users.id", ondelete=ondelete)


class StrategyVersion(CreatedAtMixin, Base):
    """Версия стратегии участника: пороги (params), версия промпта, уроки в промпте,
    метрики последнего eval. Активная версия у участника одна. У истории старого бота
    своя версия с code = 'legacy'."""

    __tablename__ = "strategy_versions"
    __table_args__ = (
        UniqueConstraint("user_id", "code"),
        Index(
            "uq_strategy_versions_user_id_active",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
        check_in("status", STRATEGY_STATUSES, "status"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(100), server_default="")
    params: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    # sha256 текста промпта
    prompt_version: Mapped[str | None] = mapped_column(String(64))
    # Коды уроков в промпте, например L-017
    lessons: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'::text[]"))
    status: Mapped[str] = mapped_column(String(16), server_default="candidate")
    metrics: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    approved_by: Mapped[int | None] = mapped_column(BigInteger, _user_fk("SET NULL"))
    approved_at: Mapped[datetime | None]


class Analysis(CreatedAtMixin, Base):
    """Запрос участника на анализ: введенный текст, разбор и статус выполнения."""

    __tablename__ = "analyses"
    __table_args__ = (check_in("status", ANALYSIS_STATUSES, "status"),)

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    input_text: Mapped[str]
    parsed: Mapped[dict[str, Any] | None]
    status: Mapped[str] = mapped_column(String(16), server_default="created")
    strategy_version_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("strategy_versions.id", ondelete="SET NULL")
    )
    prompt_version: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None]
    finished_at: Mapped[datetime | None]


class Prediction(CreatedAtMixin, Base):
    """Прогноз на исход: вероятности своей модели, Claude и итоговая, рынок на момент
    прогноза и все версии, которые его дали. Только INSERT: исправление — новая строка
    со ссылкой supersedes на старую (LLM_LEARNING.md).

    При удалении участника с согласием на обучение строка остается без пути к нему (Р15).
    Строка users не удаляется (status = deleted), поэтому ON DELETE SET NULL здесь не
    срабатывает, и обезличивает сервис удаления: обнуляет user_id и agent_run_id
    (agent_runs хранят user_id ради бюджета месяца). analysis_id и strategy_version_id
    обнуляются сами, когда удаляются анализы и стратегии участника.
    """

    __tablename__ = "predictions"
    __table_args__ = (
        Index(
            "uq_predictions_analysis_id_match_id_market_selection",
            "analysis_id",
            "match_id",
            "market",
            "selection",
            unique=True,
            postgresql_where=text("supersedes IS NULL"),
        ),
        UniqueConstraint("eval_run_id", "match_id", "market", "selection"),
        UniqueConstraint("supersedes"),
        Index("ix_predictions_match_id", "match_id"),
        Index("ix_predictions_strategy_version_id_created_at", "strategy_version_id", "created_at"),
        Index("ix_predictions_user_id", "user_id"),
        check_in("selection", (1, 2), "selection"),
        check_probability("p_base"),
        check_probability("p_claude"),
        check_probability("p_final"),
        check_probability("q_market_at_pred"),
        CheckConstraint("eval_run_id IS NULL OR is_eval", name="eval_run_is_eval"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int | None] = mapped_column(BigInteger, _user_fk("SET NULL"))
    analysis_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("analyses.id", ondelete="SET NULL")
    )
    match_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("matches.id"))
    market: Mapped[str] = mapped_column(String(32))
    selection: Mapped[int] = mapped_column(SmallInteger)
    # Данные для прогноза не новее этого момента
    as_of: Mapped[datetime]
    dossier_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("dossiers.id", ondelete="SET NULL")
    )
    features: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    feature_set: Mapped[str | None] = mapped_column(String(32))
    strategy_version_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("strategy_versions.id", ondelete="SET NULL")
    )
    ml_model_id: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("ml_models.id", ondelete="SET NULL")
    )
    llm_model: Mapped[str | None] = mapped_column(String(64))
    effort: Mapped[str | None] = mapped_column(String(16))
    prompt_version: Mapped[str | None] = mapped_column(String(64))
    # Коды уроков, которые были в промпте
    lessons_applied: Mapped[list[str]] = mapped_column(
        ARRAY(Text), server_default=text("'{}'::text[]")
    )
    p_base: Mapped[float | None]
    p_claude: Mapped[float | None]
    p_final: Mapped[float | None]
    # Вероятность рынка без маржи в момент прогноза
    q_market_at_pred: Mapped[float | None]
    rationale: Mapped[str | None]
    agent_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("agent_runs.id", ondelete="SET NULL")
    )
    supersedes: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("predictions.id", ondelete="CASCADE")
    )
    is_eval: Mapped[bool] = mapped_column(server_default=text("false"))
    eval_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("eval_runs.id", ondelete="CASCADE")
    )


class Bet(CreatedAtMixin, UpdatedAtMixin, Base):
    """Ставка участника (одиночная или экспресс). Сумма — в валюте программы.
    Ставки из старого бота: source = 'legacy', source_ref — id записи в его JSON."""

    __tablename__ = "bets"
    __table_args__ = (
        UniqueConstraint("user_id", "source", "source_ref"),
        Index("ix_bets_user_id_status", "user_id", "status"),
        check_in("status", BET_STATUSES, "status"),
        check_in("source", BET_SOURCES, "source"),
        check_in("currency", CURRENCIES, "currency"),
        CheckConstraint("stake > 0", name="stake_positive"),
        CheckConstraint("total_odds >= 1", name="total_odds_min"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    analysis_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("analyses.id", ondelete="SET NULL")
    )
    placed_at: Mapped[datetime]
    bookmaker: Mapped[str] = mapped_column(String(64))
    stake: Mapped[Money]
    currency: Mapped[CurrencyCode]
    total_odds: Mapped[Odds]
    status: Mapped[str] = mapped_column(String(8), server_default="open")
    profit: Mapped[Money | None]
    settled_at: Mapped[datetime | None]
    source: Mapped[str] = mapped_column(String(8), server_default="app")
    source_ref: Mapped[str | None] = mapped_column(String(64))


class BetLeg(Base):
    """Событие ставки (у экспресса их несколько). Возврат — кэф 1.00 в расчете."""

    __tablename__ = "bet_legs"
    __table_args__ = (
        Index("ix_bet_legs_bet_id", "bet_id"),
        Index("ix_bet_legs_match_id", "match_id"),
        check_in("selection", (1, 2), "selection"),
        check_in("result", LEG_RESULTS, "result"),
        CheckConstraint("odds_taken >= 1", name="odds_taken_min"),
        CheckConstraint("closing_odds >= 1", name="closing_odds_min"),
    )

    id: Mapped[BigIntPK]
    bet_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("bets.id", ondelete="CASCADE"))
    match_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("matches.id"))
    market: Mapped[str] = mapped_column(String(32))
    selection: Mapped[int] = mapped_column(SmallInteger)
    odds_taken: Mapped[Odds]
    closing_odds: Mapped[Odds | None]
    prediction_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("predictions.id", ondelete="SET NULL")
    )
    # NULL — событие еще не рассчитано
    result: Mapped[str | None] = mapped_column(String(8))
    clv: Mapped[float | None]


class BankrollLedger(CreatedAtMixin, Base):
    """Журнал движения банка. Банк — сумма amount, отдельного поля «банк» нет.

    Знак суммы: пополнение, выплата и возврат — плюс; вывод и ставка — минус.
    Строки не меняются и не удаляются, кроме однократной отметки reversed_by;
    исправление результата — запись reversal плюс новая выплата. Частичные уникальные
    индексы не дают списать или выплатить одну ставку дважды.
    """

    __tablename__ = "bankroll_ledger"
    __table_args__ = (
        Index(
            "uq_bankroll_ledger_bet_id_stake",
            "bet_id",
            unique=True,
            postgresql_where=text("kind = 'stake'"),
        ),
        Index(
            "uq_bankroll_ledger_bet_id_payout",
            "bet_id",
            unique=True,
            postgresql_where=text("kind IN ('payout', 'refund') AND reversed_by IS NULL"),
        ),
        Index("ix_bankroll_ledger_user_id_at", "user_id", "at"),
        check_in("kind", LEDGER_KINDS, "kind"),
        check_in("currency", CURRENCIES, "currency"),
        CheckConstraint(
            "(kind IN ('deposit', 'payout', 'refund') AND amount > 0)"
            " OR (kind IN ('withdrawal', 'stake') AND amount < 0)"
            " OR (kind IN ('reversal', 'correction') AND amount <> 0)",
            name="amount_sign",
        ),
        CheckConstraint(
            "kind NOT IN ('stake', 'payout', 'refund') OR bet_id IS NOT NULL",
            name="bet_required",
        ),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    at: Mapped[datetime] = mapped_column(server_default=func.now())
    kind: Mapped[str] = mapped_column(String(16))
    amount: Mapped[Money]
    currency: Mapped[CurrencyCode]
    # Без ON DELETE CASCADE: ставку с записями журнала удалить нельзя, иначе банк
    # изменится без следа. При удалении участника (Р15) сервис удаляет журнал раньше ставок
    bet_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("bets.id"))
    # Ссылка на запись-сторно, которая отменила эту строку
    reversed_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("bankroll_ledger.id", ondelete="SET NULL")
    )
    note: Mapped[str | None]


Index("ix_analyses_user_id_created_at", Analysis.user_id, Analysis.created_at.desc())
Index("ix_bets_user_id_placed_at", Bet.user_id, Bet.placed_at.desc())
