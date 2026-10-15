import type { DataUpload, DataUploadReport, DataUploads } from './dataUploads';
import type { AdminBudget, AdminKey, AdminUser, AuditEntry, LimitDefaults, MemberLimit } from './types';

// Данные для тестов раздела «Администрирование».
export function adminUser(over: Partial<AdminUser> = {}): AdminUser {
  const row: AdminUser = {
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
    limit_share: null,
    ...over,
  };
  // Доля лимита, как на сервере: расход к месячному лимиту, если ее не задали явно
  if (!('limit_share' in over)) row.limit_share = row.limit?.monthly_usd ? row.ai_spent_month_usd / row.limit.monthly_usd : null;
  return row;
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
  const row: MemberLimit = {
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
    level: null,
    limit_share: null,
    ...over,
  };
  if (!('limit_share' in over)) row.limit_share = row.limit?.monthly_usd ? row.spent_month_usd / row.limit.monthly_usd : null;
  return row;
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
    // темп месяца — с сервера: идет 8-й день из 31, осталось 24 (сегодня включая)
    forecast_share: 66 / 60,
    per_day_usd: 5.15,
    can_per_day_usd: 0.78,
    alert_usd: 48,
    ...over,
  };
}

export function adminKey(over: Partial<AdminKey> = {}): AdminKey {
  return { status: 'ok', last4: 'm9Tq', verified_at: '2026-10-01T10:12:00Z', users_on_key: 3, ...over };
}

// ---------- «Данные» (этап 5): загрузки файла tennis-data ----------

export function uploadReport(over: Partial<DataUploadReport> = {}): DataUploadReport {
  return {
    file_rows: 2_712,
    unchanged: false,
    new_matches: 71,
    updated_matches: 3,
    matches_to: '2026-10-11',
    settled_bets: 9,
    people: 3,
    legs: 14,
    closing: 11,
    linked: 14,
    waiting: 1,
    unlinked: 3,
    not_found: 1,
    unlinked_matches: [
      { match_id: 501, player1: 'Синнер', player2: 'Руне', day: '2026-10-09', reason: 'ambiguous' },
      { match_id: 502, player1: 'Медведев', player2: 'Рублев', day: '2026-10-10', reason: 'conflict' },
    ],
    conflicts: 1,
    manual: 2,
    legacy_legs: 0,
    steps: [
      { step: 'tennis_data', status: 'ok', error: null },
      { step: 'players_link', status: 'ok', error: null },
      { step: 'elo', status: 'ok', error: null },
      { step: 'settle', status: 'ok', error: null },
    ],
    ...over,
  };
}

/** Загрузка №12: 2026.xlsx, 1,9 МБ, готова 12 окт в 08:14 по UTC. */
export function dataUpload(over: Partial<DataUpload> = {}): DataUpload {
  return {
    id: 12,
    created_at: '2026-10-12T08:12:00Z',
    filename: '2026.xlsx',
    size_bytes: 1_992_294,
    year: 2026,
    status: 'done',
    step: null,
    uploaded_by: 'Роман Буров',
    started_at: '2026-10-12T08:12:05Z',
    finished_at: '2026-10-12T08:14:00Z',
    error: null,
    report: uploadReport(),
    ...over,
  };
}

/** Свежесть архива и загрузки (GET /api/admin/data/uploads), новые сверху. */
export function dataUploads(uploads: DataUpload[] = [dataUpload()], archive: Partial<DataUploads['archive']> = {}): DataUploads {
  return {
    archive: { last_load: '2026-10-12T08:14:00Z', matches_to: '2026-10-11', next_upload: '2026-10-19', stale_days: 7, stale: false, max_mb: 10, ...archive },
    uploads,
  };
}
