"""Личные данные участника о ставках: стратегия, анализы, прогнозы, ставки и журнал
банка (PLAN.md, раздел 5). Видит сам участник и администратор (только просмотр, Р27)."""

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    CHAR,
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Numeric,
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
    UsdCost,
    UsdLimit,
    check_in,
    check_probability,
)
from app.db.models.ai import KEY_SOURCES

# rejected — кандидат, которого отклонили (этап 5)
STRATEGY_STATUSES = ("candidate", "active", "archived", "rejected")
# Зачем версия (этап 5): качество анализа, экономия токенов, правила суммы ставки
STRATEGY_GOALS = ("quality", "saving", "rules")
# created и running — статусы до этапа 3 (импорт старого бота пишет done); путь анализа
# этапа 3: needs_confirmation → queued → building_dossier → modelling → llm_review →
# composing → done, плюс failed и cancelled (PLAN.md, раздел 3)
ANALYSIS_STATUSES = (
    "created",
    "queued",
    "running",
    "done",
    "failed",
    "cancelled",
    "parsing",
    "needs_confirmation",
    "building_dossier",
    "modelling",
    "llm_review",
    "composing",
)
# Анализ в работе у воркера: держит резерв бюджета, его проверяет задача-уборщик
ANALYSIS_ACTIVE_STATUSES = ("queued", "building_dossier", "modelling", "llm_review", "composing")
ANALYSIS_INPUT_KINDS = ("text", "form")
ANALYSIS_DECISIONS = ("bet", "skip")
BET_STATUSES = ("open", "won", "lost", "void")
BET_SOURCES = ("app", "legacy")
# Вид ставки (Р29): экспресс стратегии, ординар из вариантов анализа, своя ставка («В свою
# ставку», «Собрать свою», «Экспресс из лучших»), история старого бота
BET_KINDS = ("strategy", "single", "own", "legacy")
LEG_RESULTS = ("win", "loss", "void")
# Кто рассчитал ставку и ногу: участник вручную, авторасчет (этап 5), импорт старого бота
SETTLED_BY = ("manual", "auto", "legacy")
# Откуда закрывающий кэф ноги: ввел участник или архив tennis-data (этап 5)
CLOSING_SOURCES = ("user", "archive")
LEDGER_KINDS = ("deposit", "withdrawal", "stake", "payout", "refund", "reversal", "correction")


def _default_kind(context: Any) -> str:
    """Вид ставки по умолчанию: у ставки старого бота — legacy, иначе strategy."""
    return "legacy" if context.get_current_parameters().get("source") == "legacy" else "strategy"


def _user_fk(ondelete: str = "CASCADE") -> ForeignKey:
    return ForeignKey("users.id", ondelete=ondelete)


class StrategyVersion(CreatedAtMixin, Base):
    """Версия стратегии участника: пороги (params), версия промпта, уроки в промпте,
    метрики последнего eval. Активная версия у участника одна. У истории старого бота
    своя версия с code = 'legacy'.

    Этап 5 (Р25): user_id пустой — общая линия инструкций анализа (ведет администратор),
    у нее тоже одна активная версия; правила суммы ставки — версии участника. parent_id —
    от какой версии кандидат, goal — зачем, changes — что изменилось, decided_by — кто
    включил или отклонил, archived_at — когда версия перестала действовать."""

    __tablename__ = "strategy_versions"
    __table_args__ = (
        UniqueConstraint("user_id", "code", postgresql_nulls_not_distinct=True),
        Index(
            "uq_strategy_versions_user_id_active",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
            postgresql_nulls_not_distinct=True,
        ),
        check_in("status", STRATEGY_STATUSES, "status"),
        check_in("goal", STRATEGY_GOALS, "goal"),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int | None] = mapped_column(BigInteger, _user_fk())
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
    parent_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("strategy_versions.id", ondelete="SET NULL")
    )
    goal: Mapped[str | None] = mapped_column(String(16))
    changes: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'::text[]"))
    decided_by: Mapped[int | None] = mapped_column(BigInteger, _user_fk("SET NULL"))
    archived_at: Mapped[datetime | None]


