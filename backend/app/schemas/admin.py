"""Схемы кабинета администратора: /api/admin/*.

Здесь — учетные записи, расход на ИИ и активность: полей ставок, банка и стратегии в этих
схемах нет (это проверяет тест). Ставки и банк участника администратор читает его же
маршрутами с as_user (Р27), сводка по всем — app/schemas/admin_summary.py.
Суммы в долларах считает код в Decimal, наружу они уходят числом JSON: это только показ.
"""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, PlainSerializer, StringConstraints

from app.schemas.me import AiMode, LoginEventOut, Role, TotpCodeStr, UserStatus

# Доллары ИИ: в коде Decimal, в JSON — число
UsdOut = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]
# Лимит в долларах при вводе: не меньше нуля, два знака после запятой (NUMERIC(10, 2))
UsdLimitIn = Annotated[Decimal, Field(ge=0, max_digits=10, decimal_places=2)]
# Границы лимита участника — как в формах макета (mockup/js/screens/admin.js: limitFields):
# в месяц $1–500, анализов в день 1–30, на анализ от $0,10. Потолок анализа не выше
# месячного лимита проверяет сервис: это зависит от другого поля
MonthlyLimitIn = Annotated[Decimal, Field(ge=1, le=500, max_digits=10, decimal_places=2)]
DailyAnalysesIn = Annotated[int, Field(ge=1, le=30)]
PerAnalysisIn = Annotated[
    Decimal, Field(ge=Decimal("0.10"), le=500, max_digits=10, decimal_places=2)
]
# Email на входе: обрезаются пробелы, проверяется только общий вид name@domain.
# Символ NUL не пропускается: PostgreSQL не хранит его в тексте, запрос упал бы с 500
EmailIn = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        to_lower=True,
        max_length=320,
        pattern=r"^[^\s@\x00]+@[^\s@\x00]+\.[^\s@\x00]+$",
    ),
]

CodeStatus = Literal["active", "used", "expired", "revoked"]
AuditAction = Literal[
    "invite",
    "invite_revoke",
    "reset_code",
    "reset_code_revoke",
    "reset_2fa",
    "block",
    "unblock",
    "delete",
    "role_change",
    "sessions_revoke",
    "limit_change",
    "key_change",
    "currency_change",
    "create_admin",
    "import",
    "message",
    "confirm_failed",
    "player_merge",
    "player_edit",
    "ai_mode_change",
    "budget_change",
    "agent_config_change",
    "settings_change",
    "data_upload",
    "eval_set",
    "eval_run",
    "version_on",
    "lesson_on",
    "model_on",
    "lesson_off",
    "member_view",
    "member_export",
]


# --- участники ---


class LimitOut(BaseModel):
    """Лимит участника на ключе администратора (ai_limits)."""

    monthly_usd: UsdOut
    daily_analyses: int
    per_analysis_usd: UsdOut
    paused: bool


class AdminUserOut(BaseModel):
    """Строка списка участников. Только учетная запись, расход на ИИ и активность (Р14).

    ai_spent_month_usd и analyses_month — за текущий месяц (UTC) на ключе администратора.
    limit пустой, если лимита нет (участник на своем ключе). limit_share — ai_spent_month_usd
    к месячному лимиту (доля; пусто — лимита нет или он нулевой).
    """

    id: int
    display_name: str
    email: str
    role: Role
    status: UserStatus
    ai_mode: AiMode
    totp_enabled: bool
    created_at: datetime
    last_login_at: datetime | None
    ai_spent_month_usd: UsdOut
    analyses_month: int
    limit: LimitOut | None
    limit_share: float | None


class AdminUserDetailOut(AdminUserOut):
    """Карточка участника: плюс число действующих сеансов и последние 20 входов."""

    active_sessions: int
    recent_logins: list[LoginEventOut]


class RoleChangeIn(BaseModel):
    role: Role
    totp_code: TotpCodeStr


class TotpConfirmIn(BaseModel):
    """Текущий код 2FA администратора: подтверждение опасного действия."""

    totp_code: TotpCodeStr


class AdminActionIn(BaseModel):
    """Блокировка и завершение сеансов: код 2FA нужен, только если цель — администратор
    (с угнанным сеансом без телефона нельзя по одному отключить других администраторов)."""

    totp_code: TotpCodeStr | None = None


