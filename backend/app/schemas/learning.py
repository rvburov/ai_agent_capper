"""Схемы этапа 5, волна 3: «Обучение модели» (сводка экрана и блок «Модель учится» на
главной), версии стратегии (общая линия инструкций анализа и свои правила суммы ставки),
замороженный eval-набор и прогоны версий, сравнение по правилам «улучшение» и «экономия не
хуже», версии базовой модели (перекалибровка, проверка по месяцам).

Все числа считает сервер (Т15): экран только рисует. Деньги ИИ — в долларах числом
(UsdOut), деньги ставок — строкой Decimal. Вероятности, лог-лосс, Brier и ECE — доли
(0,05 — 5 п.п.).
"""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.schemas.admin import UsdOut
from app.schemas.analyses import DecimalOut
from app.schemas.strategy import StrategyParamsOut

EvalRunKind = Literal["eval", "quick", "smoke"]
EvalRunStatus = Literal["pending", "running", "done", "failed", "abandoned"]
VersionLine = Literal["instructions", "rules"]
VersionStatus = Literal["candidate", "active", "archived", "rejected"]
VersionGoal = Literal["quality", "saving", "rules"]
EvalRule = Literal["improve", "non_inferior"]
# Вывод кода по сравнению версий: better — лучше (правило улучшения), not_worse — не хуже
# (правило экономии), worse — хуже, noise — разница в пределах шума, failed — правило
# экономии не выполнено
CompareVerdict = Literal["better", "not_worse", "worse", "noise", "failed"]
MlStatus = Literal["candidate", "active", "archived", "rejected"]
RecalibrationDecision = Literal["activated", "rejected", "skipped"]
AdaptKey = Literal["dd10", "dd20", "week_loss", "up15", "week_win"]
EvalSetCode = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{2,39}$")]
PromptVersion = Annotated[str, StringConstraints(pattern=r"^analysis\.v[1-9][0-9]{0,3}$")]
LessonCode = Annotated[str, StringConstraints(pattern=r"^L-[0-9]{3,6}$")]
NoteText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=200, pattern=r"^[^\x00-\x1f\x7f]*$"),
]
TotpCode = Annotated[str, StringConstraints(pattern=r"^[0-9]{6}$")]


class CiNumOut(BaseModel):
    """Среднее и 95% ДИ (бутстрэп); n — событий."""

    value: float
    low: float
    high: float
    n: int


class CalibrationPointOut(BaseModel):
    """Корзина калибровки: прогнозы в [low, high), средняя вероятность p, доля сбывшихся
    actual и 95% интервал Уилсона."""

    low: float
    high: float
    n: int
    p: float
    actual: float
    ci_low: float
    ci_high: float


# --- бюджет проверок ---


class EvalBudgetOut(BaseModel):
    """Бюджет проверок месяца (UTC): всего, потрачено, в резерве за пакетами, остаток.
    first_month — месяц первого замороженного набора: бюджет не меньше суммы первого
    месяца (Р25: $30, дальше — настройка, $25); next_usd — бюджет со следующего месяца."""

    budget_usd: UsdOut
    spent_usd: UsdOut
    reserved_usd: UsdOut
    left_usd: UsdOut
    first_month: bool
    next_usd: UsdOut


# --- замороженный набор ---


class EvalSetOut(BaseModel):
    """Замороженный eval-набор: события после since (позже среза знаний модели), hard —
    трудных (близкие вероятности или неожиданный исход), sha256 списка событий. Рынок —
    по кэфам архива tennis-data без маржи (момент снятия не проверен): лог-лосс и Brier
    рынка на market_n событиях с кэфами."""

    id: int
    code: str
    frozen_at: datetime | None
    sha256: str | None
    n_events: int
    hard: int
    hard_share: float
    since: date | None
    until: date | None
    with_news: bool
    market_n: int
    market_log_loss: float | None
    market_brier: float | None


class EvalSetIn(BaseModel):
    """Заморозка набора: код (латиница, цифры, дефис; по умолчанию eval-ГГГГ-ММ по первому
    дню), первый день матчей (не раньше 1 августа 2026 и среза знаний модели), размер
    200–300 (по умолчанию из настроек, 250)."""

    model_config = ConfigDict(extra="forbid")

    code: EvalSetCode | None = None
    since: date | None = None
    size: int | None = Field(default=None, ge=200, le=300)


