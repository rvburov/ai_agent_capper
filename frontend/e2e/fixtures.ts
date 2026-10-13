import type { Page, Route } from '@playwright/test';

import type { components } from '../src/api/schema';
import { aiBudget } from '../src/features/ai/testData';
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
 * Ответы для главной этапа 4, пока экран — заглушка: банк, стратегия и лимит ИИ — тот же набор
 * и те же фабрики, что dashboardApi() в src/test/factories.ts (участник на ключе
 * администратора в октябре 2026, банк 48 000 ₽ без ставок). Маршруты новой главной
 * добавляются сюда и туда вместе с экраном.
 */
export function dashboardApi(): Record<string, MockReply> {
  return {
    'GET /api/me/bank': bankOut(),
    'GET /api/strategy/active': strategyV3(),
    'GET /api/ai/budget': aiBudget(),
  };
}

/**
 * Подменяет /api/*: me — вошедший пользователь, null — сеанса нет (401). Сам отвечает на то,
 * что нужно любому экрану (как baseApi в src/test/factories.ts): /api/me, CSRF, валюта
 * программы, колокольчик, выход. api — ответы экрана: { 'GET /api/bets': {...} } или
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

