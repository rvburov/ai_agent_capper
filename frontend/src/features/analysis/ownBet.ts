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
  /** Итоговая вероятность исхода (после поправки Claude). */
  p: number;
  name: string;
  match: string;
  /** Рынок на проверке (Р28, признак сервера `MarketRow.suspended`): в варианты не идет. */
  suspended: boolean;
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
    name,
    match: title,
    suspended: row.suspended,
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
  /** Вероятность по модели — произведение вероятностей событий. */
  p: number;
  /** Валуй по модели: p × кэф − 1. */
  ev: number;
}

/** Итоговый кэф, вероятность и валуй своей ставки; taken — кэфы при ставке по событиям. */
export function slipNumbers(items: readonly Pick<SlipItem, 'p' | 'odds'>[], taken?: readonly number[]): SlipNumbers {
  const odds = taken ?? items.map((x) => x.odds);
  const total = totalOdds(odds);
  const p = items.reduce((acc, x) => acc * x.p, 1);
  return { total, p, ev: p * total - 1 };
}
