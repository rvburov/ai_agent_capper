import type { Page, Route } from '@playwright/test';

import type { components } from '../src/api/schema';
import { aiBudget } from '../src/features/ai/testData';
import { rankingOut } from '../src/features/players/testData';
// та же стратегия v3, что strategyV3() unit-тестов (Node требует атрибут у JSON)
import strategy from '../src/features/analysis/fixtures/strategy.json' with { type: 'json' };

export {
  expectNoHorizontalScroll,
  expectScreenLayout,
  expectTapTargets,
  horizontalOverflow,
  smallTapTargets,
} from './support/layout';

// Ответы API для смоука оболочки и экранов с подмененным API (проект shell). Типы — из
// OpenAPI (src/api/schema.d.ts): смена схемы бэкенда ломает tsc -p e2e, а не тест молча.
type Schemas = components['schemas'];

export const ME_ADMIN = {
  id: 1,
  email: 'owner@example.com',
  display_name: 'Роман Буров',
  role: 'admin',
  status: 'active',
  ai_mode: 'shared',
  tz: 'Europe/Helsinki',
  totp_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
  consent_training: false,
  deletion_requested_at: null,
  deletion_at: null,
} as const satisfies Schemas['MeOut'];

export const ME_MEMBER = {
  ...ME_ADMIN,
  id: 2,
  email: 'anna@example.com',
  display_name: 'Анна Петрова',
  role: 'member',
} as const satisfies Schemas['MeOut'];

type Me = typeof ME_ADMIN | typeof ME_MEMBER;

export const SETTINGS: Schemas['PublicSettingsOut'] = { currency: 'RUB' };

/** Банк участника без ставок: 48 000 ₽ (как bankOut() в src/features/analysis/testData.ts). */
export function bankOut(over: Partial<Schemas['BankOut']> = {}): Schemas['BankOut'] {
  return {
    currency: 'RUB',
    empty: false,
    balance: '48000.00',
    in_play: '0.00',
    equity: '48000.00',
    peak: '48000.00',
    drawdown: '0.0000',
    invested: '48000.00',
    growth: null,
    week_change: null,
    winrate: null,
    settled_bets: 0,
    drawdown_level: null,
    adaptations: [],
    ...over,
  };
}

/** Активная стратегия v3 по умолчанию (GET /api/strategy/active). */
export function strategyV3(): Schemas['StrategyOut'] {
  return structuredClone(strategy) as Schemas['StrategyOut'];
}

/** Ответ на запрос: тело JSON или свой обработчик. */
export type MockReply = unknown | ((route: Route) => Promise<void>);

/**
 * Главная нового участника (GET /api/dashboard): банк 48 000 ₽, ставок еще нет, 30 дней —
 * показатели пустые, малая выборка. Числа рядов и порогов — как у сервера.
 */
export function dashboardOut(over: Partial<Schemas['DashboardOut']> = {}): Schemas['DashboardOut'] {
  return {
    period: '30d',
    date_from: '2026-09-14',
    date_to: '2026-10-13',
    kpi: {
      settled: 0,
      won: 0,
      lost: 0,
      void: 0,
      turnover: '0.00',
      profit: '0.00',
      roi: null,
      roi_ci: null,
      winrate: null,
      clv: null,
      clv_ci: null,
      clv_positive: 0,
      clv_n: 0,
      legacy_settled: 0,
    },
    prev: null,
    change: null,
    brier: {
      n: 0,
      model: null,
      market: null,
      diff: null,
      diff_ci: null,
      noise: null,
      closing_n: 0,
      closing_model: null,
      closing_market: null,
      points: [],
      windows: 0,
      better: 0,
    },
    series: {
      kind: 'bank',
      group: 'week',
      start: '2026-09-13',
      base: '48000.00',
      start_day: '2026-09-13',
      start_amount: '48000.00',
      change_share: 0,
      last: '48000.00',
      peak: '48000.00',
      max_drawdown: 0,
      best: '48000.00',
      worst: '48000.00',
      points: [
        { day: '2026-09-13', value: '48000.00' },
        { day: '2026-10-13', value: '48000.00' },
      ],
      rows: [],
    },
    recent: [],
    small_sample: true,
    currency: 'RUB',
    tz: 'Europe/Helsinki',
    today: '2026-10-13',
    greeting: 'day',
    thresholds: {
      small_sample: 20,
      insight_min_events: 30,
      calibration_min_n: 8,
      calibration_gap: 0.04,
      calibration_few: 60,
      slice_pattern_n: 30,
      dashboard_small: 15,
      rolling_window: 30,
      rolling_step: 3,
    },
    bank: bankOut(),
    open_bets: [],
    open_count: 0,
    open_stake: '0.00',
    my_matches: [],
    admin: null,
    ...over,
  };
}

