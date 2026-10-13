"""Чистые блоки аналитики (app/services/analytics.py) на синтетических ставках: период и
прошлый период, события калибровки (одно на пару исходов), статусы калибровки, выводы
кодом и их порядок, распределение CLV, просадка без пополнений и выводов, диапазоны
итогового кэфа."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from app.core.errors import AppError
from app.ml.strategy import StrategyParams
from app.schemas.analytics import AnalyticsFiltersIn
from app.services import analytics
from app.services.analytics import (
    THRESHOLDS,
    BetRow,
    Inputs,
    LegRow,
    Totals,
    Window,
    build_analytics,
    calibration_block,
    calibration_events,
    clv_block,
    max_drawdown,
    window_of,
)
from app.services.bank import DayCapital

D = Decimal
ZONE = ZoneInfo("Europe/Helsinki")
TODAY = date(2026, 10, 13)
BANDS = StrategyParams().stake_bands


def _leg(
    leg_id: int,
    *,
    match_id: int | None = None,
    market: str = "ML",
    selection: int = 1,
    odds: str = "1.80",
    result: str | None = "win",
    surface: str | None = "hard",
    p: float | None = 0.62,
    q: float | None = None,
    closing: str | None = None,
) -> LegRow:
    return LegRow(
        id=leg_id,
        match_id=match_id if match_id is not None else leg_id,
        market=market,
        selection=selection,
        odds=D(odds),
        result=result,
        closing=D(closing) if closing else None,
        q_close=None,
        surface=surface,
        p_final=p,
        p_base=p,
        p_claude=p,
        q_market=q,
        forecast=p is not None,
    )


def _bet(
    bet_id: int,
    legs: list[LegRow],
    *,
    stake: str = "100",
    profit: str | None = None,
    status: str | None = None,
    source: str = "app",
    days_ago: int = 1,
) -> BetRow:
    total = D(1)
    for leg in legs:
        total *= leg.odds
    if status is None:
        status = "won" if all(leg.result == "win" for leg in legs) else "lost"
    if profit is None:
        profit = (
            str((D(stake) * total - D(stake)).quantize(D("0.01")))
            if status == "won"
            else ("0" if status == "void" else f"-{stake}")
        )
    moment = datetime(2026, 10, 13, 9, tzinfo=UTC) - timedelta(days=days_ago)
    return BetRow(
        id=bet_id,
        placed_at=moment,
        settled_at=moment + timedelta(hours=8),
        status=status,
        stake=D(stake),
        profit=D(profit),
        total_odds=total.quantize(D("0.001")),
        source=source,
        bookmaker="Fonbet",
        legs=legs,
    )


def _inputs(rows: list[BetRow], filters: AnalyticsFiltersIn | None = None) -> Inputs:
    filters = filters or AnalyticsFiltersIn()
    played = [bet for bet in rows if bet.played]
    turnover = sum((bet.stake for bet in played), D(0))
    profit = sum((bet.profit or D(0) for bet in played), D(0))
    current = Totals(
        settled=len(rows),
        won=sum(1 for bet in rows if bet.status == "won"),
        lost=sum(1 for bet in rows if bet.status == "lost"),
        void=sum(1 for bet in rows if bet.status == "void"),
        turnover=turnover,
        profit=profit,
        open=0,
        open_stake=D(0),
        legacy=sum(1 for bet in rows if bet.source == "legacy"),
        clv=None,
        clv_n=0,
        clv_positive=0,
    )
    return Inputs(
        filters=filters,
        window=window_of(filters, TODAY),
        zone=ZONE,
        currency="RUB",
        rows=rows,
        selected=frozenset(bet.id for bet in rows),
        current=current,
        previous=None,
        equity=None,
        bands=BANDS,
        double_max=StrategyParams().double_total[1],
        bootstrap=200,
    )


def test_window_of_periods_and_dates() -> None:
    assert window_of(AnalyticsFiltersIn(), TODAY) == Window("all", None, TODAY, None)
    week = window_of(AnalyticsFiltersIn(period="7d"), TODAY)
    assert week.first == date(2026, 10, 7) and week.last == TODAY
    assert week.prev == (date(2026, 9, 30), date(2026, 10, 6))
    custom = window_of(
        AnalyticsFiltersIn.model_validate({"from": "2026-10-01", "to": "2026-10-05"}), TODAY
    )
    assert custom.period is None and custom.prev == (date(2026, 9, 26), date(2026, 9, 30))
    # Конец в будущем — ряд до сегодня
    future = window_of(
        AnalyticsFiltersIn.model_validate({"from": "2026-10-10", "to": "2026-12-01"}), TODAY
    )
    assert future.last == TODAY
    only_to = window_of(AnalyticsFiltersIn.model_validate({"to": "2026-10-01"}), TODAY)
    assert only_to.first is None and only_to.prev is None and only_to.last == date(2026, 10, 1)
    with pytest.raises(AppError):
        window_of(
            AnalyticsFiltersIn.model_validate({"from": "2026-10-05", "to": "2026-10-01"}), TODAY
        )


def test_calibration_events_one_per_pair() -> None:
    """П1 и П2 одного матча — одна пара: берется последняя ставка; Ф1(−1.5) и Ф2(+1.5) —
    тоже одна пара; ставки бота и ноги без прогноза — не события."""
    first = _bet(1, [_leg(1, match_id=7, p=0.60)], days_ago=3)
    second = _bet(2, [_leg(2, match_id=7, selection=2, p=0.45, result="loss")], days_ago=1)
    minus = _bet(3, [_leg(3, match_id=8, market="HCP_-1.5", selection=1, p=0.55)], days_ago=2)
    plus = _bet(4, [_leg(4, match_id=8, market="HCP_+1.5", selection=2, p=0.40)], days_ago=1)
    other_pair = _bet(5, [_leg(5, match_id=8, market="HCP_-1.5", selection=2, p=0.30)])
    bot = _bet(6, [_leg(6, p=None)], source="legacy")
    legs = [(bet, leg) for bet in (first, second, minus, plus, other_pair, bot) for leg in bet.legs]
    events = calibration_events(legs, "final")
    # Одно время ставки — по номеру ноги
    assert [event.leg.id for event in events] == [2, 4, 5]
    assert calibration_events(legs, "claude") == []


def _events(pairs: list[tuple[float, int]]) -> list[analytics.Event]:
    out = []
    for index, (p, y) in enumerate(pairs, start=1):
        leg = _leg(index, p=p, result="win" if y else "loss")
        out.append(analytics.Event(_bet(index, [leg]), leg, p, y))
    return out


def test_calibration_status() -> None:
    assert calibration_block([], "final").status == "empty"
    few = calibration_block(_events([(0.62, 1)] * 3), "final")
    assert few.status == "few" and few.worst is None and few.bins[0].low == 0.6
    # 10 событий по 0,72 при 5 сыгравших: переоценка; 10 по 0,52 при 9: недооценка
    over = [(0.72, 1)] * 5 + [(0.72, 0)] * 5
    under = [(0.52, 1)] * 9 + [(0.52, 0)]
    block = calibration_block(_events(over + under + [(0.97, 1), (0.40, 0)]), "final")
    assert block.status == "off" and block.outside == 2
    assert block.worst is not None and block.worst.direction == "under"
    assert block.worst.gap == pytest.approx(0.38)
    assert block.opposite is not None and block.opposite.direction == "over"
    ok = calibration_block(_events([(0.71, 1)] * 7 + [(0.71, 0)] * 3), "final")
    assert ok.status == "ok"
    # Ровно 0,70 — в корзине 70–75%
    edge = calibration_block(_events([(0.70, 1)]), "final")
    assert edge.bins[0].low == 0.7


def test_clv_bins_open_edges() -> None:
    block = clv_block([-0.08, -0.004, 0.0, 0.012, 0.03, 0.2], [])
    lows = [item.low for item in block.bins]
    assert lows[0] == -0.03 and lows[-1] == 0.07
    assert block.bins[0].open_low and block.bins[0].n == 1
    assert block.bins[-1].open_high and block.bins[-1].n == 1
    assert sum(item.n for item in block.bins) == 6
    assert (block.positive, block.negative) == (3, 2)
    assert clv_block([], []).bins == []


def test_max_drawdown_ignores_flows() -> None:
    """Вывод половины банка — не просадка; проигрыш после него — просадка от пика,
    уменьшенного в той же пропорции (Р22)."""
    day = date(2026, 10, 1)
    points = [
        DayCapital(day, D(10000), D(10000)),
        DayCapital(day + timedelta(days=1), D(5000), D(-5000)),
        DayCapital(day + timedelta(days=2), D(4500), D(0)),
    ]
    assert max_drawdown(points) == pytest.approx(-0.1)
    assert max_drawdown(points[:2]) == 0.0
    to_zero = [DayCapital(day, D(100), D(100)), DayCapital(day, D(-50), D(0))]
    assert max_drawdown(to_zero) == -1.0


@pytest.mark.parametrize(
    ("total", "index"),
    [("1.28", 0), ("1.70", 0), ("1.703", 1), ("1.705", 1), ("1.71", 1), ("2.205", 2),
     ("3.24", 2), ("3.245", 3), ("3.25", 3), ("4.10", 3), ("4.101", None), ("1.27", None)],
)  # fmt: skip
def test_band_index(total: str, index: int | None) -> None:
    """Стык полос — как у стратегии: кэф между high одной и low следующей — в следующей."""
    assert analytics._band_index(D(total), BANDS) == index


def test_band_index_matches_strategy() -> None:
    """Строка итогового кэфа — та же полоса, по которой стратегия ставила сумму: все кэфы
    с шагом 0.001 от 1.000 до 5.000 (так хранится итоговый кэф экспресса)."""
    from app.ml.strategy import _band

    for step in range(1000, 5001):
        total = D(step) / 1000
        band = _band(total, BANDS)
        index = analytics._band_index(total, BANDS)
        assert (BANDS[index] if index is not None else None) == band, total


def test_insights_order_and_codes() -> None:
    """Выборка мала — первым; затем калибровка, убыточный итоговый кэф, срез на малой
    выборке; не больше трех."""
    rows: list[BetRow] = []
    leg_id = 0
    # 10 ординаров 1.80 с p 0,72: 4 выигрыша — переоценка на 32 п.п.; итоговый кэф 1.71–2.20
    for n in range(10):
        leg_id += 1
        rows.append(_bet(leg_id, [_leg(leg_id, p=0.72, result="win" if n < 4 else "loss")]))
    # 3 события на траве с плюсом
    for _ in range(3):
        leg_id += 1
        rows.append(_bet(leg_id, [_leg(leg_id, odds="1.50", surface="grass", p=0.66)], days_ago=2))
    out = build_analytics(_inputs(rows))
    codes = [item.code for item in out.insights]
    assert codes == ["sample", "calibration_over", "total_negative"]
    # Все время и без фильтров — расширять и снимать нечего
    assert out.insights[0].action is None
    calibration = out.insights[1]
    assert calibration.title.key == "analytics.insights.calibration_over.title"
    assert calibration.title.params["p"] == pytest.approx(0.72)
    assert calibration.basis == 10 and calibration.action == "calibration"
    total = out.insights[2]
    assert total.text.params["low"] == "1.71" and total.text.params["largest"] is False
    assert total.text.params["roi"] == pytest.approx((4 * 0.8 - 6) / 10)
    # Без оговорки о выборке в выводы попадает и срез на малой выборке
    many = rows + [
        _bet(100 + n, [_leg(100 + n, odds="2.50", surface="clay", p=0.45, result="loss")],
             days_ago=3)
        for n in range(20)
    ]  # fmt: skip
    codes = [item.code for item in build_analytics(_inputs(many)).insights]
    assert codes == ["calibration_over", "total_negative", "small_slice"]
    small = next(
        item for item in build_analytics(_inputs(many)).insights if item.code == "small_slice"
    )
    assert small.filter is not None and small.filter.surface == "grass"
    assert small.text.params["roi_after_loss"] == pytest.approx((0.5 * 3 - 1) / 4)


def test_brier_insight_and_rolling() -> None:
    """Brier против рынка: окна по 30 событий с шагом 3, вывод от 20 событий."""
    rows = [
        _bet(n, [_leg(n, p=0.7, q=0.6, result="win" if n % 3 else "loss")], days_ago=40 - n)
        for n in range(1, 36)
    ]
    out = build_analytics(_inputs(rows))
    brier = out.brier
    assert brier.n == 35
    # Окна кончаются на 30-м и 33-м событии
    assert len(brier.points) == 2 and 0 <= brier.better <= 2
    assert brier.diff_ci is not None and brier.noise is not None
    codes = [item.code for item in out.insights]
    assert codes[0] == "calibration_ok" and codes[1].startswith("brier_")
    assert out.thresholds == THRESHOLDS


def test_brier_points_thinned_windows_counted() -> None:
    """На тысячах событий в ответе не больше 200 точек (последнее окно — всегда), а «точнее
    рынка X из Y» и выгрузка CSV — по всем окнам."""
    rows = [
        _bet(n, [_leg(n, p=0.7 if n % 2 else 0.55, q=0.6, result="win" if n % 3 else "loss")],
             days_ago=1)
        for n in range(1, 2001)
    ]  # fmt: skip
    inputs = _inputs(rows)
    events = analytics.parts_of(inputs).events
    brier = analytics.brier_block(inputs, events)
    windows = analytics.brier_windows(inputs, events)
    assert brier.n == 2000 and brier.windows == len(windows) == (2000 - 30) // 3 + 1
    assert len(brier.points) <= analytics.BRIER_POINTS_MAX + 1
    assert (brier.points[-1].model, brier.points[-1].market) == windows[-1][1:]
    assert (brier.points[0].model, brier.points[0].market) == windows[0][1:]
    assert brier.better == sum(1 for _, model, market in windows if model < market)
    export = analytics._part_rows("brier", inputs, analytics.parts_of(inputs))
    assert len(export) == len(windows)


def test_thin_keeps_last_point() -> None:
    assert analytics.thin(list(range(5)), 10) == [0, 1, 2, 3, 4]
    for size in (201, 202, 399, 400, 1001, 4006):
        picked = analytics.thin(list(range(size)), 200)
        assert picked[0] == 0 and picked[-1] == size - 1 and len(picked) <= 201, size
        assert picked == sorted(set(picked))


def test_brier_closing_row_without_market() -> None:
    """Второй ряд Brier — все события с двумя сторонами закрытия, и без рынка при
    прогнозе: главного ряда нет, а закрытие есть."""
    leg = _leg(1, p=0.6, q=None)
    closed = LegRow(**{**{f: getattr(leg, f) for f in leg.__slots__}, "q_close": 0.55})
    other = _leg(2, p=0.7, q=0.65, result="loss")
    rows = [_bet(1, [closed]), _bet(2, [other])]
    inputs = _inputs(rows)
    brier = analytics.brier_block(inputs, analytics.parts_of(inputs).events)
    assert brier.n == 1 and brier.closing_n == 1
    assert brier.closing_model == pytest.approx((0.6 - 1) ** 2)
    assert brier.closing_market == pytest.approx((0.55 - 1) ** 2)
    only_closing = _inputs([_bet(1, [closed])])
    empty_main = analytics.brier_block(only_closing, analytics.parts_of(only_closing).events)
    assert empty_main.n == 0 and empty_main.model is None and empty_main.closing_n == 1


def test_parlays_vs_singles_paired() -> None:
    parlay_won = _bet(1, [_leg(1, odds="1.50"), _leg(2, odds="1.40")])
    parlay_lost = _bet(2, [_leg(3, odds="1.60"), _leg(4, odds="1.30", result="loss")])
    bot = _bet(3, [_leg(5, result=None, p=None), _leg(6, result=None, p=None)],
               status="lost", source="legacy")  # fmt: skip
    single = _bet(4, [_leg(7)])
    out = build_analytics(_inputs([parlay_won, parlay_lost, bot, single]))
    parlays = out.parlays
    assert parlays is not None
    assert (parlays.parlays, parlays.events, parlays.legacy_parlays) == (2, 4, 1)
    assert parlays.parlays_roi == pytest.approx((110 - 100) / 200)
    assert parlays.parlays_roi is not None
    singles = (0.5 + 0.4 + 0.6 - 1) / 4
    assert parlays.singles_roi == pytest.approx(singles)
    assert parlays.diff == pytest.approx(parlays.parlays_roi - singles)
    assert parlays.verdict in ("noise", "parlays", "singles")
    # Ноги экспресса бота — не события
    assert out.sample.events == 5 and out.sample.legacy_parlay_events == 2


def test_texts_for_every_insight_and_csv_column() -> None:
    """Тексты выводов и заголовки выгрузки есть в локали; в тексте — только параметры,
    которые вывод передает."""
    import string
    from typing import get_args

    from app.core.i18n import has_key, t
    from app.schemas.analytics import InsightCode

    for code in get_args(InsightCode):
        for part in ("title", "text"):
            assert has_key(f"analytics.insights.{code}.{part}"), (code, part)
    for part, columns in analytics.CSV_COLUMNS.items():
        for column in columns:
            assert has_key(f"analytics.csv.{part}.{column}"), (part, column)
    # Параметры текста калибровки — те, что передает вывод
    rows = [_bet(n, [_leg(n, p=0.72, result="win" if n < 4 else "loss")]) for n in range(10)]
    for insight in build_analytics(_inputs(rows)).insights:
        for key in (insight.title, insight.text):
            fields = {name for _, name, _, _ in string.Formatter().parse(t(key.key)) if name}
            assert fields <= set(key.params), (insight.code, fields - set(key.params))
