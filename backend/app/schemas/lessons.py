"""Уроки и разборы ставок (этап 5, волна 2): «Обучение модели → Уроки» и блок «Разбор ИИ»
на «Ставках».

Уроки общие для всех участников (Р25), ведет администратор. Числа (своих случаев, эффект
с ДИ, усадка, отложенная часть, быстрая проверка) считает код на сервере; экран рисует.
Основание урока — прогнозы и матчи; свои ставки в основании (own_bets) участник видит
только свои (Т21, Р14). Деньги ИИ — в долларах числом.
"""

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.schemas.admin import UsdOut
from app.schemas.analyses import Market
from app.schemas.bets import Verdict

LessonStatus = Literal["hypothesis", "ready", "confirmed", "rejected", "retired"]
LessonKind = Literal["numeric", "process"]
LessonOrigin = Literal["postmortem", "manual"]
Direction = Literal["lower", "raise"]
FeatureName = Literal[
    "market",
    "surface",
    "round",
    "best_of",
    "role",
    "elo_gap",
    "odds",
    "sets_48h",
    "opp_sets_48h",
    "rest_days",
    "h2h_matches",
    "h2h_wins",
]
OpName = Literal["in", "eq", "lt", "le", "gt", "ge"]
# Итог проверки на истории: ready — подтвержден, rejected — нет, insufficient — мало
# случаев в архиве (урок остается гипотезой)
HistoryStatus = Literal["ready", "rejected", "insufficient"]
QuickStatus = Literal["pending", "running", "done", "failed"]
LessonText = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=10, max_length=300, pattern=r"^[^\x00-\x1f\x7f]*$"
    ),
]
ScopeValue = Annotated[str, StringConstraints(max_length=16)]


class ScopeConditionIO(BaseModel):
    """Условие из словаря признаков: перечень — op in/eq и values, число — op lt/le/gt/ge
    и value."""

    model_config = ConfigDict(extra="forbid")

    feature: FeatureName
    op: OpName
    values: list[ScopeValue] = Field(default_factory=list, max_length=8)
    value: float | None = None


class ScopeIO(BaseModel):
    """Условие урока: направление (модель завышает — lower, занижает — raise) и признаки."""

    model_config = ConfigDict(extra="forbid")

    direction: Direction
    conditions: list[ScopeConditionIO] = Field(max_length=6)


class FeatureOut(BaseModel):
    """Признак словаря: перечень (values) или число (low…high с шагом step); side —
    признак своей стороны исхода."""

    feature: FeatureName
    kind: Literal["enum", "number"]
    ops: list[OpName]
    values: list[str]
    low: float | None
    high: float | None
    step: float | None
    side: bool


class LessonDictionaryOut(BaseModel):
    features: list[FeatureOut]
    directions: list[Direction]
    max_conditions: int


class LessonEstimateOut(BaseModel):
    """Значение и его 95% ДИ (бутстрэп), n — событий."""

    value: float
    low: float
    high: float
    n: int


class LessonHistoryOut(BaseModel):
    """Проверка на архиве кодом: случаи истории и отложенной части (с holdout_since);
    bias — средний остаток y − p модели в условии (доля, −0,05 = модель завышает на
    5 п.п.); shift — поправка с усадкой; лог-лосс без урока и с поправкой; gain — выигрыш
    лог-лосса на истории (без − с, больше нуля — урок помогает), holdout_gain — на
    отложенной части; seed бутстрэпа."""

    checked_at: datetime | None
    status: HistoryStatus
    reason: str | None
    method: str
    n_hist: int
    n_history: int
    n_holdout: int
    holdout_since: date | None
    bias: LessonEstimateOut | None
    shift: float | None
    log_loss_without: float | None
    log_loss_with: float | None
    gain: LessonEstimateOut | None
    holdout_gain: LessonEstimateOut | None
    seed: int


class LessonQuickOut(BaseModel):
    """Быстрая проверка перед включением (В4): матчей, итог, разница лог-лосса с уроком и
    без (с − без, меньше нуля — лучше), ошибки формата и отказы, цена и худший случай.
    passed — не хуже: верхняя граница ДИ разницы не выше допуска, все события оценены."""

    eval_run_id: int
    status: QuickStatus
    started_at: datetime | None
    finished_at: datetime | None
    events: int
    requests: int
    passed: bool | None
    diff: LessonEstimateOut | None
    margin: float
    format_errors: int
    refusals: int
    unrated: int
    cost_usd: UsdOut
    worst_usd: UsdOut
    error: str | None


