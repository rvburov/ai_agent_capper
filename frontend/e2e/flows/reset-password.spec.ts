import { expect, newPassword, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { expectHome, expectNoHorizontalScroll, heading, submitPassword, toast, typeOtp } from '../support/ui';

// Сценарий 3: администратор выдает участнику код сброса, участник меняет пароль на /reset,
// входит новым паролем и кодом 2FA; старый пароль больше не подходит.
test('код сброса от администратора → новый пароль → вход с 2FA', async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const name = uniqueName('Борис Сбросов');
  const member = await registeredMember(admin, apiClient, name);
  const oldPassword = member.password;

  // Администратор: меню «⋯» участника → «Выдать код сброса пароля» → вкладка «Сброс доступа»
  await admin.page.goto('/admin/users');
  await admin.page.getByRole('button', { name: `Действия: ${name}` }).click();
  await admin.page.getByRole('menuitem', { name: /Выдать код сброса пароля/ }).click();
  await expect(admin.page).toHaveURL(/\/admin\/access$/);
  const issue = admin.page.getByRole('button', { name: 'Выдать код' });
  await expect(issue).toBeFocused();
  await expect(admin.page.getByText(name).first()).toBeVisible();
  await issue.click();
  await expect(toast(admin.page, `Код сброса выдан: ${name}`)).toBeVisible();
  const codeBox = admin.page.getByText(/^RST-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await expect(codeBox).toBeVisible();
  const resetCode = (await codeBox.innerText()).trim();
  // Список действующих кодов общий для всех участников, а тесты идут параллельно — ищем по имени
  const activeCodes = admin.page
    .locator('section')
    .filter({ has: admin.page.getByRole('heading', { name: 'Действующие коды сброса' }) });
  await expect(activeCodes.getByText(name)).toBeVisible();
  await expectNoHorizontalScroll(admin.page);

  // Участник на своем устройстве: «Забыли пароль?» → /reset
  const { page } = await device();
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(member.email);
  await page.getByRole('link', { name: 'Забыли пароль?' }).click();
  await expect(heading(page, 'Сброс пароля')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Email аккаунта' })).toHaveValue(member.email);
  member.password = newPassword();
  await page.getByRole('textbox', { name: 'Код сброса' }).fill(resetCode.toLowerCase());
  await page.getByLabel('Новый пароль', { exact: true }).fill(member.password);
  await page.getByLabel('Повторите новый пароль', { exact: true }).fill(member.password);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Сменить пароль' }).click();
  await expect(heading(page, 'Пароль изменен')).toBeVisible();
  await page.getByRole('link', { name: 'Войти с новым паролем' }).click();

  // Старый пароль не подходит
  await submitPassword(page, member, oldPassword);
  await expect(page.getByRole('alert').filter({ hasText: 'Неверный email или пароль' })).toBeVisible();

  // Новый пароль и код 2FA (2FA после сброса пароля сохраняется)
  await submitPassword(page, member);
  await expect(heading(page, 'Код из приложения')).toBeVisible();
  await typeOtp(page, await member.totp!.next());
  await expectHome(page);

  // Код одноразовый: у администратора в списке действующих кодов его больше нет
  await admin.page.reload();
  await expect(activeCodes).toBeVisible();
  await expect(activeCodes.getByText(name)).toHaveCount(0);
});
