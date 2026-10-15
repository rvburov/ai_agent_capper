import type { Analytics, Brier, Insight, Kpi, Series, Slices, Thresholds } from './types';

// Данные для тестов «Аналитики» и главной: участник с 3 месяцами ставок в рублях, октябрь 2026.
// Числа согласованы между собой там, где экран их сравнивает (выборка, ряд, срезы).

export function thresholdsOut(over: Partial<Thresholds> = {}): Thresholds {
  return {
    small_sample: 20,
    insight_min_events: 30,
    calibration_min_n: 8,
    calibration_gap: 0.04,
    calibration_few: 60,
    slice_pattern_n: 30,
    dashboard_small: 15,
    rolling_window: 30,
    rolling_step: 3,
    ...over,
  };
}

export function kpiOut(over: Partial<Kpi> = {}): Kpi {
  return {
    settled: 42,
    won: 25,
    lost: 15,
    void: 2,
    turnover: '52000.00',
    profit: '2860.00',
    roi: 0.055,
    roi_ci: { low: -0.08, high: 0.16 },
    winrate: 0.625,
    clv: 0.021,
    clv_ci: { low: 0.004, high: 0.038 },
    clv_positive: 24,
    clv_n: 34,
    legacy_settled: 3,
    ...over,
  };
}

export function brierOut(over: Partial<Brier> = {}): Brier {
  return {
    n: 64,
    model: 0.214,
    market: 0.22,
    diff: -0.006,
    diff_ci: { low: -0.018, high: 0.006 },
    noise: true,
    closing_n: 12,
    closing_model: 0.205,
    closing_market: 0.211,
    points: [
      { day: '2026-09-20', model: 0.231, market: 0.225 },
      { day: '2026-10-01', model: 0.219, market: 0.223 },
      { day: '2026-10-12', model: 0.214, market: 0.22 },
    ],
    windows: 12,
    better: 8,
    closing_diff: -0.006,
    closing_diff_ci: { low: -0.02, high: 0.008 },
    closing_noise: true,
    closing_points: [],
    closing_windows: 0,
    closing_better: 0,
    main: 'pred',
    ...over,
  };
}

/**
 * Ряд банка с пополнением внутри периода (В7 этапа 5, как в макете): старт 40 000 ₽ 13 сен,
 * пополнение 20 000 ₽ 14 сен, банк на конец периода 70 485 ₽. «Вложено» по дням и движения
 * банка — поля ряда, которые сервер добавляет в этапе 5 (points[].invested, flows, flows_total).
 */
const FLOW_POINTS: Series['points'] = [
  { day: '2026-09-13', value: '40000.00', invested: '40000.00' },
  { day: '2026-09-14', value: '60400.00', invested: '60000.00' },
  { day: '2026-10-01', value: '68100.00', invested: '60000.00' },
  { day: '2026-10-13', value: '70485.00', invested: '60000.00' },
].map((point) => ({ ...point }));

export function seriesWithFlows(over: Partial<Series> = {}): Series {
  return {
    ...seriesOut({
      group: 'week',
      start: '2026-09-13',
      base: '40000.00',
      start_day: '2026-09-13',
      start_amount: '40000.00',
      change_share: null,
      last: '70485.00',
      peak: '70485.00',
      best: '70485.00',
      worst: '40000.00',
      max_drawdown: -0.012,
      points: FLOW_POINTS,
      ...over,
    }),
    flows: [{ day: '2026-09-14', kind: 'deposit', amount: '20000.00' }],
    flows_total: '20000.00',
  };
}

export function seriesOut(over: Partial<Series> = {}): Series {
  // В7: движений внутри периода нет — «вложено» ровно на старте
  return {
    flows: [],
    flows_total: '0.00',
    kind: 'bank',
    group: 'month',
    start: '2026-08-31',
    base: '48000.00',
    start_day: '2026-08-31',
    start_amount: '48000.00',
    change_share: 2860 / 48000,
    last: '50860.00',
    peak: '51200.00',
    max_drawdown: -0.046,
    best: '51200.00',
    worst: '47100.00',
    points: [
      { day: '2026-08-31', value: '48000.00', invested: '48000.00' },
      { day: '2026-09-15', value: '49500.00', invested: '48000.00' },
      { day: '2026-10-01', value: '51200.00', invested: '48000.00' },
      { day: '2026-10-13', value: '50860.00', invested: '48000.00' },
    ],
    rows: [
      { date_from: '2026-09-01', date_to: '2026-09-30', bets: 26, profit: '2100.00', roi: 0.064, end: '50100.00' },
      { date_from: '2026-10-01', date_to: '2026-10-13', bets: 16, profit: '760.00', roi: 0.038, end: '50860.00' },
    ],
    ...over,
  };
}

