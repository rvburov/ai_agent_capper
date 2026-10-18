import type { Page } from '@playwright/test';

import { SINNER_RUNE, eventsText, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expectScreenLayout } from '../support/layout';
import { expect, registeredMember, signedInAdmin, test, uniqueName, type Account, type Device } from '../support/test';
import { signInWithBackupCode, toast } from '../support/ui';
import { markSpa, navTo } from './dashboard-steps';

// Администратор: «Обзор» → «Расход ИИ» (анализ участника виден в расходе по людям, сумма — как
// в ответе сервера) → смена валюты программы на настоящем API: предпросмотр сервера → «Понимаю»
// → код 2FA → банк участника пересчитан, участник видит новую валюту; сообщение всем →
// колокольчик участника. Участник с открытым приложением видит новую валюту без перезагрузки:
// экраны он открывает пунктами меню, и плашка «Банк» в шапке и суммы экрана — в одной валюте
// (watchProgramCurrency). Валюта одна на всю программу
// (Р17), а стек у сценариев общий: сценарий меняет суммы и валюту у всех, поэтому идет
// отдельно, когда остальные закончились (проект exclusive в playwright.config.ts или вручную:
// E2E_EXCLUSIVE=1 CI=1 npx playwright test admin-settings-currency --workers=1). Курс 0,5
// выбран так, чтобы туда и обратно суммы сошлись до копейки: ₽ → € умножает на 2, € → ₽ — на 0,5.

const EXCLUSIVE = process.env.E2E_EXCLUSIVE === '1';

async function checkLayout(page: Page) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Валюта программы через API (PUT с CSRF): вернуть рубли после сценария. */
async function setCurrency(admin: Device, account: Account, currency: 'RUB' | 'EUR', rate: string): Promise<void> {
  const settings = (await (await admin.api.get('/api/settings')).json()) as { currency: string };
  if (settings.currency === currency) return;
  const csrf = (await (await admin.api.get('/api/auth/csrf')).json()) as { csrf_token: string };
  const response = await admin.api.request.put('/api/admin/settings/currency', {
    data: { from_currency: settings.currency, currency, rate, rate_base: 'EUR', totp_code: await account.totp!.next() },
    headers: { 'X-CSRF-Token': csrf.csrf_token },
  });
  expect(response.status(), await response.text()).toBe(200);
}

