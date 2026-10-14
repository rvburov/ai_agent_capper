import { describe, expect, it } from 'vitest';

import { strategyV3 } from '../analysis/testData';
import { parseMove, ruleActing, stakeRows, valueRows } from './display';
import type { Adaptation } from './types';

function rule(over: Partial<Adaptation> & Pick<Adaptation, 'key'>): Adaptation {
  return { enabled: true, active: false, met: false, params: {}, ...over };
}

describe('Банк: движение', () => {
  it('пополнение и вывод — больше нуля, сумма строкой Decimal', () => {
    expect(parseMove('deposit', '5 000')).toEqual({ amount: '5000.00' });
    expect(parseMove('withdrawal', '477,14')).toEqual({ amount: '477.14' });
    expect(parseMove('deposit', '-500')).toEqual({ error: 'positive' });
    expect(parseMove('deposit', '0')).toEqual({ error: 'positive' });
    expect(parseMove('deposit', '  ')).toEqual({ error: 'empty' });
    expect(parseMove('deposit', '20000000000')).toEqual({ error: 'tooBig' });
  });

  it('корректировка — со знаком, не ноль; минус любым тире', () => {
    expect(parseMove('correction', '−500')).toEqual({ amount: '-500.00' });
    expect(parseMove('correction', '-1 250,5')).toEqual({ amount: '-1250.50' });
    expect(parseMove('correction', '+300')).toEqual({ amount: '300.00' });
    expect(parseMove('correction', '0,00')).toEqual({ error: 'zero' });
  });
});

describe('Банк: правила стратегии', () => {
  it('ставка по итоговому кэфу: процент, сумма сейчас вниз до шага, диапазон экспресса из 3', () => {
    const rows = stakeRows(strategyV3().params, 48_000, 'RUB');
    expect(rows.map((r) => [r.low, r.high, r.pct, r.triple, r.stake])).toEqual([
      ['1.28', '1.70', 0.0275, false, 1320],
      ['1.71', '2.20', 0.0225, false, 1080],
      ['2.21', '3.24', 0.0175, false, 840],
      ['3.25', '4.10', 0.0175, true, 840],
    ]);
    expect(stakeRows(strategyV3().params, null, 'RUB')[0]?.stake).toBeNull();
  });

  it('поправка на валуй: пороги перевеса сверху вниз', () => {
    expect(valueRows(strategyV3().params)).toEqual([
      { tier: 'strong', from: 15, to: null, add: 0.005 },
      { tier: 'good', from: 10, to: 14, add: 0.0025 },
      { tier: 'small', from: 5, to: 9, add: 0 },
      { tier: 'none', from: null, to: 5, add: -0.0025 },
    ]);
  });
});

describe('Банк: адаптации', () => {
  it('действует — по active и met с сервера, браузер числа банка не сравнивает', () => {
    expect(ruleActing(rule({ key: 'dd10', active: true, met: true }))).toBe(true);
    // при −25% сервер отмечает active только у −20%, но порог −10% тоже пройден (met)
    expect(ruleActing(rule({ key: 'dd10', active: false, met: true }))).toBe(true);
    expect(ruleActing(rule({ key: 'dd10', active: false, met: false }))).toBe(false);
    // выключенное правило не действует, даже если условие выполнено
    expect(ruleActing(rule({ key: 'up15', enabled: false, active: false, met: true }))).toBe(false);
  });
});
