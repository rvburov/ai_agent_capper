import type { StrategyParams } from './types';

// Сумма ставки в окнах «Изменить сумму» и «Сохранить ставку»: доля банка, выплата,
// проверки. Рекомендованную сумму считает сервер (StakeOut); здесь — только то, что
// меняется вместе с вводом участника. Деньги — в копейках/центах целыми, без ошибок float.

export interface MoneyRules {
  /** Знаков после запятой у валюты: рубли — 0, доллары и евро — 2. */
  decimals: number;
  /** Округление доли банка (как у стратегии): рубли — до 10, доллары и евро — до 1. */
  roundTo: number;
  /** Минимальная ставка: 50 ₽, $0,50, €0,50. */
  min: number;
}

const DEFAULT_ROUNDING: Record<string, string> = { RUB: '10', USD: '1', EUR: '1' };
const DEFAULT_MIN: Record<string, string> = { RUB: '50', USD: '0.50', EUR: '0.50' };

export function moneyRules(currency: string, params?: Pick<StrategyParams, 'rounding' | 'min_stake'> | null): MoneyRules {
  const roundTo = Number(params?.rounding[currency] ?? DEFAULT_ROUNDING[currency] ?? '1');
  const min = Number(params?.min_stake[currency] ?? DEFAULT_MIN[currency] ?? '0');
  return { decimals: currency === 'RUB' ? 0 : 2, roundTo, min };
}

function cents(value: number, decimals: number): number {
  return Math.round(value * 10 ** decimals);
}

/** Округление суммы до знаков валюты. */
export function roundMoney(value: number, rules: MoneyRules): number {
  return cents(value, rules.decimals) / 10 ** rules.decimals;
}

/** Деление целых с округлением половины вверх (как ROUND_HALF_UP у Decimal), для x ≥ 0. */
function divHalfUp(x: bigint, d: bigint): bigint {
  return (x * 2n + d) / (d * 2n);
}

// Кэфы и суммы — целыми тысячными и копейками: произведение в float дает 1.15 × 1.65 =
// 1.89749… вместо 1.8975, и окно показало бы 1.897, а сервер записал бы 1.898.
const MILLI = 1000n;

/** Итоговый кэф экспресса — произведение кэфов ног, 3 знака с округлением половины вверх (как у сервера). */
export function totalOdds(odds: readonly number[]): number {
  let product = 1n;
  let scale = 1n;
  for (const x of odds) {
    product *= BigInt(Math.round(x * 1000));
    scale *= MILLI;
  }
  return Number(divHalfUp(product * MILLI, scale)) / 1000;
}

/** Выплата при выигрыше: сумма × итоговый кэф, до знаков валюты с округлением половины вверх. */
export function payout(stake: number, total: number, rules: MoneyRules): number {
  const unit = 10 ** rules.decimals;
  const minor = BigInt(Math.round(stake * unit)) * BigInt(Math.round(total * 1000));
  return Number(divHalfUp(minor, MILLI)) / unit;
}

/** Сумма для доли банка: вниз до шага округления стратегии (как у суммы по стратегии). */
export function stakeForShare(bank: number, share: number, rules: MoneyRules): number {
  const raw = bank * share;
  return roundMoney(Math.floor(raw / rules.roundTo + 1e-9) * rules.roundTo, rules);
}

/** Доля банка 0..1. */
export function shareOf(stake: number, bank: number): number {
  return bank > 0 ? stake / bank : 0;
}

export type StakeProblem = 'empty' | 'aboveBank' | 'belowMin' | null;

/** Сумма из поля проверяется так же, как у сервера: больше нуля, не больше банка; минимум стратегии. */
export function stakeProblem(stake: number | null, bank: number, rules: MoneyRules): StakeProblem {
  if (stake === null || !Number.isFinite(stake) || stake <= 0) return 'empty';
  if (bank > 0 && stake > bank) return 'aboveBank';
  if (stake < rules.min) return 'belowMin';
  return null;
}
