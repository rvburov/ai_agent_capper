"""Схемы личного кабинета этапа 4: что присылать в уведомлениях, «Мои букмекеры»,
ответственная игра, удаление аккаунта и экспорт (Р3, Р15, Р24, В8–В10).

Деньги — Decimal строкой в JSON, в валюте программы (currency).
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
    "bet_needs_result",
    "settle_conflict",
    "weekly_report",
    "learning",
    "market_ready",
]
Currency = Literal["RUB", "USD", "EUR"]


# --- уведомления ---


class NotificationPrefOut(BaseModel):
    """Вид уведомления в настройках. group — строка экрана (limit_80 и limit_100 — одна
    строка); required — на сайте приходит всегда, выключить нельзя (push — можно); admin —
    раздел «Для администратора»; push — присылать ли push (по умолчанию да, кроме learning
    и ai_alert, В2)."""

    kind: NotificationKind
    group: str
    on_site: bool
    push: bool
    required: bool
    admin: bool
    # Вид этапа 5 (отметка «новое» в макете profile.js)
    new: bool


class AlertRulesOut(BaseModel):
    """Пороги сигналов расхода ИИ (ai_alert, TOKEN_ECONOMY.md, раздел 6) — те же числа,
    что проверяет воркер: доля кэша ниже cache_min_share по cache_analyses последним
    анализам; анализ дороже cost_factor медиан за cost_window_days дней; ответов
    max_tokens и refusal за сутки больше stops_max_share; поисков за день (UTC) —
    searches_per_day (лимит из настроек агента); rate_limit_series ответов 429 за
    rate_limit_window_minutes минут. Одно уведомление на правило в сутки."""

    cache_min_share: float
    cache_analyses: int
    cost_factor: float
    cost_window_days: int
    stops_max_share: float
    searches_per_day: int
    rate_limit_series: int
    rate_limit_window_minutes: int


class NotificationScheduleOut(BaseModel):
    """Числа для подписей видов этапа 5 — те же, что у воркера: еженедельный отчет —
    день недели report_weekday (0 — понедельник) в report_hour по поясу tz, следующий —
    next_report; «ставка ждет результата» — через settle_reminder_days дней после матча;
    «пора загрузить файл» (администратору) — по понедельникам в upload_hour по его поясу,
    если файл не загружали больше upload_stale_days дней."""

    tz: str
    report_weekday: int
    report_hour: int
    next_report: date
    settle_reminder_days: int
    upload_hour: int
    upload_stale_days: int


# Время тихих часов: «ЧЧ:ММ», шаг 30 минут
QuietTime = Annotated[str, Field(pattern=r"^([01][0-9]|2[0-3]):(00|30)$")]


class QuietHoursOut(BaseModel):
    """Тихие часы push по поясу пользователя (schedule.tz): с start до end push не
    приходят, кроме входа с нового устройства и неудачных попыток входа (В3)."""

    enabled: bool
    start: str
    end: str


class QuietHoursIn(BaseModel):
    """Тихие часы целиком. Начало равно концу — 422 notification.quiet_same."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool
    start: QuietTime
    end: QuietTime


class NotificationPrefsOut(BaseModel):
    """alert_rules — пороги сигналов расхода ИИ для подсказки (только у администратора,
    у участника null). push_available — есть хоть одна активная подписка push: пока нет,
    столбец «Push» неактивен (В5)."""

    items: list[NotificationPrefOut]
    push_available: bool
    quiet_hours: QuietHoursOut
    alert_rules: AlertRulesOut | None
    schedule: NotificationScheduleOut


class NotificationPrefIn(BaseModel):
    """Вид и что поменять: на сайте, push или оба (непереданное не меняется)."""

    model_config = ConfigDict(extra="forbid")

    kind: NotificationKind
    on_site: bool | None = None
    push: bool | None = None

    @model_validator(mode="after")
    def _something(self) -> "NotificationPrefIn":
        if self.on_site is None and self.push is None:
            raise ValueError("on_site or push")
        return self


class NotificationPrefsIn(BaseModel):
    """Частичное обновление: только переданные виды и, если переданы, тихие часы. Нужно
    хотя бы одно из двух."""

    model_config = ConfigDict(extra="forbid")

    items: list[NotificationPrefIn] = Field(default_factory=list, max_length=32)
    quiet_hours: QuietHoursIn | None = None

    @model_validator(mode="after")
    def _something(self) -> "NotificationPrefsIn":
        if not self.items and self.quiet_hours is None:
            raise ValueError("items or quiet_hours")
        return self


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


class LegacyPeriodOut(BaseModel):
    """Дни первой и последней ставки старого бота (по поясу участника)."""

    first: date
    last: date


class ExportSummaryOut(BaseModel):
    """Что войдет в экспорт (кабинет «Данные»): ставки (из них в игре и из старого бота),
    события — ноги всех ставок, свои вызовы Claude. legacy_period и legacy_no_result —
    для статуса импорта истории бота: период его ставок (null — ставок бота нет) и ноги
    рассчитанных экспрессов бота без исхода (бот не записывал исходы ног проигранных
    экспрессов); legacy_from_archive — ноги ставок бота, исход которых взят из архива
    (этап 5, app/services/legacy_results.py)."""

    bets: int
    open_bets: int
    legacy_bets: int
    events: int
    ai_runs: int
    legacy_period: LegacyPeriodOut | None
    legacy_no_result: int
    legacy_from_archive: int