class Analysis(CreatedAtMixin, UpdatedAtMixin, Base):
    """Запрос участника на анализ: ввод (текст или форма), разбор, подтвержденные события,
    статус выполнения, чекпойнты и деньги.

    parsed — сырой ответ разбора, confirmed — события, которые подтвердил участник.
    key_source фиксируется при запуске: на чьем ключе идет анализ. started_at — запуск,
    по которому анализ идет в «анализы за день»: первый, а после запусков на своем ключе —
    первый перезапуск на ключе администратора; attempt — номер запуска.
    checkpoint — что уже сделано: повторный запуск после сбоя не платит второй раз.
    cost_usd — расход анализа по agent_runs (источник правды — agent_runs.cost_usd);
    budget_reserved_usd — резерв бюджета на время работы (снимается по окончании),
    cost_cap_usd — потолок анализа, estimate_usd — оценка стоимости при запуске.
    updated_at обновляется при каждом изменении: по нему уборщик находит зависшие анализы.
    """

    __tablename__ = "analyses"
    __table_args__ = (
        Index(
            "ix_analyses_admin_key_started_at",
            "user_id",
            "started_at",
            postgresql_where=text("key_source = 'admin'"),
        ),
        Index(
            "ix_analyses_active_updated_at",
            "status",
            "updated_at",
            postgresql_where=text(
                "status IN ({})".format(", ".join(f"'{s}'" for s in ANALYSIS_ACTIVE_STATUSES))
            ),
        ),
        check_in("status", ANALYSIS_STATUSES, "status"),
        check_in("input_kind", ANALYSIS_INPUT_KINDS, "input_kind"),
        check_in("key_source", KEY_SOURCES, "key_source"),
        check_in("decision", ANALYSIS_DECISIONS, "decision"),
        CheckConstraint(
            "cost_usd >= 0 AND budget_reserved_usd >= 0 AND cost_cap_usd >= 0"
            " AND estimate_usd >= 0",
            name="money_non_negative",
        ),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    input_text: Mapped[str]
    input_kind: Mapped[str] = mapped_column(String(8), server_default="text")
    parsed: Mapped[dict[str, Any] | None]
    confirmed: Mapped[dict[str, Any] | None]
    # Банк и букмекер из ввода участника (банк — в валюте программы)
    bank_input: Mapped[Money | None]
    bookmaker: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), server_default="created")
    strategy_version_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("strategy_versions.id", ondelete="SET NULL")
    )
    prompt_version: Mapped[str | None] = mapped_column(String(64))
    key_source: Mapped[str | None] = mapped_column(String(8))
    started_at: Mapped[datetime | None]
    attempt: Mapped[int] = mapped_column(SmallInteger, server_default="0")
    # Ключ локали ошибки (errors.<код>), ее параметры и шаг, на котором анализ остановился
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_params: Mapped[dict[str, Any] | None]
    failed_step: Mapped[str | None] = mapped_column(String(24))
    checkpoint: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))
    # Итог: экспресс, сумма ставки, предупреждения
    result: Mapped[dict[str, Any] | None]
    cost_usd: Mapped[UsdCost] = mapped_column(server_default="0")
    budget_reserved_usd: Mapped[UsdLimit] = mapped_column(server_default="0")
    cost_cap_usd: Mapped[UsdLimit | None]
    estimate_usd: Mapped[Decimal | None] = mapped_column(Numeric(10, 4))
    # Решение участника по итогу: поставил или пропустил
    decision: Mapped[str | None] = mapped_column(String(8))
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
        CheckConstraint("odds_at_pred >= 1", name="odds_at_pred_min"),
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
    # Кэф и букмекер, по которым код считал валуй, и сам валуй (p_final * кэф - 1)
    odds_at_pred: Mapped[Odds | None]
    bookmaker_at_pred: Mapped[str | None] = mapped_column(String(64))
    value_at_pred: Mapped[float | None]
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
    Ставки из старого бота: source = 'legacy', source_ref — id записи в его JSON.

    settled_by — кто рассчитал: manual (участник), auto (авторасчет, этап 5; ручной расчет
    он не трогает), legacy (импорт бота). updated_at — версия ставки для защиты от гонки:
    расчет и сторно приходят с ожидаемым updated_at (409, если ставка уже изменилась).
    settle_run_id — запуск расчета по архиву (ingestion_runs, source = settle), которым
    рассчитана ставка; result_reminded_at — когда ушло напоминание «ставка ждет
    результата» (одно на ставку); reversed_at — когда участник последний раз исправил
    результат: такую ставку авторасчет больше не трогает, ручной расчет главнее (Т3).
    """

    __tablename__ = "bets"
    __table_args__ = (
        UniqueConstraint("user_id", "source", "source_ref"),
        Index("ix_bets_user_id_status", "user_id", "status"),
        Index(
            "ix_bets_user_id_settled_at",
            "user_id",
            "settled_at",
            postgresql_where=text("status <> 'open'"),
        ),
        check_in("status", BET_STATUSES, "status"),
        check_in("source", BET_SOURCES, "source"),
        check_in("kind", BET_KINDS, "kind"),
        check_in("settled_by", SETTLED_BY, "settled_by"),
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
    settled_by: Mapped[str | None] = mapped_column(String(8))
    source: Mapped[str] = mapped_column(String(8), server_default="app")
    source_ref: Mapped[str | None] = mapped_column(String(64))
    # Вид ставки (Р29); не задан — legacy у ставки бота, иначе strategy
    kind: Mapped[str] = mapped_column(String(8), default=_default_kind, server_default="strategy")
    settle_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("ingestion_runs.id", ondelete="SET NULL")
    )
    result_reminded_at: Mapped[datetime | None]
    reversed_at: Mapped[datetime | None]


class BetLeg(Base):
    """Событие ставки (у экспресса их несколько). Возврат — кэф 1.00 в расчете.

    Исход и счет вносит участник (в matches не пишутся: матч общий, и Эло посчитало бы
    его дважды, решение Т11). score — счет по сетам со стороны выбранного игрока («2:1» —
    его 2 сета): при слиянии матчей сторона ноги переворачивается, а счет остается верным.
    У рынков по геймам (Р28) score — счет по геймам («6:4 7:6»): у форы — со стороны
    выбранного игрока, у тотала — игрока 1 (исход тотала от стороны не зависит).
    result_source и settled_at — кто и когда рассчитал ногу.

    Закрывающий кэф (В1, Р24): closing_odds — на свой исход, closing_opp_odds — на
    обратный (по желанию), closing_bookmaker — чей кэф: код эталона (pinnacle,
    betfair_ex, avg) или название своего букмекера; closing_source — ввел участник или
    архив. q_close — вероятность своего исхода без маржи, только при двух сторонах.
    clv — кэф / закрывающий − 1.

    archive_result и archive_score — исход и счет (со стороны выбранного игрока) по архиву,
    когда он разошелся с ручным расчетом (Т3): деньги не меняются, участнику уведомление
    settle_conflict. Совпал или ставка снова открыта — пусто.
    """

    __tablename__ = "bet_legs"
    __table_args__ = (
        Index("ix_bet_legs_bet_id", "bet_id"),
        Index("ix_bet_legs_match_id", "match_id"),
        Index("ix_bet_legs_open_match_id", "match_id", postgresql_where=text("result IS NULL")),
        check_in("selection", (1, 2), "selection"),
        check_in("result", LEG_RESULTS, "result"),
        check_in("result_source", SETTLED_BY, "result_source"),
        check_in("closing_source", CLOSING_SOURCES, "closing_source"),
        check_in("archive_result", LEG_RESULTS, "archive_result"),
        check_probability("q_close"),
        CheckConstraint("odds_taken >= 1", name="odds_taken_min"),
        CheckConstraint("closing_odds >= 1", name="closing_odds_min"),
        CheckConstraint("closing_opp_odds >= 1.01", name="closing_opp_odds_min"),
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
    # Счет по сетам («2:1») или, у рынков по геймам, по геймам («6:4 7:6(5)», Р28)
    score: Mapped[str | None] = mapped_column(String(64))
    settled_at: Mapped[datetime | None]
    result_source: Mapped[str | None] = mapped_column(String(8))
    closing_opp_odds: Mapped[Odds | None]
    closing_bookmaker: Mapped[str | None] = mapped_column(String(64))
    closing_source: Mapped[str | None] = mapped_column(String(8))
    q_close: Mapped[float | None]
    archive_result: Mapped[str | None] = mapped_column(String(8))
    archive_score: Mapped[str | None] = mapped_column(String(64))


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


class Bookmaker(CreatedAtMixin, Base):
    """Букмекер из списка участника («Мои букмекеры», В9): добавить, переименовать,
    скрыть (archived_at). bets.bookmaker остается строкой: переименование не меняет уже
    сохраненные ставки. Название уникально у участника без учета регистра."""

    __tablename__ = "bookmakers"
    __table_args__ = (
        Index("uq_bookmakers_user_id_name", "user_id", func.lower(text("name")), unique=True),
    )

    id: Mapped[BigIntPK]
    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk())
    name: Mapped[str] = mapped_column(String(64))
    archived_at: Mapped[datetime | None]


class PlayLimit(Base):
    """Ответственная игра (В8): лимиты числа и суммы ставок в день и пауза. NULL —
    лимита нет. Снизить лимит можно сразу, повысить или снять — через 24 часа: новое
    значение ждет в pending_* до pending_from (pending_from задан — изменение ждет, даже
    если pending-значение NULL, то есть «без лимита»). Паузу до paused_until досрочно не
    снять. Сумма — в валюте программы (currency). day_tz и day_tz_until — участник сменил
    часовой пояс: текущие сутки лимитов досчитываются по прежнему поясу до их конца, иначе
    смена пояса обнуляла бы счетчики дня (миграция 0005)."""

    __tablename__ = "play_limits"
    __table_args__ = (
        CheckConstraint("bets_per_day BETWEEN 1 AND 20", name="bets_per_day_range"),
        CheckConstraint("pending_bets_per_day BETWEEN 1 AND 20", name="pending_bets_per_day_range"),
        CheckConstraint(
            "stake_per_day > 0 AND pending_stake_per_day > 0", name="stake_per_day_positive"
        ),
        CheckConstraint(
            "(stake_per_day IS NULL AND pending_stake_per_day IS NULL) OR currency IS NOT NULL",
            name="stake_currency",
        ),
        check_in("currency", CURRENCIES, "currency"),
        CheckConstraint("(day_tz IS NULL) = (day_tz_until IS NULL)", name="day_tz_pair"),
    )

    user_id: Mapped[int] = mapped_column(BigInteger, _user_fk(), primary_key=True)
    bets_per_day: Mapped[int | None] = mapped_column(SmallInteger)
    stake_per_day: Mapped[Money | None]
    currency: Mapped[str | None] = mapped_column(CHAR(3))
    pending_bets_per_day: Mapped[int | None] = mapped_column(SmallInteger)
    pending_stake_per_day: Mapped[Money | None]
    pending_from: Mapped[datetime | None]
    paused_until: Mapped[datetime | None]
    day_tz: Mapped[str | None] = mapped_column(String(64))
    day_tz_until: Mapped[datetime | None]
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


Index("ix_analyses_user_id_created_at", Analysis.user_id, Analysis.created_at.desc())
Index("ix_bets_user_id_placed_at", Bet.user_id, Bet.placed_at.desc())
