import { formatNumber, stepDigits } from '../../lib/format';
import type { AxisTick } from './geometry';

// Сколько знаков нужно значению: 1,85 — 2, 48 000 — 0; не больше max
function valueDigits(value: number, max = 2): number {
  for (let digits = 0; digits < max; digits++) {
    if (Math.abs(Number(value.toFixed(digits)) - value) < 1e-9 * Math.max(1, Math.abs(value))) return digits;
  }
  return max;
}

/**
 * Формат графика по умолчанию: подписи делений — с точностью шага (кэфы 1,8…2,1 — «1,8»,
 * «1,9», а не «2», «2»), значение в подсказке — как есть, до двух знаков.
 */
export function defaultValueFormat(value: number, axis?: AxisTick): string {
  return formatNumber(value, axis ? stepDigits(axis.step) : valueDigits(value));
}