class UserDeleteIn(BaseModel):
    """Удаление участника (Р15): email участника для подтверждения и код 2FA."""

    confirm_email: Annotated[
        str, StringConstraints(strip_whitespace=True, max_length=320, pattern=r"^[^\x00]*$")
    ]
    totp_code: TotpCodeStr


# --- приглашения и коды сброса ---


class InviteLimit(BaseModel):
    """Стартовый лимит из приглашения: попадет в ai_limits при регистрации."""

    monthly_usd: MonthlyLimitIn
    daily_analyses: DailyAnalysesIn
    per_analysis_usd: PerAnalysisIn


class InviteLimitOut(BaseModel):
    monthly_usd: UsdOut
    daily_analyses: int
    per_analysis_usd: UsdOut


class InviteIn(BaseModel):
    """Новое приглашение. limit — только для режима shared (ключ администратора);
    не задан — берутся значения по умолчанию из настроек программы. Для own лимит
    не нужен: потолок задает сам участник.

    totp_code — текущий код 2FA администратора, обязателен для роли admin: такое
    приглашение выдает те же права, что и смена роли. Для участника не нужен."""

    email: EmailIn
    role: Role = "member"
    ai_mode: AiMode = "shared"
    limit: InviteLimit | None = None
    totp_code: TotpCodeStr | None = None


class InviteOut(BaseModel):
    """Приглашение без кода: код показывается один раз при создании.
    created_by_name пустой — код выдан командой терминала; автор удален —
    подпись «Удаленный пользователь» (его имя стерто по Р15)."""

    id: int
    email: str
    role: Role
    ai_mode: AiMode
    limit: InviteLimitOut | None
    created_at: datetime
    expires_at: datetime
    used_at: datetime | None
    used_by_name: str | None
    revoked_at: datetime | None
    created_by_name: str
    status: CodeStatus


class InviteCreatedOut(BaseModel):
    """Созданное приглашение и его код CAP-XXXX-XXXX (в базе только хеш)."""

    invite: InviteOut
    code: str


class ResetCodeIn(BaseModel):
    user_id: Annotated[int, Field(ge=1, le=2**63 - 1)]


class ResetCodeOut(BaseModel):
    """Код сброса пароля без самого кода. created_by_name пустой — из терминала;
    автор удален — подпись «Удаленный пользователь»."""

    id: int
    user_id: int
    user_name: str
    user_email: str
    created_at: datetime
    expires_at: datetime
    used_at: datetime | None
    revoked_at: datetime | None
    created_by_name: str
    status: CodeStatus


class ResetCodeCreatedOut(BaseModel):
    """Выданный код RST-XXXX-XXXX (в базе только хеш). Прежние коды отозваны."""

    reset_code: ResetCodeOut
    code: str


# --- журнал ---


class AuditOut(BaseModel):
    """Запись журнала. actor_id пустой и actor_name "" — действие из терминала.
    Удаленный автор или участник — имя «Удаленный пользователь» (имя стерто по Р15).

    В details нет сумм, ставок, банка и стратегии участника. Просмотр данных участника
    (Р27): member_view — {user_id, screen} (screen: dashboard, bets, analytics, bank,
    analyses, learning, ai; summary — сводка по всем, user_id null, еще period);
    member_export — {user_id, what} (what: bets или analytics, у analytics — еще parts)."""

    id: int
    at: datetime
    actor_id: int | None
    actor_name: str
    action: AuditAction
    target_user_id: int | None
    target_name: str
    details: dict[str, Any]
    ip: str | None


# --- активность (этап 4) ---

# Период активности: последние сутки, 7, 30 или 90 дней (журнал входов хранится 90 дней)
ActivityPeriod = Literal["1d", "7d", "30d", "90d"]


class PersonActivityOut(BaseModel):
    """Активность человека за период (Р14: только входы и число анализов). logins —
    успешные входы, failed_logins — неудачные попытки; analyses — запущенные анализы."""

    user_id: int
    display_name: str
    role: Role
    status: UserStatus
    logins: int
    failed_logins: int
    last_login_at: datetime | None
    analyses: int
    last_analysis_at: datetime | None


class ActivityOut(BaseModel):
    """Входы и анализы по людям за период с since. active_users — сколько людей входили,
    today_users — сколько входили сегодня (с полуночи в поясе администратора)."""

    period: ActivityPeriod
    since: datetime
    logins: int
    failed_logins: int
    analyses: int
    active_users: int
    today_users: int
    people: list[PersonActivityOut]
