import type { AiBudget } from './types';

// Данные для тестов вкладки «Ключ Claude»: участник на ключе администратора в октябре 2026.
export function aiBudget(over: Partial<AiBudget> = {}): AiBudget {
  return {
    mode: 'shared',
    key_source: 'admin',
    has_key: true,
    month_start: '2026-10-01T00:00:00Z',
    monthly_usd: 10,
    spent_usd: 1.93,
    limit_share: 0.193,
    reserved_usd: 0,
    left_usd: 8.07,
    daily_analyses: 3,
    analyses_today: 1,
    analyses_month: 11,
    per_analysis_usd: 1,
    soft_cap_usd: 0.5,
    paused: false,
    alert_pct: 80,
    own_key: null,
    own_cap_usd: 1,
    avg_analysis_usd: 0.13,
    return_requested_at: null,
    reason_code: null,
    reason_params: {},
    budget: null,
    ...over,
  };
}
