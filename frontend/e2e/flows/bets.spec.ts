import type { Page } from '@playwright/test';

import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, memberDevice, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expectScreenLayout } from '../support/layout';
import { expect, test, type Device } from '../support/test';
import { toast } from '../support/ui';

// «Ставки» (этап 4): ставка по анализу (поддельный Claude) → «Ставки» → результат с закрывающим
// кэфом → банк и итоги изменились → «Исправить результат» (сторно и повторный расчет). На
// телефоне (375 px, с меткой @360 — и 360 px) — карточки, шторка фильтров и нижний лист ставки.

const START = 48_000;
// Экспресс анализа: Синнер П1 @1.30 и Джокович П1 @1.45 — итоговый кэф 1.885
const TOTAL_MILLI = 1885;

/** Анализ двух матчей и «Сохранить ставку»: номер ставки и сумма в рублях. */
async function placeBet(page: Page): Promise<{ id: number; stake: number }> {
  await parseEvents(page, eventsText(SINNER_RUNE, DJOKOVIC_RUBLEV), 2);
  const run = page.getByRole('button', { name: /^Запустить/ }).last();
  await withFakeClaude(async () => {
    await run.click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из 2 событий/ })).toBeVisible({ timeout: 30_000 });
  });
  const express = page.getByRole('region', { name: 'Экспресс' });
  await express.getByRole('button', { name: 'Сохранить ставку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить ставку' });
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  const saved = toast(page, /Ставка №\d+ сохранена/);
  await expect(saved).toBeVisible();
  const id = Number(/№(\d+)/.exec(await saved.innerText())?.[1]);
  await expect(dialog).toBeHidden();
  const stake = Number((await express.locator('.analysis-stake-value').innerText()).replace(/\D/g, ''));
  expect(id).toBeGreaterThan(0);
  expect(stake).toBeGreaterThan(0);
  return { id, stake };
}

/** Рубли как на экране: «2 488 ₽» (разделитель тысяч — неразрывный пробел). */
function rub(value: number): RegExp {
  const digits = String(Math.round(Math.abs(value))).replace(/\B(?=(\d{3})+$)/g, '\\s');
  return new RegExp(`${value < 0 ? '−' : value > 0 ? '\\+?' : ''}${digits}\\s₽`);
}

async function bankBalance(device: Device): Promise<number> {
  const bank = (await (await device.api.get('/api/me/bank')).json()) as { balance: string; equity: string };
  return Number(bank.balance);
}

