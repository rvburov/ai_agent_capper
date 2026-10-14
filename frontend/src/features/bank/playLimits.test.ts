import { describe, expect, it } from 'vitest';

import {
  cancelPendingBody,
  parseLimits,
  pauseLastDay,
  pausePreviewDay,
  pendingParts,
  sameAsCurrent,
  savedOutcome,
  usageKind,
} from './playLimits';
import { playLimitsOut } from './testData';

describe('ответственная игра: поля лимитов', () => {
  it('пустое поле — без лимита, число и сумма — в тело PUT', () => {
    expect(parseLimits({ count: '', amount: '' }, 20)).toEqual({ body: { bets_per_day: null, stake_per_day: null } });
    expect(parseLimits({ count: ' 5 ', amount: '3 000' }, 20)).toEqual({ body: { bets_per_day: 5, stake_per_day: '3000.00' } });
    expect(parseLimits({ count: '20', amount: '477,14' }, 20)).toEqual({ body: { bets_per_day: 20, stake_per_day: '477.14' } });
  });

  it('число — целое от 1 до максимума сервера, сумма — больше нуля', () => {
    expect(parseLimits({ count: '0', amount: '' }, 20)).toEqual({ errors: ['count'] });
    expect(parseLimits({ count: '21', amount: '' }, 20)).toEqual({ errors: ['count'] });
    expect(parseLimits({ count: '2.5', amount: '' }, 20)).toEqual({ errors: ['count'] });
    expect(parseLimits({ count: 'пять', amount: '0' }, 20)).toEqual({ errors: ['count', 'amount'] });
    expect(parseLimits({ count: '', amount: '−500' }, 20)).toEqual({ errors: ['amount'] });
  });
});

describe('ответственная игра: что изменилось после сохранения', () => {
  const before = playLimitsOut({ bets_per_day: 5, stake_per_day: '3000.00' });

  it('снижение действует сразу, повышение ждет 24 часа', () => {
    expect(savedOutcome(before, playLimitsOut({ bets_per_day: 3, stake_per_day: '3000.00' }))).toBe('lowered');
    const pending = { bets_per_day: 8, stake_per_day: '3000.00', starts_at: '2026-10-15T10:00:00Z' };
    expect(savedOutcome(before, { ...before, pending })).toBe('pending');
    expect(savedOutcome(before, playLimitsOut({ bets_per_day: 5, stake_per_day: '2000.00', pending }))).toBe('pendingAndLowered');
    expect(savedOutcome(before, playLimitsOut({ bets_per_day: 5, stake_per_day: '3000' }))).toBe('same');
  });

  it('отмена ждущего повышения — те же действующие лимиты; что именно ждет', () => {
    const limits = playLimitsOut({
      bets_per_day: 5,
      stake_per_day: '3000.00',
      pending: { bets_per_day: null, stake_per_day: '3000.00', starts_at: '2026-10-15T10:00:00Z' },
    });
    expect(cancelPendingBody(limits)).toEqual({ bets_per_day: 5, stake_per_day: '3000.00', currency: 'RUB' });
    expect(pendingParts(limits)).toEqual({ count: null });
    // повышение отменено — это не «снижен»: свой текст
    expect(savedOutcome(limits, playLimitsOut({ bets_per_day: 5, stake_per_day: '3000.00' }))).toBe('cancelled');
  });

  it('поля равны действующим лимитам — форма не отправляет запрос', () => {
    const limits = playLimitsOut({ bets_per_day: 1, stake_per_day: '3000.00' });
    expect(sameAsCurrent({ bets_per_day: 1, stake_per_day: '3000.00' }, limits)).toBe(true);
    expect(sameAsCurrent({ bets_per_day: 1, stake_per_day: '3000' }, limits)).toBe(true);
    expect(sameAsCurrent({ bets_per_day: 2, stake_per_day: '3000.00' }, limits)).toBe(false);
    expect(sameAsCurrent({ bets_per_day: 1, stake_per_day: null }, limits)).toBe(false);
    expect(sameAsCurrent({ bets_per_day: null, stake_per_day: null }, playLimitsOut({ bets_per_day: null, stake_per_day: null }))).toBe(true);
  });
});

describe('ответственная игра: даты паузы', () => {
  it('последний день — накануне полуночи окончания по поясу участника', () => {
    // пауза до 22 октября 00:00 по Хельсинки = 21 октября 21:00 UTC
    const day = pauseLastDay('2026-10-21T21:00:00Z');
    expect(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' }).format(day)).toBe('2026-10-21');
  });

  it('предпросмотр: сегодня по поясу плюс дни, как считает сервер', () => {
    const now = new Date('2026-10-14T22:30:00Z'); // в Хельсинки уже 15 октября
    expect(pausePreviewDay(7, 'Europe/Helsinki', now)).toBe('2026-10-22');
    expect(pausePreviewDay(1, 'America/New_York', now)).toBe('2026-10-15');
  });

  it('полоса «сегодня»: у порога — предупреждение, исчерпан — красная', () => {
    expect(usageKind(1, 4)).toBeUndefined();
    expect(usageKind(3, 4)).toBe('warn');
    expect(usageKind(4, 4)).toBe('bad');
    expect(usageKind(0, 0)).toBeUndefined();
  });
});
