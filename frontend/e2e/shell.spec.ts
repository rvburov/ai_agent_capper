import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { collectErrors, expectTapTargets, horizontalOverflow, ME_ADMIN, ME_MEMBER, mockApi } from './fixtures';

// 360 px — самый узкий телефон из PLAN.md, 375 px — из CLAUDE.md
const VIEWPORTS = [
  { name: 'телефон', width: 360, height: 780, mobile: true },
  { name: 'телефон', width: 375, height: 812, mobile: true },
  { name: 'компьютер', width: 1366, height: 900, mobile: false },
] as const;
const THEMES = ['light', 'dark'] as const;

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    test(`оболочка: ${vp.name} ${vp.width}px, тема ${theme}`, async ({ page }) => {
      const errors = collectErrors(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: theme });
      await mockApi(page, ME_ADMIN);
      await page.goto('/');

      await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
      await expect(page).toHaveTitle('Главная · AI Capper');
      // тема как в системе: без data-theme, цвет фона из токенов темной или светлой темы
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe(theme === 'dark' ? 'rgb(13, 17, 15)' : 'rgb(241, 244, 240)');
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

      if (vp.mobile) {
        // как в макете: знака AI Capper в шапке телефона нет, заголовок раздела от края
        await expect(page.locator('.topbar .brand-mark')).toHaveCount(0);
        const tabbar = page.getByRole('navigation', { name: 'Нижняя навигация' });
        await expect(tabbar).toBeVisible();
        await expect(page.getByRole('complementary', { name: 'Основная навигация' })).toBeHidden();
        await tabbar.getByRole('button', { name: 'Еще' }).click();
        const sheet = page.getByRole('dialog', { name: 'Еще' });
        await expect(sheet).toBeVisible();
        await expect(sheet.getByRole('link', { name: 'Администрирование' })).toBeVisible();
        await sheet.getByRole('link', { name: 'Игроки' }).click();
        await expect(sheet).toBeHidden();
        await expect(page.getByRole('heading', { level: 1, name: 'Игроки' })).toBeVisible();
        await expect(page).toHaveURL(/\/players$/);
        // зоны нажатия шапки и нижних вкладок не меньше 40 px
        await expectTapTargets(page, { root: tabbar });
        await expectTapTargets(page, { root: page.locator('.topbar') });
      } else {
        const sidebar = page.getByRole('complementary', { name: 'Основная навигация' });
        await expect(sidebar).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Нижняя навигация' })).toBeHidden();
        await expect(sidebar.getByText('Управление')).toBeVisible();
        await sidebar.getByRole('link', { name: 'Ставки' }).click();
        await expect(page.getByRole('heading', { level: 1, name: 'Ставки' })).toBeVisible();
        await expect(sidebar.getByRole('link', { name: 'Ставки' })).toHaveAttribute('aria-current', 'page');
      }
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
}

test('участник не видит «Управление», а по прямой ссылке — объяснение', async ({ page }) => {
  const errors = collectErrors(page);
  await mockApi(page, ME_MEMBER);
  await page.goto('/');
  const sidebar = page.getByRole('complementary', { name: 'Основная навигация' });
  await expect(sidebar.getByRole('link', { name: 'Главная' })).toBeVisible();
  await expect(sidebar.getByText('Управление')).toHaveCount(0);
  await expect(sidebar.getByRole('link', { name: 'Администрирование' })).toHaveCount(0);
  await page.goto('/admin/users');
  await expect(page.getByText('Раздел только для администратора')).toBeVisible();
  expect(errors).toEqual([]);
});

