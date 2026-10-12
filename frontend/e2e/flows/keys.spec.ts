import { randomBytes, randomInt } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { expectNoHorizontalScroll, heading, signInWithBackupCode, toast } from '../support/ui';

/*
 * Ключ Claude (Р7, Р12) и «Ключ и бюджет» (Р9, Р13) на настоящем API и поддельном Claude
 * (scripts/e2e-stack.sh): поддельный Claude принимает любой ключ формата sk-ant-...
 */

/** Ключ в формате Claude: sk-ant- и 24 символа. */
function fakeKey(): string {
  return `sk-ant-e2e-${randomBytes(12).toString('hex')}`;
}

/** Карточка режима ключа: радиокнопка спрятана под карточкой, нажимаем на карточку. */
async function chooseMode(page: Page, title: 'Ключ администратора' | 'Свой ключ') {
  const group = page.getByRole('radiogroup', { name: 'Чей ключ Claude использовать' });
  await group.locator('label', { has: page.getByRole('radio', { name: new RegExp(`^${title}`) }) }).click();
  await expect(group.getByRole('radio', { name: new RegExp(`^${title}`) })).toBeChecked();
}

/** Колокольчик: открытие перечитывает список, даже если счетчик еще не обновился опросом. */
async function openNotifications(page: Page) {
  await page.getByRole('button', { name: /^Уведомления/ }).click();
  return page.getByRole('dialog', { name: 'Уведомления' });
}

// Сценарий: участник сохраняет свой ключ и переходит на него, потом просит вернуть ключ
// администратора; администратор видит просьбу в уведомлениях и разрешает с лимитом $12.
// Оба все это время на своих страницах («Участники» и «Ключ Claude»): уведомление само
// обновляет данные открытой страницы, без перезагрузки.
test('свой ключ участника и возврат на ключ администратора с разрешения', async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const name = uniqueName('Ключ Свойский');
  const member = await registeredMember(admin, apiClient, name);
  await admin.page.goto('/admin/users');
  await expect(admin.page.getByRole('button', { name: `Действия: ${name}` })).toBeVisible();

  const m = await device();
  await signInWithBackupCode(m.page, member);
  await m.page.goto('/profile/key');
  await expect(heading(m.page, 'Личный кабинет')).toBeVisible();
  await expect(m.page.getByRole('radio', { name: /^Ключ администратора/ })).toBeChecked();
  await expect(m.page.getByText('Подключено', { exact: true })).toBeVisible();
  await expect(m.page.getByText(/у вас лимит \$10 в месяц/)).toBeVisible();
  await expectNoHorizontalScroll(m.page);

  // Свой ключ: формат проверяется на месте, затем Anthropic (поддельный) — и режим «Свой ключ»
  await chooseMode(m.page, 'Свой ключ');
  const input = m.page.getByRole('textbox', { name: 'Ваш ключ' });
  await input.fill('sk-ant-short');
  await m.page.getByRole('button', { name: 'Проверить и сохранить' }).click();
  await expect(m.page.getByText('Ключ слишком короткий — скопируйте его целиком')).toBeVisible();
  const key = fakeKey();
  await input.fill(key);
  await m.page.getByRole('button', { name: 'Проверить и сохранить' }).click();
  await expect(toast(m.page, 'Ключ проверен и сохранен. Анализы теперь идут с вашего счета')).toBeVisible();
  const own = m.page.locator('#profile-key-own');
  await expect(own.getByText(`sk-ant-…${key.slice(-4)}`)).toBeVisible();
  await expect(own.getByText('Работает')).toBeVisible();
  await own.getByRole('button', { name: 'Проверить' }).click();
  await expect(toast(m.page, /^Ключ работает: доступны Opus 5\.5/)).toBeVisible();
  await expectNoHorizontalScroll(m.page);

  // Обратно — только просьбой администратору (Р12); длинная кнопка просьбы на 375 px переносится
  await chooseMode(m.page, 'Ключ администратора');
  await expect(m.page.getByRole('button', { name: 'Попросить администратора вернуть ключ' })).toBeVisible();
  await expectNoHorizontalScroll(m.page);
  await m.page.getByRole('button', { name: 'Попросить администратора вернуть ключ' }).click();
  await expect(toast(m.page, 'Просьба отправлена администратору')).toBeVisible();
  await expect(m.page.getByText('Ждет решения')).toBeVisible();

  // Администратор (все еще на «Участниках»): уведомление ведет туда же, там «Разрешить» с лимитом
  const panel = await openNotifications(admin.page);
  await panel.getByRole('button', { name: new RegExp(`${name} просит вернуть ключ администратора`) }).click();
  await expect(admin.page).toHaveURL(/\/admin\/users$/);
  await admin.page.getByRole('button', { name: `Действия: ${name}` }).click();
  await admin.page.getByRole('menuitem', { name: /^Разрешить вернуть ключ администратора/ }).click();
  const dialog = admin.page.getByRole('dialog', { name: 'Вернуть на ключ администратора' });
  await expect(dialog.getByText(new RegExp(`Его ключ sk-ant-…${key.slice(-4)} отключится`))).toBeVisible();
  await dialog.getByLabel('В месяц, $').fill('12');
  await dialog.getByRole('button', { name: 'Разрешить' }).click();
  await expect(toast(admin.page, `${name} снова на ключе администратора. Он увидит уведомление`)).toBeVisible();
  await expectNoHorizontalScroll(admin.page);

  // Участник (все еще на «Ключ Claude»): решение — в уведомлениях, и вкладка уже показывает
  // ключ администратора с лимитом $12
  const memberPanel = await openNotifications(m.page);
  await memberPanel.getByRole('button', { name: /Вы снова на ключе администратора/ }).click();
  await expect(m.page).toHaveURL(/\/profile\/key$/);
  await expect(m.page.getByRole('radio', { name: /^Ключ администратора/ })).toBeChecked();
  await expect(m.page.getByText(/у вас лимит \$12 в месяц/)).toBeVisible();
  await expect(m.page.getByText('Ждет решения')).toBeHidden();
});

