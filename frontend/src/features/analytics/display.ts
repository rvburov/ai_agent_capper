import type { TFunction } from 'i18next';

import i18n from '../../i18n';
import { formatDateRange, formatInterval, formatNumber, formatOdds, formatPercent, formatPercentRange, formatPp } from '../../lib/format';
import type { Ci, Market, Period, Series } from './types';

/*
 * Вид чисел «Аналитики» и главной: интервалы, «в пределах шума», подписи периода и исходов.
 * Все числа и интервалы считает сервер (GET /api/analytics, GET /api/dashboard); здесь только
 * их запись, как в макете (mockup/js/screens/analytics.js: ciPct, ciPct1, ciDec3, noisy).
 */

type CiLike = Pick<Ci, 'low' | 'high'> | null | undefined;

/** Интервал ROI целыми процентами, знак у каждого конца и «%» один раз: «−8…+16%». */
export function ciPct(ci: CiLike): string {
  if (!ci) return '—';
  return formatPercentRange(ci.low, ci.high, { signed: true });
}

/** Интервал CLV с десятыми: «−1,2%…+3,4%». */
export function ciPct1(ci: CiLike): string {
  if (!ci) return '—';
  return formatInterval(ci.low, ci.high, (v) => formatPercent(v, { signed: true }));
}

/** Интервал разницы ROI в процентных пунктах, целыми: «−8…+16 п.п.». */
export function ciPp(ci: CiLike): string {
  if (!ci) return '—';
  const range = formatInterval(ci.low, ci.high, (v) => formatPp(v, { digits: 0, unit: false }));
  return i18n.t('format.pp', { value: range });
}

/** Интервал разницы Brier, три знака: «−0,012…+0,004». */
export function ciDec3(ci: CiLike): string {
  if (!ci) return '—';
  return formatInterval(ci.low, ci.high, (v) => formatNumber(v, 3, { signed: true }));
}

/** Интервал задевает ноль (или его нет): разница может быть везением — «в пределах шума». */
export function noisy(ci: CiLike): boolean {
  return !ci || (ci.low <= 0 && ci.high >= 0);
}

/** ROI и CLV со знаком, десятые: «+3,2%», «−1,0%». */
export function signedPct(value: number | null | undefined): string {
  return formatPercent(value, { signed: true });
}

/** Brier — три знака: «0,214». */
export function brierText(value: number | null | undefined): string {
  return formatNumber(value, 3);
}

/** Разница Brier со знаком: «+0,012», ноль — «0,000». */
export function brierDiff(value: number | null | undefined): string {
  return formatNumber(value, 3, { signed: true });
}

/**
 * Направление изменения для стрелки: рост, падение или «без изменений», если после округления
 * до показанных знаков разницы нет (ROI и CLV — до десятых п.п., Brier — до тысячных).
 */
export function trendOf(value: number | null | undefined, digits = 3): 'up' | 'down' | 'flat' {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'flat';
  const rounded = Math.round(value * 10 ** digits);
  return rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
}

/** Цвет числа: плюс — зеленый, минус — красный, ноль и прочерк — без цвета (как roiCls макета). */
export function signClass(value: number | string | null | undefined): string | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? 'good-text' : 'bad-text';
}

/**
 * Подпись периода в тексте: «за 30 дней», «за все время»; свои даты — «за 3–5 окт».
 * period null (заданы даты) — по датам ответа.
 */
export function periodContext(
  t: TFunction,
  period: Period | null,
  dateFrom: string | null,
  dateTo: string,
): string {
  if (period === null) {
    return t('analytics.period.dates', { range: dateFrom ? formatDateRange(dateFrom, dateTo) : formatDateRange(dateTo, dateTo) });
  }
  return t(`analytics.period.ctx.${period}`);
}

/** «к пред. 30 дням»; у «всего времени» и своих дат сравнения нет — null. */
export function prevContext(t: TFunction, period: Period | null): string | null {
  if (period === null || period === 'all') return null;
  return t(`analytics.period.prev.${period}`);
}

/** Начало ряда банка: «Старт периода», опорная линия графика и процент изменения за период. */
export interface PeriodStart {
  /** Точки ряда без дней, когда банка еще не было. */
  points: Series['points'];
  /** День, к которому относится старт: день перед периодом или первый день банка. */
  day: string;
  /** Банк на начало (сумма с сервера). */
  amount: string;
  /** Изменение за период долей от банка на начало; null — показывать только сумму. */
  share: number | null;
}

/**
 * Старт периода — как есть с сервера (SeriesOut.start_day, start_amount, change_share): обычно
 * банк на конец дня перед периодом и прибыль периода к нему; если банк появился внутри периода
 * или выбрано «все время» — первый день банка, вложенное и рост капитала к нему. Дни до
 * появления банка сервер в points не присылает. Ряд результата (kind = result) — с нуля.
 */
export function periodStart(series: Series): PeriodStart {
  return { points: series.points, day: series.start_day, amount: series.start_amount, share: series.change_share };
}

/** С заглавной буквы: «За 30 дней» в подзаголовке карточки. */
export function capitalize(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Ключ рынка в текстах (точка в названии рынка — разделитель ключей i18next). */
export const MARKET_KEY: Readonly<Record<string, 'ml' | 'minus' | 'plus'>> = { ML: 'ml', 'HCP_-1.5': 'minus', 'HCP_+1.5': 'plus' };

/** Что значит исход (сводка по рынкам): «игрок 1 — 2:0 (3:0, 3:1)»; рынок с линией (Р28) — null. */
export function outcomeDescription(t: TFunction, market: Market, selection: number): string | null {
  const key = MARKET_KEY[market];
  return key ? t(`analytics.markets.desc.${key}`, { n: selection }) : null;
}

/** Диапазон кэфа: «1.30–1.49»; без верхней границы — «2.00+»; вне таблицы стратегии — null. */
export function oddsRange(low: string | null, high: string | null): string | null {
  if (low === null) return null;
  return high === null ? `${formatOdds(low)}+` : `${formatOdds(low)}–${formatOdds(high)}`;
}
