import i18n from '../../i18n';
import { FAMILIES, familyOf, type MarketFamily } from '../analysis/markets';
import type { MarketStatusMap } from './map';
import type { MarketStatusInfo, MarketStatusKind } from './types';

/*
 * Статус рынка (Р28): «в экспрессе» (рынок есть в правилах активной версии стратегии), «на
 * проверке» (SUSPENDED_MARKETS сервера) или «для сравнения» (новый рынок, пока администратор
 * не переведет его в экспресс). Статус и счетчик событий считает сервер, экран только
 * показывает их. Счетчик «для сравнения» общий по всем участникам.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
const tr: Translate = (key, options) => (i18n.t as unknown as Translate)(key, options);

export function statusOfMarket(map: MarketStatusMap | null | undefined, market: string): MarketStatusInfo | null {
  const family = familyOf(market);
  return family ? (map?.get(family) ?? null) : null;
}

/** Короткая метка статуса: «идет в экспресс», «на проверке · временно не в экспрессе», «для сравнения · 38 из 150». */
export function statusLabel(info: Pick<MarketStatusInfo, 'status' | 'events' | 'need'>): string {
  if (info.status === 'compare') return tr('analysis.marketStatus.compareN', { n: info.events, need: info.need });
  return tr(`analysis.marketStatus.${info.status}`);
}

/** Подсказка к метке: почему рынок не в экспрессе. */
export function statusHint(info: Pick<MarketStatusInfo, 'status' | 'need'>): string | undefined {
  if (info.status === 'suspended') return tr('analysis.marketStatus.suspendedHint');
  if (info.status === 'compare') return tr('analysis.marketStatus.compareHint', { need: info.need });
  return undefined;
}

export function statusChipKind(status: MarketStatusKind): 'outline' | 'warn' | 'info' {
  return status === 'express' ? 'outline' : status === 'suspended' ? 'warn' : 'info';
}

/** Семейства, которые сейчас идут в экспресс: «П1 и П2», «П1, П2 и фора ±1.5». */
export function expressFamilies(map: MarketStatusMap): MarketFamily[] {
  return FAMILIES.filter((family) => map.get(family)?.status === 'express');
}

/** Короткое имя семейства в строке: «П1 и П2», «тотал геймов». */
export function familyShort(family: MarketFamily): string {
  return tr(`analysis.marketStatus.short.${family}`);
}

/** Список рынков экспресса текстом: «П1 и П2, фора ±1.5 по сетам». */
export function expressListText(map: MarketStatusMap): string {
  return expressFamilies(map).map(familyShort).join(', ');
}

/** Какие линии у семейства: «2.5; до 3 побед — 3.5 и 4.5». */
export function familyLines(family: MarketFamily): string {
  return tr(`analysis.marketStatus.lines.${family}`);
}

export { familyTitle, statusChipLabel } from './labels';
export { statusMap, type MarketStatusMap } from './map';
