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

/** Итоговый кэф экспресса — произведение кэфов ног (3 знака, как у сервера). */
export function totalOdds(odds: readonly number[]): number {
  const product = odds.reduce((acc, x) => acc * x, 1);
  return Math.round(product * 1000) / 1000;
}

/** Выплата при выигрыше: сумма × итоговый кэф, до знаков валюты. */
export function payout(stake: number, total: number, rules: MoneyRules): number {
  return roundMoney(stake * total, rules);
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
