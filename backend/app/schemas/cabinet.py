"""Схемы личного кабинета этапа 4: что присылать в уведомлениях, «Мои букмекеры»,
ответственная игра, удаление аккаунта и экспорт (Р3, Р15, Р24, В8–В10).

Деньги — Decimal строкой в JSON, в валюте программы (currency).
"""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.analyses import DecimalOut
from app.schemas.bets import BookmakerIn
from app.schemas.me import PasswordStr, TotpCodeStr

NotificationKind = Literal[
    "bet_settled",
    "data_stale",
    "limit_80",
    "limit_100",
    "new_device",
    "admin_message",
    "login_failures",
    "ai_key_failed",
    "ai_mode_request",
    "ai_mode_decision",
    "budget_80",
    "budget_100",
    "ai_alert",
]
Currency = Literal["RUB", "USD", "EUR"]


# --- уведомления ---


class NotificationPrefOut(BaseModel):
    """Вид уведомления в настройках. group — строка экрана (limit_80 и limit_100 — одна
    строка); required — приходит всегда, выключить нельзя; admin — раздел «Для
    администратора»; push — только показ, push появится на этапе 6."""

    kind: NotificationKind
    group: str
    on_site: bool
    push: bool
    required: bool
    admin: bool


class NotificationPrefsOut(BaseModel):
    items: list[NotificationPrefOut]
    # Push включится на этапе 6: до этого столбец «Push» неактивен
    push_available: bool


class NotificationPrefIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: NotificationKind
    on_site: bool


class NotificationPrefsIn(BaseModel):
    """Частичное обновление: только переданные виды."""

    model_config = ConfigDict(extra="forbid")

    items: list[NotificationPrefIn] = Field(min_length=1, max_length=32)


# --- букмекеры ---


class BookmakerCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: BookmakerIn


class BookmakerPatchIn(BaseModel):
    """Переименовать (name) и/или скрыть (archived = true) или вернуть (false). Поле не
    передано — не меняется."""

    model_config = ConfigDict(extra="forbid")

    name: BookmakerIn | None = None
    archived: bool | None = None


class BookmakerOut(BaseModel):
    """Букмекер из списка участника. bets — все ставки с этим названием, open_bets и
    in_play — ставки в игре и их сумма. archived_at задан — скрыт: в формах не
    предлагается, история ставок остается."""

    id: int
    name: str
    created_at: datetime
    archived_at: datetime | None
    bets: int
    open_bets: int
    in_play: DecimalOut


class BookmakersOut(BaseModel):
    currency: Currency
    items: list[BookmakerOut]


# --- ответственная игра ---

BetsPerDay = Annotated[int, Field(ge=1, le=20)]
StakePerDay = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]
PauseDays = Literal[1, 7, 30, 90]
PlayBlock = Literal["paused", "bets_limit", "stake_limit"]


class PlayLimitsIn(BaseModel):
    """Желаемые лимиты целиком: null — без лимита. Строже (ниже или новый лимит) —
    сразу; мягче (выше или снять) — через 24 часа. currency — валюта суммы в форме:
    не валюта программы — 409 common.currency_changed."""

    model_config = ConfigDict(extra="forbid")

    bets_per_day: BetsPerDay | None
    stake_per_day: StakePerDay | None
    currency: Currency | None = None


class PlayPendingOut(BaseModel):
    """Запрошенное повышение: какие лимиты будут после starts_at (null — без лимита)."""

    bets_per_day: int | None
    stake_per_day: DecimalOut | None
    starts_at: datetime


class PlayTodayOut(BaseModel):
    """Ставки, сделанные сегодня по поясу участника, — и в игре, и рассчитанные."""

    bets: int
    stake: DecimalOut
    # Начало и конец сегодняшнего дня участника (UTC): лимиты обнуляются в ends_at
    starts_at: datetime
    ends_at: datetime


class PlayLimitsOut(BaseModel):
    """Действующие лимиты, отложенное повышение, пауза и сколько поставлено сегодня.
    blocked — что сейчас не дает сделать ставку и запустить анализ (null — ничего);
    blocked_until — до какого момента. tz — пояс, по которому идут текущие сутки лимитов:
    пояс участника, а сразу после его смены — прежний до конца суток."""

    currency: Currency
    tz: str
    bets_per_day: int | None
    stake_per_day: DecimalOut | None
    pending: PlayPendingOut | None
    paused_until: datetime | None
    today: PlayTodayOut
    blocked: PlayBlock | None
    blocked_until: datetime | None
    pause_days: list[int]
    bets_per_day_max: int


class PauseIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    days: PauseDays


# --- удаление аккаунта и экспорт ---


class DeletionIn(BaseModel):
    """Пароль и текущий код 2FA."""

    model_config = ConfigDict(extra="forbid")

    password: PasswordStr
    code: TotpCodeStr


class DeletionOut(BaseModel):
    """Запрос на удаление: когда сделан и когда аккаунт будет удален (через 7 дней)."""

    requested_at: datetime
    delete_at: datetime


ExportFormat = Literal["json", "csv"]
