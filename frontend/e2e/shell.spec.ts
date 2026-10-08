import { expect, test } from '@playwright/test';

import { collectErrors, horizontalOverflow, ME_ADMIN, ME_MEMBER, mockApi } from './fixtures';

const VIEWPORTS = [
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
        // зоны нажатия нижних вкладок не меньше 40 px
        for (const box of await tabbar.locator('.tab').evaluateAll((els) =>
          els.map((el) => el.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })),
        )) {
          expect(box.w).toBeGreaterThanOrEqual(40);
          expect(box.h).toBeGreaterThanOrEqual(40);
        }
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
