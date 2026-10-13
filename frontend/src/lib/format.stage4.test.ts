import { afterEach, describe, expect, it } from 'vitest';

import {
  formatCompact,
  formatDate,
  formatDateLong,
  formatDateRange,
  formatDayMonth,
  formatInterval,
  formatMoneyCompact,
  formatNumber,
  formatPercent,
  formatPp,
  formatProb,
  formatProbRange,
  setDisplayTimeZone,
  stepDigits,
} from './format';
import { lineYDomain, niceScale } from '../components/charts/geometry';

// Дополнения этапа 4: числа со знаком, сокращенные суммы для осей, п.п., диапазоны дат.

const NB = ' ';
const MINUS = '−';
const NOW = '2026-10-08T12:00:00Z';
const MSK = 'Europe/Moscow';

afterEach(() => {
  setDisplayTimeZone(undefined);
});

describe('числа со знаком', () => {
  it('formatNumber signed: разница Brier с рынком', () => {
    expect(formatNumber(0.012, 3, { signed: true })).toBe('+0,012');
    expect(formatNumber(-0.012, 3, { signed: true })).toBe(`${MINUS}0,012`);
    expect(formatNumber(0, 3, { signed: true })).toBe('0,000');
    // округление до нуля — без знака и без «минус ноль»
    expect(formatNumber(-0.0004, 3, { signed: true })).toBe('0,000');
    expect(formatNumber(1234, 0, { signed: true })).toBe(`+1${NB}234`);
  });
});

