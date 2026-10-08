import type { Page } from '@playwright/test';

// Ответы API для смоука оболочки: только то, что оболочка спрашивает сама.
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
} as const;

export const ME_MEMBER = { ...ME_ADMIN, id: 2, email: 'anna@example.com', display_name: 'Анна Петрова', role: 'member' } as const;

type Me = typeof ME_ADMIN | typeof ME_MEMBER;

/** Подменяет /api/*: me — вошедший пользователь, null — сеанса нет (401). */
export async function mockApi(page: Page, me: Me | null): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
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
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Есть ли горизонтальная прокрутка страницы. */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}
