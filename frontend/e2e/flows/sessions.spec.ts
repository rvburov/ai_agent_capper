import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { expectNoHorizontalScroll, heading, signInWithBackupCode, signInWithTotp, toast } from '../support/ui';

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

// Сценарий 5: участник видит свои сеансы и завершает сеанс на другом устройстве —
// открытая там вкладка уходит на страницу входа с сообщением.
test('участник завершает сеанс на другом устройстве — оно уходит на вход', async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const member = await registeredMember(admin, apiClient, uniqueName('Глеб Сеансов'));

  // Второе устройство (другой браузер и IP): вход резервным кодом, открыт личный кабинет
  const other = await device({ userAgent: FIREFOX_LINUX });
  await signInWithBackupCode(other.page, member);
  await other.page.goto('/profile');
  await expect(heading(other.page, 'Личный кабинет')).toBeVisible();

  // Это устройство: вход с кодом 2FA, «Безопасность» → «Активные сеансы»
  const mine = await device();
  await signInWithTotp(mine.page, member);
  await mine.page.goto('/profile/security');
  const sessions = mine.page
    .locator('section')
    .filter({ has: mine.page.getByRole('heading', { name: 'Активные сеансы' }) });
  await expect(sessions.getByText('Этот сеанс')).toBeVisible();
  await expect(sessions.getByText('Firefox · Linux')).toBeVisible();
  await expectNoHorizontalScroll(mine.page);
  await sessions.getByRole('button', { name: 'Завершить сеанс: Firefox · Linux' }).click();
  await expect(toast(mine.page, 'Сеанс на Firefox · Linux завершен')).toBeVisible();
  await expect(sessions.getByText('Firefox · Linux')).toHaveCount(0);
  await expect(sessions.getByText('Других активных сеансов нет.')).toBeVisible();

  // Другое устройство при следующем запросе к API уходит на вход с пояснением
  await other.page.getByRole('tab', { name: 'Безопасность' }).click();
  await expect(other.page).toHaveURL(/\/login\?next=%2Fprofile%2Fsecurity/);
  await expect(heading(other.page, 'Вход в AI Capper')).toBeVisible();
  await expect(other.page.getByRole('status').filter({ hasText: 'Сеанс завершен. Войдите снова.' })).toBeVisible();

  // А это устройство продолжает работать
  await mine.page.reload();
  await expect(sessions.getByText('Этот сеанс')).toBeVisible();
});