class EvalSetsOut(BaseModel):
    items: list[EvalSetOut]
    # Сколько сыгранных матчей архива после since есть сейчас (кандидатов в набор)
    available: int
    since: date
    size: int
    hard_share: float


# --- прогоны ---


class EvalMetricsOut(BaseModel):
    """Итог прогона версии на наборе: оценены n из total событий (unrated — ответа нет или
    он не годится: ошибки формата, max_tokens, отказы, ошибки пакета). Лог-лосс, Brier и
    ECE оценки Claude (p_claude, победа в матче), то же у базовой модели (p_base) и у
    рынка архива (на market_n событиях с кэфами). vs_base — разница лог-лосса Claude −
    базовая, vs_market — Claude − рынок, парный блочный по дням бутстрэп."""

    n: int
    total: int
    unrated: int
    format_errors: int
    max_tokens: int
    refusals: int
    log_loss: float | None
    brier: float | None
    ece: float | None
    log_loss_final: float | None
    log_loss_base: float | None
    brier_base: float | None
    market_n: int
    log_loss_market: float | None
    brier_market: float | None
    vs_base: CiNumOut | None
    vs_market: CiNumOut | None
    tokens_per_event: float | None
    cost_per_event_usd: UsdOut | None
    calibration: list[CalibrationPointOut]


class EvalRunOut(BaseModel):
    """Прогон: вид (eval — версия на наборе, quick — быстрая проверка урока, smoke —
    приемка этапа 3), версия инструкций, номер повтора (2 — повтор для порога шума), ход
    (пакетов собрано из всего), цена и худший случай. metrics — у законченного eval."""

    id: int
    kind: EvalRunKind
    version_id: int | None
    version_code: str | None
    eval_set_code: str
    repeat_no: int
    status: EvalRunStatus
    events: int
    chunks_done: int
    chunks_total: int
    created_at: datetime
    finished_at: datetime | None
    cost_usd: UsdOut
    worst_usd: UsdOut
    estimate_usd: UsdOut | None
    model: str | None
    error: str | None
    waiting: str | None
    metrics: EvalMetricsOut | None
    seed: int | None
    bootstrap: int | None


class EvalRunsOut(BaseModel):
    items: list[EvalRunOut]
    budget: EvalBudgetOut


class EvalPlanOut(BaseModel):
    """Прогон до запуска: сколько событий и пакетов (по batch_size), цена по живым числам
    (средняя цена ответа прошлых проверок, иначе оценка настроек), худший случай всего
    прогона и одного пакета (весь вход по цене записи кэша на 1 час, eval_max_tokens
    выхода, половина цены — Batch), бюджет проверок. worst_usd — вместе с пакетом повтора
    истекших и сбойных запросов (retry_events, не больше одного пакета). Запуск — если
    худший случай пакета помещается в остаток; иначе reason (код ошибки): eval.set_model_seen —
    первый день набора (eval_set.since) раньше среза знаний модели анализа
    (set_seen_since); eval.lesson_overlap — урок кандидата (overlap_lesson) проверен на
    архиве до заморозки набора, его надо перепроверить. set_model — модель, для которой
    набор замораживали."""

    version_id: int
    version_code: str
    eval_set: EvalSetOut | None
    repeat_no: int
    events: int
    chunks: int
    batch_size: int
    model: str
    max_tokens: int
    estimate_usd: UsdOut
    worst_usd: UsdOut
    worst_chunk_usd: UsdOut
    per_event_worst_usd: UsdOut
    budget: EvalBudgetOut
    can_run: bool
    reason: str | None
    running_run_id: int | None
    retry_events: int
    set_model: str | None
    set_seen_since: date
    overlap_lesson: str | None


class EvalRunIn(BaseModel):
    """Запуск прогона: версия инструкций и текущий код 2FA (тратит бюджет проверок)."""

    model_config = ConfigDict(extra="forbid")

    version_id: int = Field(ge=1, le=2**63 - 1)
    totp_code: TotpCode | None = None


