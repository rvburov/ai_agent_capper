import type { PlayLimits } from './types';

/*
 * Ответственная игра для тестов (GET /api/me/play-limits): участник в Хельсинки 14 октября
 * 2026, лимитов нет, сегодня ставок не было. Поля меняются аргументом over.
 */
export function playLimitsOut(over: Partial<PlayLimits> = {}): PlayLimits {
  return {
    currency: 'RUB',
    tz: 'Europe/Helsinki',
    bets_per_day: null,
    stake_per_day: null,
    pending: null,
    paused_until: null,
    today: { bets: 0, stake: '0.00', starts_at: '2026-10-13T21:00:00Z', ends_at: '2026-10-14T21:00:00Z' },
    blocked: null,
    blocked_until: null,
    pause_days: [1, 7, 30, 90],
    bets_per_day_max: 20,
    ...over,
  };
}
