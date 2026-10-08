import type { AdminUser, AuditEntry } from './types';

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
