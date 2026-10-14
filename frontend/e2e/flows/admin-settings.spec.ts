import type { Page } from '@playwright/test';

import { expectScreenLayout } from '../support/layout';
import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { signInWithBackupCode, toast } from '../support/ui';

// «Администрирование → Настройки» и «Сообщение» на настоящем API (этап 4). Здесь — то, что
// не меняет программу для соседних сценариев (стек у всех общий): экран настроек и окно смены
// валюты с предпросмотром сервера без записи, сообщение одному участнику → его колокольчик.
// Сама смена валюты и сообщение всем — в admin-settings-currency.spec.ts (идет отдельно).
// На телефоне (375 px, с меткой @360 — и 360 px) — без прокрутки вбок, в обеих темах.

async function checkLayout(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('«Настройки»: валюта, пояс, сервер; окно смены считает на сервере и ничего не меняет', { tag: '@360' }, async ({ device }) => {
  const admin = await device();
  const account = await signedInAdmin(admin, uniqueName('Настр Валютова'));
  const page = admin.page;
  await page.goto('/admin/settings');
  await expect(page.getByRole('tab', { name: 'Настройки' })).toHaveAttribute('aria-selected', 'true');
  const choices = page.getByRole('group', { name: 'Валюта программы' });
  await expect(choices.getByRole('button', { name: /Рубли/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Pinnacle → Betfair → средний по рынку')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Часовой пояс по умолчанию' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Часовой пояс: / })).toBeVisible();
  await expect(page.getByText('Финляндия, Хельсинки')).toBeVisible();
  await checkLayout(page);

  // Окно: курс, предпросмотр с сервера (у администратора без банка — только пример), «Понимаю»
  // и код 2FA; закрыли — валюта прежняя
  await choices.getByRole('button', { name: /Евро/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Сменить валюту программы' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: /^Курс: 1/ }).fill('95,12');
  await expect(dialog.getByText(/^Например: 1\s000\s₽ → 10,51\s€$/)).toBeVisible();
  await expect(dialog.getByText(/^Пересчитается: /)).toBeVisible();
  await expect(dialog.getByText(/Ваш банк/)).toHaveCount(0);
  const go = dialog.getByRole('button', { name: 'Пересчитать и сменить' });
  await expect(go).toBeDisabled();
  await dialog.getByText('Понимаю: суммы пересчитаются у всех участников').click();
  await dialog.getByRole('textbox', { name: 'Код 2FA из вашего приложения' }).fill(await account.totp!.next());
  await expect(go).toBeEnabled();
  // Курс вне 0,001–1 000 — подсказка, кнопка снова недоступна
  await dialog.getByRole('textbox', { name: /^Курс: 1/ }).fill('5000');
  await dialog.getByRole('textbox', { name: 'Код 2FA из вашего приложения' }).focus();
  await expect(dialog.getByText('Курс — число от 0,001 до 1 000')).toBeVisible();
  await expect(go).toBeDisabled();
  await expectScreenLayout(page, { root: dialog });
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toBeHidden();
  const settings = (await (await admin.api.get('/api/settings')).json()) as { currency: string };
  expect(settings.currency).toBe('RUB');
});

test('«Сообщение» одному участнику → его колокольчик', { tag: '@360' }, async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin, uniqueName('Сообщ Админова'));
  const name = uniqueName('Сообщ Получатель');
  const member = await registeredMember(admin, apiClient, name);
  const m = await device();
  await signInWithBackupCode(m.page, member);

  const page = admin.page;
  await page.goto('/admin/message');
  await expect(page.getByRole('heading', { name: 'Сообщение участникам' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Всем участникам · \d+$/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Одному' }).click();
  await page.getByRole('button', { name: /^Получатель: / }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(page.getByRole('button', { name: `Получатель: ${name}` })).toBeVisible();

  const text = `Сервер обновится в субботу (${name})`;
  await page.getByRole('textbox', { name: /^Текст/ }).fill(text);
  // Предпросмотр — как в колокольчике участника
  const preview = page.locator('.adm-notif');
  await expect(preview.getByText('Сообщение администратора')).toBeVisible();
  await expect(preview.getByText(text)).toBeVisible();
  await expect(page.getByText(`${text.length} / 280`)).toBeVisible();
  await checkLayout(page);
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(toast(page, 'Отправлено 1 участнику: на сайте')).toBeVisible();
  const sent = page.locator('#adm-msg-sent');
  await expect(sent.getByText(text)).toBeVisible();
  await expect(sent.getByText(new RegExp(`· ${name}$`))).toBeVisible();

  // Участник: сообщение в колокольчике
  await m.page.reload();
  await m.page.getByRole('button', { name: /^Уведомления/ }).click();
  const bell = m.page.getByRole('dialog', { name: 'Уведомления' });
  await expect(bell.getByText(text)).toBeVisible();
  await expect(bell.getByText('Сообщение администратора').first()).toBeVisible();
});
