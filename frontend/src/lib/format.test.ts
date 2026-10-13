import { afterEach, describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateLong,
  formatDateTime,
  formatDayMonth,
  formatMoney,
  formatNumber,
  formatOdds,
  formatOddsExact,
  formatPercent,
  formatRelative,
  formatUsd,
  getDisplayTimeZone,
  setDisplayTimeZone,
} from './format';

const NB = '\u00a0'; // неразрывный пробел: разряды и знак валюты
const MINUS = '\u2212';
const MSK = 'Europe/Moscow';
// «Сейчас» в тестах: 8 октября 2026, 15:00 по Москве
const NOW = '2026-10-08T12:00:00Z';

afterEach(() => {
  setDisplayTimeZone(undefined);
});

describe('formatMoney', () => {
  it('рубли без копеек, доллары и евро с центами, знак валюты после суммы', () => {
    expect(formatMoney(48133, 'RUB')).toBe(`48${NB}133${NB}₽`);
    expect(formatMoney(520.5, 'USD')).toBe(`520,50${NB}$`);
    expect(formatMoney(480, 'EUR')).toBe(`480,00${NB}€`);
  });

  it('принимает Decimal строкой, как он приходит из API', () => {
    expect(formatMoney('48133.00', 'RUB')).toBe(`48${NB}133${NB}₽`);
    expect(formatMoney('0.10', 'USD')).toBe(`0,10${NB}$`);
  });

  it('минус как в макете (U+2212) и знак плюс по запросу', () => {
    expect(formatMoney(-1500, 'RUB')).toBe(`${MINUS}1${NB}500${NB}₽`);
    expect(formatMoney(1500, 'RUB', { signed: true })).toBe(`+1${NB}500${NB}₽`);
    expect(formatMoney(0, 'RUB', { signed: true })).toBe(`0${NB}₽`);
  });

  it('округление до нуля не дает «минус ноль»', () => {
    expect(formatMoney(-0.4, 'RUB')).toBe(`0${NB}₽`);
    expect(formatMoney('-0.40', 'RUB')).toBe(`0${NB}₽`);
    expect(formatMoney(-0, 'RUB')).toBe(`0${NB}₽`);
    expect(formatMoney(-0.004, 'USD')).toBe(`0,00${NB}$`);
    expect(formatMoney(-0.4, 'RUB', { signed: true })).toBe(`0${NB}₽`);
    // половина и больше округляется от нуля, знак остается
    expect(formatMoney(-0.5, 'RUB')).toBe(`${MINUS}1${NB}₽`);
    expect(formatMoney(-0.005, 'EUR')).toBe(`${MINUS}0,01${NB}€`);
  });

  it('пустое и мусор — прочерк', () => {
    expect(formatMoney(null, 'RUB')).toBe('—');
    expect(formatMoney('abc', 'RUB')).toBe('—');
  });
});

describe('formatUsd', () => {
  it('всегда доллары, знак впереди', () => {
    expect(formatUsd(0.3)).toBe('$0,30');
    expect(formatUsd('1234.5')).toBe(`$1${NB}234,50`);
    expect(formatUsd(0.0042, 4)).toBe('$0,0042');
    expect(formatUsd(-2)).toBe(`${MINUS}$2,00`);
  });

  it('округление до нуля не дает «минус ноль»', () => {
    expect(formatUsd(-0.001)).toBe('$0,00');
  });
});

describe('числа, кэфы и проценты', () => {
  it('formatNumber', () => {
    expect(formatNumber(12480)).toBe(`12${NB}480`);
    expect(formatNumber(0.25, 2)).toBe('0,25');
    expect(formatNumber(-3)).toBe(`${MINUS}3`);
  });

  it('formatOddsExact: третий знак, только если он не ноль', () => {
    expect(formatOddsExact('1.335')).toBe('1.335');
    expect(formatOddsExact(1.335)).toBe('1.335');
    expect(formatOddsExact('1.300')).toBe('1.30');
    expect(formatOddsExact('2.105')).toBe('2.105');
    expect(formatOddsExact('12.340')).toBe('12.34');
    expect(formatOddsExact(null)).toBe('—');
  });

  it('formatOdds: две цифры после точки, как на табло', () => {
    expect(formatOdds(1.85)).toBe('1.85');
    expect(formatOdds('2.100')).toBe('2.10');
    expect(formatOdds(undefined)).toBe('—');
  });

  it('formatPercent: доля 0..1 в процентах', () => {
    expect(formatPercent(0.125)).toBe('12,5%');
    expect(formatPercent(0.07, { digits: 0 })).toBe('7%');
    expect(formatPercent(0.032, { signed: true })).toBe('+3,2%');
    expect(formatPercent(-0.01, { signed: true })).toBe(`${MINUS}1,0%`);
  });

  it('округление до нуля не дает «минус ноль»', () => {
    expect(formatNumber(-0.4)).toBe('0');
    expect(formatNumber(-0.004, 2)).toBe('0,00');
    expect(formatNumber(-0.6)).toBe(`${MINUS}1`);
    expect(formatPercent(-0.0004)).toBe('0,0%');
    expect(formatPercent(-0.004, { digits: 0 })).toBe('0%');
    expect(formatPercent(-0.0004, { signed: true })).toBe('0,0%');
    expect(formatPercent(-0.0006)).toBe(`${MINUS}0,1%`);
  });
});