// Сценарий: администратор меняет ключ администратора с кодом 2FA, общий бюджет и порог
// уведомления, лимит участника и ставит его анализы на паузу.
test('ключ администратора с кодом 2FA, бюджет и лимит участника', async ({ device, apiClient }) => {
  const admin = await device();
  const owner = await signedInAdmin(admin);
  const name = uniqueName('Лимит Участников');
  await registeredMember(admin, apiClient, name);

  await admin.page.goto('/admin/key');
  await expect(admin.page.getByRole('tab', { name: 'Ключ и бюджет' })).toHaveAttribute('aria-selected', 'true');
  const keyCard = admin.page.locator('#adm-key');
  await expect(keyCard.getByText(/^sk-ant-…/)).toBeVisible();
  await expectNoHorizontalScroll(admin.page);
  // отдельная ссылка в консоль Anthropic на телефоне — зона нажатия не меньше 40 px
  const consoleLink = await keyCard.getByRole('link', { name: /Лимит трат в консоли Anthropic/ }).boundingBox();
  if ((admin.page.viewportSize()?.width ?? 1366) <= 960) expect(consoleLink!.height).toBeGreaterThanOrEqual(40);

  // Замена ключа: формат на месте, затем окно с кодом 2FA
  await keyCard.getByRole('button', { name: 'Заменить ключ' }).click();
  const field = keyCard.getByLabel('Новый ключ');
  await field.fill('sk-ant-short');
  await keyCard.getByRole('button', { name: 'Проверить и сохранить' }).click();
  await expect(keyCard.getByText('Ключ начинается с sk-ant- и длиннее 20 символов — скопируйте его целиком')).toBeVisible();
  const key = fakeKey();
  await field.fill(key);
  await keyCard.getByRole('button', { name: 'Проверить и сохранить' }).click();
  const confirm = admin.page.getByRole('dialog', { name: 'Заменить ключ администратора' });
  await confirm.getByLabel('Код 2FA из вашего приложения').fill(await owner.totp!.next());
  await confirm.getByRole('button', { name: 'Проверить и сохранить' }).click();
  await expect(toast(admin.page, `Ключ проверен и сохранен: sk-ant-…${key.slice(-4)}`)).toBeVisible();
  await expect(confirm).toBeHidden();
  await expect(keyCard.getByText(`sk-ant-…${key.slice(-4)}`)).toBeVisible();

  // Общий бюджет и порог уведомления через общий выпадающий список
  const budget = String(randomInt(100, 900));
  const budgetCard = admin.page.locator('#adm-budget');
  await budgetCard.getByLabel('Бюджет в месяц, $').fill(budget);
  await budgetCard.getByRole('button', { name: /^Уведомить при:/ }).click();
  await admin.page.getByRole('option', { name: '90%' }).click();
  await budgetCard.getByRole('button', { name: 'Сохранить' }).click();
  await expect(toast(admin.page, `Бюджет: $${budget} в месяц, уведомление при 90%`)).toBeVisible();

  // Лимит участника: окно с быстрыми суммами, затем пауза переключателем
  const limits = admin.page.locator('#adm-limits');
  await limits.getByRole('button', { name: `Изменить лимит: ${name}` }).click();
  const dialog = admin.page.getByRole('dialog', { name: 'Лимит на ключе администратора' });
  await dialog.getByRole('button', { name: '$15' }).click();
  await expect(dialog.getByText(/Израсходовано за .* — это 0% нового лимита/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await expect(toast(admin.page, new RegExp(`^${name}: \\$15 в месяц · 3\\s+анализа в день · \\$1 на анализ$`))).toBeVisible();
  await expect(dialog).toBeHidden();
  await limits.getByRole('switch', { name: `Пауза: ${name}` }).click();
  await expect(toast(admin.page, `${name}: анализы на паузе`)).toBeVisible();
  await expect(limits.getByRole('switch', { name: `Пауза: ${name}` })).toBeChecked();
  await expectNoHorizontalScroll(admin.page);

  // В «Участниках» — тот же лимит и пауза
  await admin.page.goto('/admin/users');
  const person = admin.page.getByRole('row').filter({ hasText: name }).or(admin.page.getByRole('region', { name }));
  await expect(person.getByText('Анализы на паузе')).toBeVisible();

  // «Ключ Claude» администратора: подписи порога и бюджета на шкале не наезжают друг на друга
  await admin.page.goto('/profile/key');
  const scale = admin.page.locator('.limit-bar-scale').first();
  await expect(scale.locator('.end')).toBeVisible();
  const [mid, end] = [await scale.locator('.mid').boundingBox(), await scale.locator('.end').boundingBox()];
  const sameRow = mid!.y < end!.y + end!.height && end!.y < mid!.y + mid!.height;
  expect(sameRow && mid!.x + mid!.width > end!.x).toBe(false);
  // «Открыть» в плашке администратора — путь к ключу с этой вкладки: на телефоне не меньше 40 px
  await expect(admin.page.getByRole('link', { name: 'Открыть', exact: true })).toHaveAttribute('href', '/admin/key');
  const open = await admin.page.getByRole('link', { name: 'Открыть', exact: true }).boundingBox();
  if ((admin.page.viewportSize()?.width ?? 1366) <= 960) expect(open!.height).toBeGreaterThanOrEqual(40);
  await expectNoHorizontalScroll(admin.page);
});
