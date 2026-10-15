import type { Analytics, Brier, BrierPoint, Calibration, Ci } from './types';

/*
 * Точность прогнозов этапа 5 (analytics.js макета, Р25): калибровка «Все мои прогнозы» (В3
 * этапа 4 — прогнозы своих анализов с исходом, блок calibration_all ответа) и Brier к рынку
 * закрытия главным рядом, когда закрытий больше, чем событий с рынком при прогнозе (В2 этапа
 * 4, brier.main). Какой ряд главный и что входит в выборку, решает сервер; экран переключает.
 */

export type CalibrationSample = 'all' | 'legs';
export type BrierRef = Brier['main'];

/** Калибровка «Все мои прогнозы»; под фильтром «старый бот» ее нет (null). */
export function calibrationAll(data: Analytics): Calibration | null {
  return data.calibration_all;
}

/** Главный ряд Brier — по правилу сервера. */
export function mainRef(brier: Brier): BrierRef {
  return brier.main;
}

/** Ряд Brier, выбранный переключателем: числа периода, окна графика и второй ряд — строкой. */
export interface BrierView {
  ref: BrierRef;
  n: number;
  model: number | null;
  market: number | null;
  diff: number | null;
  diffCi: Ci | null;
  noise: boolean | null;
  points: BrierPoint[];
  windows: number;
  better: number;
  /** Второй ряд — для строки под графиком. */
  other: { ref: BrierRef; n: number; model: number | null; market: number | null };
}

export function brierView(b: Brier, ref: BrierRef): BrierView {
  const pred = { ref: 'pred' as const, n: b.n, model: b.model, market: b.market };
  const closing = { ref: 'closing' as const, n: b.closing_n, model: b.closing_model, market: b.closing_market };
  if (ref === 'closing') {
    return {
      ...closing,
      diff: b.closing_diff,
      diffCi: b.closing_diff_ci,
      noise: b.closing_noise,
      points: b.closing_points,
      windows: b.closing_windows,
      better: b.closing_better,
      other: pred,
    };
  }
  return { ...pred, diff: b.diff, diffCi: b.diff_ci, noise: b.noise, points: b.points, windows: b.windows, better: b.better, other: closing };
}

// Выбор выборки калибровки помнится до конца сеанса вкладки, как в макете (capper.analytics.sample)
const SAMPLE_KEY = 'capper.analytics.sample';

export function readSample(): CalibrationSample {
  try {
    return window.sessionStorage.getItem(SAMPLE_KEY) === 'legs' ? 'legs' : 'all';
  } catch {
    return 'all';
  }
}

export function saveSample(sample: CalibrationSample): void {
  try {
    window.sessionStorage.setItem(SAMPLE_KEY, sample);
  } catch {
    // хранилище недоступно: выбор живет до перезагрузки
  }
}