describe('сокращенные числа и суммы', () => {
  it('formatCompact: тыс., млн, млрд; лишние нули не пишутся', () => {
    expect(formatCompact(950)).toBe('950');
    expect(formatCompact(4813)).toBe(`4,8${NB}тыс.`);
    expect(formatCompact(48133)).toBe(`48,1${NB}тыс.`);
    expect(formatCompact(48000)).toBe(`48${NB}тыс.`);
    expect(formatCompact(1_234_567)).toBe(`1,2${NB}млн`);
    expect(formatCompact(48133, { digits: 0 })).toBe(`48${NB}тыс.`);
    expect(formatCompact(-48133)).toBe(`${MINUS}48,1${NB}тыс.`);
    expect(formatCompact(48133, { signed: true })).toBe(`+48,1${NB}тыс.`);
    expect(formatCompact('abc')).toBe('—');
  });

  it('formatMoneyCompact: валюта программы, меньше тысячи — как сумма без лишних нулей', () => {
    expect(formatMoneyCompact(48133, 'RUB')).toBe(`48,1${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact('48000.00', 'RUB')).toBe(`48${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact(1_250_000, 'EUR')).toBe(`1,3${NB}млн${NB}€`);
    expect(formatMoneyCompact(950, 'RUB')).toBe(`950${NB}₽`);
    expect(formatMoneyCompact(999.4, 'RUB')).toBe(`999${NB}₽`);
    // на границе тысячи рубли не показывают копеек: 999,5 ₽ — это уже «1 тыс. ₽»
    expect(formatMoneyCompact(999.5, 'RUB')).toBe(`1${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact(999.94, 'RUB')).toBe(`1${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact(999.5, 'RUB', { signed: true })).toBe(`+1${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact(-999.6, 'RUB')).toBe(`${MINUS}1${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact(999.5, 'USD')).toBe(`999,5${NB}$`);
    expect(formatMoneyCompact(999.996, 'USD')).toBe(`1${NB}тыс.${NB}$`);
    expect(formatMoneyCompact(12.5, 'USD')).toBe(`12,5${NB}$`);
    expect(formatMoneyCompact(0, 'USD')).toBe(`0${NB}$`);
    expect(formatMoneyCompact(-2500, 'RUB', { signed: true })).toBe(`${MINUS}2,5${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact(2500, 'RUB', { signed: true })).toBe(`+2,5${NB}тыс.${NB}₽`);
    expect(formatMoneyCompact(-0.2, 'RUB')).toBe(`0${NB}₽`);
    expect(formatMoneyCompact(null, 'RUB')).toBe('—');
  });
});

describe('подписи оси: соседние деления различаются', () => {
  it('stepDigits: знаков столько, сколько нужно шагу', () => {
    expect(stepDigits(1)).toBe(0);
    expect(stepDigits(10_000)).toBe(0);
    expect(stepDigits(0.5)).toBe(1);
    expect(stepDigits(0.1)).toBe(1);
    expect(stepDigits(0.2)).toBe(1);
    expect(stepDigits(0.05)).toBe(2);
    expect(stepDigits(0.01)).toBe(2);
    expect(stepDigits(0)).toBe(0);
    expect(stepDigits(Number.NaN)).toBe(0);
  });

  const distinct = (labels: string[]) => expect(new Set(labels).size).toBe(labels.length);

  it('счетчики 0…1, кэфы 1,8…2,1, банк 999 000…1 026 000 ₽', () => {
    // счетчики (целые деления) и дробные значения без шага — formatNumber с точностью шага
    for (const [lo, hi, minStep] of [
      [0, 1, 1],
      [0, 1, 0],
      [1.8, 2.1, 0],
      [0.18, 0.26, 0],
    ] as const) {
      const { ticks, step } = niceScale(lo, hi, 3, { minStep });
      distinct(ticks.map((t) => formatNumber(t, stepDigits(step))));
    }
    const kefs = lineYDomain([1.8, 2.1]);
    expect(kefs.ticks.map((t) => formatNumber(t, stepDigits(kefs.step)))).toEqual(['1,7', '1,8', '1,9', '2,0', '2,1', '2,2']);
    const bank = lineYDomain([999_000, 1_026_000]);
    const labels = bank.ticks.map((t) => formatMoneyCompact(t, 'RUB', { step: bank.step }));
    distinct(labels);
    expect(labels).toEqual([
      `990${NB}тыс.${NB}₽`,
      `1${NB}млн${NB}₽`,
      `1,01${NB}млн${NB}₽`,
      `1,02${NB}млн${NB}₽`,
      `1,03${NB}млн${NB}₽`,
    ]);
    distinct(bank.ticks.map((t) => formatCompact(t, { step: bank.step })));
    // мелкий шаг у тысяч: 47 200…51 900 — «46 тыс.», «48 тыс.»…
    const small = lineYDomain([47_200, 51_900]);
    distinct(small.ticks.map((t) => formatMoneyCompact(t, 'USD', { step: small.step })));
    // без шага — прежние знаки
    expect(formatCompact(1_010_000)).toBe(`1${NB}млн`);
    expect(formatCompact(1_010_000, { step: 10_000 })).toBe(`1,01${NB}млн`);
  });
});

describe('вероятности, проценты и п.п.', () => {
  it('formatProb: целые проценты', () => {
    expect(formatProb(0.664)).toBe('66%');
    expect(formatProb(1)).toBe('100%');
    expect(formatProb(null)).toBe('—');
  });

  it('formatProbRange: корзина калибровки', () => {
    expect(formatProbRange(0.7, 0.75)).toBe('70–75%');
    expect(formatProbRange(0.5, undefined)).toBe('—');
  });

  it('formatPp: разница долей в процентных пунктах', () => {
    expect(formatPp(0.021)).toBe('+2,1 п.п.');
    expect(formatPp(-0.01)).toBe(`${MINUS}1,0 п.п.`);
    expect(formatPp(0)).toBe('0,0 п.п.');
    expect(formatPp(0.04, { digits: 0 })).toBe('+4 п.п.');
    expect(formatPp(0.04, { digits: 0, signed: false })).toBe('4 п.п.');
    expect(formatPp(undefined)).toBe('—');
  });

  it('formatPp: ноль со знаком «±» и без единицы — вид поправки Claude на экране анализа', () => {
    expect(formatPp(0, { digits: 0, zero: '±' })).toBe('±0 п.п.');
    expect(formatPp(0.001, { digits: 0, zero: '±' })).toBe('±0 п.п.');
    expect(formatPp(-0.004, { digits: 0, zero: '±' })).toBe('±0 п.п.');
    expect(formatPp(0.04, { digits: 0, zero: '±' })).toBe('+4 п.п.');
    expect(formatPp(-0.021, { digits: 0, zero: '±', unit: false })).toBe(`${MINUS}2`);
    expect(formatPp(0, { zero: '±' })).toBe('±0,0 п.п.');
  });

  it('formatInterval: 95% ДИ одним форматом', () => {
    const pct = (v: number) => formatPercent(v, { signed: true });
    expect(formatInterval(-0.032, 0.084, pct)).toBe(`${MINUS}3,2%…+8,4%`);
    expect(formatInterval(-0.012, 0.004, (v) => formatNumber(v, 3, { signed: true }))).toBe(
      `${MINUS}0,012…+0,004`,
    );
    expect(formatInterval(null, 0.1, pct)).toBe('—');
  });
});

describe('диапазон дат', () => {
  const o = { timeZone: MSK, now: NOW };

  it('один месяц — «3–5 окт», разные месяцы — «28 сен – 5 окт»', () => {
    expect(formatDateRange('2026-10-03T09:00:00Z', '2026-10-05T09:00:00Z', o)).toBe('3–5 окт');
    expect(formatDateRange('2026-09-28T09:00:00Z', '2026-10-05T09:00:00Z', o)).toBe('28 сен – 5 окт');
    expect(formatDateRange('2026-10-08T09:00:00Z', '2026-10-08T18:00:00Z', o)).toBe('8 окт');
  });

  it('год — если концы в разных годах или не в текущем', () => {
    expect(formatDateRange('2025-12-28T09:00:00Z', '2026-01-05T09:00:00Z', o)).toBe(
      '28 дек 2025 – 5 янв 2026',
    );
    expect(formatDateRange('2025-05-03T09:00:00Z', '2025-05-09T09:00:00Z', o)).toBe('3–9 мая 2025');
  });

  it('месяц полностью — период расходов «1–13 октября»', () => {
    expect(formatDateRange('2026-10-01', '2026-10-13', { ...o, month: 'long' })).toBe('1–13 октября');
  });

  it('конец раньше начала — концы меняются местами; пустое — прочерк', () => {
    expect(formatDateRange('2026-10-05T09:00:00Z', '2026-10-03T09:00:00Z', o)).toBe('3–5 окт');
    expect(formatDateRange(null, '2026-10-03', o)).toBe('—');
    expect(formatDateRange('2026-10-03', 'nope', o)).toBe('—');
  });

  it('день считается в поясе пользователя', () => {
    // 22:30 UTC — в Москве уже следующий день
    expect(formatDateRange('2026-10-03T22:30:00Z', '2026-10-05T22:30:00Z', o)).toBe('4–6 окт');
  });
});

describe('дата без времени — календарный день в любом поясе', () => {
  it('«2026-10-03» не съезжает на день назад к западу от Гринвича', () => {
    setDisplayTimeZone('America/New_York');
    expect(formatDate('2026-10-03', { now: NOW })).toBe('3 окт');
    expect(formatDateLong('2026-10-03')).toBe('3 октября 2026');
    expect(formatDayMonth('2026-10-03')).toBe('3 октября');
    expect(formatDateRange('2026-10-01', '2026-10-03', { now: NOW })).toBe('1–3 окт');
    // момент времени по-прежнему в поясе пользователя
    expect(formatDate('2026-10-03T02:00:00Z', { now: NOW })).toBe('2 окт');
  });
});