describe('даты в часовом поясе пользователя', () => {
  it('formatDate: день и месяц, год — только если не текущий', () => {
    expect(formatDate('2026-10-08T12:00:00Z', { timeZone: MSK, now: NOW })).toBe('8 окт');
    expect(formatDate('2025-05-03T12:00:00Z', { timeZone: MSK, now: NOW })).toBe('3 мая 2025');
    expect(formatDate('2026-10-08T12:00:00Z', { timeZone: MSK, now: NOW, year: 'always' })).toBe(
      '8 окт 2026',
    );
  });

  it('formatDateLong: полная дата с годом, месяц в родительном падеже', () => {
    expect(formatDateLong('2026-06-30T12:00:00Z', { timeZone: MSK })).toBe('30 июня 2026');
    expect(formatDateLong('2026-05-03T22:30:00Z', { timeZone: MSK })).toBe('4 мая 2026');
    expect(formatDateLong(null)).toBe('—');
  });

  it('formatDayMonth: день и месяц в родительном падеже, без года', () => {
    expect(formatDayMonth('2026-11-01T00:00:00Z', { timeZone: 'UTC' })).toBe('1 ноября');
    expect(formatDayMonth('2026-05-03T22:30:00Z', { timeZone: MSK })).toBe('4 мая');
    expect(formatDayMonth(undefined)).toBe('—');
  });

  it('день считается в поясе пользователя, а не в UTC', () => {
    // 22:30 UTC 8 октября — в Москве уже 9 октября, в Нью-Йорке еще 8-е
    const late = '2026-10-08T22:30:00Z';
    expect(formatDate(late, { timeZone: MSK, now: NOW })).toBe('9 окт');
    expect(formatDate(late, { timeZone: 'America/New_York', now: NOW })).toBe('8 окт');
  });

  it('formatDateTime: «Сегодня», «Вчера», «Завтра» и дата', () => {
    const o = { timeZone: MSK, now: NOW };
    expect(formatDateTime('2026-10-08T11:05:00Z', o)).toBe('Сегодня, 14:05');
    expect(formatDateTime('2026-10-07T06:30:00Z', o)).toBe('Вчера, 09:30');
    expect(formatDateTime('2026-10-09T17:00:00Z', o)).toBe('Завтра, 20:00');
    expect(formatDateTime('2026-10-01T09:00:00Z', o)).toBe('1 окт, 12:00');
    expect(formatDateTime('2026-10-08T11:05:00Z', { ...o, calendar: false })).toBe('8 окт, 14:05');
    expect(formatDateTime('2026-10-08T11:05:00Z', { ...o, calendar: false, year: 'always' })).toBe(
      '8 окт 2026, 14:05',
    );
  });

  it('пояс пользователя задается один раз для всех функций', () => {
    setDisplayTimeZone('Asia/Tokyo');
    expect(getDisplayTimeZone()).toBe('Asia/Tokyo');
    expect(formatDateTime('2026-10-08T11:05:00Z', { now: NOW })).toBe('Сегодня, 20:05');
    setDisplayTimeZone('Not/AZone');
    expect(getDisplayTimeZone()).toBeUndefined();
  });

  it('formatRelative: только что, минуты, часы, дни, потом дата', () => {
    const o = { timeZone: MSK, now: NOW };
    expect(formatRelative('2026-10-08T11:59:30Z', o)).toBe('только что');
    expect(formatRelative('2026-10-08T11:55:00Z', o)).toBe('5 мин назад');
    expect(formatRelative('2026-10-08T09:00:00Z', o)).toBe('3 ч назад');
    expect(formatRelative('2026-10-07T12:00:00Z', o)).toBe('1 день назад');
    expect(formatRelative('2026-10-06T12:00:00Z', o)).toBe('2 дня назад');
    expect(formatRelative('2026-10-03T12:00:00Z', o)).toBe('5 дней назад');
    expect(formatRelative('2026-12-08T12:00:00Z', { ...o, now: '2027-03-01T12:00:00Z' })).toBe(
      '8 дек 2026',
    );
    expect(formatRelative('2026-10-08T12:20:00Z', o)).toBe('через 20 мин');
  });

  it('пустое и неверное — прочерк', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
  });
});