# --- сравнение версий ---


class MetricDiffOut(BaseModel):
    """Показатель двух версий: a — база (активная), b — кандидат, diff = b − a с 95% ДИ
    (парный блочный по дням бутстрэп), margin — допуск правила, ok — выполнено."""

    a: float | None
    b: float | None
    diff: float | None
    low: float | None
    high: float | None
    margin: float | None
    ok: bool | None


class CountDiffOut(BaseModel):
    a: int
    b: int
    ok: bool


class CostChangeOut(BaseModel):
    """Стоимость или токены на событие у двух версий; change = b / a − 1 (−0,31 —
    дешевле на 31%)."""

    a: float | None
    b: float | None
    change: float | None
    ok: bool | None


class AgreementOut(BaseModel):
    """Совпадение решений по ставкам (набор исходов с p_final не ниже порога стратегии)
    и средняя |Δp| между кандидатом и базой; noise_* — то же между двумя прогонами базы
    (порог шума). ok — расхождение не больше 1,5 × шума (null — повтора базы нет)."""

    value: float | None
    mean_abs_dp: float | None
    noise_value: float | None
    noise_abs_dp: float | None
    ok: bool | None


class ComparisonOut(BaseModel):
    """Сравнение кандидата с активной версией на одних событиях набора (правила
    LLM_LEARNING.md 3.4 и TOKEN_ECONOMY.md 2.4 — кодом). rule improve: ДИ разницы
    лог-лосса целиком ниже нуля; non_inferior: верхняя граница ДИ лог-лосса ≤ +0,01,
    Brier ≤ +0,005, ECE ≤ +0,02, стоимость на событие ниже. В обоих правилах ошибок
    формата, остановок по max_tokens и отказов — каждого не больше, чем у базы. passed —
    решение кода; включает версию только администратор."""

    id: int | None
    candidate_run_id: int
    baseline_run_id: int
    noise_run_id: int | None
    candidate_version_id: int
    candidate_code: str
    baseline_version_id: int
    baseline_code: str
    rule: EvalRule
    n: int
    log_loss: MetricDiffOut
    brier: MetricDiffOut
    ece: MetricDiffOut
    format_errors: CountDiffOut
    max_tokens: CountDiffOut
    refusals: CountDiffOut
    cost_per_event: CostChangeOut
    tokens_per_event: CostChangeOut
    agreement: AgreementOut
    passed: bool
    verdict: CompareVerdict
    seed: int
    bootstrap: int
    created_at: datetime | None


# --- версии стратегии ---


class RulesCheckOut(BaseModel):
    """Проверка правил суммы на своих ставках (код, бесплатно): рассчитанные ставки
    приложения с since, у скольких сумма изменилась бы (changed), сумма ставок до и после
    (stake_old/stake_new) и прибыль при тех же исходах (profit_old/profit_new);
    triggered — сколько раз сработало бы каждое правило адаптации новой версии."""

    since: date | None
    bets: int
    changed: int
    stake_old: DecimalOut
    stake_new: DecimalOut
    stake_change: float | None
    profit_old: DecimalOut
    profit_new: DecimalOut
    currency: str
    triggered: dict[str, int]


class VersionEvalOut(BaseModel):
    """Версия инструкций на замороженном наборе: прогонов, последний прогон (метрики),
    noise — насколько разошлись два прогона (лог-лосс), to_market — разница лог-лосса с
    рынком архива с ДИ."""

    eval_set_code: str
    runs: int
    run_ids: list[int]
    n: int
    log_loss: float | None
    brier: float | None
    ece: float | None
    format_errors: int
    max_tokens: int
    refusals: int
    to_market: CiNumOut | None
    noise: float | None
    tokens_per_event: float | None
    cost_per_event_usd: UsdOut | None


