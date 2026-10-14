import type { AdminBudget, AdminKey, AdminUser, AuditEntry, LimitDefaults, MemberLimit } from './types';

// Данные для тестов раздела «Администрирование».
export function adminUser(over: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 2,
    display_name: 'Ольга Лехтинен',
    email: 'olga@example.com',
    role: 'member',
    status: 'active',
    ai_mode: 'shared',
    totp_enabled: true,
    created_at: '2026-09-01T09:00:00Z',
    last_login_at: '2026-10-07T08:00:00Z',
    ai_spent_month_usd: 1.93,
    analyses_month: 11,
    limit: { monthly_usd: 10, daily_analyses: 3, per_analysis_usd: 1, paused: false },
    ...over,
  };
}

export function auditEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    at: '2026-10-07T09:20:00Z',
    actor_id: 1,
    actor_name: 'Роман Буров',
    action: 'block',
    target_user_id: 2,
    target_name: 'Ольга Лехтинен',
    details: {},
    ip: '95.216.10.20',
    ...over,
  };
}

// «Ключ и бюджет» (этап 3): лимиты по умолчанию (Р13), строка лимитов участника, бюджет и ключ
export const LIMIT_DEFAULTS: LimitDefaults = { monthly_usd: 10, daily_analyses: 3, per_analysis_usd: 1, soft_cap_usd: 0.5 };

export function memberLimit(over: Partial<MemberLimit> = {}): MemberLimit {
  return {
    id: 2,
    display_name: 'Ольга Лехтинен',
    email: 'olga@example.com',
    role: 'member',
    status: 'active',
    ai_mode: 'shared',
    limit: { monthly_usd: 10, daily_analyses: 3, per_analysis_usd: 1, paused: false },
    own_cap_usd: 1,
    own_key_last4: null,
    spent_month_usd: 1.93,
    own_spent_month_usd: 0,
    analyses_today: 1,
    analyses_month: 11,
    return_requested_at: null,
    ...over,
  };
}

export function adminBudget(over: Partial<AdminBudget> = {}): AdminBudget {
  return {
    month_start: '2026-10-01T00:00:00Z',
    days_in_month: 31,
    days_left: 24,
    budget_usd: 60,
    spent_usd: 41.2,
    background_usd: 3.1,
    reserved_usd: 0,
    left_usd: 18.8,
    forecast_usd: 66,
    members_limits_usd: 18,
    members_usd: 30.4,
    budget_share: 41.2 / 60,
    alert_pct: 80,
    eval_budget_usd: 25,
    eval_spent_usd: 4.5,
    ...over,
  };
}

export function adminKey(over: Partial<AdminKey> = {}): AdminKey {
  return { status: 'ok', last4: 'm9Tq', verified_at: '2026-10-01T10:12:00Z', users_on_key: 3, ...over };
}
