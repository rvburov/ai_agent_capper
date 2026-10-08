import { createCliAdmin, expect, test, uniqueName } from '../support/test';
import {
  completeTwoFactorSetup,
  expectHome,
  heading,
  signInWithBackupCode,
  signOut,
  submitPassword,
  toast,
  typeOtp,
} from '../support/ui';

// Сценарий 1: администратор, созданный командой терминала, впервые входит и настраивает 2FA,
// затем входит с кодом из приложения и резервным кодом.
test('администратор из терминала: настройка 2FA, вход с кодом и резервным кодом', async ({ device }) => {
  const name = uniqueName('Роман Тестов');
  const admin = await createCliAdmin(name);
  const { page } = await device();

  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await submitPassword(page, admin);
  await completeTwoFactorSetup(page, admin);
  const totp = admin.totp!;

  // Выход и вход с кодом из приложения
  await signOut(page);
  await submitPassword(page, admin);
  await expect(heading(page, 'Код из приложения')).toBeVisible();
  await typeOtp(page, await totp.next());
  await expect(toast(page, `Вход выполнен: ${name}`)).toBeVisible();
  await expectHome(page);

  // Выход и вход резервным кодом
  await signOut(page);
  await signInWithBackupCode(page, admin);

  // Использованный код списан: в «Безопасности» осталось 7 из 8
  await page.goto('/profile/security');
  await expect(page.getByText(/7 из 8/).first()).toBeVisible();
});
