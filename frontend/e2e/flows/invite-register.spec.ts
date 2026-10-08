import { ADMIN_TABS, paths } from '../../src/app/paths';
import { expect, newPassword, signedInAdmin, test, uniqueEmail, uniqueName, type Account } from '../support/test';
import {
  completeTwoFactorSetup,
  expectNoHorizontalScroll,
  heading,
  navigationLinks,
  signOut,
  toast,
} from '../support/ui';

// Сценарий 2: администратор приглашает участника, тот регистрируется по коду и настраивает 2FA.
// Раздел «Администрирование» участнику не виден ни в меню, ни по прямой ссылке.
test('приглашение → регистрация → 2FA → участник без администрирования', async ({ device, isMobile }) => {
  const computer = await device(); // один компьютер: сначала администратор, потом участник
  await signedInAdmin(computer);
  const { page } = computer;
  const member: Account = {
    email: uniqueEmail('anna'),
    password: newPassword(),
    name: uniqueName('Анна Тестова'),
    recoveryCodes: [],
  };

  // Администратор создает приглашение
  await page.goto('/admin/invites');
  // «Пригласить» есть в шапке раздела и в карточке приглашений: берем кнопку шапки
  await page.getByRole('button', { name: 'Пригласить', exact: true }).first().click();
  const form = page.getByRole('dialog', { name: 'Пригласить в AI Capper' });
  await expect(form).toBeVisible();
  await form.getByRole('textbox', { name: 'Email' }).fill(member.email);
  await form.getByRole('button', { name: 'Создать код' }).click();
  await expect(toast(page, `Приглашение создано: ${member.email}`)).toBeVisible();
  const codeBox = form.getByText(/^CAP-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(codeBox).toBeVisible();
  const inviteCode = (await codeBox.innerText()).trim();
  await expectNoHorizontalScroll(page);
  await form.getByRole('button', { name: 'Готово' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText(member.email).first()).toBeVisible();
  await signOut(page);

  // Регистрация по коду (код вводится в нижнем регистре: маска приводит его к CAP-XXXX-XXXX)
  await page.getByRole('link', { name: 'Регистрация только по приглашению' }).click();
  await expect(heading(page, 'Регистрация по приглашению')).toBeVisible();
  await page.getByRole('textbox', { name: 'Код приглашения' }).fill(inviteCode.toLowerCase());
  await page.getByRole('textbox', { name: 'Имя' }).fill(member.name);
  await page.getByRole('textbox', { name: 'Email' }).fill(member.email);
  await page.getByLabel('Пароль', { exact: true }).fill(member.password);
  await page.getByLabel('Повторите пароль', { exact: true }).fill(member.password);
  await page.getByText('Мне 18 лет').click();
  await page.getByText('Понимаю, что прогнозы делает ИИ').click();
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(toast(page, 'Аккаунт создан. Осталось включить 2FA')).toBeVisible();
  await completeTwoFactorSetup(page, member);

  // Участник: в меню нет «Администрирования», прямой адрес — объяснение
  const links = await navigationLinks(page, isMobile);
  expect(links).toContain('Ставки');
  expect(links).not.toContain('Администрирование');
  await page.getByRole('button', { name: 'Меню пользователя' }).click();
  await expect(page.getByRole('dialog', { name: 'Меню пользователя' }).getByText(member.name)).toBeVisible();
  await page.keyboard.press('Escape');

  // Каждый адрес раздела — объяснение вместо данных, и ни одного запроса к /api/admin
  const adminRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/admin')) adminRequests.push(request.url());
  });
  for (const tab of ADMIN_TABS) {
    await page.goto(paths.admin(tab));
    await expect(page.getByText('Раздел только для администратора')).toBeVisible();
  }
  expect(adminRequests).toEqual([]);

  // И сервер не отдает и не меняет данные раздела участнику
  const adminGets = ['/users', '/users/1', '/invites', '/reset-codes', '/audit'].map((p) => `/api/admin${p}`);
  for (const path of adminGets) {
    expect((await computer.api.get(path)).status(), path).toBe(403);
  }
  const invite = await computer.api.post('/api/admin/invites', {
    email: uniqueEmail('x'),
    role: 'member',
    ai_mode: 'shared',
  });
  expect(invite.status()).toBe(403);
});
