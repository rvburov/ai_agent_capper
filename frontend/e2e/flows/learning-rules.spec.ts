import type { Locator, Page } from '@playwright/test';

import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { learningSeed } from '../support/learning';
import { expectScreenLayout } from '../support/layout';
import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { signInWithBackupCode, toast } from '../support/ui';

// Этап 5, волна 4, участник на настоящем API:
// 1) свои правила суммы ставки — версией: «Предложить изменение» → кандидат, сервер сразу
//    проверяет его на ваших ставках → «Включить» → правило выключено; второй кандидат →
//    «Включить» → «Вернуть» первую, затем исходные правила (r1);
// 2) отчет недели (собирает задача воркера по понедельникам; на стеке — learning_seed.py
//    weekly) приходит в колокольчик и открывается на вкладке «Отчеты».
// 3) числа проверки кандидата на своих ставках (ставки, у скольких изменилась бы сумма, суммы
//    и прибыль до и после) на экране — те же, что в ответе API.
// Участник у каждого прогона свой — сценарии не мешают друг другу и повторяются на одном
// стеке. Раскладка — на 375 и 360 px в обеих темах.

const THEMES = ['light', 'dark'] as const;

async function layout(page: Page, root?: () => Locator): Promise<void> {
  for (const scheme of THEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page, { exclude: '.skip-link', ...(root ? { root: root() } : {}) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('свои правила суммы: кандидат с проверкой на ставках → «Включить» → «Вернуть», и к исходным r1', { tag: '@360' }, async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin, uniqueName('Админ Правил'));
  const member = await registeredMember(admin, apiClient, uniqueName('Участник Правил'));
  const m = await device();
  await signInWithBackupCode(m.page, member);
  const page = m.page;
  await page.goto('/profile/bank');
  const strategy = page.locator('#profile-strategy');
  await expect(strategy.getByText('Версия правил')).toBeVisible();
  await expect(strategy.getByText('Кандидат', { exact: true })).toBeVisible();

  // правило «итог 7 дней» включено (стратегия этапа 3) — кандидат его выключает
  const rule = page.getByRole('switch', { name: /^Итог 7 дней −5% и хуже/ });
  await expect(rule).toBeChecked();
  await strategy.getByRole('button', { name: 'Предложить изменение' }).click();
  const dialog = page.getByRole('dialog', { name: 'Предложить изменение правил' });
  await dialog.getByRole('button', { name: /^Что изменить:/ }).click();
  await page.getByRole('option', { name: /^Выключить «Итог 7 дней/ }).click();
  await layout(page, () => page.getByRole('dialog'));
  await dialog.getByRole('button', { name: 'Создать кандидата' }).click();

  const note = page.getByText(/^Кандидат r\d+ создан\./);
  await expect(note).toBeVisible();
  const code = /r\d+/.exec((await note.textContent()) ?? '')?.[0] ?? '';
  expect(code).toBeTruthy();
  const created = page.getByRole('dialog', { name: `Кандидат ${code}` });
  // у нового участника рассчитанных ставок нет — проверять не на чем, это сказано словами
  await expect(created.getByText(/Рассчитанных ставок приложения пока нет/)).toBeVisible();
  await layout(page, () => page.getByRole('dialog'));
  await created.getByRole('button', { name: `Включить ${code}` }).click();
  await expect(page.getByText(new RegExp(`^${code} действует со следующего анализа`))).toBeVisible();
  await expect(rule).not.toBeChecked();

  // «Версии стратегии»: свои правила — та же версия; откат — в кабинете
  await page.goto('/learning/versions');
  const stake = page.getByRole('heading', { name: 'Ваши правила суммы ставки' }).locator('xpath=ancestor::section[1]');
  await expect(stake.getByText(code, { exact: true })).toBeVisible();
  await layout(page);

  // второй кандидат — включить рост «Итог 7 дней +10%»; откат возвращает первую версию
  // (вернуть можно версию, которую вы уже включали)
  await page.goto('/profile/bank');
  const growth = page.getByRole('switch', { name: /^Итог 7 дней \+10%/ });
  await expect(growth).not.toBeChecked();
  await strategy.getByRole('button', { name: 'Предложить изменение' }).click();
  await dialog.getByRole('button', { name: /^Что изменить:/ }).click();
  await page.getByRole('option', { name: /^Включить «Итог 7 дней \+10%/ }).click();
  await dialog.getByRole('button', { name: 'Создать кандидата' }).click();
  const second = /r\d+/.exec((await page.getByText(/^Кандидат r\d+ создан\./).last().textContent()) ?? '')?.[0] ?? '';
  await page.getByRole('dialog', { name: `Кандидат ${second}` }).getByRole('button', { name: `Включить ${second}` }).click();
  await expect(growth).toBeChecked();
  await strategy.getByRole('button', { name: `Вернуть ${code}` }).click();
  await expect(page.getByText(`Снова действует ${code}`)).toBeVisible();
  await expect(growth).not.toBeChecked();
  await expect(rule).not.toBeChecked();
  // исходные правила (r1, стратегия этапа 3) тоже возвращаются: правило недели снова включено
  await strategy.getByRole('button', { name: 'Вернуть r1', exact: true }).click();
  await expect(page.getByText('Снова действует r1')).toBeVisible();
  await expect(rule).toBeChecked();
  await expect(growth).not.toBeChecked();
  await layout(page);
});

test('отчет недели приходит в колокольчик и открывается на вкладке «Отчеты»', { tag: '@360' }, async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin, uniqueName('Админ Отчетов'));
  const member = await registeredMember(admin, apiClient, uniqueName('Участник Отчетов'));
  const m = await device();
  await signInWithBackupCode(m.page, member);
  const page = m.page;
  await page.goto('/learning/reports');
  await expect(page.getByText(/^Отчетов пока нет\. Первый придет в понедельник/)).toBeVisible();

  // задача воркера по понедельникам: отчет прошлой недели (ставок не было) и уведомление
  await learningSeed(['weekly', member.email]);
  await page.goto('/');
  await page.getByRole('button', { name: /^Уведомления/ }).click();
  const bell = page.getByRole('dialog', { name: 'Уведомления' });
  await bell.getByRole('button', { name: /^Отчет за неделю .*: ставок не было/ }).click();
  await expect(page).toHaveURL(/\/learning\/reports\?report=\d+$/);
  await expect(page.getByText('Последний отчет')).toBeVisible();
  await expect(page.getByText('Ставок на неделе не было — ниже расход и состояние модели.')).toBeVisible();
  await expect(page.getByText('Рассчитано ставок', { exact: true })).toBeVisible();
  await layout(page);
});

