import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

import type { Page } from '@playwright/test';

import { expectScreenLayout } from '../support/layout';
import { expect, registeredMember, signedInAdmin, test, uniqueName, type Account } from '../support/test';
import { expectHome, heading, signInWithBackupCode, submitPassword, toast } from '../support/ui';
import { placeBet } from './dashboard-steps';

// Кабинет → «Данные» (GDPR, Р15, В10) на настоящем API: экспорт сразу скачиванием (JSON — файлом,
// CSV — архивом ZIP), согласие на обезличенные прогнозы, удаление аккаунта с паролем и кодом 2FA:
// выход, при входе — один экран «Аккаунт будет удален …», отмена возвращает приложение.

/**
 * Файлы архива ZIP по центральному каталогу: имя → текст (без сжатия или deflate — других
 * способов архив экспорта не использует).
 */
function unzip(bytes: Buffer): Map<string, string> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('нет конца центрального каталога ZIP');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('битая запись центрального каталога');
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + size);
    files.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** Вход резервным кодом, когда после входа открывается не главная, а экран отмены удаления. */
async function signInPendingDeletion(page: Page, account: Account): Promise<void> {
  const code = account.recoveryCodes.shift();
  if (!code) throw new Error('резервные коды закончились');
  await submitPassword(page, account);
  await expect(heading(page, 'Код из приложения')).toBeVisible();
  await page.getByRole('button', { name: 'Нет доступа к приложению-аутентификатору' }).click();
  await page.getByRole('textbox', { name: 'Резервный код' }).fill(code);
  await page.getByRole('button', { name: 'Войти по резервному коду' }).click();
}

test('экспорт JSON и ZIP, согласие; удаление → экран отмены → отмена', { tag: '@360' }, async ({ device, apiClient }) => {
  const admin = await device();
  const adminAccount = await signedInAdmin(admin);
  const member = await registeredMember(admin, apiClient, uniqueName('Данные Удалова'));
  const m = await device();
  await signInWithBackupCode(m.page, member);
  const page = m.page;

  // своя ставка — в архиве должна быть она, а не чужие данные
  const bet = await placeBet(page);

  await page.goto('/profile/data');
  const exportCard = page.locator('#profile-export');
  await expect(exportCard.getByText('без паролей, кодов 2FA и ключей Claude')).toBeVisible();

  // JSON — одним файлом
  let downloaded = page.waitForEvent('download');
  await exportCard.getByRole('button', { name: 'Скачать JSON' }).click();
  const json = await downloaded;
  expect(json.suggestedFilename()).toMatch(/^capper-export-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(toast(page, `Скачивание началось: ${json.suggestedFilename()}`)).toBeVisible();
  const data = JSON.parse(await readFile(await json.path(), 'utf8')) as Record<string, unknown>;
  expect(JSON.stringify(data)).toContain(member.email);
  expect(JSON.stringify(data)).not.toContain(member.password);

  // CSV — архив ZIP (сигнатура PK\x03\x04)
  downloaded = page.waitForEvent('download');
  await exportCard.getByRole('button', { name: 'Скачать CSV (ZIP)' }).click();
  const zip = await downloaded;
  expect(zip.suggestedFilename()).toMatch(/^capper-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const bytes = await readFile(await zip.path());
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  // внутри — свои данные: профиль со своим email, своя ставка; email администратора (другого
  // участника) нет ни в одном файле
  const files = unzip(bytes);
  expect([...files.keys()]).toEqual(expect.arrayContaining(['profile.csv', 'bets.csv', 'bank_ledger.csv']));
  expect(files.get('profile.csv')).toContain(member.email);
  const betRows = (files.get('bets.csv') ?? '').trim().split(/\r?\n/).slice(1);
  expect(betRows).toHaveLength(1);
  expect(betRows[0]?.split(',')[0]).toBe(String(bet.id));
  for (const [name, text] of files) {
    expect(text, name).not.toContain(adminAccount.email);
    expect(text, name).not.toContain(member.password);
  }

  // Согласие на обезличенные прогнозы (Р15) — сразу, профиль с сервера
  const consent = page.locator('#profile-consent');
  await consent.getByRole('switch', { name: /Разрешаю обезличенно использовать мои прогнозы/ }).click();
  await expect(toast(page, 'Согласие дано: обезличенные прогнозы помогут общей модели')).toBeVisible();
  expect(((await (await m.api.get('/api/me')).json()) as { consent_training: boolean }).consent_training).toBe(true);
  await expect(page.locator('#profile-delete').getByText(/^Обезличенные прогнозы — без имени и email/)).toBeVisible();

  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'light' });

  // Удаление: пароль и код 2FA; неверный пароль — под полем
  const danger = page.locator('#profile-delete');
  await danger.getByLabel('Пароль', { exact: true }).fill('wrong-password-1');
  await danger.getByRole('textbox', { name: 'Код 2FA' }).fill(await member.totp!.next());
  await danger.getByRole('button', { name: 'Удалить аккаунт' }).click();
  await expect(danger.getByText('Текущий пароль указан неверно')).toBeVisible();
  // код после ошибки стирается: этот шаг уже использован
  await danger.getByLabel('Пароль', { exact: true }).fill(member.password);
  await danger.getByRole('textbox', { name: 'Код 2FA' }).fill(await member.totp!.next());
  await danger.getByRole('button', { name: 'Удалить аккаунт' }).click();
  await expect(toast(page, /^Удаление запланировано на \d+ \S+\. Вы вышли из аккаунта на всех устройствах/)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  // Вход снова — один экран отмены, а не ошибки на каждом экране
  await signInPendingDeletion(page, member);
  await expect(page.getByRole('heading', { name: /^Аккаунт будет удален \d+ \S+ \d{4}$/ })).toBeVisible();
  await expect(page.getByText(`Аккаунт: ${member.email}`)).toBeVisible();
  await expect(page.getByRole('navigation', { name: /навигация/ })).toHaveCount(0);
  await page.goto('/bets');
  await expect(page.getByRole('heading', { name: /^Аккаунт будет удален/ })).toBeVisible();
  const screen = { root: page.locator('main') };
  await expectScreenLayout(page, screen);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page, screen);

  await page.getByRole('button', { name: 'Отменить удаление' }).click();
  await expect(toast(page, 'Удаление отменено. Аккаунт работает как раньше')).toBeVisible();
  await expect(heading(page, 'Ставки')).toBeVisible();
  await page.goto('/');
  await expectHome(page);
  const me = (await (await m.api.get('/api/me')).json()) as { deletion_requested_at: string | null };
  expect(me.deletion_requested_at).toBeNull();
});
