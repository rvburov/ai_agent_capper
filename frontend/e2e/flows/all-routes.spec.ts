import type { Page } from '@playwright/test';

import { memberDevice } from '../support/analysis';
import { expectScreenLayout } from '../support/layout';
import { appUrls, routePatterns, type AppUrl } from '../support/routes';
import { expect, registeredMember, signedInAdmin, test, uniqueName, type Device } from '../support/test';
import { signInWithBackupCode } from '../support/ui';
import { placeBet, settleWon } from './dashboard-steps';

// Общая проверка раскладки по всем маршрутам приложения (список — из src/app/router.tsx, см.
// e2e/support/routes.ts): на телефоне 375 px и 360 px (метка @360), в светлой и темной темах — нет
// прокрутки вбок, зоны нажатия не меньше 40 px, ошибок консоли и ответов 5xx нет (их ловит фикстура
// device). Зоны нажатия меряются по всей странице — с шапкой, боковой панелью и нижними вкладками,
// а у участника и администратора еще и с открытым колокольчиком (окно уведомлений). Данные на
// экранах настоящие: у участника — анализ и рассчитанная ставка, у администратора — его разделы,
// «ИИ и расходы» и кабинет.

const THEMES = ['light', 'dark'] as const;

// «Перейти к содержимому» — для клавиатуры: спрятана за верхним краем окна (top: -60px), пока на
// ней нет фокуса, пальцем на нее не нажимают
const PAGE_LAYOUT = { exclude: '.skip-link' } as const;

/** Экран загрузился: заголовок в шапке есть, заглушек загрузки на месте данных нет. */
async function settled(page: Page, guest: boolean): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  if (guest) return;
  await expect(page.locator('#view')).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => page.locator('#view .skeleton').count(), { timeout: 15_000 }).toBe(0);
}

async function checkUrls(device: Device, urls: readonly AppUrl[]): Promise<string[]> {
  const page = device.page;
  const seen: string[] = [];
  for (const item of urls) {
    await test.step(`${item.url} (${item.pattern})`, async () => {
      await page.goto(item.url);
      const guest = item.who === 'guest';
      await settled(page, guest);
      for (const scheme of THEMES) {
        await page.emulateMedia({ colorScheme: scheme });
        // вся страница: экран, шапка, меню и нижние вкладки
        await expectScreenLayout(page, { ...PAGE_LAYOUT, root: page.locator('body') });
      }
      await page.emulateMedia({ colorScheme: 'light' });
      seen.push(item.url);
    });
  }
  return seen;
}

/** Открытый колокольчик (окно уведомлений) на главной: раскладка всей страницы в обеих темах. */
async function checkBell(device: Device): Promise<void> {
  const page = device.page;
  await test.step('колокольчик', async () => {
    await page.goto('/');
    await settled(page, false);
    await page.getByRole('button', { name: /^Уведомления/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Уведомления' });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.locator('.skeleton').count(), { timeout: 15_000 }).toBe(0);
    for (const scheme of THEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectScreenLayout(page, { ...PAGE_LAYOUT, root: page.locator('body') });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}

test('список маршрутов — из router.tsx, каждый описан в routes.ts', () => {
  const patterns = routePatterns();
  expect(patterns).toEqual(expect.arrayContaining(['/login', '/index', 'bets', 'analytics', 'players/:id/:tab?', 'costs', 'profile/:tab?', 'admin/:tab?', '*']));
  // каждый шаблон превращается в адреса; новый маршрут без описания роняет этот тест
  expect(() => appUrls({ analysisId: 1, playerId: 1 }, patterns)).not.toThrow();
  expect(() => appUrls({ analysisId: 1, playerId: 1 }, [...patterns, 'new-screen'])).toThrow(/new-screen/);
});

test('все экраны на телефоне: без прокрутки вбок, зоны нажатия, обе темы', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  test.skip(!isMobile, 'раскладка телефона: 375 px и 360 px');
  test.setTimeout(240_000);

  // администратор, участник по его приглашению и гость без входа
  const admin = await device();
  await signedInAdmin(admin, uniqueName('Обход Админов'));
  const member = await registeredMember(admin, apiClient, uniqueName('Обход Маршрутов'));
  const m = await device();
  await signInWithBackupCode(m.page, member);
  // данные экранов: анализ и рассчитанная ставка
  const { id } = await placeBet(m.page);
  const analysisId = Number(/\/analysis\/(\d+)/.exec(m.page.url())?.[1]);
  // ссылка на открытую ставку сама открывает окно результата
  await m.page.goto(`/bets?bet=${id}`);
  await settleWon(m.page, id);
  const ranking = (await (await m.api.get('/api/players/ranking?q=%D1%81%D0%B8%D0%BD%D0%BD%D0%B5%D1%80')).json()) as { items: { id: number }[] };
  const playerId = ranking.items[0]?.id ?? 0;
  expect(playerId).toBeGreaterThan(0);

  const urls = appUrls({ analysisId, playerId });
  const guest = await device();
  const seen = [
    ...(await checkUrls(guest, urls.filter((u) => u.who === 'guest'))),
    ...(await checkUrls(m, urls.filter((u) => u.who === 'member'))),
    ...(await checkUrls(admin, urls.filter((u) => u.who === 'admin'))),
    // у администратора свои виды общих экранов: дела на главной, бюджет ключа, разделы кабинета
    ...(await checkUrls(admin, ['/', '/costs', '/profile/notifications', '/profile/data'].map((url) => ({ url, who: 'admin' as const, pattern: 'вид администратора' })))),
  ];
  expect(seen.length).toBe(urls.length + 4);
  await checkBell(m);
  await checkBell(admin);
});

test('гостю закрыты экраны приложения: адрес из списка маршрутов ведет на вход', async ({ device, isMobile }) => {
  test.skip(isMobile, 'не зависит от ширины');
  const guest = await device();
  const urls = appUrls({ analysisId: 1, playerId: 1 }).filter((u) => u.who !== 'guest' && u.pattern !== '*');
  for (const item of urls.slice(0, 3)) {
    await guest.page.goto(item.url);
    // главная — просто вход, остальные — вход с возвратом на этот адрес
    await expect(guest.page).toHaveURL(item.url === '/' ? /\/login$/ : /\/login\?next=/);
  }
});

// Участник не видит разделов администратора даже по прямому адресу
test('участнику /admin/* — «Раздел только для администратора»', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'не зависит от ширины');
  const m = await memberDevice(device, apiClient, 'Прямой Адрес');
  for (const item of appUrls({ analysisId: 1, playerId: 1 }).filter((u) => u.who === 'admin').slice(0, 2)) {
    await m.page.goto(item.url);
    await expect(m.page.getByText('Раздел только для администратора')).toBeVisible();
  }
});
