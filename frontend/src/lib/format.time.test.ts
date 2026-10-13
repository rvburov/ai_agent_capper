import { describe, expect, it } from 'vitest';

import { formatTime, formatWeekday } from './format';

describe('formatTime и formatWeekday', () => {
  it('время в поясе пользователя: «14:30»', () => {
    expect(formatTime('2026-10-13T11:30:00Z', { timeZone: 'Europe/Helsinki' })).toBe('14:30');
    expect(formatTime('2026-10-13T23:05:00Z', { timeZone: 'America/New_York' })).toBe('19:05');
    expect(formatTime(null)).toBe('—');
  });

  it('день недели: день без времени — календарный в любом поясе', () => {
    expect(formatWeekday('2026-10-13')).toBe('вторник');
    expect(formatWeekday('2026-10-13', { timeZone: 'America/Los_Angeles' })).toBe('вторник');
    expect(formatWeekday('2026-10-13T22:30:00Z', { timeZone: 'Europe/Helsinki' })).toBe('среда');
    expect(formatWeekday(undefined)).toBe('—');
  });
});
