"""Схемы «Аналитики» (GET /api/analytics) и общих блоков главной: фильтры, показатели
за период с прошлым периодом, срезы ROI с доверительными интервалами, экспрессы против
ординаров (Р21), калибровка, Brier модели против рынка, CLV, ряд банка и выводы.

Все числа считает сервер (решение Т4), экран только рисует. Деньги и кэфы — строкой
Decimal, доли (ROI, винрейт, CLV, вероятности, Brier) — числом: 0.052 — это 5,2%.
Интервалы — 95%, бутстрэп с фиксированным seed (одинаковые данные — одинаковые
интервалы); выборка меньше 2 — интервала нет (null). Тексты выводов — ключами локали
(key, params): числа в params — как есть (доли и кэфы), их форматирует экран.
"""

from datetime import date, datetime
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

from app.schemas.analyses import DecimalOut, Market, TextKey
from app.schemas.bets import DATE_MAX, DATE_MIN, BetSource, Period, SurfaceFilter

# Часть выгрузки CSV (В13): ставки, события, калибровка, скользящий Brier
ExportPart = Literal["bets", "events", "calibration", "brier"]
InsightTone = Literal["warn", "bad", "info", "accent", "good"]
InsightCode = Literal[
    "sample",
    "calibration_over",
    "calibration_under",
    "calibration_ok",
    "total_negative",
    "small_slice",
    "brier_noise",
    "brier_model_better",
    "brier_market_better",
]
# Действие у вывода: к калибровке, к «Ставкам», фильтр среза, расширить период до «все
# время», снять фильтры, «Brier и CLV простыми словами»
InsightAction = Literal["calibration", "bets", "filter", "widen", "clear", "explain"]


