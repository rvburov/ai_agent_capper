import { describe, expect, it, vi } from 'vitest';

import { lowerFirst, maskIp, spendMonth, timeLeft, utcDayInline } from './display';

const NOW = Date.parse('2026-10-07T09:00:00Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

describe('подписи раздела «Администрирование»', () => {
  it('сколько осталось до конца срока кода', () => {
    expect(timeLeft(at(-1), NOW)).toBe('срок вышел');
    expect(timeLeft(at(0), NOW)).toBe('срок вышел');
    expect(timeLeft(at(40), NOW)).toBe('осталось 40\u00a0мин');
    expect(timeLeft(at(23 * 60 + 59), NOW)).toBe('осталось 23\u00a0часа');
    expect(timeLeft(at(21 * 60), NOW)).toBe('осталось 21\u00a0час');
    expect(timeLeft(at(47 * 60), NOW)).toBe('осталось 47\u00a0часов');
    expect(timeLeft(at(6 * 1440 + 30), NOW)).toBe('еще 6\u00a0дней');
    expect(timeLeft(at(2 * 1440 + 30), NOW)).toBe('еще 2\u00a0дня');
  });

  it('IP показывается частично, как в макете', () => {
    expect(maskIp('95.216.10.20')).toBe('95.216.•.•');
    expect(maskIp('2a01:4f9:c010:1234::1')).toBe('2a01:4f9:…');
    expect(maskIp(null)).toBe('—');
  });

  it('месяц расхода — по UTC, для подписи «за октябрь»', () => {
    expect(spendMonth(new Date('2026-10-31T23:30:00Z'))).toBe('октябрь');
    expect(spendMonth(new Date('2026-11-01T00:10:00Z'))).toBe('ноябрь');
  });

  it('день, когда кончится лимит (UTC), внутри фразы: «сегодня», «завтра», иначе дата', () => {
    const now = new Date('2026-10-13T23:30:00Z');
    // год у даты formatDate сверяет с часами: «16 окт» без года — пока на часах 2026 год
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      expect(utcDayInline('2026-10-13', now)).toBe('сегодня');
      expect(utcDayInline('2026-10-14', now)).toBe('завтра');
      expect(utcDayInline('2026-10-16', now)).toBe('16 окт');
    } finally {
      vi.useRealTimers();
    }
  });

  it('время внутри фразы — со строчной буквы', () => {
    expect(lowerFirst('Сегодня, 09:20')).toBe('сегодня, 09:20');
  });
});