export function slicesOut(over: Partial<Slices> = {}): Slices {
  return {
    surfaces: [
      { surface: 'hard', n: 48, wins: 33, winrate: 0.6875, roi: 0.042, roi_ci: { low: -0.06, high: 0.14 }, avg_odds: 1.52, small: false },
      { surface: 'clay', n: 12, wins: 9, winrate: 0.75, roi: 0.182, roi_ci: { low: -0.05, high: 0.4 }, avg_odds: 1.58, small: true },
    ],
    markets: [
      { market: 'ML', selection: 1, n: 40, wins: 28, winrate: 0.7, roi: 0.051, roi_ci: { low: -0.04, high: 0.15 }, avg_odds: 1.5, small: false },
      { market: 'HCP_+1.5', selection: 2, n: 20, wins: 14, winrate: 0.7, roi: -0.021, roi_ci: { low: -0.2, high: 0.15 }, avg_odds: 1.4, small: false },
    ],
    markets_total: { n: 60, winrate: 0.7, roi: 0.027, avg_odds: 1.47 },
    odds: [
      { low: '1.30', high: '1.49', n: 30, wins: 23, winrate: 0.767, roi: 0.031, roi_ci: { low: -0.05, high: 0.11 }, avg_odds: 1.41, small: false },
      { low: '2.00', high: null, n: 4, wins: 2, winrate: 0.5, roi: 0.1, roi_ci: null, avg_odds: 2.2, small: true },
    ],
    totals: [
      { low: '1.28', high: '1.70', stake_pct: '0.0275', triple: false, bets: 10, voids: 1, turnover: '13200.00', profit: '-1640.00', roi: -0.124, roi_ci: { low: -0.35, high: 0.1 }, small: true },
      { low: '1.71', high: '2.20', stake_pct: '0.0225', triple: false, bets: 22, voids: 1, turnover: '26000.00', profit: '3600.00', roi: 0.138, roi_ci: { low: -0.02, high: 0.3 }, small: false },
      { low: '3.25', high: '4.10', stake_pct: '0.0175', triple: true, bets: 0, voids: 0, turnover: '0.00', profit: '0.00', roi: null, roi_ci: null, small: false },
    ],
    ...over,
  };
}

export function insightOut(over: Partial<Insight> = {}): Insight {
  const params = { low: 0.7, high: 0.75, p: 0.72, actual: 0.62, gap: 0.1 };
  return {
    code: 'calibration_over',
    tone: 'warn',
    title: { key: 'analytics.insights.calibration_over.title', params },
    text: { key: 'analytics.insights.calibration_over.text', params },
    basis: 14,
    basis_unit: 'events',
    action: 'calibration',
    filter: null,
    ...over,
  };
}

/** Вывод с одними и теми же params у заголовка и текста (как отдает сервер). */
export function insightWith(code: Insight['code'], params: Record<string, unknown>, over: Partial<Insight> = {}): Insight {
  return insightOut({
    code,
    title: { key: `analytics.insights.${code}.title`, params },
    text: { key: `analytics.insights.${code}.text`, params },
    ...over,
  });
}

export function analyticsOut(over: Partial<Analytics> = {}): Analytics {
  return {
    currency: 'RUB',
    tz: 'Europe/Helsinki',
    period: 'all',
    date_from: null,
    date_to: '2026-10-13',
    filtered: false,
    thresholds: thresholdsOut(),
    sample: {
      bets: 42,
      singles: 12,
      parlays: 30,
      events: 64,
      legacy_bets: 3,
      legacy_parlay_events: 4,
      open_bets: 2,
      first_day: '2026-09-01',
      last_day: '2026-10-12',
      last_settled_at: '2026-10-12T18:00:00Z',
    },
    kpi: kpiOut(),
    prev: null,
    change: null,
    brier: brierOut(),
    insights: [
      insightOut(),
      insightWith(
        'small_slice',
        { dimension: 'surface', surface: 'clay', roi: 0.182, n: 12, roi_after_loss: 0.091, pattern_n: 30 },
        { tone: 'info', basis: 12, action: 'filter', filter: { surface: 'clay', market: null, selection: null } },
      ),
      insightWith(
        'brier_noise',
        { model: 0.214, market: 0.22, ci_low: -0.018, ci_high: 0.006, clv: 0.021, clv_positive: 24, clv_n: 34 },
        { tone: 'accent', basis: 64, action: 'explain' },
      ),
    ],
    series: seriesOut(),
    slices: slicesOut(),
    parlays: {
      parlays: 30,
      events: 62,
      legacy_parlays: 2,
      profit: '1900.00',
      parlays_roi: 0.045,
      parlays_ci: { low: -0.09, high: 0.17 },
      singles_roi: 0.03,
      singles_ci: { low: -0.03, high: 0.09 },
      diff: 0.015,
      diff_ci: { low: -0.08, high: 0.11 },
      verdict: 'noise',
    },
    calibration: {
      kind: 'final',
      events: 58,
      outside: 6,
      bins: [
        { low: 0.65, high: 0.7, n: 20, p: 0.672, p_base: 0.66, p_claude: 0.68, actual: 0.7, diff: 0.028, ci_low: 0.48, ci_high: 0.85 },
        { low: 0.7, high: 0.75, n: 14, p: 0.72, p_base: 0.71, p_claude: 0.73, actual: 0.62, diff: -0.1, ci_low: 0.36, ci_high: 0.82 },
      ],
      status: 'off',
      worst: { low: 0.7, high: 0.75, n: 14, p: 0.72, actual: 0.62, gap: 0.1, direction: 'over' },
      opposite: null,
    },
    // «Все мои прогнозы» (этап 5): по умолчанию нет — как под фильтром «старый бот»
    calibration_all: null,
    clv: {
      n: 34,
      positive: 24,
      negative: 8,
      bins: [
        { low: -0.02, high: -0.01, n: 3, share: 0.088, open_low: true, open_high: false },
        { low: -0.01, high: 0, n: 5, share: 0.147, open_low: false, open_high: false },
        { low: 0, high: 0.01, n: 10, share: 0.294, open_low: false, open_high: false },
        { low: 0.01, high: 0.02, n: 16, share: 0.471, open_low: false, open_high: true },
      ],
      fair_mean: 0.012,
      fair_n: 9,
    },
    ...over,
  };
}