test('без сеанса — страница входа с возвратом', async ({ page }) => {
  const errors = collectErrors(page);
  await mockApi(page, null);
  await page.goto('/bets?status=open');
  await expect(page).toHaveURL(/\/login\?next=%2Fbets%3Fstatus%3Dopen$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Вход' })).toBeVisible();
  // ответ 401 на /api/me браузер пишет в консоль как ошибку загрузки — это ожидаемо
  expect(errors.filter((e) => !e.includes('401'))).toEqual([]);
});

test('тема: переключатель в шапке, выбор переживает перезагрузку', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await mockApi(page, ME_ADMIN);
  await page.goto('/');
  await page.getByRole('button', { name: 'Темная тема' }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // меню пользователя: «Как в системе» снимает выбор
  await page.getByRole('button', { name: 'Меню пользователя' }).click();
  const menu = page.getByRole('dialog', { name: 'Меню пользователя' });
  await menu.getByRole('button', { name: 'Как в системе' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('меню пользователя закрывается, когда фокус уходит из него', async ({ page }) => {
  await mockApi(page, ME_ADMIN);
  await page.goto('/bets');
  const avatar = page.getByRole('button', { name: 'Меню пользователя' });
  const menu = page.getByRole('dialog', { name: 'Меню пользователя' });
  await avatar.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeVisible();
  // Tab по пунктам меню: пока фокус внутри, меню открыто
  await page.keyboard.press('Tab');
  await expect(menu.getByRole('link', { name: 'Личный кабинет' })).toBeFocused();
  // Shift+Tab — на кнопку меню: меню еще открыто; дальше — колокольчик: меню закрылось
  await page.keyboard.press('Shift+Tab');
  await expect(avatar).toBeFocused();
  await expect(menu).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Уведомления', exact: true })).toBeFocused();
  await expect(menu).toBeHidden();
  // Tab вперед за последний пункт меню тоже закрывает его
  await avatar.click();
  await expect(menu).toBeVisible();
  for (let i = 0; i < 10 && (await menu.count()) > 0; i++) await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
});

test('выход: меню пользователя → «Выйти» → страница входа', async ({ page }) => {
  await mockApi(page, ME_ADMIN);
  await page.goto('/analytics');
  await page.getByRole('button', { name: 'Меню пользователя' }).click();
  await page.getByRole('dialog', { name: 'Меню пользователя' }).getByRole('button', { name: 'Выйти' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status').filter({ hasText: 'Вы вышли из аккаунта' })).toBeVisible();
});

test('вкладки-адреса и неизвестная страница', async ({ page }) => {
  await mockApi(page, ME_ADMIN);
  await page.goto('/profile/security');
  const tabs = page.getByRole('tablist', { name: 'Вкладки личного кабинета' });
  await expect(tabs.getByRole('tab', { name: 'Безопасность' })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: 'Безопасность' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/profile\/bank$/);
  await page.goto('/profile/nope');
  await expect(page).toHaveURL(/\/profile$/);
  await page.goto('/no-such-page');
  await expect(page.getByText('Такой страницы нет')).toBeVisible();
});

test('экран не загрузился после выкладки: одна автоперезагрузка, потом текст и «Обновить страницу»', async ({ page }) => {
  // сколько раз документ загружался: счетчик в sessionStorage до скриптов приложения
  await page.addInitScript(() => {
    sessionStorage.setItem('e2e.loads', String(Number(sessionStorage.getItem('e2e.loads') ?? 0) + 1));
  });
  const loads = () => page.evaluate(() => Number(sessionStorage.getItem('e2e.loads')));
  await mockApi(page, ME_ADMIN);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  expect(await loads()).toBe(1);
  // файла экрана «Новый анализ» на сервере нет — как после выкладки новой версии
  await page.route(/\/assets\/NewAnalysisPage-[^/]+\.js$/, (route) => route.abort());
  await page.getByRole('complementary', { name: 'Основная навигация' }).getByRole('link', { name: 'Новый анализ' }).click();
  // первая ошибка — страница перезагружается сама; вторая подряд (новая версия уже загружена) —
  // текст сбоя без цикла, а не «Вышла новая версия»
  await expect(page.getByText('Экран не загрузился')).toBeVisible();
  await expect(page.getByText('Вышла новая версия программы')).toHaveCount(0);
  await expect(page).toHaveURL(/\/new$/);
  expect(await loads()).toBe(2);
  await page.waitForTimeout(500);
  expect(await loads()).toBe(2);
  // файл снова на месте: «Обновить страницу» открывает экран
  await page.unroute(/\/assets\/NewAnalysisPage-[^/]+\.js$/);
  await page.getByRole('button', { name: 'Обновить страницу' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Новый анализ' })).toBeVisible();
  await expect(page.getByText('Экран не загрузился')).toHaveCount(0);
});

test('долгий переход на экран: шапка и меню — нового экрана, на месте прежнего — индикатор', async ({ page }) => {
  await mockApi(page, ME_ADMIN);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  // файл экрана «Новый анализ» отдается через 2 с — медленная мобильная сеть
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/assets\/NewAnalysisPage-[^/]+\.js$/, async (route) => {
    await released;
    await route.continue();
  });
  const nav = page.getByRole('complementary', { name: 'Основная навигация' });
  await nav.getByRole('link', { name: 'Новый анализ' }).click();
  await expect(page.getByRole('status', { name: 'Загружаем экран' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Новый анализ' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Новый анализ' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main')).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.getByRole('status', { name: 'Загружаем экран' })).toHaveCount(0);
  await expect(page.getByRole('main')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page).toHaveURL(/\/new$/);
});

test('CSP: preview отдает ту же политику, что Caddy, и страница ее не нарушает', async ({ page }) => {
  const caddyfile = readFileSync(new URL('../../deploy/Caddyfile', import.meta.url), 'utf8');
  const policy = /Content-Security-Policy\s+"([^"]+)"/.exec(caddyfile)?.[1];
  expect(policy).toBeTruthy();
  const errors = collectErrors(page);
  await mockApi(page, ME_ADMIN);
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toBe(policy);
  await expect(page.getByRole('heading', { level: 1, name: 'Главная' })).toBeVisible();
  // Нарушение видно в консоли: событие securitypolicyviolation (collectErrors) и текст Chromium
  await page.evaluate(() => {
    const probe = document.createElement('img');
    probe.src = 'https://example.com/csp-probe.png';
    document.body.append(probe);
  });
  await expect.poll(() => errors.some((e) => e.includes('CSP: img-src'))).toBe(true);
});
