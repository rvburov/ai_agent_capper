import { expect, freshIp, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { expectHome, expectNoHorizontalScroll, heading, submitPassword, typeOtp } from '../support/ui';

const PAUSE = /^(\d{1,2}):(\d{2})$/;

function seconds(text: string): number {
  const match = PAUSE.exec(text.trim());
  if (!match) throw new Error(`не отсчет: ${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

// Сценарий 4: пять неверных паролей с одного IP → шестая попытка получает экран
// «Вход временно закрыт» с обратным отсчетом. С другого IP тот же аккаунт входит.
test('пауза после пяти неверных паролей только для этого IP', async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const member = await registeredMember(admin, apiClient, uniqueName('Вера Паузова'));

  const attacker = await device();
  const { page } = attacker;
  await page.goto('/login');
  for (let i = 1; i <= 5; i++) {
    await submitPassword(page, member, `wrong-password-${i}`);
    await expect(page.getByRole('alert').filter({ hasText: 'Неверный email или пароль' })).toBeVisible();
    // поле пароля очищается после ошибки — следующий ввод с чистого листа
    await expect(page.getByLabel('Пароль', { exact: true })).toHaveValue('');
  }

  // Шестая попытка — даже с верным паролем — пауза: пароль не проверяется
  await submitPassword(page, member);
  await expect(heading(page, 'Вход временно закрыт')).toBeVisible();
  await expect(page.getByText(member.email)).toBeVisible();
  await expect(page.getByText('вход работает как обычно')).toBeVisible();
  const countdown = page.getByRole('timer');
  await expect(countdown).toBeVisible();
  const first = seconds(await countdown.innerText());
  expect(first).toBeGreaterThan(14 * 60);
  expect(first).toBeLessThanOrEqual(15 * 60);
  await expect.poll(async () => seconds(await countdown.innerText()), { timeout: 5_000 }).toBeLessThan(first);
  await expectNoHorizontalScroll(page);

  // API с того же IP: 429 и время ожидания; с другого IP (X-Forwarded-For через доверенный
  // прокси) пароль принимается и просят код 2FA
  const credentials = { email: member.email, password: member.password };
  const blocked = await (await apiClient({ ip: attacker.ip })).post('/api/auth/login', credentials);
  expect(blocked.status()).toBe(429);
  const pause = ((await blocked.json()) as { error: { code: string; retry_after: number } }).error;
  expect(pause.code).toBe('auth.rate_limited');
  expect(pause.retry_after).toBeGreaterThan(14 * 60);
  const allowed = await (await apiClient({ ip: freshIp() })).post('/api/auth/login', credentials);
  expect(allowed.status()).toBe(200);
  expect(((await allowed.json()) as { status: string }).status).toBe('totp_required');

  // И в браузере с другого IP вход проходит целиком; владельцу пришло уведомление
  const owner = await device();
  await submitPassword(owner.page, member);
  await expect(heading(owner.page, 'Код из приложения')).toBeVisible();
  await typeOtp(owner.page, await member.totp!.next());
  await expectHome(owner.page);
  await owner.page.getByRole('button', { name: /^Уведомления: непрочитанных \d+$/ }).click();
  const panel = owner.page.getByRole('dialog', { name: 'Уведомления' });
  await expect(panel.getByText('Неудачные попытки входа')).toBeVisible();
  await expect(panel.getByText(attacker.ip)).toBeVisible();
});
