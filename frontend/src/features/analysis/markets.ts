import i18n from '../../i18n';
import { formatPercent, formatPp, formatUsd } from '../../lib/format';
import type { Market, MarketRow } from './types';

// Исходы матча на экране: подписи (П1, Ф1(−1.5)), описание, порядок, уровни валуя.

/** Подпись исхода: П1, П2, Ф1(−1.5), Ф2(+1.5). */
export function marketLabel(market: Market, selection: number): string {
  if (market === 'ML') return i18n.t('analysis.market.ml', { n: selection });
  if (market === 'HCP_-1.5') return i18n.t('analysis.market.minus', { n: selection });
  return i18n.t('analysis.market.plus', { n: selection });
}

/** Что значит исход: «Синнер выигрывает 2:0»; в матче до 3 побед −1.5 — это 3:0 или 3:1. */
export function marketDescription(market: Market, name: string, bestOf: number): string {
  const five = bestOf === 5;
  if (market === 'ML') return i18n.t('analysis.marketDesc.ml', { name });
  if (market === 'HCP_-1.5') return i18n.t(five ? 'analysis.marketDesc.minus5' : 'analysis.marketDesc.minus3', { name });
  return i18n.t(five ? 'analysis.marketDesc.plus5' : 'analysis.marketDesc.plus3', { name });
}

// Порядок строк как в макете: П1, Ф1(−1.5), Ф2(+1.5), П2, затем зеркальные форы
const ORDER: ReadonlyArray<[Market, number]> = [
  ['ML', 1],
  ['HCP_-1.5', 1],
  ['HCP_+1.5', 2],
  ['ML', 2],
  ['HCP_-1.5', 2],
  ['HCP_+1.5', 1],
];

/** Исходы для таблицы: с кэфом участника (П1 и П2 — всегда), в порядке макета. */
export function shownMarkets(rows: readonly MarketRow[]): MarketRow[] {
  const out: MarketRow[] = [];
  for (const [market, selection] of ORDER) {
    const row = rows.find((r) => r.market === market && r.selection === selection);
    if (row && (row.odds !== null || market === 'ML')) out.push(row);
  }
  return out;
}

export type ValueTier = 'strong' | 'good' | 'small';

/** Уровень валуя для метки: сильный ≥ 15%, хороший ≥ 10%, небольшой ≥ 5% (как value_tier). */
export function valueTier(tier: string): ValueTier | null {
  return tier === 'strong' || tier === 'good' || tier === 'small' ? tier : null;
}

// Вероятность целыми процентами («66%») — общая для всех экранов, живет в lib/format
export { formatProb } from '../../lib/format';

/**
 * Поправка Claude в процентных пунктах: «+4 п.п.», «−2 п.п.», «±0 п.п.». Общий формат п.п. —
 * formatPp в lib/format; здесь только вид экрана анализа: целые и ноль со знаком «±».
 * unit: false — только число (в узкой ячейке единица уже в заголовке).
 */
export function ppDelta(delta: number, { unit = true }: { unit?: boolean } = {}): string {
  return formatPp(delta, { digits: 0, zero: '±', unit });
}

/** Модель Claude по имени: claude-opus-5-5 → «Opus 5.5». */
export function modelName(model: string | null | undefined): string {
  if (!model) return '';
  const found = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  if (!found) return model;
  const [, family = '', major = '', minor = ''] = found;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

/** Доля банка без лишних нулей: 0.0225 → «2,25%», 0.015 → «1,5%», 0.02 → «2%». */
export function formatShare(share: number | string | null | undefined): string {
  const n = typeof share === 'string' ? Number(share) : share;
  if (n === null || n === undefined || !Number.isFinite(n)) return formatPercent(null);
  return formatPercent(n, { digits: 2 }).replace(/([.,]\d*?)0+%$/, '$1%').replace(/[.,]%$/, '%');
}

/** Расход Claude: меньше цента — с тремя-четырьмя знаками («$0,004», «$0,0003»), иначе «$0,13». */
export function usdSmall(value: number): string {
  if (value > 0 && value < 0.001) return formatUsd(value, 4);
  if (value > 0 && value < 0.01) return formatUsd(value, 3);
  return formatUsd(value, 2);
}
