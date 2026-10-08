import { expect, type Locator, type Page } from '@playwright/test';

import type { Account } from './test';
import { Totp } from './totp';

/*
 * Шаги интерфейса, общие для сценариев. Локаторы — по ролям и подписям из ru.json,
 * как их видит человек и программа чтения с экрана, без привязки к классам.
 */

export function heading(page: Page, name: string | RegExp): Locator {
  return page.getByRole('heading', { level: 1, name });
}

/**
 * Всплывающее сообщение. Оно живет 2,6 секунды, поэтому проверять его нужно сразу после
 * действия, до других ожиданий.
 */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByRole('status').filter({ hasText: text }).last();
}

/** Шаг «Пароль» на /login: email, пароль, «Войти». */
export async function submitPassword(page: Page, account: Pick<Account, 'email' | 'password'>, password?: string) {
  const url = page.url();
  if (url === 'about:blank' || new URL(url).pathname !== '/login') await page.goto('/login');
  await expect(heading(page, 'Вход в AI Capper')).toBeVisible();
  const email = page.getByRole('textbox', { name: 'Email' });
  // email мог остаться с прошлой попытки или прийти со страницы сброса
  if ((await email.inputValue()) !== account.email) await email.fill(account.email);
  await page.getByLabel('Пароль', { exact: true }).fill(password ?? account.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
}

/** Ввод шести цифр в клетки кода (видимые на текущем шаге). Шаг входа отправляет код сам. */
export async function typeOtp(page: Page, code: string) {
  const first = page.getByRole('textbox', { name: 'Цифра 1 из 6' });
  await first.click();
  await page.keyboard.type(code);
}

/** Полный вход с кодом из приложения: пароль → код → главная (или страница из ?next=). */
export async function signInWithTotp(page: Page, account: Account, { home = true } = {}) {
  if (!account.totp) throw new Error('2FA не настроена');
  await submitPassword(page, account);
  await expect(heading(page, 'Код из приложения')).toBeVisible();
  await typeOtp(page, await account.totp.next());
  if (home) await expectHome(page);
  else await expect(page).not.toHaveURL(/\/login/);
}

/** Полный вход резервным кодом (не тратит шаг TOTP): пароль → «Нет доступа к приложению» → код. */
export async function signInWithBackupCode(page: Page, account: Account) {
  const code = account.recoveryCodes.shift();
  if (!code) throw new Error('резервные коды закончились');
  await submitPassword(page, account);
  await expect(heading(page, 'Код из приложения')).toBeVisible();
  await page.getByRole('button', { name: 'Нет доступа к приложению-аутентификатору' }).click();
  await expect(heading(page, 'Вход по резервному коду')).toBeVisible();
  await page.getByRole('textbox', { name: 'Резервный код' }).fill(code);
  await page.getByRole('button', { name: 'Войти по резервному коду' }).click();
  await expect(toast(page, 'Вход по резервному коду. Этот код больше не сработает')).toBeVisible();
  await expectHome(page);
}

/**
 * Обязательная настройка 2FA (после первого входа или регистрации): ключ с экрана, код,
 * 8 резервных кодов, отметка «сохранил», «Готово» — главная. Секрет и коды — в account.
 */
export async function completeTwoFactorSetup(page: Page, account: Account) {
  await expect(heading(page, 'Включите двухфакторную защиту')).toBeVisible();
  await expect(page.getByRole('img', { name: 'QR-код для приложения-аутентификатора' })).toBeVisible();
  const key = page.locator('.login-key code');
  await expect(key).toHaveText(/[A-Z2-7]{4}/);
  const secret = (await key.innerText()).replace(/\s/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  account.totp = new Totp(secret);
  await expectNoHorizontalScroll(page);

  await typeOtp(page, await account.totp.next());
  await page.getByRole('button', { name: 'Проверить код и включить 2FA' }).click();
  await expect(page.getByText('Код подошел: 2FA включена')).toBeVisible();
  const codes = page.getByRole('list', { name: 'Резервные коды' }).getByRole('listitem');
  await expect(codes).toHaveCount(8);
  account.recoveryCodes = (await codes.allInnerTexts()).map((code) => code.trim());
  for (const code of account.recoveryCodes) expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);

  // «Готово» без отметки «сохранил коды» не пускает дальше
  const finish = page.getByRole('button', { name: 'Готово — войти в кабинет' });
  await finish.click();
  await expect(page.getByText('Отметьте, что сохранили коды')).toBeVisible();
  await page.getByText('Я сохранил(а) резервные коды в надежном месте').click();
  await finish.click();
  await expect(toast(page, 'Готово: 2FA включена, вы в личном кабинете')).toBeVisible();
  await expectHome(page);
}

export async function expectHome(page: Page) {
  await expect(heading(page, 'Главная')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
}

/** Выход из меню пользователя (аватар в шапке): на компьютере и на телефоне. */
export async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Меню пользователя' }).click();
  await page.getByRole('dialog', { name: 'Меню пользователя' }).getByRole('button', { name: 'Выйти' }).click();
  await expect(toast(page, 'Вы вышли из аккаунта')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
}

/** Ссылки основной навигации: боковая панель на компьютере, шторка «Еще» на телефоне. */
export async function navigationLinks(page: Page, isMobile: boolean): Promise<string[]> {
  if (isMobile) {
    await page.getByRole('navigation', { name: 'Нижняя навигация' }).getByRole('button', { name: 'Еще' }).click();
    const sheet = page.getByRole('dialog', { name: 'Еще' });
    await expect(sheet).toBeVisible();
    const links = await sheet.getByRole('link').allInnerTexts();
    const tabs = await page.getByRole('navigation', { name: 'Нижняя навигация' }).getByRole('link').allInnerTexts();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    return [...tabs, ...links].map((s) => s.trim());
  }
  const sidebar = page.getByRole('complementary', { name: 'Основная навигация' });
  return (await sidebar.getByRole('link').allInnerTexts()).map((s) => s.trim());
}

/** Нет горизонтальной прокрутки страницы. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
