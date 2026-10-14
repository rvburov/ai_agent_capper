import { expectScreenLayout } from '../support/layout';
import { expect, signedInAdmin, test, uniqueEmail } from '../support/test';

// «Администрирование → Обзор» и «Расход ИИ» (этап 4): пункт меню ведет к «Обзору» — дела,
// действующие коды и приглашения, бюджет ключа и кто его тратит, плитки и последние действия;
// «Расход ИИ» — по людям, по задачам, проверки отдельно и активность. Р14: о людях — только
// расход на ИИ и активность. На телефоне (375 px, с меткой @360 — и 360 px) — без прокрутки
// вбок, в обеих темах.

test('администратор: «Обзор» и «Расход ИИ»', { tag: '@360' }, async ({ device, isMobile }) => {
  const admin = await device();
  await signedInAdmin(admin, 'Ольга Обзорова');
  const page = admin.page;
  // приглашение ждет регистрации — видно в «Действует сейчас»
  const email = uniqueEmail('invited');
  await admin.api.ok('/api/admin/invites', { email, role: 'member', ai_mode: 'shared' });

  await page.goto('/');
  if (isMobile) {
    await page.getByRole('navigation', { name: 'Нижняя навигация' }).getByRole('button', { name: 'Еще' }).click();
    await page.getByRole('navigation', { name: 'Дополнительные разделы' }).getByRole('link', { name: 'Администрирование' }).click();
  } else {
    await page.getByRole('complementary', { name: 'Основная навигация' }).getByRole('link', { name: 'Администрирование' }).click();
  }
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Участники, доступ и расходы на ИИ' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Обзор/ })).toHaveAttribute('aria-selected', 'true');

  // дела, коды и приглашения общие для всех администраторов: стек делят параллельные сценарии,
  // поэтому проверяем свое приглашение и устройство карточек, а не точные числа
  await expect(page.getByRole('heading', { name: 'Нужно решение' })).toBeVisible();
  const pending = page.locator('#adm-pending');
  await expect(pending.getByText(`Приглашение ждет регистрации: ${email}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Бюджет ключа администратора' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Кто тратит ключ администратора' })).toContainText('Итого с вашего ключа');
  await expect(page.getByRole('region', { name: 'Ключ администратора' })).toContainText('Работает');
  await expect(page.getByRole('region', { name: 'Валюта программы' })).toContainText('₽');
  const recent = page.getByRole('heading', { name: 'Последние действия' }).locator('xpath=ancestor::section[1]');
  await expect(recent.getByRole('listitem').first()).toBeVisible();
  await expect(recent.getByRole('link', { name: 'Весь журнал' })).toHaveAttribute('href', '/admin/audit');
  await expectScreenLayout(page);

  await page.getByRole('tab', { name: 'Расход ИИ' }).click();
  await expect(page).toHaveURL(/\/admin\/usage$/);
  await expect(page.getByRole('heading', { name: 'По людям' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'По задачам' })).toBeVisible();
  await expect(page.getByText('Проверки (eval)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'На своем ключе' })).toBeVisible();
  const activity = page.getByRole('heading', { name: 'Активность' }).locator('xpath=ancestor::section[1]');
  await expect(activity.getByText(/^Входили:/)).toBeVisible();
  const request = page.waitForRequest((r) => r.url().includes('/api/admin/activity?period=7d'));
  await activity.getByRole('button', { name: '7 дней' }).click();
  await request;
  // Р14: ни ставок, ни банков участников
  await expect(page.locator('#admin-panel')).not.toContainText('₽');
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }
});
