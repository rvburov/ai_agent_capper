"""Отчет бэктеста в Markdown: по-русски, коротко и с числами (тексты — раздел backtest
в app/locales/ru.json).

Вывод в начале отчета формулирует код по числам: где интервал разницы с рынком целиком
выше нуля — «модель хуже рынка», ниже нуля — «лучше» (с предупреждением искать утечку),
иначе — «в пределах шума». Так текст не может разойтись с таблицами. Если основной эталон
рынка (Pinnacle) — меньше порога событий сравнения в целом или в одном из тестовых годов,
вывод и отчет говорят, что сравнение менее строгое, и показывают состав эталона по годам.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import UTC, date, datetime
from typing import TYPE_CHECKING, Any

from app.core.i18n import t
from app.ml.metrics import COIN_BRIER, COIN_LOG_LOSS, CalibrationBin, Estimate, RoiEstimate

if TYPE_CHECKING:
    from app.ml.backtest import BacktestResult, BetResult, ReferenceMix, ScoreSummary

# Корзина калибровки с меньшим числом событий — шум (LLM_LEARNING.md, 3.1)
MIN_BIN_EVENTS = 30
# Меньше ставок — бутстрэп-интервал ROI ничего не значит, вывода о деньгах нет
MIN_VERDICT_BETS = 30
# Букмекер для главного вывода о ROI: среднее по рынку ближе всего к доступному кэфу
MAIN_BOOKMAKER = "avg"
MINUS = "−"
DASH = "—"


# --- числа ---


def num(value: float | None, digits: int = 3) -> str:
    """Число с запятой и настоящим минусом: −0,012."""
    if value is None:
        return DASH
    text = f"{value:.{digits}f}".replace(".", ",")
    return text.replace("-", MINUS)


def pct(value: float | None, digits: int = 1) -> str:
    """Доля в процентах: 0,0312 → 3,1%."""
    return DASH if value is None else f"{num(value * 100, digits)}%"


def _ci(estimate: Estimate | None, digits: int = 3) -> str:
    if estimate is None:
        return DASH
    return t(
        "backtest.report.ci",
        value=num(estimate.value, digits),
        low=num(estimate.low, digits),
        high=num(estimate.high, digits),
    )


def _roi_ci(roi: RoiEstimate) -> str:
    if roi.roi is None:
        return DASH
    return t("backtest.report.ci", value=pct(roi.roi), low=pct(roi.low), high=pct(roi.high))


def _day(value: date | datetime | None) -> str:
    if value is None:
        return DASH
    if isinstance(value, datetime):
        return value.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")
    return value.isoformat()


def _years(years: Sequence[int]) -> str:
    return ", ".join(str(year) for year in years) or DASH


# --- названия ---


def level_name(code: str) -> str:
    names = {
        "grand_slam": t("backtest.levels.grand_slam"),
        "masters": t("backtest.levels.masters"),
        "500": t("backtest.levels.500"),
        "250": t("backtest.levels.250"),
        "atp": t("backtest.levels.atp"),
        "finals": t("backtest.levels.finals"),
        "davis_cup": t("backtest.levels.davis_cup"),
        "olympics": t("backtest.levels.olympics"),
        "unknown": t("backtest.levels.unknown"),
    }
    return names.get(code, code)


def surface_name(code: str) -> str:
    names = {
        "hard": t("backtest.surfaces.hard"),
        "clay": t("backtest.surfaces.clay"),
        "grass": t("backtest.surfaces.grass"),
        "carpet": t("backtest.surfaces.carpet"),
        "unknown": t("backtest.surfaces.unknown"),
    }
    return names.get(code, code)


def bookmaker_name(code: str) -> str:
    names = {
        "pinnacle": t("backtest.bookmakers.pinnacle"),
        "bet365": t("backtest.bookmakers.bet365"),
        "avg": t("backtest.bookmakers.avg"),
        "max": t("backtest.bookmakers.max"),
        "betfair_ex": t("backtest.bookmakers.betfair_ex"),
    }
    return names.get(code, code)


def _skip_name(reason: str) -> str:
    names = {
        "walkover": t("ml.elo.skip.walkover"),
        "no_winner": t("ml.elo.skip.no_winner"),
        "no_date": t("ml.elo.skip.no_date"),
    }
    return names.get(reason, reason)


def _reference_label(reference: ReferenceMix) -> str:
    """Эталон рынка для подписей таблиц: букмекеры, по которым оценены события, по
    порядку («Pinnacle → среднее по рынку»); нет событий — весь порядок."""
    used = [bookmaker for bookmaker, count in reference.counts.items() if count]
    return " → ".join(bookmaker_name(bookmaker) for bookmaker in used or reference.order)


def _source_name(source: str) -> str:
    names = {
        "sackmann": t("backtest.sources.sackmann"),
        "tennis_data": t("backtest.sources.tennis_data"),
    }
    return names.get(source, source)


# --- вывод ---


def _reference_others(reference: ReferenceMix, years: Iterable[int] | None = None) -> str:
    """Запасные эталоны, по которым оценены события (всех тестовых лет или только
    years): «биржа Betfair — 12, ...»."""
    counts = reference.counts if years is None else reference.counts_for(years)
    return ", ".join(
        t("backtest.warnings.reference_count", name=bookmaker_name(bookmaker), n=count)
        for bookmaker, count in counts.items()
        if bookmaker != reference.primary and count
    )


def _reference_years(reference: ReferenceMix, years: Iterable[int]) -> str:
    """Доля основного эталона по годам: «2024 — 99,0%, 2025 — 3,0%»."""
    return ", ".join(
        t("backtest.warnings.reference_year", year=year, share=pct(share))
        for year in years
        if (share := reference.year_share(year)) is not None
    )


def reference_warning(reference: ReferenceMix) -> str:
    """Предупреждение бэктеста: основной эталон (Pinnacle) — меньше порога событий
    сравнения в целом (доля — по всем годам) или в отдельных годах (эти годы и их
    запасные эталоны)."""
    params = {
        "primary": bookmaker_name(reference.primary),
        "share": pct(reference.primary_share),
        "min": pct(reference.min_share, 0),
    }
    if reference.overall_strict:
        weak = reference.weak_years
        return t(
            "backtest.warnings.reference_weak_years",
            **params,
            years=_reference_years(reference, weak),
            others=_reference_others(reference, weak),
        )
    return t(
        "backtest.warnings.reference_weak",
        **params,
        years=_reference_years(reference, reference.by_year),
        others=_reference_others(reference),
    )


def _reference_note(reference: ReferenceMix) -> str:
    """Пусто, если сравнение строгое; иначе — доля основного эталона и запасные (в целом
    или в годах, где основного мало)."""
    if reference.strict:
        return ""
    params = {
        "primary": bookmaker_name(reference.primary),
        "share": pct(reference.primary_share),
        "min": pct(reference.min_share, 0),
    }
    if reference.overall_strict:
        weak = reference.weak_years
        return ". " + t(
            "backtest.verdict.reference_weak_years",
            **params,
            years=_reference_years(reference, weak),
            others=_reference_others(reference, weak),
        )
    return ". " + t(
        "backtest.verdict.reference_weak", **params, others=_reference_others(reference)
    )


def _market_verdict(result: BacktestResult) -> str:
    gap = result.calibrated_gap
    reference = result.data.reference
    if gap is None:
        return t(
            "backtest.verdict.no_market",
            bookmakers=", ".join(map(bookmaker_name, reference.order)),
        )
    params: dict[str, Any] = {
        "diff": num(abs(gap.log_loss.value)),
        "signed": num(gap.log_loss.value),
        "low": num(gap.log_loss.low),
        "high": num(gap.log_loss.high),
        "n": gap.log_loss.n,
    }
    if gap.log_loss.low > 0:
        key = "backtest.verdict.worse"
    elif gap.log_loss.high < 0:
        key = "backtest.verdict.better"
    else:
        key = "backtest.verdict.tie"
    return t(key, **params) + _reference_note(reference)


def _coin_verdict(result: BacktestResult) -> str:
    score = result.calibrated or result.model_all
    params = {"model": num(score.log_loss.value), "coin": num(COIN_LOG_LOSS)}
    if score.log_loss.high < COIN_LOG_LOSS:
        return t("backtest.verdict.coin_better", **params)
    return t("backtest.verdict.coin_not_better", **params)


def _main_bet(result: BacktestResult) -> BetResult | None:
    """Экспресс для вывода: у MAIN_BOOKMAKER, иначе у первого букмекера, чей ROI не
    верхняя граница (максимум по рынку для вывода не годится)."""
    parlays = [
        bet for bet in result.bets if bet.kind == "parlay" and not bet.rule7 and not bet.upper_bound
    ]
    preferred = [bet for bet in parlays if bet.bookmaker == MAIN_BOOKMAKER]
    return next(iter(preferred or parlays), None)


def _legs_text(result: BacktestResult, parlay: BetResult) -> str:
    """Те же исходы одиночными ставками против экспрессов (Р21): сколько съедает
    экспресс. Пусто, если одиночных на исходах экспрессов нет."""
    legs = next(
        (
            bet
            for bet in result.bets
            if bet.kind == "legs" and bet.bookmaker == parlay.bookmaker and not bet.rule7
        ),
        None,
    )
    if legs is None or legs.roi.roi is None or parlay.roi.roi is None:
        return ""
    diff = (parlay.roi.roi - legs.roi.roi) * 100
    return ". " + t(
        "backtest.verdict.roi_legs",
        bets=legs.roi.bets,
        roi=pct(legs.roi.roi),
        diff=num(abs(diff), 1),
        direction=t(
            "backtest.verdict.roi_legs_worse" if diff < 0 else "backtest.verdict.roi_legs_better"
        ),
    )


def _roi_verdict(result: BacktestResult) -> str | None:
    bet = _main_bet(result)
    if bet is None:
        return None
    bookmaker = bookmaker_name(bet.bookmaker)
    roi = bet.roi
    if roi.roi is None or roi.low is None or roi.high is None:
        return t("backtest.verdict.roi_none", bookmaker=bookmaker)
    if roi.bets < MIN_VERDICT_BETS:
        conclusion = t("backtest.verdict.roi_few", min=MIN_VERDICT_BETS)
    elif roi.low > 0:
        conclusion = t("backtest.verdict.roi_profit")
    elif roi.high < 0:
        conclusion = t("backtest.verdict.roi_loss")
    else:
        conclusion = t("backtest.verdict.roi_noise")
    return t(
        "backtest.verdict.roi",
        bookmaker=bookmaker,
        bets=roi.bets,
        roi=pct(roi.roi),
        low=pct(roi.low),
        high=pct(roi.high),
        conclusion=conclusion,
    ) + _legs_text(result, bet)


def _decoy_verdict(result: BacktestResult) -> str:
    decoy = result.decoy
    key = "decoy_passed" if decoy.passed else "decoy_failed"
    if decoy.refit_log_loss is None:
        return t(
            f"backtest.verdict.{key}", value=num(decoy.log_loss), threshold=num(decoy.threshold)
        )
    return t(
        f"backtest.verdict.{key}_refit",
        value=num(decoy.log_loss),
        refit=num(decoy.refit_log_loss),
        threshold=num(decoy.threshold),
    )


def summary_lines(result: BacktestResult) -> list[str]:
    """Честный вывод по числам: рынок, монетка, ROI экспрессов, приманка."""
    lines = [_market_verdict(result), _coin_verdict(result)]
    roi = _roi_verdict(result)
    if roi is not None:
        lines.append(roi)
    lines.append(_decoy_verdict(result))
    return lines


# --- разделы отчета ---


def _table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> list[str]:
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return lines


def _data_section(result: BacktestResult) -> list[str]:
    data, config = result.data, result.config
    lines = [
        f"## {t('backtest.report.data_title')}",
        "",
        "- "
        + t(
            "backtest.report.history",
            matches=data.matches,
            first=_day(data.first_day),
            last=_day(data.last_day),
        ),
    ]
    for reason, count in data.skipped.items():
        lines.append("  - " + t("backtest.report.skipped", reason=_skip_name(reason), count=count))
    lines += [
        "- " + t("backtest.report.tune_period", years=_years(data.tune.years), n=data.tune.events),
        "- "
        + t("backtest.report.calib_period", years=_years(data.calib.years), n=data.calib.events),
        "- "
        + t(
            "backtest.report.test_period",
            years=_years(data.test.years),
            n=data.test.events,
            with_market=data.test_with_market,
            share=pct(data.market_share),
        ),
    ]
    lines.append("- " + t("backtest.report.bet_events", n=data.bet_events))
    lines.append(
        "- " + t("backtest.report.levels", levels=", ".join(map(level_name, config.levels)))
    )
    fresh = result.freshness
    if fresh is not None:
        lines.append("- " + t("backtest.report.freshness", day=_day(fresh.last_day)))
        for source in fresh.sources:
            name = _source_name(source.source)
            if source.last_ok_run is None and source.last_day is None:
                lines.append("  - " + t("backtest.report.freshness_source_none", source=name))
                continue
            lines.append(
                "  - "
                + t(
                    "backtest.report.freshness_source",
                    source=name,
                    run=_day(source.last_ok_run),
                    day=_day(source.last_day),
                )
            )
    return [*lines, "", *_reference_section(result)]


def _reference_section(result: BacktestResult) -> list[str]:
    """Состав эталона рынка по тестовым годам: сколько событий оценено по каждому
    букмекеру и доля основного (Pinnacle)."""
    data = result.data
    reference = data.reference
    names = [bookmaker_name(bookmaker) for bookmaker in reference.order]
    rows = []
    for year, (with_market, total) in data.market_by_year.items():
        counts = reference.by_year.get(year, {})
        rows.append(
            [
                str(year),
                str(total),
                f"{with_market} ({pct(with_market / total if total else None)})",
                *[str(counts.get(bookmaker, 0)) for bookmaker in reference.order],
                pct(reference.year_share(year)),
            ]
        )
    if len(rows) > 1:
        rows.append(
            [
                t("backtest.report.reference_total"),
                str(data.test.events),
                f"{data.test_with_market} ({pct(data.market_share)})",
                *[str(count) for count in reference.counts.values()],
                pct(reference.primary_share),
            ]
        )
    return [
        f"### {t('backtest.report.reference_title')}",
        "",
        t(
            "backtest.report.reference_note",
            order=" → ".join(names),
            primary=names[0],
            min=pct(reference.min_share, 0),
            events=reference.min_year_events,
        ),
        "",
        *_table(
            [
                t("backtest.report.col_year"),
                t("backtest.report.col_events"),
                t("backtest.report.col_with_reference"),
                *names,
                t("backtest.report.col_primary_share", name=names[0]),
            ],
            rows,
        ),
    ]


def _model_section(result: BacktestResult) -> list[str]:
    elo = result.config.elo
    lines = [
        f"## {t('backtest.report.model_title')}",
        "",
        "- "
        + t(
            "backtest.report.elo_params",
            initial=num(elo.initial, 0),
            k_num=num(elo.k_num, 0),
            k_offset=num(elo.k_offset, 0),
            k_shape=num(elo.k_shape, 2),
        ),
        "- "
        + t(
            "backtest.report.surface_weight",
            weight=num(result.surface_weight, 2),
            years=_years(result.data.tune.years),
        ),
        "- " + t("backtest.report.platt", a=num(result.platt.a), b=num(result.platt.b)),
    ]
    if result.tuning:
        lines += [
            "",
            *_table(
                [t("backtest.report.col_weight"), t("backtest.report.col_log_loss")],
                [[num(weight, 2), num(value, 4)] for weight, value in result.tuning.items()],
            ),
        ]
    return lines


def _score_row(name: str, score: ScoreSummary | None, skill: float | None) -> list[str]:
    if score is None:
        return [name, DASH, DASH, DASH, DASH, DASH]
    return [name, str(score.n), _ci(score.log_loss), _ci(score.brier), num(score.ece), num(skill)]


def _accuracy_section(result: BacktestResult) -> list[str]:
    lines = [f"## {t('backtest.report.accuracy_title')}", ""]
    header = [
        t("backtest.report.col_forecast"),
        t("backtest.report.col_events"),
        t("backtest.report.col_log_loss_ci"),
        t("backtest.report.col_brier_ci"),
        t("backtest.report.col_ece"),
        t("backtest.report.col_skill"),
    ]
    if result.calibrated is not None and result.market is not None:
        n = str(result.calibrated.n)
        market_name = t(
            "backtest.report.row_market", bookmaker=_reference_label(result.data.reference)
        )
        lines += [t("backtest.report.accuracy_note"), ""]
        lines += _table(
            header,
            [
                [t("backtest.report.row_coin"), n, num(COIN_LOG_LOSS), num(COIN_BRIER), DASH, DASH],
                _score_row(
                    t("backtest.report.row_elo"),
                    result.raw,
                    result.raw_gap.skill if result.raw_gap else None,
                ),
                _score_row(
                    t("backtest.report.row_elo_calibrated"),
                    result.calibrated,
                    result.calibrated_gap.skill if result.calibrated_gap else None,
                ),
                _score_row(market_name, result.market, None),
            ],
        )
        lines += ["", t("backtest.report.gap_note"), ""]
        gaps = [
            (t("backtest.report.row_elo"), result.raw_gap),
            (t("backtest.report.row_elo_calibrated"), result.calibrated_gap),
        ]
        lines += _table(
            [
                t("backtest.report.col_forecast"),
                t("backtest.report.col_log_loss_ci"),
                t("backtest.report.col_brier_ci"),
            ],
            [[name, _ci(gap.log_loss), _ci(gap.brier)] for name, gap in gaps if gap is not None],
        )
        lines.append("")
    lines += [t("backtest.report.all_events_note"), ""]
    lines += _table(
        header,
        [
            _score_row(t("backtest.report.row_elo"), result.model_all_raw, None),
            _score_row(t("backtest.report.row_elo_calibrated"), result.model_all, None),
        ],
    )
    return lines


def _calibration_rows(table: Sequence[CalibrationBin]) -> list[list[str]]:
    rows = []
    for item in table:
        rows.append(
            [
                t("backtest.report.bin", low=pct(item.low, 0), high=pct(item.high, 0)),
                str(item.n) + (" *" if item.n < MIN_BIN_EVENTS else ""),
                pct(item.mean_p),
                pct(item.rate),
                t("backtest.report.range", low=pct(item.ci_low), high=pct(item.ci_high)),
            ]
        )
    return rows


def _calibration_section(result: BacktestResult) -> list[str]:
    header = [
        t("backtest.report.col_bin"),
        t("backtest.report.col_events"),
        t("backtest.report.col_mean_p"),
        t("backtest.report.col_rate"),
        t("backtest.report.col_wilson"),
    ]
    lines = [
        f"## {t('backtest.report.calibration_title')}",
        "",
        t("backtest.report.calibration_note", min=MIN_BIN_EVENTS),
        "",
        f"**{t('backtest.report.row_elo_calibrated')}**",
        "",
    ]
    lines += _table(header, _calibration_rows(result.calibration))
    if result.market_calibration:
        market = t("backtest.report.row_market", bookmaker=_reference_label(result.data.reference))
        lines += ["", f"**{market}**", ""]
        lines += _table(header, _calibration_rows(result.market_calibration))
    return lines


def _slices_section(result: BacktestResult) -> list[str]:
    lines = [
        f"## {t('backtest.report.slices_title')}",
        "",
        t("backtest.report.slices_note", min=result.config.min_slice),
        "",
    ]
    if not result.slices:
        return [*lines, t("backtest.report.slices_none")]
    rows = []
    for item in result.slices:
        name = surface_name(item.value) if item.kind == "surface" else level_name(item.value)
        kind = t(
            "backtest.report.slice_surface"
            if item.kind == "surface"
            else "backtest.report.slice_level"
        )
        rows.append(
            [
                f"{kind}: {name}",
                str(item.n),
                num(item.model_log_loss),
                num(item.market_log_loss),
                _ci(item.gap),
            ]
        )
    return lines + _table(
        [
            t("backtest.report.col_slice"),
            t("backtest.report.col_events"),
            t("backtest.report.col_model_log_loss"),
            t("backtest.report.col_market_log_loss"),
            t("backtest.report.col_gap_ci"),
        ],
        rows,
    )


def _bets_section(result: BacktestResult) -> list[str]:
    rules = result.config.rules
    lines = [
        f"## {t('backtest.report.roi_title')}",
        "",
        t(
            "backtest.report.roi_rules",
            min_p=pct(rules.min_p, 0),
            min_odds=num(float(rules.min_odds), 2),
            max_odds=num(float(rules.max_odds), 2),
            triple_p=pct(rules.triple_min_p, 0),
            triple_odds=num(float(rules.triple_max_odds), 2),
            triple_low=num(float(rules.triple_total[0]), 2),
            triple_high=num(float(rules.triple_total[1]), 2),
            double_low=num(float(rules.double_total[0]), 2),
            double_high=num(float(rules.double_total[1]), 2),
        ),
        "",
        t("backtest.report.roi_variants"),
        "",
    ]
    rows = []
    for bet in result.bets:
        kind = t(f"backtest.report.kind_{bet.kind}")
        if bet.legs:
            legs = ", ".join(
                t("backtest.report.legs", legs=size, n=count) for size, count in bet.legs.items()
            )
            kind = f"{kind} ({legs})"
        name = bookmaker_name(bet.bookmaker)
        if bet.upper_bound:
            name = t("backtest.report.upper_bound_name", name=name)
        rows.append(
            [
                name,
                kind,
                t("backtest.report.rule7_yes" if bet.rule7 else "backtest.report.rule7_no"),
                str(bet.bets),
                pct(bet.win_rate),
                num(bet.avg_odds, 2),
                _roi_ci(bet.roi),
            ]
        )
    lines += _table(
        [
            t("backtest.report.col_bookmaker"),
            t("backtest.report.col_kind"),
            t("backtest.report.col_rule7"),
            t("backtest.report.col_bets"),
            t("backtest.report.col_win_rate"),
            t("backtest.report.col_avg_odds"),
            t("backtest.report.col_roi_ci"),
        ],
        rows,
    )
    if any(bet.upper_bound for bet in result.bets):
        lines += ["", t("backtest.report.roi_upper_bound")]
    return lines


def _decoy_section(result: BacktestResult) -> list[str]:
    return [
        f"## {t('backtest.report.decoy_title')}",
        "",
        t(
            "backtest.report.decoy_note",
            margin=num(result.config.decoy_margin),
            refit_min=result.decoy.refit_min,
        ),
        "",
        "- " + _decoy_verdict(result) + " " + t("backtest.report.decoy_events", n=result.decoy.n),
    ]


def _assumptions_section(result: BacktestResult) -> list[str]:
    keys = [
        t("backtest.assumptions.odds_moment"),
        t("backtest.assumptions.retired"),
        t("backtest.assumptions.walkover"),
        t("backtest.assumptions.carpet"),
        t("backtest.assumptions.sides"),
        t("backtest.assumptions.match_day"),
        t("backtest.assumptions.stake"),
        t("backtest.assumptions.tour"),
    ]
    return [f"## {t('backtest.report.assumptions_title')}", "", *[f"- {line}" for line in keys]]


def render_markdown(result: BacktestResult) -> str:
    """Отчет бэктеста целиком (Markdown)."""
    config = result.config
    lines = [
        f"# {t('backtest.report.title')}",
        "",
        t(
            "backtest.report.subtitle",
            created=_day(result.created_at),
            years=_years(config.test_years),
            eval_set=config.eval_set,
            seed=config.seed,
            bootstrap=config.bootstrap,
        ),
        "",
        f"## {t('backtest.report.summary_title')}",
        "",
        *[f"- {line}" for line in summary_lines(result)],
        "",
    ]
    for section in (
        _data_section,
        _model_section,
        _accuracy_section,
        _calibration_section,
        _slices_section,
        _bets_section,
        _decoy_section,
        _assumptions_section,
    ):
        lines += [*section(result), ""]
    if result.warnings:
        lines += [f"## {t('backtest.report.warnings_title')}", ""]
        lines += [f"- {warning}" for warning in result.warnings] + [""]
    lines += [
        f"## {t('backtest.report.sources_title')}",
        "",
        f"- {t('backtest.report.license_sackmann')}",
        f"- {t('backtest.report.license_tennis_data')}",
        "",
    ]
    return "\n".join(lines)