class StrategyVersionOut(BaseModel):
    """Версия стратегии. line instructions — общая линия инструкций анализа (ведет
    администратор, Р25): промпт анализа и уроки в system; rules — свои правила суммы
    ставки участника (params). activated_at — когда включена; can_activate / can_rollback
    — может ли смотрящий включить или вернуть ее (activate_reason — почему нельзя)."""

    id: int
    line: VersionLine
    code: str
    name: str
    status: VersionStatus
    goal: VersionGoal | None
    parent_id: int | None
    parent_code: str | None
    changes: list[str]
    created_at: datetime
    activated_at: datetime | None
    archived_at: datetime | None
    prompt_version: str | None
    base_prompt: str | None
    lessons: list[str]
    params: StrategyParamsOut | None
    eval: VersionEvalOut | None
    comparison: ComparisonOut | None
    check: RulesCheckOut | None
    can_activate: bool
    activate_reason: str | None
    can_rollback: bool


class StrategyVersionsOut(BaseModel):
    """Версии: общая линия инструкций (новые сверху) и свои правила суммы ставки;
    замороженный набор, на котором проверяются инструкции."""

    instructions: list[StrategyVersionOut]
    rules: list[StrategyVersionOut]
    eval_set: EvalSetOut | None


class ParamDiffOut(BaseModel):
    key: str
    a: str | None
    b: str | None


class VersionCompareOut(BaseModel):
    """Сравнение двух версий одной линии: что отличается (diff) и, у инструкций,
    сравнение прогонов на наборе (null — у одной из версий нет прогона)."""

    a: StrategyVersionOut
    b: StrategyVersionOut
    diff: list[ParamDiffOut]
    comparison: ComparisonOut | None


class StakeBandIn(BaseModel):
    """Доля банка в диапазоне итогового кэфа: номер диапазона (с 0) и доля (0,0175)."""

    model_config = ConfigDict(extra="forbid")

    index: int = Field(ge=0, le=20)
    pct: float = Field(ge=0.001, le=0.05)


class RulesCandidateIn(BaseModel):
    """Кандидат своих правил суммы: включить или выключить правила адаптации и/или
    поменять долю банка в диапазонах итогового кэфа; note — зачем."""

    model_config = ConfigDict(extra="forbid")

    adapt: dict[AdaptKey, bool] = Field(default_factory=dict)
    stake_bands: list[StakeBandIn] = Field(default_factory=list, max_length=20)
    note: NoteText | None = None


class InstructionsCandidateIn(BaseModel):
    """Кандидат инструкций анализа (администратор): опубликованный промпт анализа
    (analysis.vN) и/или набор уроков (коды; null — как у активной), цель — улучшение или
    экономия; note — что изменилось."""

    model_config = ConfigDict(extra="forbid")

    prompt_version: PromptVersion | None = None
    lessons: list[LessonCode] | None = Field(default=None, max_length=50)
    goal: Literal["quality", "saving"] = "quality"
    note: NoteText | None = None


# --- базовая модель ---


class MlVersionOut(BaseModel):
    """Версия калибровки базовой модели (Эло по покрытиям + Платт): на чем подобрана
    (train_*), проверка на отложенной части (holdout_*: Brier, лог-лосс, ECE) против
    прежней (prev_*, diff_* — разница новая − прежняя с ДИ). auto — включена сама по
    правилу В6; reason — почему не включена. can_rollback — можно вернуть (была активной)."""

    id: str
    status: MlStatus
    created_at: datetime
    activated_at: datetime | None
    auto: bool
    parent_id: str | None
    train_from: date | None
    train_to: date | None
    n_train: int
    n_holdout: int
    brier: float | None
    log_loss: float | None
    ece: float | None
    prev_brier: float | None
    prev_log_loss: float | None
    diff_log_loss: CiNumOut | None
    diff_brier: CiNumOut | None
    platt_a: float | None
    platt_b: float | None
    reason: str | None
    can_rollback: bool


class WalkForwardOut(BaseModel):
    """Проверка по месяцам: калибровка — только на матчах до месяца, Brier модели на
    матчах месяца (n) против рынка архива (market_n — с кэфами)."""

    month: date
    n: int
    model_brier: float | None
    model_log_loss: float | None
    market_n: int
    market_brier: float | None


class MlRuleOut(BaseModel):
    """Правило включения перекалибровки (В6): верхняя граница ДИ разницы лог-лосса и
    Brier на отложенной части не выше допусков."""

    log_loss_margin: float
    brier_margin: float
    holdout_share: float


