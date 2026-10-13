// Деньги из API приходят строкой Decimal («1234.50»). Сложение и умножение на кэф — в копейках
// и тысячных целыми (BigInt): в float 0.1 + 0.2 и 1.15 × 1.65 дают не то, что запишет сервер.

const HUNDRED = 100n;
const MILLI = 1000n;

function digits(value: string, scale: number): bigint | null {
  const text = value.trim();
  const found = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!found) return null;
  const [, sign = '', whole = '0', frac = ''] = found;
  const head = frac.slice(0, scale).padEnd(scale, '0');
  // лишние знаки — половина вверх (у денег сервера их нет, это страховка)
  let n = BigInt(whole) * 10n ** BigInt(scale) + BigInt(head || '0');
  const rest = frac.slice(scale);
  if (rest && Number(rest[0]) >= 5) n += 1n;
  return sign === '-' ? -n : n;
}

/** Сумма в копейках (центах): «1234.5» → 123450n; не число — null. */
export function toCents(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return digits(typeof value === 'number' ? value.toFixed(2) : value, 2);
}

/** Кэф в тысячных: «1.885» → 1885n. */
export function toMilli(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return digits(typeof value === 'number' ? value.toFixed(3) : value, 3);
}

/** Копейки → строка Decimal «1234.50» (для formatMoney и API). */
export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const text = `${abs / HUNDRED}.${String(abs % HUNDRED).padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** Деление неотрицательного на положительное с округлением половины вверх (ROUND_HALF_UP). */
function divHalfUp(x: bigint, d: bigint): bigint {
  if (x < 0n) return -divHalfUp(-x, d);
  return (x * 2n + d) / (d * 2n);
}

/** Сумма сумм: пустой список — «0.00». */
export function sumMoney(values: readonly (string | null | undefined)[]): string {
  let total = 0n;
  for (const value of values) total += toCents(value) ?? 0n;
  return fromCents(total);
}

/** Выплата: сумма × кэф до копеек, половина вверх (как money() сервиса ставок). */
export function payoutOf(stake: string, odds: string | number): string | null {
  const s = toCents(stake);
  const k = toMilli(odds);
  if (s === null || k === null) return null;
  return fromCents(divHalfUp(s * k, MILLI));
}

/** Произведение кэфов до 0.001, половина вверх (кэф расчета с возвратом ноги, как у сервера). */
export function productOdds(odds: readonly string[]): string | null {
  let product = 1n;
  let scale = 1n;
  for (const value of odds) {
    const k = toMilli(value);
    if (k === null) return null;
    product *= k;
    scale *= MILLI;
  }
  const milli = divHalfUp(product * MILLI, scale);
  return `${milli / MILLI}.${String(milli % MILLI).padStart(3, '0')}`;
}

/** Разность сумм a − b строкой Decimal. */
export function subMoney(a: string, b: string): string {
  return fromCents((toCents(a) ?? 0n) - (toCents(b) ?? 0n));
}

/** Сумма двух сумм строкой Decimal. */
export function addMoney(a: string, b: string): string {
  return fromCents((toCents(a) ?? 0n) + (toCents(b) ?? 0n));
}
