import type { NotificationPrefs } from './prefs';

type Kind = NotificationPrefs['items'][number]['kind'];

/** Настройки «что присылать» участника на ключе администратора; off — выключенные виды. */
// Новые виды этапа 5 и сигналы расхода — сервер помечает «новое»
const NEW_KINDS = new Set<string>(['bet_needs_result', 'settle_conflict', 'weekly_report', 'learning', 'ai_alert']);

/** Расписание напоминаний и отчета (по поясу участника) — с сервера. */
const SCHEDULE = {
  tz: 'Europe/Helsinki',
  report_weekday: 0,
  report_hour: 7,
  next_report: '2026-10-19',
  settle_reminder_days: 3,
  upload_hour: 7,
  upload_stale_days: 7,
};

export function memberPrefsOut(off: Kind[] = []): NotificationPrefs {
  const item = (kind: Kind, group: string, required = false) => ({
    kind,
    group,
    on_site: required || !off.includes(kind),
    push: false,
    required,
    admin: false,
    new: NEW_KINDS.has(kind),
  });
  return {
    items: [
      item('bet_settled', 'bet'),
      item('bet_needs_result', 'needs'),
      item('settle_conflict', 'needs'),
      item('weekly_report', 'weekly'),
      item('limit_80', 'limit'),
      item('limit_100', 'limit'),
      item('ai_mode_decision', 'decision'),
      item('new_device', 'login', true),
      item('login_failures', 'fails', true),
      item('admin_message', 'message', true),
    ],
    push_available: false,
    alert_rules: null,
    schedule: SCHEDULE,
  };
}

/** То же у администратора: свои виды и раздел «Для администратора». */
export function adminPrefsOut(off: Kind[] = []): NotificationPrefs {
  const item = (kind: Kind, group: string, { required = false, admin = false } = {}) => ({
    kind,
    group,
    on_site: required || !off.includes(kind),
    push: false,
    required,
    admin,
    new: NEW_KINDS.has(kind),
  });
  return {
    items: [
      item('bet_settled', 'bet'),
      item('bet_needs_result', 'needs'),
      item('settle_conflict', 'needs'),
      item('weekly_report', 'weekly'),
      item('new_device', 'login', { required: true }),
      item('login_failures', 'fails', { required: true }),
      item('admin_message', 'message', { required: true }),
      item('learning', 'learning', { admin: true }),
      item('ai_mode_request', 'requests', { admin: true }),
      item('limit_80', 'users', { admin: true }),
      item('limit_100', 'users', { admin: true }),
      item('budget_80', 'budget', { admin: true }),
      item('budget_100', 'budget', { admin: true }),
      item('ai_key_failed', 'key', { admin: true }),
      item('data_stale', 'archive', { admin: true }),
      item('ai_alert', 'alert', { admin: true }),
    ],
    push_available: false,
    schedule: SCHEDULE,
    // пороги сигналов расхода ИИ — у администратора (как в правилах воркера)
    alert_rules: {
      cache_min_share: 0.5,
      cache_analyses: 10,
      cost_factor: 2,
      cost_window_days: 7,
      stops_max_share: 0.02,
      searches_per_day: 30,
      rate_limit_series: 3,
      rate_limit_window_minutes: 10,
    },
  };
}
