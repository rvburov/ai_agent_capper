import { describe, expect, it } from 'vitest';

import {
  amountInput,
  checkBudget,
  checkLimit,
  formatLimitUsd,
  limitDraftOf,
  limitPatch,
  limitShort,
  limitText,
  parseAmount,
  R13_LIMIT,
  sameLimit,
} from './limits';

describe('стартовый лимит приглашения', () => {
  it('поля — по лимиту по умолчанию из API (Р13: $10 в месяц, 3 анализа в день, $1 на анализ)', () => {
    expect(checkLimit(limitDraftOf(R13_LIMIT))).toEqual({
      limit: { monthly_usd: '10.00', daily_analyses: 3, per_analysis_usd: '1.00' },
      errors: {},
    });
    expect(limitDraftOf({ monthly_usd: 12.5, daily_analyses: 4, per_analysis_usd: 0.5 })).toEqual({
      monthly: '12,50',
      daily: '4',
      perAnalysis: '0,50',
    });
    expect(limitDraftOf(null)).toEqual({ monthly: '', daily: '', perAnalysis: '' });
    // неразрывный пробел в разрядах разбирается обратно
    expect(parseAmount(amountInput(1500))).toBe(1500);
  });

  it('суммы принимают запятую и пробелы, на сервер уходят строкой с двумя знаками', () => {
    expect(parseAmount('12,5')).toBe(12.5);
    expect(parseAmount(' 1 000 ')).toBe(1000);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('-1')).toBeNull();
    expect(checkLimit({ monthly: '12,345', daily: '5', perAnalysis: '0,5' }).limit).toEqual({
      monthly_usd: '12.35',
      daily_analyses: 5,
      per_analysis_usd: '0.50',
    });
  });

  it('границы как в макете', () => {
    expect(checkLimit({ monthly: '0,5', daily: '3', perAnalysis: '1' }).errors).toEqual({ monthly: true });
    expect(checkLimit({ monthly: '501', daily: '3', perAnalysis: '1' }).errors.monthly).toBe(true);
    expect(checkLimit({ monthly: '10', daily: '0', perAnalysis: '1' }).errors).toEqual({ daily: true });
    expect(checkLimit({ monthly: '10', daily: '2.5', perAnalysis: '1' }).errors).toEqual({ daily: true });
    expect(checkLimit({ monthly: '10', daily: '31', perAnalysis: '1' }).errors).toEqual({ daily: true });
    expect(checkLimit({ monthly: '10', daily: '3', perAnalysis: '0,05' }).errors).toEqual({ perAnalysis: true });
    // на один анализ — не больше месячного лимита
    expect(checkLimit({ monthly: '5', daily: '3', perAnalysis: '6' }).errors).toEqual({ perAnalysis: true });
    expect(checkLimit({ monthly: '', daily: '', perAnalysis: '' }).limit).toBeNull();
  });

  it('подписи лимита: целые доллары без центов', () => {
    expect(formatLimitUsd(10)).toBe('$10');
    expect(formatLimitUsd('1.50')).toBe('$1,50');
    const limit = { monthly_usd: 8, daily_analyses: 5, per_analysis_usd: 1 };
    expect(limitText(limit)).toBe('$8 в месяц · 5\u00a0анализов в день · $1 на анализ');
    expect(limitText({ ...limit, daily_analyses: 3 })).toBe('$8 в месяц · 3\u00a0анализа в день · $1 на анализ');
    expect(limitText({ ...limit, daily_analyses: 1 })).toBe('$8 в месяц · 1\u00a0анализ в день · $1 на анализ');
    expect(limitShort(limit)).toBe('$8 · 5 в день · $1');
  });
});

describe('лимит участника и бюджет', () => {
  const before = { monthly_usd: 10, daily_analyses: 3, per_analysis_usd: 1, paused: false };

  it('правка лимита: уходят только измененные поля, без изменений — null', () => {
    expect(limitPatch(before, { monthly_usd: '10.00', daily_analyses: 3, per_analysis_usd: '1.00' }, false)).toBeNull();
    expect(limitPatch(before, { monthly_usd: '15.00', daily_analyses: 3, per_analysis_usd: '1.00' }, true)).toEqual({
      monthly_usd: '15.00',
      paused: true,
    });
    expect(limitPatch(before, { monthly_usd: '10.00', daily_analyses: 5, per_analysis_usd: '0.50' }, false)).toEqual({
      daily_analyses: 5,
      per_analysis_usd: '0.50',
    });
    expect(sameLimit(R13_LIMIT, { monthly_usd: '10.00', daily_analyses: 3, per_analysis_usd: '1' })).toBe(true);
    expect(sameLimit(R13_LIMIT, { monthly_usd: 12, daily_analyses: 3, per_analysis_usd: 1 })).toBe(false);
  });

  it('бюджет: от $1 до $5000 и не меньше потраченного, если сумма меняется', () => {
    const state = { spent: 41.2, current: 60 };
    expect(checkBudget('70', state)).toEqual({ value: '70.00', problem: null });
    expect(checkBudget('0,5', state)).toEqual({ value: null, problem: 'range' });
    expect(checkBudget('5000,01', state)).toEqual({ value: null, problem: 'range' });
    expect(checkBudget('5000', state).problem).toBeNull();
    expect(checkBudget('abc', state).problem).toBe('range');
    expect(checkBudget('40', state)).toEqual({ value: null, problem: 'belowSpent' });
    // тот же бюджет можно оставить, даже если потрачено больше (сервер так же)
    expect(checkBudget('60', { spent: 65, current: 60 })).toEqual({ value: '60.00', problem: null });
  });
});
