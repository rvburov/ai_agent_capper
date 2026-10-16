"""Суммы и время в текстах сервера для людей (уведомления): так же, как на экранах
(frontend/src/lib/format.ts) — «+840 ₽», «73 295 ₽», «−700 ₽», «12 окт, 09:00».

Разряды и пробел перед знаком валюты — неразрывные, минус — настоящий (U+2212), рубли
без копеек, доллары и евро — с двумя знаками. Названия месяцев и порядок слов — в локали
(format.*), в коде только ключи.
"""

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

from app.core.i18n import t

NBSP = "\u00a0"
MINUS = "\u2212"
CURRENCY_SIGNS = {"RUB": "₽", "USD": "$", "EUR": "€"}
# Знаков после запятой, если валюта не здесь, — два
_DIGITS = {"RUB": 0}


def format_int(value: int) -> str:
    """Целое с разрядами: 20000 → «20 000»."""
    return f"{value:,}".replace(",", NBSP)


def format_money(value: Decimal, currency: str, *, signed: bool = False) -> str:
    """Сумма с валютой: 73295 → «73 295 ₽», signed — «+840 ₽» (ноль — без знака)."""
    digits = _DIGITS.get(currency, 2)
    amount = value.quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP)
    body = f"{abs(amount):,.{digits}f}".replace(",", NBSP).replace(".", ",")
    sign = MINUS if amount < 0 else ("+" if signed and amount > 0 else "")
    return f"{sign}{body}{NBSP}{CURRENCY_SIGNS.get(currency, currency)}"


def format_moment(moment: datetime, zone: ZoneInfo, *, now: datetime | None = None) -> str:
    """Момент по поясу получателя: «12 окт, 09:00»; год — если он не текущий («12 окт
    2025, 09:00»)."""
    local = moment.astimezone(zone)
    months = t("format.months").split(",")
    month = months[local.month - 1] if len(months) == 12 else f"{local.month:02d}"
    current = (now or datetime.now(zone)).astimezone(zone).year
    key = "format.moment" if local.year == current else "format.moment_year"
    return t(key, day=local.day, month=month, year=local.year, time=local.strftime("%H:%M"))


def format_pct(share: float, *, digits: int = 1) -> str:
    """Доля со знаком в процентах: 0.042 → «+4,2%», −0.013 → «−1,3%» (ноль — без знака)."""
    value = round(share * 100, digits)
    body = f"{abs(value):.{digits}f}".replace(".", ",")
    sign = MINUS if value < 0 else ("+" if value > 0 else "")
    return f"{sign}{body}%"


def format_week(first: date, last: date) -> str:
    """Неделя для заголовка: «5–11 окт», через месяц — «28 сен – 4 окт» (без года)."""
    months = t("format.months").split(",")

    def month(day: date) -> str:
        return months[day.month - 1] if len(months) == 12 else f"{day.month:02d}"

    if first.month == last.month:
        return t("format.week_same_month", first=first.day, last=last.day, month=month(last))
    return t(
        "format.week",
        first=first.day,
        first_month=month(first),
        last=last.day,
        last_month=month(last),
    )
