import { aiUsageOut } from '../dashboard/testData';
import type { Activity, AdminAiUsage, AiRun, AiRuns, AiUsage, CostPart, PersonActivity, PersonUsage, RunCost } from './types';

// Данные для тестов «ИИ и расходов» и «Администрирование → Расход ИИ»: октябрь 2026 (UTC),
// участник на ключе администратора, расход $1,93 за 13 дней.

function part(tokens: number, price: number): CostPart {
  return { tokens, price, cost_usd: Math.round(tokens * price) / 1_000_000 };
}

/** Разбор цены вызова Opus: вход 2000, чтение кэша 30 000, выход 3000 токенов — $0,100. */
export function runCost(over: Partial<RunCost> = {}): RunCost {
  return {
    valid_from: '2026-09-01T00:00:00Z',
    input: part(2_000, 5),
    cache_write_5m: part(0, 6.25),
    cache_write_1h: part(0, 10),
    cache_read: part(30_000, 0.5),
    output: part(3_000, 25),
    searches: { tokens: 0, price: 0.01, cost_usd: 0 },
    long_factor: 1,
    batch: false,
    ...over,
  };
}

export function aiRunOut(over: Partial<AiRun> = {}): AiRun {
  return {
    id: 301,
    created_at: '2026-10-13T09:20:00Z',
    kind: 'analysis',
    step: 3,
    model: 'claude-opus-5-5',
    effort: 'medium',
    prompt_version: 'analysis-v3',
    key_source: 'admin',
    analysis_id: 42,
    shared: false,
    acceptance: false,
    batch: false,
    input_tokens: 2_000,
    cache_write_tokens: 0,
    cache_read_tokens: 30_000,
    output_tokens: 3_000,
    thinking_tokens: 1_200,
    prompt_tokens: 32_000,
    web_searches: 0,
    cache_share: 30_000 / 32_000,
    cost_usd: 0.1,
    duration_ms: 41_000,
    stop_reason: 'end_turn',
    error: null,
    price: runCost(),
    ...over,
  };
}

/** Вызов новостей Sonnet с двумя веб-поисками и записью в кэш. */
export const NEWS_RUN = aiRunOut({
  id: 300,
  created_at: '2026-10-13T09:19:00Z',
  kind: 'news',
  step: 2,
  model: 'claude-sonnet-5-5',
  effort: 'low',
  prompt_version: 'news-v2',
  input_tokens: 9_000,
  cache_write_tokens: 6_000,
  cache_read_tokens: 0,
  output_tokens: 700,
  thinking_tokens: null,
  prompt_tokens: 15_000,
  web_searches: 2,
  cache_share: 0,
  cost_usd: 0.071,
  price: runCost({
    input: part(9_000, 3),
    cache_write_5m: part(6_000, 3.75),
    cache_read: part(0, 0.3),
    output: part(700, 15),
    searches: { tokens: 2, price: 0.01, cost_usd: 0.02 },
  }),
});

export function aiRunsOut(items: AiRun[] = [aiRunOut(), NEWS_RUN], over: Partial<AiRuns> = {}): AiRuns {
  return {
    items,
    total_runs: items.length,
    total_cost_usd: Math.round(items.reduce((sum, run) => sum + run.cost_usd, 0) * 1000) / 1000,
    next_before: null,
    ...over,
  };
}

/** Свой расход за октябрь с днями, моделями задач, версиями инструкций, анализами и ценами. */
export function aiUsageFull(over: Partial<AiUsage> = {}): AiUsage {
  const base = aiUsageOut();
  const [analysis, news, parse] = base.kinds;
  return aiUsageOut({
    days: [
      { ...base.totals, day: '2026-10-12', runs: 4, cost_usd: 0.61, cache_share: 0.66, kinds: [{ kind: 'analysis', runs: 2, cost_usd: 0.45 }, { kind: 'news', runs: 2, cost_usd: 0.16 }] },
      { ...base.totals, day: '2026-10-13', runs: 6, cost_usd: 1.32, cache_share: 0.7, kinds: [{ kind: 'analysis', runs: 3, cost_usd: 0.98 }, { kind: 'news', runs: 2, cost_usd: 0.22 }, { kind: 'parse', runs: 1, cost_usd: 0.12 }] },
    ],
    kinds: [
      { ...analysis!, models: ['claude-opus-5-5'], efforts: ['medium'] },
      { ...news!, models: ['claude-sonnet-5-5'], efforts: ['low'] },
      { ...parse!, models: ['claude-haiku-5-5'], efforts: ['low'] },
    ],
    versions: [
      { kind: 'analysis', prompt_version: 'analysis-v3', runs: 5, cost_usd: 1.43, avg_cost_usd: 0.286 },
      { kind: 'news', prompt_version: 'news-v2', runs: 4, cost_usd: 0.38, avg_cost_usd: 0.095 },
    ],
    analyses: [
      { id: 41, started_at: '2026-10-12T18:00:00Z', cost_usd: 0.61, done: true, acceptance: false, key_source: 'admin' },
      { id: 42, started_at: '2026-10-13T09:18:00Z', cost_usd: 1.32, done: true, acceptance: false, key_source: 'admin' },
    ],
    prices: [
      { model: 'claude-opus-5-5', valid_from: '2026-09-01T00:00:00Z', input: 5, output: 25, cache_read: 0.5, cache_write_5m: 6.25, cache_write_1h: 10, search_price: 0.01, long_input_threshold: null, long_multiplier: null },
      { model: 'claude-sonnet-5-5', valid_from: '2026-09-01T00:00:00Z', input: 3, output: 15, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6, search_price: 0.01, long_input_threshold: 200_000, long_multiplier: 2 },
    ],
    ...over,
  });
}

