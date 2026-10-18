import i18n from '../../i18n';
import { formatOdds, formatProb } from '../../lib/format';
import { keyText } from './codes';
import { formatShare } from './markets';
import type { AnalysisBet, BetKind, Variant } from './types';

// Варианты ставки итога анализа (Р29): какие считает и отбирает сервер, здесь — только как
// их показать и с каким видом ставки сохранить.

export type VariantTitle = 'strategy' | 'safer' | 'saferValue' | 'value' | 'best';

/** Заголовок карточки: «Ординар · надежнее», «… надежнее и лучший валуй», «Экспресс из лучших». */
export function variantTitle(variant: Pick<Variant, 'code' | 'also'>): VariantTitle {
  switch (variant.code) {
    case 'strategy':
      return 'strategy';
    case 'safer':
      return variant.also.includes('value') ? 'saferValue' : 'safer';
    case 'value':
      return 'value';
    default:
      return 'best';
  }
}

/** Валуя нет: сервер так и сказал (no_value) или валуй варианта ниже нуля. */
export function variantNoValue(variant: Pick<Variant, 'value' | 'warnings'>): boolean {
  return variant.warnings.includes('no_value') || variant.value < 0;
}

function sameLegs(a: readonly (number | null)[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((x) => x !== null && set.has(x));
}

/** Ставка анализа с теми же исходами и видом — вариант уже сохранен. */
export function savedBetOf(
  predictionIds: readonly number[],
  kind: BetKind,
  bets: readonly AnalysisBet[],
): AnalysisBet | null {
  return (
    bets.find(
      (bet) =>
        bet.kind === kind &&
        sameLegs(
          bet.legs.map((leg) => leg.prediction_id),
          predictionIds,
        ),
    ) ?? null
  );
}

/** Диапазон кэфа таблицы ординаров: «до 1.60», «1.61–2.20», «от 2.21» (края 1.01 и 50 — открытые). */
export function singleRangeText(low: string | number, high: string | number): string {
  const lo = Number(low);
  const hi = Number(high);
  if (lo <= 1.01) return i18n.t('analysis.calc.rangeTo', { high: formatOdds(hi) });
  if (hi >= 50) return i18n.t('analysis.calc.rangeFrom', { low: formatOdds(lo) });
  return i18n.t('analysis.calc.rangeBetween', { low: formatOdds(lo), high: formatOdds(hi) });
}

// Числа причины с сервера — строками Decimal: кэф «1.30», вероятность «0.5», доля «0.015»
function whyParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...params };
  if (params.min_odds !== undefined) out.min_odds = formatOdds(params.min_odds);
  if (params.min_p !== undefined) out.min_p = formatProb(Number(params.min_p));
  if (params.max_pct !== undefined) out.max_pct = formatShare(params.max_pct);
  return out;
}

/** «Почему» варианта: причина с сервера; совпал с лучшим валуем — и об этом. */
export function variantWhy(variant: Pick<Variant, 'why_key' | 'why_params' | 'also'>, fallback: string): string {
  const why = keyText(variant.why_key, whyParams(variant.why_params), fallback);
  return variant.also.includes('value') ? `${why}. ${i18n.t('analysis.variants.also.value')}` : why;
}
