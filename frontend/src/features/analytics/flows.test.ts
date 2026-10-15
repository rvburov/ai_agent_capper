import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import i18n from '../../i18n';
import { periodStart } from './display';
import { bankSteps, flowLabel, flowMarks, flowsText, type BankFlow } from './flows';
import { seriesOut, seriesWithFlows } from './testData';

const t = i18n.t.bind(i18n);
const norm = (text: string) => text.replace(/\s+/g, ' ');

// Дата без года — только в текущем году: часы зафиксированы
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

describe('«Банк по дням» по В7: ступенька «вложено» и движения банка', () => {
  it('«вложено» по дням и движения — как прислал сервер', () => {
    const series = seriesWithFlows();
    const steps = bankSteps(series, periodStart(series));
    expect(steps.invested).toEqual([40_000, 60_000, 60_000, 60_000]);
    expect(steps.flows).toEqual([{ day: '2026-09-14', kind: 'deposit', amount: '20000.00' }]);
    expect(steps.flowSum).toBe('20000.00');
  });

  it('ответ без полей В7 — «вложено» ровно на старте периода, движений нет', () => {
    const series = seriesOut();
    const steps = bankSteps(series, periodStart(series));
    expect(steps.invested).toEqual([48_000, 48_000, 48_000, 48_000]);
    expect(steps.flows).toEqual([]);
    expect(steps.flowSum).toBeNull();
  });

  it('нулевая сумма движений — «нет»; у ряда результата ступеньки нет', () => {
    const zero = seriesWithFlows();
    const steps = bankSteps({ ...zero, flows_total: '0.00' } as typeof zero, periodStart(zero));
    expect(steps.flowSum).toBeNull();
    const result = seriesOut({ kind: 'result' });
    expect(bankSteps(result, periodStart(result))).toEqual({ invested: [], flows: [], flowSum: null });
  });

  it('подписи: «+20 000 ₽ · пополнение, 14 сен», на телефоне — без даты; вывод — с минусом', () => {
    const deposit: BankFlow = { day: '2026-09-14', kind: 'deposit', amount: '20000.00' };
    const withdrawal: BankFlow = { day: '2026-10-03', kind: 'withdrawal', amount: '-5000.00' };
    expect(norm(flowLabel(t, deposit, 'RUB'))).toBe('+20 000 ₽ · пополнение, 14 сен');
    expect(norm(flowLabel(t, deposit, 'RUB', true))).toBe('+20 000 ₽ · пополнение');
    expect(norm(flowLabel(t, withdrawal, 'USD'))).toBe('−5 000,00 $ · вывод, 3 окт');
    expect(norm(flowsText(t, [deposit, withdrawal], 'RUB'))).toBe('+20 000 ₽ · пополнение, 14 сен; −5 000 ₽ · вывод, 3 окт');
  });

  it('отметки — на день движения в ряду; день вне ряда пропускается; в подсказке — вид и сумма', () => {
    const flows: BankFlow[] = [
      { day: '2026-09-14', kind: 'deposit', amount: '20000.00' },
      { day: '2026-08-01', kind: 'correction', amount: '150.00' },
    ];
    const marks = flowMarks(t, flows, ['2026-09-13', '2026-09-14', '2026-10-13'], 'RUB', true);
    expect(marks).toHaveLength(1);
    expect(marks[0]?.index).toBe(1);
    expect(norm(marks[0]?.label ?? '')).toBe('+20 000 ₽ · пополнение');
    expect(marks[0]?.tip?.name).toBe('Пополнение');
    expect(norm(marks[0]?.tip?.value ?? '')).toBe('+20 000 ₽');
  });
});
