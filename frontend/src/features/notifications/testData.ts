import type { NotificationPrefs } from './prefs';

type Kind = NotificationPrefs['items'][number]['kind'];

/** Настройки «что присылать» участника на ключе администратора; off — выключенные виды. */
export function memberPrefsOut(off: Kind[] = []): NotificationPrefs {
  const item = (kind: Kind, group: string, required = false) => ({
    kind,
    group,
    on_site: required || !off.includes(kind),
    push: false,
    required,
    admin: false,
  });
  return {
    items: [
      item('bet_settled', 'bet'),
      item('limit_80', 'limit'),
      item('limit_100', 'limit'),
      item('ai_mode_decision', 'decision'),
      item('new_device', 'login', true),
      item('login_failures', 'fails', true),
      item('admin_message', 'message', true),
    ],
    push_available: false,
    alert_rules: null,
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
  });
  return {
    items: [
      item('bet_settled', 'bet'),
      item('new_device', 'login', { required: true }),
      item('login_failures', 'fails', { required: true }),
      item('admin_message', 'message', { required: true }),
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
