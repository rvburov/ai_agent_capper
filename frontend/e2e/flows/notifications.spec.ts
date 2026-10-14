import { randomBytes } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expectScreenLayout } from '../support/layout';
import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { signInWithBackupCode, toast } from '../support/ui';

// Кабинет → «Уведомления» и колокольчик на настоящем API: выключенный вид сервер больше не
// присылает, а уже пришедшие колокольчик прячет; включили — снова видны. Обязательные виды
// (вход с нового устройства, неудачные входы, сообщение администратора) не выключаются.

async function openBell(page: Page) {
  await page.getByRole('button', { name: /^Уведомления/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Уведомления' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function closeBell(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Уведомления' })).toBeHidden();
}

/** Участник переходит на свой ключ и просит администратора вернуть его на ключ администратора. */
async function askToReturn(page: Page) {
  await page.goto('/profile/key');
  const group = page.getByRole('radiogroup', { name: 'Чей ключ Claude использовать' });
  await group.locator('label', { has: page.getByRole('radio', { name: /^Свой ключ/ }) }).click();
  await page.getByRole('textbox', { name: 'Ваш ключ' }).fill(`sk-ant-e2e-${randomBytes(12).toString('hex')}`);
  await page.getByRole('button', { name: 'Проверить и сохранить' }).click();
  await expect(toast(page, 'Ключ проверен и сохранен. Анализы теперь идут с вашего счета')).toBeVisible();
  await group.locator('label', { has: page.getByRole('radio', { name: /^Ключ администратора/ }) }).click();
  await page.getByRole('button', { name: 'Попросить администратора вернуть ключ' }).click();
  await expect(toast(page, 'Просьба отправлена администратору')).toBeVisible();
}

test('выключенный вид: колокольчик его не показывает, сервер не присылает; включили — снова виден', { tag: '@360' }, async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const name = uniqueName('Уведомл Просьбин');
  const member = await registeredMember(admin, apiClient, name);
  const m = await device();
  await signInWithBackupCode(m.page, member);
  const title = `${name} просит вернуть ключ администратора`;

  // администратор: настройки «что присылать» — обязательные неактивны, свои виды включены
  const page = admin.page;
  await page.goto('/profile/notifications');
  const what = page.locator('#profile-notif');
  await expect(what.getByText('Для администратора')).toBeVisible();
  await expect(what.getByText('Сообщение администратора: на сайте всегда включено')).toBeVisible();
  const requests = what.getByRole('switch', { name: 'На сайте: Просьбы вернуть ключ администратора' });
  await expect(requests).toBeChecked();
  await expect(what.getByRole('switch', { name: /^Push: / }).first()).toBeDisabled();
  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'light' });

  // выключили до просьбы — сервер ее администратору не пишет, колокольчик пуст
  await requests.click();
  await expect(toast(page, 'Выключено на сайте: просьбы вернуть ключ администратора')).toBeVisible();
  await expect(requests).not.toBeChecked();
  await askToReturn(m.page);
  const kinds = async () =>
    ((await (await admin.api.get('/api/me/notifications')).json()) as { items: { kind: string }[] }).items.map((item) => item.kind);
  expect(await kinds()).not.toContain('ai_mode_request');
  let bell = await openBell(page);
  await expect(bell.getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
  await expect(bell.getByText('Часть видов выключена в настройках')).toBeVisible();
  await closeBell(page);

  // включили — новая просьба приходит
  await requests.click();
  await expect(toast(page, 'Включено на сайте: просьбы вернуть ключ администратора')).toBeVisible();
  await m.page.getByRole('button', { name: 'Отменить запрос' }).click();
  await expect(toast(m.page, 'Просьба отменена')).toBeVisible();
  await m.page.getByRole('button', { name: 'Попросить администратора вернуть ключ' }).click();
  // тост первой просьбы может быть еще на экране: ждем саму запись на сервере
  await expect(m.page.getByRole('button', { name: 'Отменить запрос' })).toBeVisible();
  await expect.poll(kinds).toContain('ai_mode_request');
  bell = await openBell(page);
  await expect(bell.getByRole('button', { name: new RegExp(title) })).toHaveCount(1);
  await expect(bell.getByText('На сайте · push появится на этапе 6')).toBeVisible();
  await closeBell(page);

  // выключили снова — пришедшее колокольчик прячет (оно не удаляется: включили — снова видно)
  await requests.click();
  await expect(toast(page, 'Выключено на сайте: просьбы вернуть ключ администратора')).toBeVisible();
  bell = await openBell(page);
  await expect(bell.getByRole('button', { name: new RegExp(title) })).toHaveCount(0);
  await closeBell(page);
  await requests.click();
  await expect(toast(page, 'Включено на сайте: просьбы вернуть ключ администратора')).toBeVisible();
  bell = await openBell(page);
  await expect(bell.getByRole('button', { name: new RegExp(title) })).toHaveCount(1);
  await closeBell(page);
});