test.describe('смена валюты программы', () => {
  test('₽ → €: предпросмотр, 2FA, банк участника пересчитан; сообщение всем → колокольчик', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
    test.skip(!EXCLUSIVE && test.info().project.name !== 'exclusive', 'меняет валюту у всех: идет отдельно от остальных');
    const admin = await device();
    const account = await signedInAdmin(admin, uniqueName('Валют Сменщикова'));
    const name = uniqueName('Валют Участник');
    const member = await registeredMember(admin, apiClient, name);
    const m = await device();
    await signInWithBackupCode(m.page, member);
    await m.api.ok('/api/me/bank/entries', { kind: 'deposit', amount: '10000', expected_last_id: null, currency: 'RUB' });
    // анализ участника на ключе администратора (поддельный Claude) — расход по людям
    await parseEvents(m.page, eventsText(SINNER_RUNE), 1);
    await withFakeClaude(async () => {
      await m.page.getByRole('button', { name: /^Запустить/ }).last().click();
      await expect(m.page.getByRole('heading', { level: 2, name: /^Экспресса стратегии нет · \d варианта? ставки$|^Анализ 1 матча готов/ })).toBeVisible({ timeout: 30_000 });
    });

    // Участник с открытым приложением: кэш запросов с суммами в рублях (главная, «Ставки»,
    // «Аналитика»); дальше — только пункты меню, без перезагрузки
    test.setTimeout(240_000);
    const pill = m.page.locator('.topbar .bank-pill');
    const view = m.page.locator('#view');
    await m.page.goto('/');
    await markSpa(m.page);
    await expect(pill).toContainText('₽');
    await expect(view).toContainText('₽');
    for (const item of ['Ставки', 'Аналитика', 'Главная'] as const) await navTo(m.page, isMobile, item);

    try {
      const page = admin.page;
      // «Обзор»: бюджет ключа и кто его тратит; «Расход ИИ»: участник в «По людям» с суммой сервера
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Бюджет ключа администратора' })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Кто тратит ключ администратора' })).toContainText('Итого с вашего ключа');
      await page.getByRole('tab', { name: 'Расход ИИ' }).click();
      await expect(page).toHaveURL(/\/admin\/usage$/);
      const usage = (await (await admin.api.get('/api/admin/ai/usage')).json()) as { people: { display_name: string; key_spent_usd: number }[] };
      const spent = usage.people.find((p) => p.display_name === name)?.key_spent_usd ?? 0;
      expect(spent).toBeGreaterThan(0);
      const row = page.getByRole('list', { name: 'Расход по людям' }).getByRole('listitem').filter({ hasText: name });
      await expect(row).toContainText(`$${spent.toFixed(2).replace('.', ',')}`);
      await expect(page.locator('#admin-panel')).not.toContainText('₽');

      await page.goto('/admin/settings');
      const choices = page.getByRole('group', { name: 'Валюта программы' });
      await expect(choices.getByRole('button', { name: /Рубли/ })).toHaveAttribute('aria-pressed', 'true');
      await choices.getByRole('button', { name: /Евро/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Сменить валюту программы' });
      await dialog.getByRole('textbox', { name: /^Курс: 1/ }).fill('0,5');
      // Предпросмотр сервера: пример и сколько сумм пересчитается (сумм участников нет, Р14)
      await expect(dialog.getByText(/^Например: 1\s000\s₽ → 2\s000,00\s€$/)).toBeVisible();
      await expect(dialog.getByText(/^Пересчитается: /)).toBeVisible();
      await dialog.getByText('Понимаю: суммы пересчитаются у всех участников').click();
      await dialog.getByRole('textbox', { name: 'Код 2FA из вашего приложения' }).fill(await account.totp!.next());
      await expectScreenLayout(page, { root: dialog });
      await dialog.getByRole('button', { name: 'Пересчитать и сменить' }).click();
      await expect(toast(page, 'Валюта программы — евро. Суммы пересчитаны у всех участников')).toBeVisible();
      await expect(dialog).toBeHidden();
      await expect(page.locator('.adm-cur-name')).toHaveText('Евро');
      await expect(page.getByText(/· курс 1\s€ = 0,5\s₽$/)).toBeVisible();
      await checkLayout(page);

      // Участник, без перезагрузки: как только экран перечитал ответ сервера (срок свежести
      // запросов 30 с), он в евро, и плашка «Банк» в шапке — тоже, без смеси ₽ и € на экране
      await expect(async () => {
        await navTo(m.page, isMobile, 'Ставки');
        await navTo(m.page, isMobile, 'Главная');
        await expect(view).toContainText('€', { timeout: 2_000 });
      }).toPass({ timeout: 60_000 });
      for (const item of ['Главная', 'Ставки', 'Аналитика'] as const) {
        if (item !== 'Главная') await navTo(m.page, isMobile, item);
        await expect(pill).toContainText('€');
        await expect(view).not.toContainText('₽');
      }

      // Участник: валюта и банк — в евро, сумма по курсу
      await m.page.goto('/profile/bank');
      await expect(m.page.getByText('Валюта программы: евро (€)')).toBeVisible();
      const bank = (await (await m.api.get('/api/me/bank')).json()) as { balance: string };
      expect(Number(bank.balance)).toBe(20000);
      await expect(m.page.locator('#view')).toContainText(/20\s000,00\s€/);
      // и на главной: плашка «Банк» в шапке — в евро
      await m.page.goto('/');
      await expect(m.page.locator('.topbar .bank-pill')).toContainText('€');

      // Сообщение всем → колокольчик участника
      const text = `Валюта программы теперь евро (${name})`;
      await page.goto('/admin/message');
      await page.getByRole('textbox', { name: /^Текст/ }).fill(text);
      await page.getByRole('button', { name: 'Отправить' }).click();
      await expect(toast(page, /^Отправлено \d+\sучастник/)).toBeVisible();
      await expect(page.locator('#adm-msg-sent').getByText(text)).toBeVisible();
      await m.page.reload();
      await m.page.getByRole('button', { name: /^Уведомления/ }).click();
      await expect(m.page.getByRole('dialog', { name: 'Уведомления' }).getByText(text)).toBeVisible();
    } finally {
      // € → ₽ по тому же курсу: суммы всех участников возвращаются до копейки
      await setCurrency(admin, account, 'RUB', '0.5');
    }
    const back = (await (await m.api.get('/api/me/bank')).json()) as { balance: string };
    expect(Number(back.balance)).toBe(10000);
  });
});