class AnalyticsFiltersIn(BaseModel):
    """Фильтры «Аналитики»: период (последние 7, 30, 90 дней с сегодняшним по поясу
    участника или все время) или даты from–to (включительно, по поясу участника);
    рынок (и по желанию сторона selection — один из шести исходов: П1, П2, Ф1(−1.5)…);
    покрытия; источник ставок (приложение или старый бот, В5). Ставка попадает в выборку,
    если поставлена в периоде и у нее есть нога под фильтр рынка и покрытия — как на
    «Ставках»."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    period: Period = "all"
    date_from: date | None = Field(default=None, alias="from", ge=DATE_MIN, le=DATE_MAX)
    date_to: date | None = Field(default=None, alias="to", ge=DATE_MIN, le=DATE_MAX)
    market: Market | None = None
    selection: int | None = Field(default=None, ge=1, le=2)
    surface: list[SurfaceFilter] = Field(default_factory=list, max_length=5)
    source: BetSource | None = None

    @model_validator(mode="after")
    def _selection_needs_market(self) -> Self:
        if self.selection is not None and self.market is None:
            raise ValueError("selection без market")
        return self

    @property
    def filtered(self) -> bool:
        """Выбран рынок, покрытие или источник (период фильтром не считается)."""
        return self.market is not None or bool(self.surface) or self.source is not None


class AnalyticsExportIn(AnalyticsFiltersIn):
    """Выгрузка CSV: те же фильтры и часть (одна на файл)."""

    part: ExportPart = "bets"


def _archive_parts() -> list[ExportPart]:
    return ["bets", "events"]


class AnalyticsArchiveIn(AnalyticsFiltersIn):
    """Выгрузка ZIP: те же фильтры и части (каждая — отдельный CSV в архиве)."""

    part: list[ExportPart] = Field(default_factory=_archive_parts, min_length=1, max_length=4)


class CiOut(BaseModel):
    """95% доверительный интервал доли."""

    low: float
    high: float


class ThresholdsOut(BaseModel):
    """Пороги, по которым сервер ставит метки и выводы (одно место — app/services/
    analytics.py): small_sample — меньше стольких событий или ставок в срезе ROI метка
    «мало данных»; insight_min_events — меньше стольких событий вывод «выборка мала»;
    calibration_min_n и calibration_gap — диапазон калибровки с n событиями и больше,
    где прогноз расходится с фактом на gap и больше, — плохой; calibration_few — меньше
    стольких событий калибровка «скачет»; slice_pattern_n — меньше стольких событий
    плюс в срезе — «пока не закономерность»; dashboard_small — меньше стольких
    рассчитанных ставок за период главная предупреждает о малой выборке;
    rolling_window и rolling_step — окно и шаг скользящего Brier."""

    small_sample: int
    insight_min_events: int
    calibration_min_n: int
    calibration_gap: float
    calibration_few: int
    slice_pattern_n: int
    dashboard_small: int
    rolling_window: int
    rolling_step: int


class SampleOut(BaseModel):
    """Что попало в выборку: bets — рассчитанные ставки (с возвратами), из них singles и
    parlays; events — события (ноги с исходом «выиграл» или «проиграл») под фильтрами
    рынка и покрытия; legacy_bets — ставки старого бота среди bets (в банке и ROI, но не в
    CLV, Brier и калибровке, В5); legacy_parlay_events — события экспрессов бота, которые
    по отдельности не считаются (Т10); open_bets — ставки в игре под теми же фильтрами (в
    расчет не входят); first_day и last_day — даты первой и последней ставки выборки по
    поясу участника; last_settled_at — когда рассчитана последняя."""

    bets: int
    singles: int
    parlays: int
    events: int
    legacy_bets: int
    legacy_parlay_events: int
    open_bets: int
    first_day: date | None
    last_day: date | None
    last_settled_at: datetime | None


class KpiOut(BaseModel):
    """Показатели за период — те же правила и те же числа, что итоги «Ставок»
    (GET /bets/summary): оборот и прибыль без возвратов (Т8), ROI = прибыль / оборот,
    винрейт = выигрыш / (выигрыш + проигрыш), CLV — средний по рассчитанным ставкам
    приложения с закрытием у всех ног (ставки бота не входят, В5). roi_ci и clv_ci —
    бутстрэп по ставкам (на главной не считаются — null)."""

    settled: int
    won: int
    lost: int
    void: int
    turnover: DecimalOut
    profit: DecimalOut
    roi: float | None
    roi_ci: CiOut | None
    winrate: float | None
    clv: float | None
    clv_ci: CiOut | None
    clv_positive: int
    clv_n: int
    legacy_settled: int


class PrevOut(BaseModel):
    """Прошлый период той же длины (до первого дня текущего). Его нет (null), если
    история участника начинается позже начала прошлого периода или в нем нет рассчитанных
    ставок."""

    date_from: date
    date_to: date
    settled: int
    turnover: DecimalOut
    profit: DecimalOut
    roi: float | None
    winrate: float | None
    clv: float | None
    clv_n: int


class ChangeOut(BaseModel):
    """Изменение к прошлому периоду: прибыль — деньгами, ROI, винрейт и CLV — разницей
    долей (0.021 — это +2,1 п.п.); null — сравнить не с чем."""

    profit: DecimalOut | None
    roi: float | None
    winrate: float | None
    clv: float | None


class BrierPointOut(BaseModel):
    """Окно скользящего Brier: последние rolling_window событий по день day."""

    day: date
    model: float
    market: float


class BrierOut(BaseModel):
    """Brier модели против рынка (В2): события — ноги рассчитанных ставок приложения с
    итоговой вероятностью модели (p_final) и рынком в момент прогноза без маржи
    (q_market_at_pred). diff = модель − рынок (меньше 0 — модель точнее), diff_ci —
    парный бутстрэп по событиям, noise — интервал задевает ноль. Второй ряд — рынок
    закрытия: события, где внесены обе стороны закрывающего кэфа (closing_*).
    Скользящее окно: windows — число окон (шаг rolling_step), better — в скольких из них
    модель точнее рынка; points — окна для графика, не больше 200 равномерно по ряду
    (последнее — всегда), все окна — в выгрузке CSV."""

    n: int
    model: float | None
    market: float | None
    diff: float | None
    diff_ci: CiOut | None
    noise: bool | None
    closing_n: int
    closing_model: float | None
    closing_market: float | None
    points: list[BrierPointOut]
    windows: int
    better: int


class SeriesPointOut(BaseModel):
    """Точка ряда: значение на конец дня; invested — «вложено» ступенькой (у ряда банка:
    старт периода плюс пополнения и минус выводы с корректировками внутри периода по
    этот день; у ряда результата — null)."""

    day: date
    value: DecimalOut
    invested: DecimalOut | None


FlowKind = Literal["deposit", "withdrawal", "correction"]


class BankFlowOut(BaseModel):
    """Отметка на ряду банка (В7): пополнение, вывод или корректировка за день, сумма со
    знаком."""

    day: date
    kind: FlowKind
    amount: DecimalOut


class SeriesRowOut(BaseModel):
    """Строка таблицы под графиком: неделя или месяц (date_from–date_to), ставки,
    рассчитанные в эти дни, их прибыль и ROI, значение ряда на конец строки."""

    date_from: date
    date_to: date
    bets: int
    profit: DecimalOut
    roi: float | None
    end: DecimalOut


class SeriesOut(BaseModel):
    """Ряд по дням. kind = bank — капитал (баланс + ставки в игре) на конец дня, когда
    фильтров рынка, покрытия и источника нет; result — прибыль отобранных ставок
    нарастающим итогом по дню расчета (по поясу участника). Первая точка — день перед
    периодом (start, значение base), у «всего времени» — первый день; у ряда банка дни до
    первой записи журнала в points не входят. peak — наибольшее значение ряда;
    max_drawdown (доля от −1 до 0, только у bank) — наибольшая просадка от пика по правилу
    Р22: пополнение, вывод и корректировка — не просадка; best и worst — лучшая и худшая
    точка (у result худшая не выше нуля). rows — по неделям (период до 31 дня) или по
    месяцам.

    В7 (Р25): у ряда банка points[].invested — пунктир «вложено» ступенькой, flows —
    пополнения, выводы и корректировки внутри периода (отметки на линии), flows_total —
    их сумма. Главное число периода — прибыль ставок и ROI (kpi), а не рост капитала."""

    kind: Literal["bank", "result"]
    group: Literal["week", "month"]
    start: date
    base: DecimalOut
    # Старт периода для экрана (В7): день, сумма и изменение за период долей от нее. Банк
    # появился внутри периода или выбрано «все время» — первый день банка и первое
    # пополнение (движение банка в тот день), изменение — капитал к вложенному на конец
    # периода; иначе — start, капитал на начало периода (base) и прибыль периода к нему
    start_day: date
    start_amount: DecimalOut
    change_share: float | None
    last: DecimalOut
    peak: DecimalOut
    max_drawdown: float
    best: DecimalOut
    worst: DecimalOut
    points: list[SeriesPointOut]
    rows: list[SeriesRowOut]
    flows: list[BankFlowOut]
    flows_total: DecimalOut


class SliceOut(BaseModel):
    """Срез ROI по событиям как виртуальным ординарам на равную сумму (Р21): ROI = среднее
    (кэф − 1 при выигрыше, −1 при проигрыше), roi_ci — бутстрэп по событиям; small —
    событий меньше small_sample."""

    n: int
    wins: int
    winrate: float
    roi: float
    roi_ci: CiOut | None
    avg_odds: float
    small: bool


class SurfaceSliceOut(SliceOut):
    surface: SurfaceFilter


class MarketSliceOut(SliceOut):
    """Исход: рынок и сторона (П1 — ML и 1, Ф2(+1.5) — HCP_+1.5 и 2)."""

    market: Market
    selection: int


class OddsSliceOut(SliceOut):
    """Диапазон кэфа события: от low до high включительно (high null — и выше)."""

    low: DecimalOut
    high: DecimalOut | None


class MarketsTotalOut(BaseModel):
    """Итоговая строка «Сводки по рынкам»: все исходы вместе."""

    n: int
    winrate: float
    roi: float
    avg_odds: float


class TotalSliceOut(BaseModel):
    """ROI реальных ставок по итоговому кэфу — диапазоны таблицы стратегии (Т20):
    первый от low, остальные до следующего; low и high null — ставки вне таблицы.
    bets — сыгравшие (выигрыш и проигрыш), voids — возвраты (в оборот не входят);
    stake_pct — доля банка по таблице, triple — диапазон только для экспресса из 3."""

    low: DecimalOut | None
    high: DecimalOut | None
    stake_pct: DecimalOut | None
    triple: bool
    bets: int
    voids: int
    turnover: DecimalOut
    profit: DecimalOut
    roi: float | None
    roi_ci: CiOut | None
    small: bool


class SlicesOut(BaseModel):
    """Срезы. Срез по покрытию не сужается фильтром покрытия, по рынку — фильтром рынка
    (выбранное значение экран подсвечивает); по кэфу — всеми фильтрами."""

    surfaces: list[SurfaceSliceOut]
    markets: list[MarketSliceOut]
    markets_total: MarketsTotalOut | None
    odds: list[OddsSliceOut]
    totals: list[TotalSliceOut]


class ParlaysOut(BaseModel):
    """Р21: реальные экспрессы против тех же событий ординарами на равную сумму. Экспрессы
    старого бота не входят (Т10, legacy_parlays). Интервалы — парный бутстрэп по
    экспрессам; verdict — noise (интервал разницы задевает ноль), parlays (экспрессы
    лучше) или singles."""

    parlays: int
    events: int
    legacy_parlays: int
    profit: DecimalOut
    parlays_roi: float | None
    parlays_ci: CiOut | None
    singles_roi: float | None
    singles_ci: CiOut | None
    diff: float | None
    diff_ci: CiOut | None
    verdict: Literal["noise", "parlays", "singles"] | None


class CalibrationBinOut(BaseModel):
    """Корзина 5 п.п.: события с вероятностью в [low, high), средняя вероятность p (на
    графике), средние p_base и p_claude (в таблице), доля сыгравших и интервал Уилсона.
    diff — «факт − прогноз» (доля, со знаком; колонка «Разница» в таблице)."""

    low: float
    high: float
    n: int
    p: float
    p_base: float | None
    p_claude: float | None
    actual: float
    ci_low: float
    ci_high: float

    @computed_field  # type: ignore[prop-decorator]
    @property
    def diff(self) -> float:
        return self.actual - self.p


class CalibrationFlagOut(BaseModel):
    """Диапазон с самым большим расхождением: over — модель переоценивает, under —
    недооценивает; gap — |p − actual|."""

    low: float
    high: float
    n: int
    p: float
    actual: float
    gap: float
    direction: Literal["over", "under"]


class CalibrationOut(BaseModel):
    """Калибровка (В3, Т9): события рассчитанных ставок, по одному на пару исходов;
    прогноз — последний не замененный, проверочные прогоны исключены. kind = final —
    итоговая вероятность модели (ставки приложения), claude — оценка Claude ставок бота
    (только под фильтром «старый бот», Т10). Корзины 5 п.п. от 50 до 95%; outside —
    события вне этого отрезка. status: empty — событий нет, few — ни в одной корзине нет
    calibration_min_n, off — есть расхождение на calibration_gap и больше, ok — нет.
    worst — диапазон с наибольшим расхождением, opposite — самый заметный с обратным
    знаком."""

    kind: Literal["final", "claude"]
    events: int
    outside: int
    bins: list[CalibrationBinOut]
    status: Literal["empty", "few", "off", "ok"]
    worst: CalibrationFlagOut | None
    opposite: CalibrationFlagOut | None


class ClvBinOut(BaseModel):
    """Столбец распределения CLV шириной 1 п.п.: [low, high); open_low — крайний левый
    собирает все меньше, open_high — крайний правый все больше."""

    low: float
    high: float
    n: int
    share: float
    open_low: bool
    open_high: bool


class ClvOut(BaseModel):
    """Распределение CLV ставок (кэф / закрытие − 1, В1) — тех же, что в KPI; positive и
    negative — лучше и хуже закрытия. fair_mean — средний CLV без маржи (кэф · q_close −
    1) по событиям, где внесены обе стороны закрытия (fair_n)."""

    n: int
    positive: int
    negative: int
    bins: list[ClvBinOut]
    fair_mean: float | None
    fair_n: int


class InsightFilterOut(BaseModel):
    """Фильтр для действия filter: покрытие или исход."""

    surface: SurfaceFilter | None = None
    market: Market | None = None
    selection: int | None = None


class InsightOut(BaseModel):
    """Вывод кодом (до трех, без Claude): заголовок и текст — ключи локали с числами,
    основание — basis событий или ставок, действие — по кнопке."""

    code: InsightCode
    tone: InsightTone
    title: TextKey
    text: TextKey
    basis: int
    basis_unit: Literal["events", "bets"]
    action: InsightAction | None
    filter: InsightFilterOut | None = None


class AnalyticsOut(BaseModel):
    """Все блоки «Аналитики» одним ответом (Т5). period null — заданы даты; date_from —
    первый день (null — все время), date_to — последний (сегодня или to). filtered —
    выбран рынок, покрытие или источник (ряд — результат отобранных ставок, а не банк).
    prev и change — null у «всего времени», без начала периода и если в прошлом периоде
    нет рассчитанных ставок."""

    currency: str
    tz: str
    period: Period | None
    date_from: date | None
    date_to: date
    filtered: bool
    thresholds: ThresholdsOut
    sample: SampleOut
    kpi: KpiOut
    prev: PrevOut | None
    change: ChangeOut | None
    brier: BrierOut
    insights: list[InsightOut]
    series: SeriesOut
    slices: SlicesOut
    parlays: ParlaysOut | None
    calibration: CalibrationOut
    clv: ClvOut
