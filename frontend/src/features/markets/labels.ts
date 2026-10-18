import i18n from '../../i18n';
import type { MarketFamily } from '../analysis/markets';
import type { MarketStatusKind } from './types';

// Короткие подписи рынков (Р28): название семейства и метка статуса. Отдельно от status.ts —
// их берет и «Администрирование» (тексты экрана близки к бюджету JS).

type Translate = (key: string, options?: Record<string, unknown>) => string;
const tr: Translate = (key, options) => (i18n.t as unknown as Translate)(key, options);

/** Название семейства в списках рынков: «Фора по сетам ±2.5», «Тотал геймов». */
export function familyTitle(family: MarketFamily): string {
  return tr(`analysis.marketName.${family}`);
}

/** Короткая метка статуса в списках рынков: «в экспрессе», «на проверке», «для сравнения». */
export function statusChipLabel(status: MarketStatusKind): string {
  return tr(`analysis.marketChip.${status}`);
}