class MlModelOut(BaseModel):
    """«Базовая модель»: активная версия, все версии (новые сверху), проверка по месяцам,
    калибровка активной на отложенной части; поправка Claude числом — после
    claude_min_events событий с исходами (сейчас events_with_outcome)."""

    active: MlVersionOut | None
    versions: list[MlVersionOut]
    walk_forward: list[WalkForwardOut]
    calibration: list[CalibrationPointOut]
    events_with_outcome: int
    claude_min_events: int
    rule: MlRuleOut
    next_run: date


class RecalibrationOut(BaseModel):
    """Итог перекалибровки: новая версия включена (activated), не включена — хуже прежней
    (rejected) или не посчитана — мало матчей (skipped, reason)."""

    decision: RecalibrationDecision
    reason: str | None
    version: MlVersionOut | None


# --- сводка «Обучения модели» ---


class LessonBriefOut(BaseModel):
    id: int
    code: str
    text: str
    status: str
    created_at: datetime


class LearningLessonsOut(BaseModel):
    """Уроки: в анализе (in_prompt) из max_active, по статусам, готовые к решению (коды),
    последний (не отклоненный и не списанный)."""

    in_prompt: int
    max_active: int
    total: int
    hypotheses: int
    ready: int
    confirmed: int
    rejected: int
    retired: int
    ready_codes: list[str]
    last: LessonBriefOut | None


class VersionBriefOut(BaseModel):
    """Версия кратко: checked — у кандидата инструкций есть прогон на наборе и сравнение,
    passed — решение кода по правилу (null — сравнения нет)."""

    id: int
    code: str
    name: str
    status: VersionStatus
    activated_at: datetime | None
    checked: bool
    passed: bool | None
    rule: EvalRule | None


class LearningVersionsOut(BaseModel):
    """active — действующая версия общей линии инструкций: есть всегда (v3 создается при
    первом обращении к сводке)."""

    active: VersionBriefOut
    candidate: VersionBriefOut | None
    rules_active: VersionBriefOut | None
    rules_candidate: VersionBriefOut | None


class LearningModelOut(BaseModel):
    """Базовая модель на плитке: действующая версия (калибровка или elo-v1, пока
    перекалибровок не было). auto — версию включила перекалибровка сама (только у версии
    калибровки); recalibrated_at — когда была последняя перекалибровка (включена версия
    или нет), null — перекалибровок еще не было."""

    id: str
    brier: float | None
    log_loss: float | None
    activated_at: datetime | None
    auto: bool
    recalibrated_at: datetime | None


class LearningThresholdsOut(BaseModel):
    """Пороги из настроек (app_settings.agent_config): уроков в анализе, своих случаев
    для проверки урока (числовой и процессный), усадка k, событий для поправки Claude
    числом, матчей быстрой проверки, размер набора, пакет прогона, доля трудных."""

    lessons_max: int
    lesson_min_cases: int
    lesson_min_process: int
    shrink_k: int
    claude_min_events: int
    quick_check_events: int
    eval_set_size: int
    eval_batch_size: int
    eval_hard_share: float
    eval_min_answered: float


class LearningPricesOut(BaseModel):
    """Цены по настройкам и живым числам: разбор ставки (Batch), быстрая проверка урока
    (оценка), худший случай одного события прогона; бюджет проверок."""

    postmortem_usd: UsdOut
    quick_check_usd: UsdOut
    eval_event_worst_usd: UsdOut
    budget: EvalBudgetOut


class LearningOut(BaseModel):
    """Сводка «Обучения модели» и блока «Модель учится» на главной: рассчитано ставок
    приложения (своих), из них по архиву, событий в них; уроки, версии (общая линия и
    свои правила), базовая модель, набор, пороги и цены; следующий отчет — понедельник
    по поясу участника (отчеты — волна 4, last_report пока null)."""

    settled: int
    settled_auto: int
    settled_legs: int
    awaiting: int
    events_with_outcome: int
    lessons: LearningLessonsOut
    versions: LearningVersionsOut
    model: LearningModelOut | None
    eval_set: EvalSetOut | None
    thresholds: LearningThresholdsOut
    prices: LearningPricesOut
    next_report: date
    last_report: date | None
