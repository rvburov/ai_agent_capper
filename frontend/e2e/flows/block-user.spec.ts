import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import {
  expectNoHorizontalScroll,
  heading,
  signInWithBackupCode,
  signInWithTotp,
  submitPassword,
  toast,
} from '../support/ui';

// Сценарий 6: администратор блокирует участника — открытый у участника кабинет уходит на вход
// с сообщением, войти нельзя; после разблокировки вход снова работает.
test('блокировка закрывает сеанс участника, разблокировка возвращает вход', async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const name = uniqueName('Дина Блокова');
  const member = await registeredMember(admin, apiClient, name);

  // Участник вошел (резервным кодом) и открыл личный кабинет
  const m = await device();
  await signInWithBackupCode(m.page, member);
  await m.page.goto('/profile');
  await expect(heading(m.page, 'Личный кабинет')).toBeVisible();

  // Администратор: «⋯» → «Заблокировать» → подтверждение
  await admin.page.goto('/admin/users');
  await admin.page.getByRole('button', { name: `Действия: ${name}` }).click();
  await admin.page.getByRole('menuitem', { name: /^Заблокировать/ }).click();
  const confirm = admin.page.getByRole('dialog', { name: /Заблокировать/ });
  await expect(confirm.getByText('все его сеансы завершатся')).toBeVisible();
  await confirm.getByRole('button', { name: 'Заблокировать' }).click();
  await expect(toast(admin.page, `${name} заблокирован`)).toBeVisible();
  await expect(confirm).toBeHidden();
  await expectNoHorizontalScroll(admin.page);

  // Открытая вкладка участника при следующем запросе уходит на вход с пояснением
  await m.page.getByRole('tab', { name: 'Безопасность' }).click();
  await expect(m.page).toHaveURL(/\/login\?next=%2Fprofile%2Fsecurity/);
  await expect(m.page.getByRole('status').filter({ hasText: 'Сеанс завершен. Войдите снова.' })).toBeVisible();
  // Войти нельзя даже с верным паролем
  await submitPassword(m.page, member);
  const blocked = m.page.getByRole('alert').filter({ hasText: 'Аккаунт заблокирован. Напишите администратору' });
  await expect(blocked).toBeVisible();

  // Разблокировка из того же меню
  await admin.page.getByRole('button', { name: `Действия: ${name}` }).click();
  await admin.page.getByRole('menuitem', { name: /^Разблокировать/ }).click();
  await expect(toast(admin.page, `${name} разблокирован и может снова войти`)).toBeVisible();

  // Вход снова работает: пароль и код 2FA — и возврат туда, где выкинуло
  await signInWithTotp(m.page, member, { home: false });
  await expect(m.page).toHaveURL(/\/profile\/security$/);
  await expect(heading(m.page, 'Личный кабинет')).toBeVisible();
});
