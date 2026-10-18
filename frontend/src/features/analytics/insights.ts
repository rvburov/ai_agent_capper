import type { TFunction } from 'i18next';

import type { IconName } from '../../components';
import { currencyOf } from '../bets/display';
import { formatShare, marketLabel } from '../analysis/markets';
import { formatMoney, formatNumber, formatOdds, formatPercentNumber, formatPp, formatProb } from '../../lib/format';
import { brierDiff, brierText, signedPct } from './display';
import type { Insight, InsightFilter, InsightTone, Market, SurfaceFilter } from './types';

/*
 * Выводы «Аналитики» считает сервер (до трех, без Claude): код, тон, числа и действие. Тексты —
 * ключи analytics.insights.<код>.title|text, копия backend/app/locales/ru.json; четыре текста
 * со склонениями и названием среза — как в макете (список отличий — DEVIATIONS в
 * analytics.test.ts). Числа в params приходят как есть (доли, кэфы, суммы строкой) — здесь они
 * записываются по-русски.
 */

/** Иконка вывода — как в макете (insightList). */
export const INSIGHT_ICON: Record<Insight['code'], IconName> = {
  sample: 'info',
  calibration_over: 'target',
  calibration_under: 'target',
  calibration_ok: 'check',
  total_negative: 'alert',
  small_slice: 'info',
  brier_noise: 'bolt',
  brier_model_better: 'bolt',
  brier_market_better: 'bolt',
};

/** Подпись тона для читалки экрана: «Внимание», «Риск»… */
export const TONES: readonly InsightTone[] = ['warn', 'bad', 'info', 'accent', 'good'];

function num(params: Record<string, unknown>, name: string): number | null {
  const value = params[name];
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(params: Record<string, unknown>, name: string): string | null {
  const value = params[name];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
}

/** «12 ставок», «25 событий». */
export function countText(t: TFunction, unit: 'bets' | 'events', count: number): string {
  return unit === 'bets' ? t('analytics.count.bets', { count }) : t('analytics.count.events', { count });
}

/** Название среза для фильтра: «Грунт», «П1». */
export function filterLabel(t: TFunction, filter: InsightFilter | null | undefined): string | null {
  if (!filter) return null;
  if (filter.surface) return t(`analytics.surfaces.${filter.surface}`);
  if (filter.market) {
    if (filter.selection) return marketLabel(filter.market, filter.selection);
    const group = MARKET_GROUP[filter.market];
    return group ? t(`analytics.markets.group.${group}`) : marketLabel(filter.market, 1);
  }
  return null;
}

const MARKET_GROUP: Readonly<Record<string, 'ml' | 'minus' | 'plus'>> = { ML: 'ml', 'HCP_-1.5': 'minus', 'HCP_+1.5': 'plus' };

function sliceName(t: TFunction, params: Record<string, unknown>): string {
  if (params.dimension === 'surface') {
    const surface = str(params, 'surface') as SurfaceFilter | null;
    return t('analytics.insights.slice.surface', { name: surface ? t(`analytics.surfaces.${surface}`) : '—' });
  }
  const market = str(params, 'market') as Market | null;
  const selection = num(params, 'selection');
  const name = market && selection ? marketLabel(market, selection) : '—';
  return t('analytics.insights.slice.market', { name });
}

const PP0 = { digits: 0, signed: false } as const;

/**
 * Невидимый «соединитель слов» (U+2060) у тире диапазона: «2.21–3.24» и «60–65%» в заголовке
 * вывода не рвутся на две строки (в макете диапазон — в nowrap).
 */
const JOIN = '\u2060';

/**
 * Заголовок и текст вывода: числа из params по-русски. currency — валюта программы (сумма в
 * выводе об итоговом кэфе).
 */
export function insightTexts(t: TFunction, insight: Insight, currency: string): { title: string; text: string } {
  const p = insight.title.params;
  switch (insight.code) {
    case 'sample': {
      const params = {
        bets: t('analytics.count.bets', { count: num(p, 'bets') ?? 0 }),
        events: t('analytics.count.events', { count: num(p, 'events') ?? 0 }),
        min_events: formatNumber(num(p, 'min_events')),
      };
      return { title: t('analytics.insights.sample.title'), text: t('analytics.insights.sample.text', params) };
    }
    case 'calibration_over':
    case 'calibration_under': {
      const params = {
        low: `${formatPercentNumber(num(p, 'low') ?? 0)}${JOIN}`,
        high: `${JOIN}${formatProb(num(p, 'high'))}`,
        p: formatProb(num(p, 'p')),
        actual: formatProb(num(p, 'actual')),
        gap: formatPp(num(p, 'gap'), PP0),
      };
      return {
        title: t(`analytics.insights.${insight.code}.title`, params),
        text: t(`analytics.insights.${insight.code}.text`, params),
      };
    }
    case 'calibration_ok': {
      const params = { min_n: formatNumber(num(p, 'min_n')), gap: formatPp(num(p, 'gap'), PP0) };
      return { title: t('analytics.insights.calibration_ok.title'), text: t('analytics.insights.calibration_ok.text', params) };
    }
    case 'total_negative': {
      const params = {
        low: `${formatOdds(str(p, 'low'))}${JOIN}`,
        high: `${JOIN}${formatOdds(str(p, 'high'))}`,
        roi: signedPct(num(p, 'roi')),
        bets: t('analytics.count.betsLoc', { count: num(p, 'bets') ?? 0 }),
        profit: formatMoney(str(p, 'profit'), currencyOf(currency), { signed: true }),
        stake_pct: formatShare(str(p, 'stake_pct')),
      };
      const largest = p.largest === true;
      return {
        title: t('analytics.insights.total_negative.title', params),
        text: largest ? t('analytics.insights.total_negative.textLargest', params) : t('analytics.insights.total_negative.text', params),
      };
    }
    case 'small_slice': {
      const params = {
        slice: sliceName(t, p),
        roi: signedPct(num(p, 'roi')),
        n: t('analytics.count.events', { count: num(p, 'n') ?? 0 }),
        roi_after_loss: signedPct(num(p, 'roi_after_loss')),
        pattern_n: formatNumber(num(p, 'pattern_n')),
      };
      return { title: t('analytics.insights.small_slice.title', params), text: t('analytics.insights.small_slice.text', params) };
    }
    case 'brier_noise':
    case 'brier_model_better':
    case 'brier_market_better': {
      const low = num(p, 'ci_low');
      const high = num(p, 'ci_high');
      const params = {
        model: brierText(num(p, 'model')),
        market: brierText(num(p, 'market')),
        ci_low: low === null ? '—' : brierDiff(low),
        ci_high: high === null ? '—' : brierDiff(high),
      };
      const clvN = num(p, 'clv_n') ?? 0;
      const clv = num(p, 'clv');
      const tail =
        clvN > 0 && clv !== null
          ? t('analytics.insights.clvTail', { clv: signedPct(clv), positive: formatNumber(num(p, 'clv_positive')), n: formatNumber(clvN) })
          : '';
      return {
        title: t(`analytics.insights.${insight.code}.title`),
        text: `${t(`analytics.insights.${insight.code}.text`, params)}${tail}`,
      };
    }
    default:
      return { title: '', text: '' };
  }
}
