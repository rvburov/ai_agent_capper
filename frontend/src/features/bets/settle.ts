import { addMoney, fromCents, payoutOf, productOdds, toCents, toMilli } from './money';
import type { BetItem, BetStatus, LegResult } from './types';

/*
 * Окно «Результат ставки»: что станет с деньгами, пока участник отмечает исходы. Считается так
 * же, как сервис расчета (backend/app/services/settlement.py): есть проигрыш — проигрыш, все
 * возвраты — возврат, иначе выигрыш с кэфом расчета (возврат ноги — кэф 1.00); выплата — сумма ×
 * кэф до копеек, половина вверх. Это только подсказка: записывает расчет сервер.
 */

export interface SettlePreview {
  status: Exclude<BetStatus, 'open'>;
  /** Выплата строкой Decimal; у проигрыша — «0.00». */
  payout: string;
  profit: string;
  /** Кэф расчета выигрыша, если он отличается от итогового (была нога-возврат). */
  recalculated: string | null;
}

/** Итог ставки по исходам ног; не все отмечены — null (кроме уже проигранной ставки). */
export function settlePreview(bet: Pick<BetItem, 'stake' | 'total_odds' | 'legs'>, results: readonly (LegResult | null)[]): SettlePreview | null {
  const stake = bet.stake;
  if (results.includes('loss')) {
    return { status: 'lost', payout: '0.00', profit: fromCents(-(toCents(stake) ?? 0n)), recalculated: null };
  }
  if (results.some((r) => r === null) || results.length !== bet.legs.length) return null;
  if (results.every((r) => r === 'void')) return { status: 'void', payout: fromCents(toCents(stake) ?? 0n), profit: '0.00', recalculated: null };
  const hasVoid = results.includes('void');
  const odds = hasVoid
    ? productOdds(bet.legs.filter((_, i) => results[i] === 'win').map((leg) => leg.odds_taken))
    : bet.total_odds;
  if (odds === null) return null;
  const payout = payoutOf(stake, odds);
  if (payout === null) return null;
  const profit = fromCents((toCents(payout) ?? 0n) - (toCents(stake) ?? 0n));
  const recalculated = hasVoid && toMilli(odds) !== toMilli(bet.total_odds) ? odds : null;
  return { status: 'won', payout, profit, recalculated };
}

/** Банк после расчета: капитал (баланс + в игре) + прибыль ставки. */
export function bankAfter(equity: string, profit: string): string {
  return addMoney(equity, profit);
}

// ---------- счет по сетам ----------

// Как _SET_COUNT в backend/app/ml/sets.py: «2:1», «2-1», «2–1», «2.1», «2 1», «21»
const SET_COUNT = /^([0-3])\s*[:\-–.\s]?\s*([0-3])$/;

/** Счет из поля → ключ score_outcomes («2:1», первым — игрок 1); не похоже на счет — null. */
export function scoreKey(text: string): string | null {
  const found = SET_COUNT.exec(text.trim());
  return found ? `${found[1]}:${found[2]}` : null;
}

export type ScoreCheck =
  | { kind: 'empty' }
  | { kind: 'typing' }
  | { kind: 'invalid' }
  | { kind: 'ok'; key: string; result: LegResult };

/**
 * Проверка счета по таблице сервера (legs[].score_outcomes): исход по счету не считается на
 * клиенте, правило фор — только у сервера. Пока введено меньше двух цифр — еще вводят.
 */
export function checkScore(text: string, outcomes: Readonly<Record<string, LegResult>> | null): ScoreCheck {
  const value = text.trim();
  if (!value) return { kind: 'empty' };
  const key = scoreKey(value);
  if (key && outcomes && key in outcomes) {
    const result = outcomes[key];
    if (result) return { kind: 'ok', key, result };
  }
  return value.replace(/\D/g, '').length >= 2 ? { kind: 'invalid' } : { kind: 'typing' };
}

/** Полные счета формата для подсказки: «2:0, 2:1, 1:2, 0:2». */
export function scoreExamples(outcomes: Readonly<Record<string, LegResult>> | null): string[] {
  return outcomes ? Object.keys(outcomes) : [];
}

// ---------- закрывающий кэф и CLV ----------

const POWER_TOLERANCE = 1e-12;
const MAX_ITERATIONS = 200;

/**
 * Вероятность своего исхода без маржи степенным методом по двум кэфам закрытия — как
 * devig_pair в backend/app/ml/market.py: Σ(1/o)^k = 1, бисекция по k.
 */
export function devigPower(own: number, opposite: number): number {
  const a = 1 / own;
  const b = 1 / opposite;
  const excess = (k: number) => a ** k + b ** k - 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < MAX_ITERATIONS && excess(high) > 0; i += 1) {
    low = high;
    high *= 2;
  }
  for (let i = 0; i < MAX_ITERATIONS && high - low > POWER_TOLERANCE; i += 1) {
    const middle = (low + high) / 2;
    if (excess(middle) > 0) low = middle;
    else high = middle;
  }
  const k = (low + high) / 2;
  const pa = a ** k;
  return pa / (pa + b ** k);
}

/** CLV ноги на лету: кэф ÷ закрывающий − 1; при двух сторонах — еще без маржи (кэф × q − 1). */
export function clvPreview(odds: number, closing: number, opposite: number | null): { clv: number; fair: number | null } {
  const clv = odds / closing - 1;
  const fair = opposite === null ? null : odds * devigPower(closing, opposite) - 1;
  return { clv, fair };
}
