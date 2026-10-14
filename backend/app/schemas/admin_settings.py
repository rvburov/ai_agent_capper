"""Схемы «Администрирование → Настройки» и «Сообщение»: валюта программы с курсом (Р17,
Т30), часовой пояс по умолчанию, сообщение участникам (В14)."""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.schemas.analyses import DecimalOut
from app.schemas.me import ProfileTimeZoneStr, TotpCodeStr

Currency = Literal["RUB", "USD", "EUR"]
# Курс: сколько единиц второй валюты дают за 1 rate_base, например 1 € = 95,1234 ₽. Границы
# 0,001–1 000 (реальные пары ₽, $ и € — далеко внутри) не дают подбором курса узнать
# суммы участников по отказу «не помещается» (Р14): суммы меняются не больше чем в 1 000
# раз, и отказ возможен только при сумме больше 10 млн
RATE_MIN = Decimal("0.001")
RATE_MAX = Decimal(1000)
RateIn = Annotated[Decimal, Field(ge=RATE_MIN, le=RATE_MAX, max_digits=18, decimal_places=8)]


class CurrencyChangeOut(BaseModel):
    """Последняя смена валюты из журнала: когда, кто, с какой на какую и по какому курсу."""

    at: datetime
    actor_name: str | None
    from_currency: Currency
    to_currency: Currency
    rate: DecimalOut
    rate_base: Currency


class AdminSettingsOut(BaseModel):
    """Настройки программы: валюта (одна на всех, Р17) и часовой пояс новых участников.
    Расходы на Claude всегда в долларах."""

    currency: Currency
    default_tz: str
    currency_changed: CurrencyChangeOut | None
    updated_at: datetime


class AdminSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    default_tz: ProfileTimeZoneStr


class CurrencyIn(BaseModel):
    """Новая валюта программы и курс: 1 rate_base = rate второй валюты (rate_base —
    прежняя или новая валюта, как в окне смены). from_currency — валюта, от которой
    считает окно: если ее уже сменили, курс относится к другой паре, и смена отклоняется.
    preview — только посчитать, что станет; без preview нужен текущий код 2FA."""

    model_config = ConfigDict(extra="forbid")

    from_currency: Currency
    currency: Currency
    rate: RateIn
    rate_base: Currency
    totp_code: TotpCodeStr | None = None
    preview: bool = False


class MoneyChangeOut(BaseModel):
    before: DecimalOut
    after: DecimalOut


class CurrencyPreviewOut(BaseModel):
    """Что станет при смене валюты (или что стало, applied = true): сколько сумм
    пересчитано по всем участникам, банк администратора и примеры до и после. factor —
    множитель (новая сумма = прежняя × factor до округления каждой суммы до копеек).
    analyses — анализы с суммами (банк из ввода, рекомендация, предупреждение о банке);
    corrections — у скольких участников остаток от округления строк журнала уйдет в одну
    корректировку «Округление при смене валюты» (банк = round(прежний × курс)).
    overflow — какая-то сумма после пересчета не поместится в NUMERIC(12, 2) и смена по
    этому курсу будет отклонена (только да или нет: сумм участников администратор не
    видит, Р14); примеры samples — круглые суммы, а не суммы участников."""

    applied: bool
    overflow: bool
    from_currency: Currency
    to_currency: Currency
    rate: DecimalOut
    rate_base: Currency
    factor: DecimalOut
    bets: int
    ledger_entries: int
    play_limits: int
    analyses: int
    members: int
    corrections: int
    own_bank: MoneyChangeOut | None
    samples: list[MoneyChangeOut]


# --- сообщение участникам ---

MessageText = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=280, pattern=r"^[^\x00]*$"),
]


class MessageIn(BaseModel):
    """Кому: всем (user_id = null) или одному участнику. preview — без отправки."""

    model_config = ConfigDict(extra="forbid")

    text: MessageText
    user_id: int | None = Field(default=None, ge=1, le=2**63 - 1)
    preview: bool = False


class MessageOut(BaseModel):
    """Отправленное сообщение (или что будет отправлено, sent = false): текст, кому
    (user_id null — всем), имя получателя, сколько получили, когда и кто отправил."""

    id: int | None
    sent: bool
    at: datetime
    text: str
    user_id: int | None
    recipient_name: str | None
    recipients: int
    actor_name: str | None


class MessagesOut(BaseModel):
    """Отправленные сообщения и сколько людей получит сообщение «всем» сейчас (по правилу
    сервера: активные, кроме вас) — число для переключателя «Всем участникам · N»."""

    items: list[MessageOut]
    recipients_all: int