test('ставка → результат с закрытием → банк и итоги → исправить результат', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'на телефоне — отдельный сценарий ниже');
  const m = await memberDevice(device, apiClient, 'Сева Ставкин');
  const page = m.page;
  const { id, stake } = await placeBet(page);
  // выплата до копеек, половина вверх (сумма в рублях целая — произведение точное)
  const payout = Math.round((stake * TOTAL_MILLI) / 10) / 100;

  await page.goto('/bets');
  await expect(page.getByRole('heading', { level: 2, name: 'История ставок' })).toBeVisible();
  const summary = page.getByRole('region', { name: 'Итоги по ставкам' });
  await expect(summary.getByText('Рассчитано ставок')).toBeVisible();
  await expect(summary.getByText(/и еще 1 в игре/)).toBeVisible();
  const card = page.getByRole('article', { name: `Открытая ставка №${id}` });
  await expect(card).toContainText('Экспресс из 2 событий');
  await expect(card).toContainText('Синнер — Руне');
  await expect(card.getByRole('link', { name: 'Почему эта ставка' })).toHaveAttribute('href', /\/analysis\/\d+$/);

  // Окно результата: счет отмечает исход сам, закрывающий кэф дает CLV на лету
  await card.getByRole('button', { name: 'Внести результат' }).click();
  const dialog = page.getByRole('dialog', { name: `Результат ставки №${id}` });
  const sinner = dialog.getByRole('group', { name: /Синнер — Руне$/ });
  const djokovic = dialog.getByRole('group', { name: /Джокович — Рублев$/ });
  await sinner.getByRole('textbox', { name: 'Счет по сетам' }).fill('2:1');
  await expect(sinner.getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sinner.getByText('Отметили по счету — можно поправить')).toBeVisible();
  await sinner.getByRole('textbox', { name: 'На ваш исход' }).fill('1.25');
  await expect(sinner.getByText(/CLV \+4,0%/)).toBeVisible();
  await sinner.getByRole('textbox', { name: 'На обратный исход' }).fill('4.20');
  await expect(sinner.getByText(/без маржи \+2,2%/)).toBeVisible();
  // Исход не совпал со счетом — только предупреждение (В16)
  await djokovic.getByRole('button', { name: 'Проиграл' }).click();
  await djokovic.getByRole('textbox', { name: 'Счет по сетам' }).fill('2:0');
  await expect(djokovic.getByText('По счету ставка выиграла — проверьте, что выбрано верно')).toBeVisible();
  await djokovic.getByRole('button', { name: 'Выиграл' }).click();
  await djokovic.getByRole('textbox', { name: 'На ваш исход' }).fill('1.40');
  await expect(dialog.locator('.bets-ssum')).toContainText('Выигрыш');
  await expect(dialog.locator('.bets-ssum')).toContainText(rub(payout));
  await dialog.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} рассчитана`))).toBeVisible();
  await expect(dialog).toBeHidden();

  // Банк и итоги изменились: выплата пришла в журнал, ставка — в истории
  expect(await bankBalance(m)).toBeCloseTo(START - stake + payout, 2);
  const banner = page.getByRole('status').filter({ hasText: 'Вердикт по CLV' });
  await expect(banner).toContainText(`Ставка №${id} рассчитана: выигрыш`);
  await expect(banner).toContainText('Перевес подтвержден');
  // банк в сообщении — перечитанный после расчета; фокус — на сообщении (кнопка ставки исчезла)
  await expect(banner).toContainText(new RegExp(`Банк — ${rub(START - stake + payout).source}\\.`));
  await expect(banner).toBeFocused();
  await expect(summary.locator('.bets-sum-v').first()).toHaveText('1');
  await expect(summary).toContainText('1 · 0 · 0');
  const row = page.locator(`tr[data-bet="${id}"]`);
  await expect(row).toContainText('Выигрыш');
  const detail = page.getByRole('table', { name: `События ставки №${id}` });
  await expect(detail).toContainText('эталон · Pinnacle');
  await expect(detail).toContainText('2:1');

  // «Исправить результат»: сторно, окно с прежними значениями, новый расчет
  await banner.getByRole('button', { name: 'Исправить результат' }).click();
  const confirm = page.getByRole('dialog', { name: `Исправить результат №${id}` });
  await expect(confirm).toContainText('Банк после сторно');
  await confirm.getByRole('button', { name: 'Отменить расчет и исправить' }).click();
  const again = page.getByRole('dialog', { name: `Исправить результат №${id}` });
  await expect(again.getByText('Прошлый расчет уже отменен сторно.')).toBeVisible();
  const sinner2 = again.getByRole('group', { name: /Синнер — Руне$/ });
  await expect(sinner2.getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sinner2.getByRole('textbox', { name: 'Счет по сетам' })).toHaveValue('2:1');
  await expect(sinner2.getByRole('textbox', { name: 'На ваш исход' })).toHaveValue('1.25');
  await again.getByRole('group', { name: /Джокович — Рублев$/ }).getByRole('button', { name: 'Проиграл' }).click();
  await again.getByRole('button', { name: 'Сохранить исправление' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} пересчитана`))).toBeVisible();
  expect(await bankBalance(m)).toBeCloseTo(START - stake, 2);
  await expect(summary).toContainText('0 · 1 · 0');
  await expect(row).toContainText('Проигрыш');

  // Журнал банка в кабинете: ставка, выплата и ее сторно записаны сами
  const entries = (await (await m.api.get('/api/me/bank/entries')).json()) as { items: { kind: string }[] };
  expect(entries.items.map((e) => e.kind).slice(0, 3)).toEqual(['reversal', 'payout', 'stake']);
});

test('телефон: карточки, фильтры шторкой, результат и нижний лист', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  test.skip(!isMobile, 'сценарий для телефона');
  const m = await memberDevice(device, apiClient, 'Таня Телефонова');
  const page = m.page;
  const { id } = await placeBet(page);

  await page.goto('/bets');
  const card = page.getByRole('article', { name: `Открытая ставка №${id}` });
  await expect(card).toBeVisible();
  await expectScreenLayout(page);

  await card.getByRole('button', { name: 'Внести результат' }).click();
  const dialog = page.getByRole('dialog', { name: `Результат ставки №${id}` });
  await dialog.getByRole('group', { name: /Синнер — Руне$/ }).getByRole('button', { name: 'Проиграл' }).click();
  await expect(dialog.getByText(/Ставка уже проиграна/)).toBeVisible();
  await dialog.getByRole('group', { name: /Джокович — Рублев$/ }).getByRole('button', { name: 'Выиграл' }).click();
  await expectScreenLayout(page, { root: dialog });
  await dialog.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} рассчитана`))).toBeVisible();

  // История на телефоне — карточки; детали — в нижнем листе
  const history = page.getByRole('region', { name: 'История ставок' });
  const item = history.getByRole('button', { name: new RegExp(`^Ставка №${id},.*Проигрыш`) });
  await expect(item).toBeVisible();
  await expectScreenLayout(page);
  await item.click();
  const sheet = page.getByRole('dialog', { name: `Ставка №${id}` });
  await expect(sheet).toContainText('Без закрытия');
  await expect(sheet.getByRole('button', { name: 'Исправить' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
  await expect(sheet).toBeHidden();

  // Фильтры шторкой: «Показать N ставок» по итогам сервера
  await page.getByRole('button', { name: /^Фильтры/ }).click();
  const filters = page.getByRole('dialog', { name: 'Фильтры' });
  await filters.getByRole('group', { name: 'Статус ставки' }).getByRole('button', { name: 'Проигрыш' }).click();
  await filters.getByRole('button', { name: 'Показать 1 ставку' }).click();
  await expect(page).toHaveURL(/status=lost/);
  await expect(page.getByRole('button', { name: 'Убрать фильтр: Проигрыш' })).toBeVisible();
  await expect(page.getByRole('article', { name: `Открытая ставка №${id}` })).toBeHidden();

  // Темная тема — та же раскладка
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);
});
