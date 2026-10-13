import { describe, expect, it } from 'vitest';

import { strategyV3 } from '../analysis/testData';
import { bankOut } from '../analysis/testData';
import { conditionMet, parseMove, stakeRows, valueRows } from './display';
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
  it('включенное правило — как ответил сервер', () => {
    expect(conditionMet(rule({ key: 'dd10', active: true }), bankOut())).toBe(true);
    expect(conditionMet(rule({ key: 'dd10', active: false }), bankOut({ drawdown: '0.5000' }))).toBe(false);
  });

  it('выключенное — сравнение чисел банка с порогом правила', () => {
    const up15 = rule({ key: 'up15', enabled: false, params: { bank_up: '0.15', min_winrate: '0.60', max_pct: '0.04' } });
    expect(conditionMet(up15, bankOut({ growth: '0.2000', winrate: '0.6500' }))).toBe(true);
    expect(conditionMet(up15, bankOut({ growth: '0.2000', winrate: '0.5000' }))).toBe(false);
    expect(conditionMet(up15, bankOut({ growth: null, winrate: '0.7000' }))).toBe(false);
    const weekWin = rule({ key: 'week_win', enabled: false, params: { win: '0.10', add: '0.005' } });
    expect(conditionMet(weekWin, bankOut({ week_change: '0.1000' }))).toBe(true);
    expect(conditionMet(weekWin, bankOut({ week_change: '0.0999' }))).toBe(false);
    const dd20 = rule({ key: 'dd20', enabled: false, params: { from: '0.20', max_pct: '0.015' } });
    expect(conditionMet(dd20, bankOut({ drawdown: '0.2100' }))).toBe(true);
    const weekLoss = rule({ key: 'week_loss', enabled: false, params: { loss: '-0.05', max_pct: '0.02' } });
    expect(conditionMet(weekLoss, bankOut({ week_change: '-0.0600' }))).toBe(true);
  });
});
