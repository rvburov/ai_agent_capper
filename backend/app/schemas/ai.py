"""Схемы ключей Claude, лимитов и бюджета на ИИ: /api/ai/budget, /api/me/ai-*,
/api/admin/ai/* и решение администратора о режиме ключа (Р7, Р9, Р12, Р13).

Ключ Claude целиком не возвращается ни в одном ответе: только последние 4 символа.
Доллары считает код в Decimal, наружу они уходят числом JSON (UsdOut): это только показ.
Р14: в ответах администратору об участнике — только расход на ИИ и активность.
"""

from datetime import datetime
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
    eval_* — отдельный бюджет проверочных прогонов (eval и теневые, Р22)."""

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
    reason_params), пусто — запустится. budget — общий бюджет, только администратору."""

    mode: AiMode
    key_source: KeySource
    has_key: bool
    month_start: datetime
    monthly_usd: UsdOut | None
    spent_usd: UsdOut
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