/** Дела администратора (GET /api/admin/attention): архив свежий, просьб и участников у лимита нет. */
export function adminAttention(over: Partial<Schemas['AdminAttentionOut']> = {}): Schemas['AdminAttentionOut'] {
  return {
    archive: null,
    archive_status: {
      days: 0,
      last_load: '2026-10-13T03:30:00Z',
      stale_after_days: 3,
      update_hour_utc: 3,
      update_minute: 30,
      sources: [],
      stale: false,
    },
    return_requests: [],
    limits: [],
    alert_pct: 80,
    ...over,
  };
}

/**
 * Свой расход ИИ за октябрь (GET /api/ai/usage) — как aiUsageOut() в
 * src/features/dashboard/testData.ts ($1,93, из кэша 68%, прогноз $4,50). Здесь своей копией:
 * тот файл тянет фикстуры JSON без атрибута импорта, а Playwright грузит модули сам.
 */
export function aiUsage(): Schemas['AiUsageOut'] {
  const sums = (cost: number, cacheShare = 0.7): Schemas['AiUsageOut']['totals'] => ({
    runs: 10,
    errors: 0,
    cost_usd: cost,
    input_tokens: 20_000,
    cache_write_tokens: 10_000,
    cache_read_tokens: 70_000,
    output_tokens: 8_000,
    prompt_tokens: 100_000,
    web_searches: 4,
    cache_share: cacheShare,
  });
  const kind = (name: string, cost: number): Schemas['AiUsageOut']['kinds'][number] => ({
    ...sums(cost),
    kind: name,
    share: cost / 1.93,
    avg_cost_usd: cost / 10,
    avg_prompt_tokens: 10_000,
    avg_output_tokens: 800,
    models: [],
    efforts: [],
  });
  return {
    month: '2026-10',
    month_start: '2026-10-01',
    last_day: '2026-10-31',
    days_in_month: 31,
    days_elapsed: 13,
    current: true,
    totals: sums(1.93, 0.68),
    own_usd: 1.93,
    acceptance_usd: 0,
    shared_usd: 0,
    admin_key_usd: 1.93,
    own_key_usd: 0,
    search_usd: 0.08,
    cache_saved_usd: 0.4,
    days: [],
    kinds: [kind('analysis', 1.43), kind('news', 0.38), kind('parse', 0.12)],
    models: [],
    steps: [],
    versions: [],
    analyses: [],
    avg_analysis_usd: 0.13,
    admin_key_avg_usd: 0.13,
    forecast_usd: 4.5,
    analyses_left: 62,
    pace_usd: 0.32,
    prices: [],
    settings: {
      parse_model: 'claude-haiku-5-5',
      parse_effort: 'low',
      news_enabled: true,
      news_model: 'claude-sonnet-5-5',
      news_effort: 'low',
      news_searches_per_match: 2,
      news_searches_per_analysis: 6,
      news_searches_per_day: 40,
      news_ttl_hours: 12,
      news_lookback_days: 7,
      news_domains: [],
      news_prompt_cache: true,
      analysis_model: 'claude-opus-5-5',
      analysis_effort: 'medium',
      analysis_parallel: 2,
      assessment_reuse_hours: 6,
      soft_cap_usd: 0.5,
      hard_cap_usd: 1.5,
      default_per_analysis_usd: 0.5,
    },
  };
}

/**
 * Ответы главной: показатели периода, банк, стратегия, лимит и расход ИИ — как dashboardApi() в
 * src/test/factories.ts (участник на ключе администратора в октябре 2026, банк 48 000 ₽).
 */
