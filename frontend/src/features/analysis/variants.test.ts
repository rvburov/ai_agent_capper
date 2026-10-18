import { describe, expect, it } from 'vitest';

import { addToSlip, removeFromSlip, slipNumbers, type SlipItem } from './ownBet';
import { variantOut } from './testData';
import type { AnalysisBet } from './types';
import { savedBetOf, singleRangeText, variantNoValue, variantTitle, variantWhy } from './variants';

// Р29: своя ставка (один рынок на матч, итоговый кэф, вероятность и валуй) и варианты ставки.

function item(over: Partial<SlipItem>): SlipItem {
  return {
    predictionId: 1,
    matchId: 91,
    market: 'ML',
    selection: 1,
    odds: 1.3,
    p: 0.99,
    name: 'Синнер П1',
    match: 'Синнер — Руне',
    pPush: 0,
    model: 'ok',
    status: 'express',
    confidence: 'high',
    ...over,
  };
}

describe('своя ставка', () => {
  it('один рынок на матч: второй рынок того же матча заменяет первый на его месте', () => {
    const sinner = item({});
    const djokovic = item({ predictionId: 7, matchId: 92, name: 'Джокович П1', odds: 1.45, p: 0.904 });
    let change = addToSlip([], sinner);
    expect(change).toEqual({ slip: [sinner], replaced: null });
    change = addToSlip(change.slip, djokovic);
    expect(change.slip.map((x) => x.predictionId)).toEqual([1, 7]);
    const rune = item({ predictionId: 2, selection: 2, name: 'Руне П2', odds: 3.6, p: 0.01 });
    change = addToSlip(change.slip, rune);
    expect(change.replaced).toBe(sinner);
    expect(change.slip.map((x) => x.predictionId)).toEqual([2, 7]);
    // тот же исход еще раз — без изменений
    expect(addToSlip(change.slip, rune)).toEqual({ slip: change.slip, replaced: null });
    expect(removeFromSlip(change.slip, 2).map((x) => x.predictionId)).toEqual([7]);
  });

  it('итоговый кэф как у сервера, вероятность — произведение, валуй — p × кэф − 1', () => {
    const legs = [item({}), item({ predictionId: 7, matchId: 92, odds: 1.45, p: 0.904 })];
    const nums = slipNumbers(legs);
    expect(nums.total).toBe(1.885);
    expect(nums.p).toBeCloseTo(0.89496, 5);
    expect(nums.ev).toBeCloseTo(0.89496 * 1.885 - 1, 6);
    // кэфы при ставке — свои: 1.15 × 1.65 = 1.8975 → 1.898 (половина вверх, без ошибки float)
    expect(slipNumbers(legs, [1.15, 1.65]).total).toBe(1.898);
    expect(slipNumbers([item({ odds: 3.6, p: 0.01 })]).ev).toBeCloseTo(-0.964, 6);
  });

  it('целая линия: возврат идет с кэфом 1 — валуй Π(pᵢ·кэфᵢ + P(возврат)ᵢ) − 1', () => {
    const total = item({ predictionId: 3, market: 'GTOT_22', selection: 2, odds: 2.05, p: 0.46, pPush: 0.08 });
    // ординар: 0.46 × 2.05 + 0.08 − 1
    expect(slipNumbers([total]).ev).toBeCloseTo(0.46 * 2.05 + 0.08 - 1, 6);
    // экспресс с П1 Джоковича: (0.46 × 2.05 + 0.08) × (0.904 × 1.45) − 1
    const legs = [total, item({ predictionId: 7, matchId: 92, odds: 1.45, p: 0.904 })];
    const nums = slipNumbers(legs);
    expect(nums.p).toBeCloseTo(0.46 * 0.904, 6);
    expect(nums.ev).toBeCloseTo((0.46 * 2.05 + 0.08) * (0.904 * 1.45) - 1, 6);
    // кэфы при ставке — свои
    expect(slipNumbers(legs, [2.1, 1.4]).ev).toBeCloseTo((0.46 * 2.1 + 0.08) * (0.904 * 1.4) - 1, 6);
  });
});

describe('варианты ставки', () => {
  it('заголовок карточки по коду; «надежнее» совпал с лучшим валуем — свой', () => {
    expect(variantTitle({ code: 'strategy', also: [] })).toBe('strategy');
    expect(variantTitle({ code: 'safer', also: [] })).toBe('safer');
    expect(variantTitle({ code: 'safer', also: ['value'] })).toBe('saferValue');
    expect(variantTitle({ code: 'value', also: [] })).toBe('value');
    expect(variantTitle({ code: 'best_express', also: [] })).toBe('best');
  });

  it('«Почему» — числа причины в формате экрана; совпадение с лучшим валуем — дописано', () => {
    expect(variantWhy(variantOut(), '')).toBe('Самая высокая вероятность среди рынков с кэфом от 1.30 и валуем от нуля');
    expect(variantWhy(variantOut({ code: 'value', why_key: 'analysis.variants.why.value', why_params: { min_p: '0.5' } }), '')).toMatch(
      /^Наибольший перевес среди исходов с вероятностью от 50\s?%$/,
    );
    expect(variantWhy(variantOut({ also: ['value'] }), '')).toMatch(/\. Он же дает наибольший перевес$/);
    expect(
      variantWhy(variantOut({ code: 'best_express', why_key: 'analysis.variants.why.best_express', why_params: { max_pct: '0.015' } }), ''),
    ).toMatch(/не больше 1,5\s?% банка$/);
    expect(variantWhy(variantOut({ why_key: 'analysis.variants.why.unknown' }), 'запасной')).toBe('запасной');
  });

  it('валуя нет — по предупреждению сервера или по валую', () => {
    expect(variantNoValue(variantOut())).toBe(false);
    expect(variantNoValue(variantOut({ warnings: ['no_value'] }))).toBe(true);
    expect(variantNoValue(variantOut({ value: -0.01 }))).toBe(true);
  });

  it('вариант сохранен — ставка того же вида с теми же исходами', () => {
    const bet = (kind: AnalysisBet['kind'], ids: number[]): AnalysisBet => ({
      id: ids[0] ?? 0,
      kind,
      stake: '720.00',
      currency: 'RUB',
      total_odds: '1.300',
      bookmaker: 'Fonbet',
      legs: ids.map((id) => ({ prediction_id: id, match_id: 91, market: 'ML', selection: 1, odds_taken: '1.30' })),
    });
    const bets = [bet('own', [1]), bet('strategy', [7, 1])];
    expect(savedBetOf([1], 'single', bets)).toBeNull();
    expect(savedBetOf([1], 'own', bets)?.kind).toBe('own');
    expect(savedBetOf([1, 7], 'strategy', bets)?.id).toBe(7);
    expect(savedBetOf([1, 8], 'strategy', bets)).toBeNull();
  });

  it('диапазон таблицы ординаров: открытые края — «до» и «от»', () => {
    expect(singleRangeText('1.01', '1.60')).toBe('до 1.60');
    expect(singleRangeText('1.61', '2.20')).toBe('1.61–2.20');
    expect(singleRangeText('2.21', '50')).toBe('от 2.21');
  });
});
