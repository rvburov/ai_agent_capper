import { describe, expect, it } from 'vitest';

import { nextReportDay } from './schedule';

// Часы — явными моментами: результат не зависит от того, когда и где идут тесты
describe('nextReportDay: понедельник 07:00 по поясу участника', () => {
  it('среда — ближайший понедельник', () => {
    // 15 окт 2026 — четверг
    expect(nextReportDay(new Date('2026-10-15T10:00:00Z'), 'Europe/Helsinki')).toBe('2026-10-19');
    expect(nextReportDay(new Date('2026-10-14T10:00:00Z'), 'Europe/Helsinki')).toBe('2026-10-19');
  });

  it('воскресенье — завтра; понедельник до 07:00 — сегодня, после — через неделю', () => {
    expect(nextReportDay(new Date('2026-10-18T20:00:00Z'), 'UTC')).toBe('2026-10-19');
    // 19 окт 03:59 UTC = 06:59 в Хельсинки (UTC+3)
    expect(nextReportDay(new Date('2026-10-19T03:59:00Z'), 'Europe/Helsinki')).toBe('2026-10-19');
    expect(nextReportDay(new Date('2026-10-19T04:00:00Z'), 'Europe/Helsinki')).toBe('2026-10-26');
  });

  it('день считается по поясу участника, а не по UTC', () => {
    // 18 окт 22:30 UTC: в UTC еще воскресенье, в Хельсинки уже понедельник 01:30 — отчет сегодня
    expect(nextReportDay(new Date('2026-10-18T22:30:00Z'), 'Europe/Helsinki')).toBe('2026-10-19');
    // 19 окт 10:00 UTC: в Нью-Йорке понедельник 06:00 — отчет сегодня; в Токио 19:00 — через неделю
    expect(nextReportDay(new Date('2026-10-19T10:00:00Z'), 'America/New_York')).toBe('2026-10-19');
    expect(nextReportDay(new Date('2026-10-19T10:00:00Z'), 'Asia/Tokyo')).toBe('2026-10-26');
  });

  it('конец месяца и года; неизвестный пояс — UTC', () => {
    expect(nextReportDay(new Date('2026-12-30T12:00:00Z'), 'UTC')).toBe('2027-01-04');
    expect(nextReportDay(new Date('2026-10-15T10:00:00Z'), 'Mars/Olympus')).toBe('2026-10-19');
  });
});
