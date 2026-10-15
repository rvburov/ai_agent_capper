import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Часы файла тестов — с момента now, и идут дальше (таймеры настоящие). Даты в ответах-образцах
 * стоят в октябре 2026: formatDate добавляет год, если он не текущий, «сегодня» и «завтра» тоже
 * считаются от часов, поэтому без фиксации тест падает в другом году или вечером по UTC.
 */
export function fixClock(now: string): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(now));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}
