import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import {
  parseShortOffset,
  timeZoneDative,
  timeZoneLabel,
  timeZoneName,
  timeZoneOptions,
  utcOffset,
} from './timezones';

const t = i18n.t.bind(i18n);
const OCTOBER = new Date('2026-10-08T12:00:00Z');
const JANUARY = new Date('2026-01-15T12:00:00Z');
const MINUS = '−';

describe('часовые пояса', () => {
  it('смещение учитывает летнее и зимнее время', () => {
    expect(utcOffset('Europe/Helsinki', OCTOBER)).toBe('+3');
    expect(utcOffset('Europe/Helsinki', JANUARY)).toBe('+2');
    expect(utcOffset('America/New_York', OCTOBER)).toBe(`${MINUS}4`);
    expect(utcOffset('Asia/Kolkata', OCTOBER)).toBe('+5:30');
    expect(utcOffset('UTC', OCTOBER)).toBe('');
    expect(utcOffset('Not/AZone', OCTOBER)).toBeNull();
  });

  it('нулевое смещение не зависит от версии ICU: «GMT» и «GMT+0»', () => {
    expect(parseShortOffset('GMT')).toBe('');
    expect(parseShortOffset('GMT+0')).toBe('');
    expect(parseShortOffset('GMT-3')).toBe(`${MINUS}3`);
    expect(parseShortOffset('GMT+5:30')).toBe('+5:30');
    expect(parseShortOffset('PST')).toBeNull();
  });

  it('подписи как в макете', () => {
    expect(timeZoneLabel(t, 'Europe/Helsinki', OCTOBER)).toBe('Хельсинки (UTC+3)');
    expect(timeZoneLabel(t, 'America/Los_Angeles', OCTOBER)).toBe(`Лос-Анджелес (UTC${MINUS}7)`);
    expect(timeZoneLabel(t, 'America/Argentina/Buenos_Aires', OCTOBER)).toBe(
      `America/Argentina/Buenos Aires (UTC${MINUS}3)`,
    );
    expect(timeZoneLabel(t, 'UTC', OCTOBER)).toBe('UTC');
    expect(timeZoneName(t, 'America/New_York')).toBe('Нью-Йорк');
    expect(timeZoneDative(t, 'America/New_York')).toBe('Нью-Йорку');
    expect(timeZoneDative(t, 'Asia/Tokyo')).toBeNull();
  });

  it('список: свой пояс и пояс браузера в начале, без повторов', () => {
    const base = timeZoneOptions(t, 'Europe/Berlin', { browser: 'Europe/Helsinki', at: OCTOBER });
    expect(base.map((o) => o.value)).toEqual([
      'Europe/Helsinki',
      'Europe/Berlin',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
    ]);
    const extra = timeZoneOptions(t, 'Asia/Tokyo', { browser: 'Europe/Paris', at: OCTOBER });
    expect(extra.slice(0, 3).map((o) => o.value)).toEqual(['Asia/Tokyo', 'Europe/Paris', 'Europe/Helsinki']);
    expect(extra[0]?.label).toBe('Asia/Tokyo (UTC+9)');
    const broken = timeZoneOptions(t, 'Europe/Helsinki', { browser: 'Not/AZone', at: OCTOBER });
    expect(broken).toHaveLength(6);
  });
});