export function dashboardApi(): Record<string, MockReply> {
  return {
    'GET /api/dashboard': dashboardOut(),
    'GET /api/me/bank': bankOut(),
    'GET /api/strategy/active': strategyV3(),
    'GET /api/ai/budget': aiBudget(),
    // «Расходы ИИ» участника на главной (прогноз и доля кэша); администратору не запрашивается
    'GET /api/ai/usage': aiUsage(),
  };
}

/**
 * Ответ «Игроков» (этап 4): первая страница списка. Смоук оболочки на телефоне открывает
 * /players из шторки «Еще» — без него экран ловил бы 404.
 */
export function playersApi(): Record<string, MockReply> {
  return { 'GET /api/players/ranking': rankingOut() };
}

/**
 * Ответы «Ставок» (этап 4) для участника без ставок: пустой список, нулевые итоги и банк
 * 48 000 ₽. Смоук оболочки открывает /bets из меню — без них экран ловил бы 404.
 */
export function betsApi(): Record<string, MockReply> {
  const summary: Schemas['BetsSummaryOut'] = {
    currency: 'RUB',
    settled: 0,
    won: 0,
    lost: 0,
    void: 0,
    winrate: null,
    turnover: '0.00',
    profit: '0.00',
    roi: null,
    avg_stake: null,
    open: 0,
    open_stake: '0.00',
    clv: null,
    clv_positive: 0,
    clv_n: 0,
    legacy_settled: 0,
  };
  const page: Schemas['BetPageOut'] = { items: [], next_before: null };
  return {
    'GET /api/bets': page,
    'GET /api/bets/summary': summary,
    'GET /api/me/bank': bankOut(),
  };
}

/**
 * Подменяет /api/*: me — вошедший пользователь, null — сеанса нет (401). Сам отвечает на то,
 * что нужно любому экрану (как baseApi в src/test/factories.ts): /api/me, CSRF, валюта
 * программы, колокольчик, банк для плашки в шапке, выход. api — ответы экрана: { 'GET /api/bets': {...} } или
 * обработчик; для главной — dashboardApi(). Остальное — 404.
 */
export async function mockApi(page: Page, me: Me | null, api: Record<string, MockReply> = {}): Promise<void> {
  const replies: Record<string, MockReply> = { 'GET /api/settings': SETTINGS, ...api };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const reply = replies[`${route.request().method()} ${url.pathname}`];
    if (reply !== undefined && me) {
      if (typeof reply === 'function') await (reply as (route: Route) => Promise<void>)(route);
      else await route.fulfill({ json: reply });
      return;
    }
    if (url.pathname === '/api/me') {
      if (me) await route.fulfill({ json: me });
      else {
        await route.fulfill({
          status: 401,
          json: { error: { code: 'auth.not_authenticated', message: 'Войдите в аккаунт' } },
        });
      }
      return;
    }
    // колокольчик в шапке спрашивает уведомления сам
    if (url.pathname === '/api/me/notifications') {
      await route.fulfill({ json: { items: [], unread: 0 } });
      return;
    }
    // и что присылать: выключенные в кабинете виды он прячет (все включены)
    if (url.pathname === '/api/me/notification-prefs' && me) {
      await route.fulfill({ json: { items: [], push_available: false, alert_rules: null } });
      return;
    }
    // счетчик дел у пункта «Администрирование» (GET /api/admin/attention) — дел нет
    if (url.pathname === '/api/admin/attention' && me?.role === 'admin') {
      await route.fulfill({ json: adminAttention() });
      return;
    }
    // плашка «Банк» в шапке — тоже
    if (url.pathname === '/api/me/bank' && me) {
      await route.fulfill({ json: bankOut() });
      return;
    }
    if (url.pathname === '/api/auth/csrf') {
      await route.fulfill({
        json: { csrf_token: 'e2e' },
        headers: { 'Set-Cookie': 'capper_csrf=e2e; Path=/; SameSite=Lax' },
      });
      return;
    }
    if (url.pathname === '/api/auth/logout' && route.request().method() === 'POST') {
      me = null;
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.fulfill({
      status: 404,
      json: { error: { code: 'common.not_found', message: 'Не найдено' } },
    });
  });
}

/** Ошибки консоли и страницы за время теста. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  // Нарушение CSP сайта (preview отдает ту же политику, что Caddy) — тоже ошибка. Скрипт
  // регистрируется до перехода на страницу: команды Playwright идут по порядку
  void page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