export function personUsage(over: Partial<PersonUsage> = {}): PersonUsage {
  return {
    user_id: 2,
    display_name: 'Ольга Лехтинен',
    role: 'member',
    status: 'active',
    ai_mode: 'shared',
    key_spent_usd: 8.6,
    own_spent_usd: 0,
    analyses: 31,
    own_analyses: 0,
    limit_usd: 10,
    paused: false,
    budget_share: 8.6 / 60,
    limit_share: 0.86,
    // доля в расходе ключа за месяц ($41,20) — с сервера
    spent_share: (over.key_spent_usd ?? 8.6) / 41.2,
    ...over,
  };
}

/** «Расход ИИ» администратора за октябрь: $41,20 из $60, трое на ключе, один на своем. */
export function adminAiUsageOut(over: Partial<AdminAiUsage> = {}): AdminAiUsage {
  return {
    month: '2026-10',
    month_start: '2026-10-01',
    last_day: '2026-10-13',
    days_in_month: 31,
    days_elapsed: 13,
    current: true,
    budget_usd: 60,
    spent_usd: 41.2,
    budget_share: 41.2 / 60,
    analyses: 112,
    avg_analysis_usd: 0.31,
    cache_share: 0.64,
    own_key_usd: 3.4,
    people: [
      personUsage({ user_id: 1, display_name: 'Роман Буров', role: 'admin', key_spent_usd: 27.5, analyses: 70, limit_usd: null, budget_share: 27.5 / 60, limit_share: null }),
      personUsage(),
      personUsage({ user_id: 3, display_name: 'Игорь Нестеров', status: 'blocked', key_spent_usd: 2.0, analyses: 11, limit_usd: 5, paused: true, budget_share: 2 / 60, limit_share: 0.4 }),
      personUsage({ user_id: 5, display_name: 'Дмитрий Шульц', ai_mode: 'own', key_spent_usd: 0, own_spent_usd: 3.4, analyses: 0, own_analyses: 12, budget_share: 0, limit_share: 0 }),
    ],
    shared: { runs: 9, cost_usd: 3.1, cache_share: 0.4, budget_share: 3.1 / 60, kinds: ['analysis', 'news'], spent_share: 3.1 / 41.2 },
    tasks: [
      { kind: 'analysis', runs: 112, cost_usd: 30.2, cache_share: 0.72, budget_share: 30.2 / 60, models: ['claude-opus-5-5'] },
      { kind: 'news', runs: 160, cost_usd: 6.9, cache_share: 0.18, budget_share: 6.9 / 60, models: ['claude-sonnet-5-5'] },
      { kind: 'parse', runs: 40, cost_usd: 1.0, cache_share: null, budget_share: 1 / 60, models: ['claude-haiku-5-5'] },
    ],
    eval: {
      budget_usd: 25,
      spent_usd: 4.5,
      runs: 2,
      items: [{ eval_run_id: 3, created_at: '2026-10-05T10:00:00Z', name: 'Прогон на истории сентября', eval_set: 'sept-2026', n_events: 120, models: ['claude-opus-5-5'], runs: 120, cost_usd: 4.5 }],
    },
    // тратили ключ трое (не больше 4): «остальных» одной строкой нет
    others_ids: [],
    others_count: 0,
    others_usd: 0,
    ...over,
  };
}

export function personActivity(over: Partial<PersonActivity> = {}): PersonActivity {
  return {
    user_id: 2,
    display_name: 'Ольга Лехтинен',
    role: 'member',
    status: 'active',
    logins: 14,
    failed_logins: 0,
    last_login_at: '2026-10-13T08:00:00Z',
    analyses: 31,
    last_analysis_at: '2026-10-13T08:10:00Z',
    ...over,
  };
}

export function activityOut(over: Partial<Activity> = {}): Activity {
  return {
    period: '30d',
    since: '2026-09-13T00:00:00Z',
    logins: 40,
    failed_logins: 2,
    analyses: 112,
    active_users: 3,
    today_users: 2,
    people: [
      personActivity({ user_id: 1, display_name: 'Роман Буров', role: 'admin', logins: 24, analyses: 70 }),
      personActivity(),
      personActivity({ user_id: 3, display_name: 'Игорь Нестеров', status: 'blocked', logins: 2, failed_logins: 2, analyses: 11, last_login_at: '2026-09-20T10:00:00Z' }),
    ],
    ...over,
  };
}
