import type { Page } from '@playwright/test';

import { expect, registeredMember, signedInAdmin, test, uniqueName, type Device } from '../support/test';
import { heading, signInWithBackupCode, toast } from '../support/ui';
import { markSpa, placeBet, settleWon } from './dashboard-steps';

// Р27: администратор видит данные участника — только просмотр, каждый просмотр в журнале.
// «Сводка» → участник → его главная, ставки и «Банк и стратегия» глазами участника → выгрузка
// CSV его ставок → журнал показывает просмотры и выгрузку → «Вернуться к своим». Участник выбора
// «Чьи данные смотреть» не видит, а адрес с ?as= чужого дает понятную ошибку (сервер — 403).

interface Person {
  id: number;
  email: string;
  display_name: string;
}

async function peopleOf(admin: Device): Promise<Person[]> {
  const response = await admin.api.get('/api/admin/users');
  expect(response.ok()).toBe(true);
  return (await response.json()) as Person[];
}

const banner = (page: Page) => page.getByRole('region', { name: 'Режим просмотра данных участника' });

test('администратор: сводка → данные участника → CSV → журнал → «Вернуться к своим»', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'сценарий на компьютере; раскладку телефона проверяет all-routes.spec.ts');
  test.setTimeout(180_000);

  const admin = await device();
  await signedInAdmin(admin, uniqueName('Смотрит Админ'));
  const name = uniqueName('Ольга Просмотр');
  const account = await registeredMember(admin, apiClient, name);
  const m = await device();
  await signInWithBackupCode(m.page, account);
  // данные участника: ставка по анализу, рассчитана
  const { id: betId } = await placeBet(m.page);
  await m.page.goto(`/bets?bet=${betId}`);
  await settleWon(m.page, betId);
  const member = (await peopleOf(admin)).find((p) => p.email === account.email);
  expect(member).toBeDefined();
  const memberId = member!.id;

  const page = admin.page;
  // «Сводка»: строка участника открывает его главную в режиме просмотра
  await page.goto('/admin/summary');
  const table = page.getByRole('table', { name: 'По участникам' });
  await expect(table).toBeVisible();
  await table.getByRole('row', { name: new RegExp(`^${name}: открыть данные`) }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?as=${memberId}$`));
  await expect(banner(page)).toContainText(name);
  await expect(banner(page)).toContainText('только просмотр');
  await expect(page.getByRole('heading', { level: 2, name: new RegExp(`, ${name.split(' ')[0]}$`) })).toBeVisible();
  await markSpa(page);

  // «Ставки» пунктом меню — режим сохраняется, «Внести результат» и правки недоступны
  await page.getByRole('complementary', { name: 'Основная навигация' }).getByRole('link', { name: /^Ставки(\s|$)/ }).click();
  await expect(page).toHaveURL(new RegExp(`/bets\\?as=${memberId}$`));
  expect(await page.evaluate(() => (window as Window & { __spa?: boolean }).__spa)).toBe(true);
  await expect(banner(page)).toContainText(name);
  await expect(page.getByRole('table', { name: 'Рассчитанные ставки по месяцам' })).toBeVisible();
  const correct = page.getByRole('button', { name: /^Исправить результат\. Только просмотр/ }).first();
  await expect(correct).toHaveAttribute('aria-disabled', 'true');
  // aria-disabled: Playwright считает кнопку неактивной, но нажать ее можно — она объясняет почему
  await correct.click({ force: true });
  await expect(toast(page, 'Только просмотр: менять данные участника может только он сам')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // «Экспорт CSV» работает (В2): ставки участника, выгрузка — в журнал
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Экспорт CSV/ }).click();
  const file = await download;
  const csv = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(csv).toString('utf8')).toContain(String(betId));

  // «Банк и стратегия» участника: значения без форм
  await page.goto(`/profile/bank?as=${memberId}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Банк и стратегия' })).toBeVisible();
  await expect(page.getByText('Только просмотр: лимиты и паузу меняет сам участник.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Записать' })).toHaveCount(0);

  // «Вернуться к своим»: те же «Ставки», свои данные
  await page.goto(`/bets?as=${memberId}`);
  await banner(page).getByRole('button', { name: 'Вернуться к своим' }).click();
  await expect(toast(page, 'Вы снова смотрите свои данные')).toBeVisible();
  await expect(page).toHaveURL(/\/bets$/);
  await expect(banner(page)).toHaveCount(0);

  // журнал: просмотры экранов и выгрузка CSV
  await page.goto('/admin/audit');
  await page.getByRole('button', { name: /^Тип действия/ }).click();
  await page.getByRole('option', { name: 'Просмотр данных участников' }).click();
  const log = page.locator('#admin-panel');
  await expect(log.getByText('Выгрузка данных участника').first()).toBeVisible();
  await expect(log.getByText('Ставки, CSV').first()).toBeVisible();
  await expect(log.getByText('Ставки · только просмотр').first()).toBeVisible();
  await expect(log.getByText('Главная · только просмотр').first()).toBeVisible();
  await expect(log.getByText('Сводка за 30 дней · только просмотр').first()).toBeVisible();
  await expect(log.getByText(name).first()).toBeVisible();
});

test('участник: выбора «Чьи данные смотреть» нет, ?as= чужого — ошибка, сервер отвечает 403', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'не зависит от ширины');
  const admin = await device();
  const adminAccount = await signedInAdmin(admin, uniqueName('Чужой Админ'));
  const account = await registeredMember(admin, apiClient, uniqueName('Любопытный Участник'));
  const adminId = (await peopleOf(admin)).find((p) => p.email === adminAccount.email)!.id;
  const m = await device();
  await signInWithBackupCode(m.page, account);

  await expect(heading(m.page, 'Главная')).toBeVisible();
  await expect(m.page.getByRole('button', { name: /Чьи данные смотреть/ })).toHaveCount(0);

  await m.page.goto(`/bets?as=${adminId}`);
  await expect(m.page.getByRole('heading', { name: 'Чужие данные недоступны' })).toBeVisible();
  await expect(m.page.getByText(/может смотреть только администратор/)).toBeVisible();
  await expect(banner(m.page)).toHaveCount(0);

  for (const path of ['/api/bets', '/api/dashboard', '/api/me/bank']) {
    const response = await m.api.get(`${path}?as_user=${adminId}`);
    expect(response.status(), path).toBe(403);
  }
  await m.page.getByRole('link', { name: 'К своим данным' }).click();
  await expect(m.page).toHaveURL(/\/$/);
});
