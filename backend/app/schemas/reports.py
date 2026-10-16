"""Еженедельный отчет (В8 Р25, этап 5, волна 4): «Обучение модели → Отчеты» и уведомление
weekly_report.

Неделя — с понедельника по воскресенье по поясу участника; отчет собирается в понедельник
в 07:00 по тому же поясу и хранится снимком (weekly_reports.payload): числа не меняются,
если потом поправить ставку. Все числа считает сервер (Т15). Деньги ставок — строкой
Decimal в валюте программы на момент отчета (currency), деньги ИИ — в долларах числом.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.admin import UsdOut
from app.schemas.analyses import DecimalOut

AccuracySource = Literal["pred", "closing"]


class ReportBetsOut(BaseModel):
    """Ставки приложения, рассчитанные за неделю (по времени расчета): сколько, из них
    сами по архиву (auto) и вручную (manual); оборот и прибыль без возвратов, ROI =
    прибыль / оборот. placed — поставлено за неделю, open — в игре на момент отчета."""

    settled: int
    auto: int
    manual: int
    won: int
    lost: int
    void: int
    turnover: DecimalOut
    profit: DecimalOut
    roi: float | None
    placed: int
    open: int


class ReportClvOut(BaseModel):
    """Средний CLV рассчитанных за неделю ставок с закрытием у всех ног (доля), сколько
    таких ставок и сколько из них в плюсе."""

    mean: float | None
    n: int
    positive: int


class ReportAccuracyOut(BaseModel):
    """Brier модели против рынка на событиях недели: source pred — рынок при прогнозе,
    closing — закрытие (главный ряд — как в «Аналитике»: закрытие, когда событий с ним
    больше). diff = model − market (меньше нуля — модель точнее). За неделю это почти
    всегда шум: тренд — в «Аналитике»."""

    n: int
    model: float | None
    market: float | None
    diff: float | None
    source: AccuracySource


class ReportCalibrationOut(BaseModel):
    """Калибровка недели в целом: средняя вероятность модели (сторона пары исходов,
    которую выбрала ставка) и доля сбывшихся, n — событий."""

    n: int
    mean_p: float | None
    hit_rate: float | None


class ReportReviewsOut(BaseModel):
    """Разборы ИИ матчей рассчитанных за неделю ставок (общие, один на матч, В3): готовы,
    ждут; цена готовых — ключ администратора, в лимит участника не входит."""

    done: int
    pending: int
    cost_usd: UsdOut


class ReportLessonsOut(BaseModel):
    """Уроки недели (общие и свои): новые гипотезы, подтвердились на истории, включены в
    инструкции анализа, списаны; in_prompt — уроков в анализе на момент отчета."""

    new: list[str]
    confirmed: list[str]
    enabled: list[str]
    retired: list[str]
    in_prompt: int


class ReportEvalOut(BaseModel):
    """Проверки качества (eval) за неделю: потрачено из бюджета проверок и законченных
    прогонов; бюджет месяца отчета и потрачено за месяц."""

    spent_usd: UsdOut
    runs: int
    budget_usd: UsdOut
    month_spent_usd: UsdOut


class ReportModelOut(BaseModel):
    """Базовая модель на момент отчета; recalibrated_at — перекалибровка за неделю
    (включена или нет), иначе null."""

    id: str | None
    brier: float | None
    log_loss: float | None
    recalibrated_at: datetime | None
    recalibration_activated: bool | None


class ReportSharedOut(BaseModel):
    """Только у администратора (Р14 — без ставок и сумм участников): со скольких
    участников были рассчитанные ставки, сколько ставок рассчитано (из них по архиву),
    разборов готово и их цена, анализов запущено и расход ключа администратора за неделю
    без проверок."""

    members: int
    settled: int
    auto: int
    reviews: int
    reviews_usd: UsdOut
    analyses: int
    ai_usd: UsdOut


class WeeklyReportOut(BaseModel):
    """Отчет недели. week_start — понедельник, week_end — воскресенье (по поясу tz);
    created_at — когда отчет собран; empty — за неделю ни одна ставка не рассчитана
    (короткий отчет: «ставок не было», расход и состояние модели — есть)."""

    id: int
    week_start: date
    week_end: date
    created_at: datetime
    tz: str
    currency: str
    empty: bool
    bets: ReportBetsOut
    clv: ReportClvOut
    accuracy: ReportAccuracyOut
    calibration: ReportCalibrationOut
    reviews: ReportReviewsOut
    lessons: ReportLessonsOut
    eval: ReportEvalOut
    model: ReportModelOut
    shared: ReportSharedOut | None


class WeeklyReportBriefOut(BaseModel):
    """Строка списка «Прошлые недели»."""

    id: int
    week_start: date
    week_end: date
    created_at: datetime
    empty: bool
    currency: str
    settled: int
    profit: DecimalOut
    roi: float | None
    clv: float | None


class WeeklyReportsOut(BaseModel):
    """Свои отчеты, новые сверху. next_report — день следующего отчета (понедельник по
    поясу участника), report_hour — час отчета по тому же поясу."""

    items: list[WeeklyReportBriefOut]
    next_report: date
    report_hour: int