/**
 * «Широкие» данные для проверки ширины таблиц: длинные интервалы, большие суммы, все покрытия
 * (с «Не указано»), итоговый кэф вне таблицы стратегии и калибровка с краевыми корзинами.
 */
export function wideAnalyticsOut(over: Partial<Analytics> = {}): Analytics {
  const base = analyticsOut();
  return analyticsOut({
    slices: {
      ...base.slices,
      surfaces: [
        { surface: 'hard', n: 148, wins: 93, winrate: 0.6284, roi: -0.1235, roi_ci: { low: -0.456, high: 1.204 }, avg_odds: 1.523, small: false },
        { surface: 'clay', n: 12, wins: 9, winrate: 0.75, roi: 1.825, roi_ci: { low: -0.95, high: 2.5 }, avg_odds: 11.58, small: true },
        { surface: 'grass', n: 8, wins: 3, winrate: 0.375, roi: -0.444, roi_ci: { low: -1, high: 0.6 }, avg_odds: 2.05, small: true },
        { surface: 'carpet', n: 2, wins: 1, winrate: 0.5, roi: 0.1, roi_ci: null, avg_odds: 2.05, small: true },
        { surface: 'unknown', n: 4, wins: 1, winrate: 0.25, roi: -0.5, roi_ci: { low: -1, high: 0.4 }, avg_odds: 2.05, small: true },
      ],
      odds: [
        { low: '1.30', high: '1.49', n: 130, wins: 93, winrate: 0.767, roi: -0.1031, roi_ci: { low: -0.455, high: 1.11 }, avg_odds: 1.41, small: false },
        { low: '2.00', high: null, n: 4, wins: 2, winrate: 0.5, roi: 1.1, roi_ci: { low: -1, high: 2.4 }, avg_odds: 12.2, small: true },
      ],
      totals: [
        { low: '1.28', high: '1.70', stake_pct: '0.0275', triple: false, bets: 110, voids: 1, turnover: '113200.00', profit: '-11640.55', roi: -0.124, roi_ci: { low: -0.35, high: 0.1 }, small: false },
        { low: '1.71', high: '2.20', stake_pct: '0.0225', triple: false, bets: 22, voids: 1, turnover: '26000.00', profit: '123600.00', roi: 1.138, roi_ci: { low: -0.92, high: 2.3 }, small: false },
        { low: '2.21', high: '3.24', stake_pct: '0.0175', triple: false, bets: 9, voids: 0, turnover: '9000.00', profit: '-4500.00', roi: -0.5, roi_ci: { low: -1, high: 0.3 }, small: true },
        { low: '3.25', high: '4.10', stake_pct: '0.0125', triple: true, bets: 3, voids: 0, turnover: '3000.00', profit: '-3000.00', roi: -1, roi_ci: { low: -1, high: -0.2 }, small: true },
        { low: null, high: null, stake_pct: null, triple: false, bets: 8, voids: 0, turnover: '8000.00', profit: '1200.00', roi: 0.15, roi_ci: { low: -0.2, high: 0.5 }, small: true },
      ],
    },
    calibration: {
      ...base.calibration,
      bins: [
        { low: 0.5, high: 0.55, n: 120, p: 0.522, p_base: 0.516, p_claude: 0.538, actual: 0.7, diff: 0.178, ci_low: 0.48, ci_high: 0.85 },
        { low: 0.65, high: 0.7, n: 20, p: 0.672, p_base: 0.66, p_claude: 0.68, actual: 0.7, diff: 0.028, ci_low: 0.48, ci_high: 0.85 },
        { low: 0.95, high: 1, n: 14, p: 0.972, p_base: 0.971, p_claude: 0.973, actual: 0.62, diff: -0.352, ci_low: 0.36, ci_high: 0.82 },
      ],
    },
    ...over,
  });
}
