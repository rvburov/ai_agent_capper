import { marketSpec } from '../analysis/markets';
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

// ---------- счет по геймам (Р28) ----------

/*
 * Рынки по геймам (фора и тотал) рассчитываются по счету по геймам: «6:4 7:6(5) 6:3», первым —
 * игрок 1, тай-брейк — один гейм. Так же, как parse_sets и исход по геймам на сервере
 * (backend/app/ml/markets.py): при «ровно» на целой линии — возврат (кэф 1,00).
 */

export interface GamesScore {
  /** Сеты: геймы игрока 1 и 2; супер-тай-брейк [10-8] — сет из одного гейма (1:0). */
  sets: { a: number; b: number }[];
  /** Сумма геймов игрока 1 и 2. */
  games: [number, number];
  /** Счет для сервера: «6:4 7:6(5) [10-8]». */
  text: string;
}

// Тай-брейк — «(5)» или полностью «(10-8)»: на сервер уходит очки проигравшего, «7:6(8)»
const SET_GAMES = /^(\[)?(\d{1,2})[:\-\u2013](\d{1,2})(?:\((\d{1,2})(?:[:\-\u2013](\d{1,2}))?\))?(\])?$/;

// Сет доигран: 6:0–6:4, 7:5, 7:6 или затяжной (разница 2 после 6:6); решающий — и 13:12
// (Уимблдон 2019–2021: тай-брейк при 12:12)
function finishedSet(a: number, b: number, last: boolean): boolean {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi === 6) return lo <= 4;
  if (hi === 7) return lo === 5 || lo === 6;
  if (hi === 13 && lo === 12) return last;
  return hi > 7 && hi - lo === 2;
}

/** Очки проигравшего тай-брейк: «(5)» — 5, «(10-8)» — 8; нет тай-брейка — null, не счет — false. */
function tiebreak(first: string | undefined, second: string | undefined): number | null | false {
  if (first === undefined) return null;
  if (second === undefined) return Number(first);
  const [x, y] = [Number(first), Number(second)];
  return Math.max(x, y) >= 7 && Math.abs(x - y) >= 2 ? Math.min(x, y) : false;
}

export type GamesParse = { kind: 'ok'; score: GamesScore } | { kind: 'unfinished' } | { kind: 'invalid' };

/**
 * Счет по геймам из поля (как parse_games сервера, но строже: каждый сет доигран). bestOf —
 * формат матча; не известен — по счету. unfinished — последний сет не доигран или победителя
 * нет (снятие): исход по правилам букмекера.
 */
export function parseGamesScore(text: string, bestOf: number | null | undefined): GamesParse {
  const tokens = text.replace(/,/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 5) return { kind: 'invalid' };
  const sets: GamesScore['sets'] = [];
  const shown: string[] = [];
  let open = false;
  for (const [i, token] of tokens.entries()) {
    const found = SET_GAMES.exec(token);
    if (!found || Boolean(found[1]) !== Boolean(found[6])) return { kind: 'invalid' };
    const a = Number(found[2]);
    const b = Number(found[3]);
    if (a === b) return { kind: 'invalid' };
    if (found[1]) {
      // супер-тай-брейк — последний сет, один гейм
      if (i !== tokens.length - 1 || found[4] !== undefined) return { kind: 'invalid' };
      sets.push(a > b ? { a: 1, b: 0 } : { a: 0, b: 1 });
      shown.push(`[${a}-${b}]`);
      continue;
    }
    const last = i === tokens.length - 1;
    if (!finishedSet(a, b, last)) {
      if (!last || Math.max(a, b) > 6) return { kind: 'invalid' };
      open = true;
    }
    sets.push({ a, b });
    const tb = tiebreak(found[4], found[5]);
    if (tb === false) return { kind: 'invalid' };
    shown.push(`${a}:${b}${tb === null ? '' : `(${tb})`}`);
  }
  const done = open ? sets.slice(0, -1) : sets;
  const wins = [done.filter((x) => x.a > x.b).length, done.filter((x) => x.b > x.a).length];
  const leader = Math.max(wins[0] ?? 0, wins[1] ?? 0);
  const need = bestOf === 5 ? 3 : bestOf === 3 ? 2 : leader >= 3 || sets.length > 3 ? 3 : 2;
  if (leader > need || sets.length > need * 2 - 1) return { kind: 'invalid' };
  // сеты после того, как кто-то уже выиграл матч
  let w1 = 0;
  let w2 = 0;
  for (const [i, x] of done.entries()) {
    if (x.a > x.b) w1 += 1;
    else w2 += 1;
    if ((w1 === need || w2 === need) && i < sets.length - 1) return { kind: 'invalid' };
  }
  if (open || leader < need) return { kind: 'unfinished' };
  const games: [number, number] = [sets.reduce((n, x) => n + x.a, 0), sets.reduce((n, x) => n + x.b, 0)];
  return { kind: 'ok', score: { sets, games, text: shown.join(' ') } };
}

export interface GamesOutcome {
  result: LegResult;
  /** Тотал: всего геймов; фора: разница геймов выбранной стороны. */
  value: number;
  line: number;
}

/** Исход ноги рынка по геймам по счету; не рынок по геймам — null. */
export function gamesOutcome(market: string, selection: number, score: GamesScore): GamesOutcome | null {
  const spec = marketSpec(market);
  if (!spec || spec.line === null || (spec.family !== 'gtot' && spec.family !== 'ghcp')) return null;
  const [a, b] = score.games;
  const cmp = (v: number): LegResult => (v > 0 ? 'win' : v < 0 ? 'loss' : 'void');
  if (spec.family === 'gtot') {
    const total = a + b;
    return { result: cmp(selection === 1 ? total - spec.line : spec.line - total), value: total, line: spec.line };
  }
  const diff = selection === 1 ? a - b : b - a;
  return { result: cmp(diff + spec.line), value: diff, line: spec.line };
}

export type GamesCheck =
  | { kind: 'empty' }
  | { kind: 'typing' }
  | { kind: 'invalid' }
  | { kind: 'unfinished' }
  | { kind: 'ok'; key: string; outcome: GamesOutcome };

/** Проверка счета по геймам в окне расчета: как checkScore, но исход считает код по линии. */
export function checkGamesScore(text: string, market: string, selection: number, bestOf: number | null | undefined): GamesCheck {
  const value = text.trim();
  if (!value) return { kind: 'empty' };
  const parsed = parseGamesScore(value, bestOf);
  if (parsed.kind === 'ok') {
    const outcome = gamesOutcome(market, selection, parsed.score);
    if (outcome) return { kind: 'ok', key: parsed.score.text, outcome };
    return { kind: 'invalid' };
  }
  if (parsed.kind === 'unfinished') return { kind: 'unfinished' };
  // меньше двух сетов цифрами — еще вводят
  return value.replace(/\D/g, '').length >= 4 ? { kind: 'invalid' } : { kind: 'typing' };
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