class LessonOut(BaseModel):
    """Урок. n_cases — своих случаев (матчей ставок под условием; участник видит только
    матчи своих ставок, администратор — всех), need_cases — порог проверки; effect,
    effect_ci, effect_shrunk, holdout_* — как в lessons (доли);
    own_bets — ваши ставки в основании урока (только ваши, Т21); watching — вы просили
    сообщить, когда урок проверят; scope_ok — условие из словаря (его можно проверить на
    архиве)."""

    id: int
    code: str
    text: str
    kind: LessonKind
    status: LessonStatus
    origin: LessonOrigin
    shared: bool
    scope: ScopeIO | None
    scope_ok: bool
    in_prompt: bool
    created_at: datetime
    n_cases: int
    need_cases: int
    n_hist: int
    effect: float | None
    effect_ci: list[float] | None
    effect_shrunk: float | None
    holdout_effect: float | None
    holdout_ci: list[float] | None
    validated_at: datetime | None
    decided_at: datetime | None
    retired_at: datetime | None
    rechecked_at: datetime | None
    history: LessonHistoryOut | None
    quick: LessonQuickOut | None
    own_bets: list[int]
    watching: bool


class LessonsOut(BaseModel):
    """Уроки и пороги из настроек: не больше max_active в анализе (сейчас active),
    проверка — с min_cases своих случаев (процессный — min_cases_process), усадка k."""

    items: list[LessonOut]
    active: int
    max_active: int
    min_cases: int
    min_cases_process: int
    shrink_k: int


class LessonIn(BaseModel):
    """Предложить урок: наблюдение одной фразой и условие из словаря (Т7). Процессный урок
    (kind process) — только администратор."""

    model_config = ConfigDict(extra="forbid")

    text: LessonText
    kind: LessonKind = "numeric"
    scope: ScopeIO


class QuickCheckOut(BaseModel):
    """Быстрая проверка урока до запуска (цена по живым числам и худший случай) и после
    (eval_run_id, status). requests — запросов в пакете: по матчу с уроком и, где нет
    готового прогона без урока, еще по одному без него. reason — почему запустить нельзя
    (ключ errors.*): нет матчей, мало бюджета проверок, проверка уже идет, урок не готов."""

    lesson_id: int
    events: int
    requests: int
    baseline_reused: int
    model: str
    estimate_usd: UsdOut
    worst_usd: UsdOut
    budget_usd: UsdOut
    spent_usd: UsdOut
    reserved_usd: UsdOut
    left_usd: UsdOut
    active: int
    max_active: int
    can_run: bool
    reason: str | None
    eval_run_id: int | None
    status: QuickStatus | None


# --- разбор ставки ---

ReviewVerdict = Literal["fine", "lucky", "luck", "model_error", "data_gap"]
ReviewStatus = Literal["queued", "submitted", "done", "failed"]
# Разбор ставки целиком: open — не рассчитана; not_reviewed — не разбирается (возврат,
# ставка старого бота, нет прогноза); pending — разборы готовятся; done; failed — разбор
# не удался (без повтора)
BetReviewState = Literal["open", "not_reviewed", "pending", "done", "failed"]
NotReviewedReason = Literal["void", "legacy", "no_prediction"]


class ReviewLessonOut(BaseModel):
    """Урок гипотезы разбора: код, статус, случаев из порога (у участника — только по его
    ставкам, Р14), в анализе ли."""

    id: int
    code: str
    status: LessonStatus
    in_prompt: bool
    n_cases: int
    need_cases: int
    text: str


class LegReviewOut(BaseModel):
    """Разбор матча ноги (общий для всех, кто на него ставил, В3) и вердикт по вашей ноге.
    Общий разбор построен только по архиву и досье: market и selection — сторона, которую
    разбирали (прогноз базовой модели на победу в матче — ее фаворит), same_pick — ваша
    нога на эту же сторону. what — что произошло, why — почему, hypothesis — гипотеза
    текстом, lesson — ее урок (нет — условие не из словаря или гипотезы нет). verdict —
    вывод по вашей ноге, считает код: won — ваша нога сыграла (как внесена или
    рассчитана), clv — CLV вашей ноги (доля; нет закрытия — null); вывод общего разбора
    берется, только если нога на ту же сторону и обе проиграли. model, cost_usd,
    done_at — модель, цена вызова (Batch) и когда разбор готов."""

    leg_id: int
    match_id: int
    market: Market
    selection: int
    same_pick: bool
    won: bool
    clv: float | None
    status: ReviewStatus
    verdict: ReviewVerdict | None
    what: str | None
    why: str | None
    hypothesis: str | None
    lesson: ReviewLessonOut | None
    model: str | None
    cost_usd: UsdOut | None
    done_at: datetime | None


class BetReviewOut(BaseModel):
    """Разбор ИИ ставки: по разбору на каждый матч с исходом (возвраты ног не
    разбираются) и вердикт по CLV кодом (строкой на экране, как на этапе 4)."""

    bet_id: int
    state: BetReviewState
    reason: NotReviewedReason | None
    clv_verdict: Verdict | None
    legs: list[LegReviewOut]