/** Рубли как на экране, для RegExp: «2 488 ₽», «−1 240 ₽» (пробелы — неразрывные). */
function rub(value: string | number): string {
  const n = Number(value);
  const digits = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+$)/g, '\\s');
  return `${n < 0 ? '\u2212' : ''}${digits}\\s₽`;
}

interface RulesCheck {
  bets: number;
  changed: number;
  stake_old: string;
  stake_new: string;
  profit_old: string;
  profit_new: string;
}

test('проверка кандидата на своих ставках: числа экрана — из API', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'ставка через анализ — на компьютере; раскладка окна правил — в сценарии выше');
  const admin = await device();
  await signedInAdmin(admin, uniqueName('Админ Проверки'));
  const member = await registeredMember(admin, apiClient, uniqueName('Участник Проверки'));
  const m = await device();
  await signInWithBackupCode(m.page, member);
  const page = m.page;

  // ставка по анализу (поддельный Claude): экспресс Синнер П1 @1.30 и Джокович П1 @1.45 —
  // итоговый кэф 1.885, диапазон 1.71–2.20; выиграна (ручной расчет через API)
  await parseEvents(page, eventsText(SINNER_RUNE, DJOKOVIC_RUBLEV), 2);
  await withFakeClaude(async () => {
    await page.getByRole('button', { name: /^Запустить/ }).last().click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из 2 событий/ })).toBeVisible({ timeout: 30_000 });
  });
  await page.getByRole('region', { name: 'Экспресс стратегии' }).getByRole('button', { name: 'Сохранить ставку' }).click();
  await page.getByRole('dialog', { name: 'Сохранить ставку' }).getByRole('button', { name: 'Сохранить ставку' }).click();
  const saved = toast(page, /Ставка №\d+ сохранена/);
  await expect(saved).toBeVisible();
  const betId = Number(/№(\d+)/.exec(await saved.innerText())?.[1]);
  const bet = (await (await m.api.get(`/api/bets/${betId}`)).json()) as { updated_at: string; legs: { id: number }[] };
  const settle = await m.api.put(`/api/bets/${betId}/result`, {
    expected_updated_at: bet.updated_at,
    legs: bet.legs.map((leg) => ({ leg_id: leg.id, result: 'win' })),
  });
  expect(settle.ok(), await settle.text()).toBe(true);

  // кандидат: доля банка в диапазоне 1.71–2.20 — 1,5% вместо 2,25%
  await page.goto('/profile/bank');
  const strategy = page.locator('#profile-strategy');
  await strategy.getByRole('button', { name: 'Предложить изменение' }).click();
  const dialog = page.getByRole('dialog', { name: 'Предложить изменение правил' });
  await dialog.getByRole('button', { name: /^Что изменить:/ }).click();
  await page.getByRole('option', { name: /^Доля банка при итоговом кэфе 1\.71–2\.20/ }).click();
  await dialog.getByRole('textbox', { name: 'Новая доля банка' }).fill('1,5');
  await dialog.getByRole('button', { name: 'Создать кандидата' }).click();
  const note = page.getByText(/^Кандидат r\d+ создан\./);
  await expect(note).toBeVisible();
  const code = /r\d+/.exec((await note.textContent()) ?? '')?.[0] ?? '';

  // проверку считает сервер: экран показывает ровно его числа
  // код на экране — по порядку в линии (r1, r2…), на сервере свой: кандидат один — по статусу
  const versions = (await (await m.api.get('/api/strategy/versions')).json()) as { rules: { status: string; check: RulesCheck | null }[] };
  const check = versions.rules.find((version) => version.status === 'candidate')?.check;
  expect(check).toBeTruthy();
  expect(check!.bets).toBe(1);
  expect(check!.changed).toBe(1);
  expect(Number(check!.stake_new)).toBeLessThan(Number(check!.stake_old));
  const created = page.getByRole('dialog', { name: `Кандидат ${code}` });
  const box = created.getByText(/^Проверка на ваших ставках:/).locator('xpath=..');
  await expect(box).toContainText(': 1 ставка, у 1 сумма изменилась бы.');
  const stakes = new RegExp(`Сумма ставок ${rub(check!.stake_old)} → ${rub(check!.stake_new)}`);
  await expect(box).toContainText(stakes);
  await expect(box).toContainText(new RegExp(`Прибыль при тех же исходах ${rub(check!.profit_old)} → ${rub(check!.profit_new)}\\.`));
  await expect(box).not.toContainText('—:');
  await created.getByRole('button', { name: 'Включить позже' }).click();
  // кандидат ждет решения — та же проверка в «Правилах стратегии»
  await expect(strategy.getByText(stakes)).toBeVisible();
});
