import type { MarketStatusKind } from '../markets/types';
import { totalOdds } from './stake';
import type { Market, MarketRow, MatchResult } from './types';

// Своя ставка (Р29): любой исход из таблицы анализа, один рынок на матч. Второй рынок того же
// матча заменяет первый. Сумму стратегия не считает; вероятность и валуй — по модели (те же
// числа, что в таблице: произведение вероятностей событий).

export interface SlipItem {
  predictionId: number;
  matchId: number;
  market: Market;
  selection: number;
  /** Кэф из анализа. */
  odds: number;
  /** Итоговая вероятность исхода (после поправки Claude); у рынков по геймам пока нет — null. */
  p: number | null;
  /** Вероятность возврата на целой линии (Р28). */
  pPush: number;
  name: string;
  match: string;
  /** Статус рынка (Р28): на проверке и «для сравнения» в варианты не идут. */
  status: MarketStatusKind;
  confidence: MatchResult['confidence'];
}

/** Исход таблицы можно взять в свою ставку: есть прогноз и кэф. */
export function slipEligible(row: MarketRow): boolean {
  return row.prediction_id !== null && row.odds !== null;
}

export function slipItem(row: MarketRow, match: MatchResult, name: string, title: string): SlipItem | null {
  if (row.prediction_id === null || row.odds === null) return null;
  return {
    predictionId: row.prediction_id,
    matchId: match.match_id,
    market: row.market,
    selection: row.selection,
    odds: Number(row.odds),
    p: row.p_final,
    pPush: row.p_push,
    name,
    match: title,
    status: row.status,
    confidence: match.confidence,
  };
}

export interface SlipChange {
  slip: SlipItem[];
  /** Исход того же матча, который заменен новым (подсказка «Один рынок на матч»). */
  replaced: SlipItem | null;
}

/** Добавить исход: уже есть — без изменений; есть другой рынок того же матча — замена на месте. */
export function addToSlip(slip: readonly SlipItem[], item: SlipItem): SlipChange {
  if (slip.some((x) => x.predictionId === item.predictionId)) return { slip: [...slip], replaced: null };
  const i = slip.findIndex((x) => x.matchId === item.matchId);
  if (i < 0) return { slip: [...slip, item], replaced: null };
  const next = [...slip];
  const replaced = next[i] ?? null;
  next[i] = item;
  return { slip: next, replaced };
}

export function removeFromSlip(slip: readonly SlipItem[], predictionId: number): SlipItem[] {
  return slip.filter((x) => x.predictionId !== predictionId);
}

export interface SlipNumbers {
  /** Итоговый кэф по кэфам при ставке (3 знака, как у сервера). */
  total: number;
  /** Вероятность по модели — произведение вероятностей событий; у события нет оценки — null. */
  p: number | null;
  /** Валуй по модели: p × кэф − 1, у ординара на целой линии + P(возврат). */
  ev: number | null;
}

/** Вероятность своей ставки по модели: произведение; у события нет оценки — null. */
export function slipProb(items: readonly Pick<SlipItem, 'p'>[]): number | null {
  let p = 1;
  for (const x of items) {
    if (x.p === null) return null;
    p *= x.p;
  }
  return p;
}

/** Итоговый кэф, вероятность и валуй своей ставки; taken — кэфы при ставке по событиям. */
export function slipNumbers(items: readonly Pick<SlipItem, 'p' | 'odds' | 'pPush'>[], taken?: readonly number[]): SlipNumbers {
  const odds = taken ?? items.map((x) => x.odds);
  const total = totalOdds(odds);
  const p = slipProb(items);
  if (p === null) return { total, p, ev: null };
  // У ординара на целой линии «ровно» — возврат: валуй = p·кэф + P(возврат) − 1
  const push = items.length === 1 ? (items[0]?.pPush ?? 0) : 0;
  return { total, p, ev: p * total + push - 1 };
}
