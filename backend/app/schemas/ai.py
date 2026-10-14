"""Схемы ключей Claude, лимитов и бюджета на ИИ: /api/ai/budget, /api/me/ai-*,
/api/admin/ai/* и решение администратора о режиме ключа (Р7, Р9, Р12, Р13).

Ключ Claude целиком не возвращается ни в одном ответе: только последние 4 символа.
Доллары считает код в Decimal, наружу они уходят числом JSON (UsdOut): это только показ.
Р14: в ответах администратору об участнике — только расход на ИИ и активность.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.schemas.admin import (
    DailyAnalysesIn,
    LimitOut,
    MonthlyLimitIn,
    PerAnalysisIn,
    UsdLimitIn,
    UsdOut,
)
from app.schemas.me import AiMode, Role, TotpCodeStr, UserStatus

KeySource = Literal["admin", "own"]


# Итог проверки своего ключа: ok — ключ рабочий и все модели доступны; rejected —
# Anthropic не принял ключ (401/403); error — Anthropic ответил другой ошибкой;
# models — ключ рабочий, но части моделей из настроек агента нет
KeyCheckResult = Literal["ok", "rejected", "error", "models"]
AdminKeyStatus = Literal["ok", "unverified", "missing"]
AlertPct = Literal[50, 70, 80, 90]
ModeDecision = Literal["approve", "reject"]
# Ключ Claude на входе: формат (sk-ant-…) проверяет сервис, здесь — только защита
# от огромного тела запроса
KeyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=512)]
# Границы лимитов участника (MonthlyLimitIn, DailyAnalysesIn, PerAnalysisIn) — в
# app/schemas/admin.py, их же берет приглашение. Бюджет — как в форме макета
# (budgetEditCard); бюджет не меньше потраченного проверяет сервис: это зависит от расхода.
BudgetUsdIn = Annotated[Decimal, Field(ge=1, le=5000, max_digits=10, decimal_places=2)]
# Бюджет проверочных прогонов (Р22: $20–30 в месяц); 0 — проверки не запускаются
EvalBudgetUsdIn = Annotated[Decimal, Field(ge=0, le=500, max_digits=10, decimal_places=2)]


# --- участник: свой ключ, режим, потолок ---


class KeyModelOut(BaseModel):
    """Модель из настроек агента и доступна ли она ключу."""

    model: str
    available: bool


class OwnKeyOut(BaseModel):
    """Свой ключ участника и его режим. check — итог проверки в этом запросе (пусто,
    если ключ не проверяли), models — доступность моделей по этой проверке.
    last_error — код последней ошибки ключа (например rejected:401, ai.billing)."""

    mode: AiMode
    has_key: bool
    last4: str | None
    verified_at: datetime | None
    last_error: str | None
    check: KeyCheckResult | None
    models: list[KeyModelOut]


class OwnKeyIn(BaseModel):
    """Новый свой ключ: сохраняется, только если прошел проверку."""

    key: KeyStr


class AiModeIn(BaseModel):
    """Режим ключа. Участник сам переходит только на own; вернуться на ключ
    администратора — просьбой (POST /me/ai-mode/return-request)."""

    mode: AiMode


class OwnCapIn(BaseModel):
    """Свой потолок одного анализа на своем ключе, от $0,10 до $20."""

    per_analysis_usd: UsdLimitIn


class OwnCapOut(BaseModel):
    per_analysis_usd: UsdOut


class ReturnRequestOut(BaseModel):
    """Когда отправлена просьба вернуть ключ администратора."""

    requested_at: datetime


# --- бюджет ---


class AdminBudgetOut(BaseModel):
    """Общий бюджет ключа администратора на месяц (UTC).

    spent_usd — все вызовы на ключе администратора без проверочных прогонов,
    background_usd — из них общие задачи без участника. reserved_usd — резерв
    анализов, которые идут сейчас. forecast_usd — прогноз на конец месяца по темпу.
    members_limits_usd — сумма месячных лимитов участников на ключе администратора.
    members_usd — из spent_usd вызовы участников (не администраторов). budget_share —
    spent_usd к бюджету (доля; пусто — бюджет 0). eval_* — отдельный бюджет проверочных
    прогонов (eval и теневые, Р22)."""

    month_start: datetime
    days_in_month: int
    days_left: int
    budget_usd: UsdOut
    spent_usd: UsdOut
    background_usd: UsdOut
    reserved_usd: UsdOut
    left_usd: UsdOut
    forecast_usd: UsdOut
    members_limits_usd: UsdOut
    members_usd: UsdOut | None
    budget_share: float | None
    alert_pct: int
    eval_budget_usd: UsdOut
    eval_spent_usd: UsdOut


class OwnKeyInfoOut(BaseModel):
    """Свой ключ участника: последние 4 символа, когда проверен, последняя ошибка."""

    last4: str | None
    verified_at: datetime | None
    last_error: str | None


class AiBudgetOut(BaseModel):
    """Лимит и расход участника на ИИ (экраны «Ключ Claude» и «Новый анализ»).

    mode — режим участника, key_source — чей ключ платит. Месяц — по UTC с month_start,
    «анализов сегодня» — с полуночи в поясе участника. monthly_usd, left_usd и
    daily_analyses пустые, если личного лимита нет (свой ключ, администратор).
    spent_usd — расход за месяц на ключе этого режима, reserved_usd — резерв анализов,
    которые идут сейчас. per_analysis_usd — потолок одного анализа в этом режиме,
    own_cap_usd — свой потолок на своем ключе. avg_analysis_usd — средняя цена
    законченного анализа за месяц на ключе этого режима (пусто — анализов нет).
    reason_code — почему новый анализ сейчас не запустится (ключ errors.<код> и
    reason_params), пусто — запустится. budget — общий бюджет, только администратору.
    limit_share — spent_usd к месячному лимиту (доля; пусто — личного лимита нет)."""

    mode: AiMode
    key_source: KeySource
    has_key: bool
    month_start: datetime
    monthly_usd: UsdOut | None
    spent_usd: UsdOut
    limit_share: float | None
    reserved_usd: UsdOut
    left_usd: UsdOut | None
    daily_analyses: int | None
    analyses_today: int
    analyses_month: int
    per_analysis_usd: UsdOut
    soft_cap_usd: UsdOut
    paused: bool
    alert_pct: int
    own_key: OwnKeyInfoOut | None
    own_cap_usd: UsdOut
    avg_analysis_usd: UsdOut | None
    return_requested_at: datetime | None
    reason_code: str | None
    reason_params: dict[str, Any]
    budget: AdminBudgetOut | None


class BudgetIn(BaseModel):
    """Общий бюджет ключа администратора ($1–5000, не меньше потраченного за месяц),
    порог предупреждения о расходе и (по желанию) бюджет проверочных прогонов."""

    model_config = ConfigDict(extra="forbid")

    monthly_usd: BudgetUsdIn
    alert_pct: AlertPct
    eval_budget_usd: EvalBudgetUsdIn | None = None


# --- ключ администратора ---


class AdminKeyOut(BaseModel):
    """Ключ администратора: ok — проверен, unverified — сохранен, но не проверен или
    Anthropic перестал его принимать, missing — не задан. users_on_key — сколько
    активных пользователей сейчас на ключе администратора."""

    status: AdminKeyStatus
    last4: str | None
    verified_at: datetime | None
    users_on_key: int


class AdminKeyIn(BaseModel):
    """Новый ключ администратора и текущий код 2FA (смена ключа — опасное действие)."""

    key: KeyStr
    totp_code: TotpCodeStr


# --- лимиты участников ---


class LimitIn(BaseModel):
    """Лимит участника на ключе администратора: в месяц ($1–500), анализов в день
    (1–30), на анализ (от $0,10 до месячного лимита)."""

    monthly_usd: MonthlyLimitIn
    daily_analyses: DailyAnalysesIn
    per_analysis_usd: PerAnalysisIn


class LimitPatchIn(BaseModel):
    """Правка лимита участника: поле не передано (или null) — не меняется. Потолок на
    анализ не выше месячного лимита — с учетом действующего, если месяц не передан."""

    model_config = ConfigDict(extra="forbid")

    monthly_usd: MonthlyLimitIn | None = None
    daily_analyses: DailyAnalysesIn | None = None
    per_analysis_usd: PerAnalysisIn | None = None
    paused: bool | None = None


class LimitDefaultsOut(BaseModel):
    """Лимиты по умолчанию для новых участников (Р13): у зарегистрированных не меняются.
    per_analysis_usd — потолок анализа нового участника (и потолок своего ключа по
    умолчанию), это не жесткий потолок программы: его лимиты по умолчанию не меняют.
    soft_cap_usd — мягкий потолок анализа программы (предупреждение о цене)."""

    monthly_usd: UsdOut
    daily_analyses: int
    per_analysis_usd: UsdOut
    soft_cap_usd: UsdOut


class MemberLimitOut(BaseModel):
    """Строка таблицы «Лимиты участников». Р14: только расход на ИИ и активность.

    limit — действующий лимит на ключе администратора (у участника на своем ключе он
    вступит в силу при возврате); пусто у администратора: у него нет личного лимита.
    spent_month_usd — расход за месяц на ключе администратора, own_spent_month_usd —
    на своем ключе (вне общего бюджета); без проверочных прогонов. analyses_today — на
    ключе администратора с полуночи в поясе участника. return_requested_at — участник
    просит вернуть ключ администратора (Р12)."""

    id: int
    display_name: str
    email: str
    role: Role
    status: UserStatus
    ai_mode: AiMode
    limit: LimitOut | None
    own_cap_usd: UsdOut
    own_key_last4: str | None
    spent_month_usd: UsdOut
    own_spent_month_usd: UsdOut
    analyses_today: int
    analyses_month: int
    return_requested_at: datetime | None


class AdminLimitsOut(BaseModel):
    defaults: LimitDefaultsOut
    members: list[MemberLimitOut]


class ModeDecisionIn(BaseModel):
    """Решение по просьбе вернуть ключ администратора. limit — лимит на ключе
    администратора при одобрении (не задан — остается прежний)."""

    model_config = ConfigDict(extra="forbid")

    decision: ModeDecision
    limit: LimitIn | None = None


# --- расход по вызовам: «ИИ и расходы» и «Администрирование → Расход ИИ» (этап 4) ---

# Месяц расходов по UTC: 2026-10
MonthStr = Annotated[str, StringConstraints(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")]
# Вид вызова в журнале: шаги анализа и задачи этапа 5; проверки (eval, shadow) — только
# у администратора, в «Расходе ИИ» отдельной строкой
RunKind = Literal["parse", "news", "analysis", "refresh", "postmortem"]
# Фильтр журнала: вид вызова или shared — общие задачи без участника и прогоны приемки
# (только у администратора, у участника их нет)
RunFilter = Literal["parse", "news", "analysis", "refresh", "postmortem", "shared"]


class UsageSumsOut(BaseModel):
    """Сумма вызовов: число (errors — с ошибкой), цена, токены по видам и поиски.
    input_tokens — вход без кэша (как usage.input_tokens API), prompt_tokens — весь вход
    (без кэша, запись и чтение кэша). cache_share — доля кэша по формуле PLAN.md, раздел 8:
    cache_read / (input + cache_write + cache_read); пусто — входа нет."""

    runs: int
    errors: int
    cost_usd: UsdOut
    input_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    output_tokens: int
    prompt_tokens: int
    web_searches: int
    cache_share: float | None


class UsageKindCostOut(BaseModel):
    """Вид вызова в дне: число вызовов и цена (состав столбца «Расходы по дням»)."""

    kind: str
    runs: int
    cost_usd: UsdOut


class UsageDayOut(UsageSumsOut):
    """День по UTC (месяц расходов тоже по UTC, поэтому сумма дней — расход месяца)."""

    day: date
    kinds: list[UsageKindCostOut]


class UsageKindOut(UsageSumsOut):
    """Вид вызова за месяц. avg_* — в среднем на вызов без ошибки (пусто — таких нет);
    models и efforts — какие модели и effort были у вызовов. share — доля вида в расходе
    месяца (пусто — расхода нет)."""

    kind: str
    share: float | None
    avg_cost_usd: UsdOut | None
    avg_prompt_tokens: int | None
    avg_output_tokens: int | None
    models: list[str]
    efforts: list[str]


class UsageModelOut(UsageSumsOut):
    model: str


class UsageStepOut(BaseModel):
    """Шаг анализа (agent_runs.step; 0 — вызов вне анализа) и вид вызова."""

    kind: str
    step: int
    runs: int
    cost_usd: UsdOut


class UsageVersionOut(BaseModel):
    """Версия инструкций вида вызова: цена за месяц и в среднем на вызов без ошибки.
    Качество версии — этап 5."""

    kind: str
    prompt_version: str | None
    runs: int
    cost_usd: UsdOut
    avg_cost_usd: UsdOut | None


class AnalysisCostOut(BaseModel):
    """Свой анализ месяца: цена (сумма его вызовов), закончен ли, прогон приемки ли, на
    чьем ключе шел (key_source фиксируется при запуске)."""

    id: int
    started_at: datetime
    cost_usd: UsdOut
    done: bool
    acceptance: bool
    key_source: KeySource | None


class ModelPriceOut(BaseModel):
    """Действующая цена модели в долларах за 1 млн токенов и за один веб-поиск (из
    model_prices). Вторая ступень: весь вход запроса больше long_input_threshold —
    цены токенов × long_multiplier."""

    model: str
    valid_from: datetime
    input: UsdOut
    output: UsdOut
    cache_read: UsdOut
    cache_write_5m: UsdOut
    cache_write_1h: UsdOut
    search_price: UsdOut
    long_input_threshold: int | None
    long_multiplier: UsdOut | None


class AgentSettingsOut(BaseModel):
    """Настройки агента только для показа (Р23): меняются командой agent-config.
    Потолки анализа программы — из app_settings."""

    parse_model: str
    parse_effort: str
    news_enabled: bool
    news_model: str
    news_effort: str
    news_searches_per_match: int
    news_searches_per_analysis: int
    news_searches_per_day: int
    news_ttl_hours: int
    news_lookback_days: int
    news_domains: list[str]
    news_prompt_cache: bool
    analysis_model: str
    analysis_effort: str
    analysis_parallel: int
    assessment_reuse_hours: int
    soft_cap_usd: UsdOut
    hard_cap_usd: UsdOut
    default_per_analysis_usd: UsdOut


class AiUsageOut(BaseModel):
    """Свой расход на Claude за месяц (UTC) по вызовам agent_runs, без проверок (eval).
    У администратора — свои вызовы и общие задачи без участника (shared_usd), прогоны
    приемки — отдельно (acceptance_usd); own_usd — свои остальные вызовы.

    days — с 1-го числа по last_day (сегодня, если месяц текущий). admin_key_usd и
    own_key_usd — чей ключ платил. search_usd — цена поисков, cache_saved_usd — сколько
    сэкономило чтение кэша против обычного входа (по model_prices на момент вызова).
    avg_analysis_usd — средняя цена своего законченного анализа месяца без прогонов
    приемки (на обоих ключах). admin_key_avg_usd — то же только на ключе администратора
    (шаг $0,0001): у участника на ключе администратора — то же число, что
    avg_analysis_usd в GET /ai/budget; ее показывать рядом с лимитом. forecast_usd —
    прогноз на конец месяца по темпу (участник на ключе администратора — не выше лимита,
    на паузе — потрачено); у прошедшего месяца — итог. analyses_left — на сколько
    анализов по admin_key_avg_usd хватит остатка лимита (left_usd в GET /ai/budget;
    только участник на ключе администратора в текущем месяце)."""

    month: str
    month_start: date
    last_day: date
    days_in_month: int
    days_elapsed: int
    current: bool
    totals: UsageSumsOut
    own_usd: UsdOut
    acceptance_usd: UsdOut
    shared_usd: UsdOut
    admin_key_usd: UsdOut
    own_key_usd: UsdOut
    search_usd: UsdOut
    cache_saved_usd: UsdOut
    days: list[UsageDayOut]
    kinds: list[UsageKindOut]
    models: list[UsageModelOut]
    steps: list[UsageStepOut]
    versions: list[UsageVersionOut]
    analyses: list[AnalysisCostOut]
    avg_analysis_usd: UsdOut | None
    admin_key_avg_usd: UsdOut | None
    forecast_usd: UsdOut
    analyses_left: int | None
    prices: list[ModelPriceOut]
    settings: AgentSettingsOut


class CostPartOut(BaseModel):
    """Часть цены вызова: токены (у поисков — число поисков), цена за 1 млн токенов (у
    поисков — за один поиск) и сумма с учетом второй ступени и Batch."""

    tokens: int
    price: UsdOut
    cost_usd: UsdOut


class RunCostOut(BaseModel):
    """Из чего сложилась цена вызова по model_prices на момент вызова. long_factor —
    множитель второй ступени (1 — нет), batch — половина цены токенов. Части округлены
    до миллионной доли, cost_usd вызова — как записано в agent_runs."""

    valid_from: datetime
    input: CostPartOut
    cache_write_5m: CostPartOut
    cache_write_1h: CostPartOut
    cache_read: CostPartOut
    output: CostPartOut
    searches: CostPartOut
    long_factor: UsdOut
    batch: bool


class AiRunOut(BaseModel):
    """Вызов Claude (строка журнала): вид, шаг анализа, модель и effort, токены, цена.
    shared — общая задача без участника, acceptance — прогон приемки (у администратора).
    analysis_id — свой анализ. error — код сбоя вызова. price — разбор цены (пусто —
    цены модели на момент вызова нет)."""

    id: int
    created_at: datetime
    kind: str
    step: int
    model: str
    effort: str | None
    prompt_version: str | None
    key_source: KeySource
    analysis_id: int | None
    shared: bool
    acceptance: bool
    batch: bool
    input_tokens: int
    cache_write_tokens: int
    cache_read_tokens: int
    output_tokens: int
    thinking_tokens: int | None
    prompt_tokens: int
    web_searches: int
    cache_share: float | None
    cost_usd: UsdOut
    duration_ms: int | None
    stop_reason: str | None
    error: str | None
    price: RunCostOut | None


class AiRunsOut(BaseModel):
    """Страница журнала вызовов месяца, новые сверху. total_* — все вызовы фильтра за
    месяц; next_before — курсор следующей страницы."""

    items: list[AiRunOut]
    total_runs: int
    total_cost_usd: UsdOut
    next_before: int | None


class PersonUsageOut(BaseModel):
    """Человек в «Расходе ИИ» администратора (Р14: только расход на ИИ и число анализов).
    key_spent_usd — на ключе администратора, own_spent_usd — на своем (вне бюджета);
    analyses — анализы на ключе администратора, own_analyses — на своем. limit_usd —
    месячный лимит (пусто у администратора); budget_share и limit_share — доля бюджета
    и лимита."""

    user_id: int
    display_name: str
    role: Role
    status: UserStatus
    ai_mode: AiMode
    key_spent_usd: UsdOut
    own_spent_usd: UsdOut
    analyses: int
    own_analyses: int
    limit_usd: UsdOut | None
    paused: bool
    budget_share: float | None
    limit_share: float | None


class TaskUsageOut(BaseModel):
    """Задача (вид вызова) на ключе администратора: вызовы участников, без общих задач."""

    kind: str
    runs: int
    cost_usd: UsdOut
    cache_share: float | None
    budget_share: float | None
    models: list[str]


class SharedUsageOut(BaseModel):
    """Общие задачи без участника на ключе администратора (сейчас — приемка agent-smoke)."""

    runs: int
    cost_usd: UsdOut
    cache_share: float | None
    budget_share: float | None
    kinds: list[str]


class EvalRunUsageOut(BaseModel):
    """Проверочный прогон (eval) месяца: вызовы и цена; eval_run_id пустой — вызовы без
    записи прогона."""

    eval_run_id: int | None
    created_at: datetime | None
    name: str | None
    eval_set: str | None
    n_events: int | None
    models: list[str]
    runs: int
    cost_usd: UsdOut


class EvalUsageOut(BaseModel):
    """Проверки (eval, shadow) — свой бюджет на ключе администратора, в общий не входят."""

    budget_usd: UsdOut
    spent_usd: UsdOut
    runs: int
    items: list[EvalRunUsageOut]


class AdminAiUsageOut(BaseModel):
    """«Администрирование → Расход ИИ» за месяц (UTC). spent_usd — ключ администратора
    без проверок (как бюджет), из него shared — общие задачи; own_key_usd — участники на
    своих ключах (вне бюджета). analyses — анализы на ключе администратора за месяц,
    avg_analysis_usd — средняя цена законченного. cache_share — по всем вызовам ключа
    администратора без проверок. Р14: ни анализов, ни ввода, ни ставок участников."""

    month: str
    month_start: date
    last_day: date
    days_in_month: int
    days_elapsed: int
    current: bool
    budget_usd: UsdOut
    spent_usd: UsdOut
    budget_share: float | None
    analyses: int
    avg_analysis_usd: UsdOut | None
    cache_share: float | None
    own_key_usd: UsdOut
    people: list[PersonUsageOut]
    shared: SharedUsageOut
    tasks: list[TaskUsageOut]
    eval: EvalUsageOut
