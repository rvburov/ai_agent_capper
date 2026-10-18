import type { Page } from '@playwright/test';

import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, memberDevice, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expect, test, type Device } from '../support/test';
import { expectNoHorizontalScroll, toast } from '../support/ui';

// Р29: варианты ставки и своя ставка. Анализ одного матча → экспресса нет → вариант «Ординар» →
// «Сохранить ставку» → ставка с меткой «Ординар» в «Ставках» → «Внести результат» → банк.
// Своя ставка из двух матчей: «В свою ставку» у исходов → окно «Своя ставка» → «Ставки» с «Своя».

const START = 48_000;

async function runAnalysis(page: Page, text: string, count: number): Promise<void> {
  await parseEvents(page, text, count);
  const run = page.getByRole('button', { name: /^Запустить/ }).last();
  await withFakeClaude(async () => {
    await run.click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 3, name: 'Варианты ставки' })).toBeVisible({ timeout: 30_000 });
  });
}

async function bankBalance(device: Device): Promise<number> {
  const bank = (await (await device.api.get('/api/me/bank')).json()) as { balance: string };
  return Number(bank.balance);
}

test('один матч → вариант «Ординар» → ставка «Ординар» в «Ставках» → результат → банк', async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Ора Ординарова');
  const page = m.page;
  await runAnalysis(page, eventsText(SINNER_RUNE), 1);

  // Экспресса из одного матча нет — не тупик: варианты ставки
  await expect(page.getByRole('heading', { level: 2, name: /^Экспресса стратегии нет · \d варианта? ставки$/ })).toBeVisible();
  await expect(page.getByText('Экспресса стратегии нет.')).toBeVisible();
  const single = page.getByRole('region', { name: /^Ординар · надежнее/ });
  await expect(single.getByText('Ординар', { exact: true })).toBeVisible();
  const stake = Number((await single.locator('.analysis-stake-value').innerText()).replace(/\D/g, ''));
  expect(stake).toBeGreaterThan(0);
  // таблица ординара: от 1% до 1,5% банка по кэфу, поправки на валуй у ординара нет
  expect(stake).toBeGreaterThanOrEqual(START * 0.01);
  expect(stake).toBeLessThanOrEqual(START * 0.015);
  if (isMobile) await expectNoHorizontalScroll(page);

  await single.getByRole('button', { name: 'Сохранить ставку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить ставку' });
  await expect(dialog.getByText(/Ординар — настоящая ставка/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  const saved = toast(page, /Ставка №\d+ сохранена · ординар/);
  await expect(saved).toBeVisible();
  const id = Number(/№(\d+)/.exec(await saved.innerText())?.[1]);
  await expect(single.getByText('Сохранена')).toBeVisible();
  expect(await bankBalance(m)).toBe(START - stake);

  await single.getByRole('link', { name: 'Открыть в ставках' }).click();
  const card = page.getByRole('article', { name: `Открытая ставка №${id}` });
  await expect(card).toContainText('Вариант анализа');
  await expect(card.getByText('Ординар', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Внести результат' }).click();
  const settle = page.getByRole('dialog', { name: `Результат ставки №${id}` });
  await expect(settle.getByText('Ординар', { exact: true })).toBeVisible();
  await settle.getByRole('textbox', { name: 'Счет по сетам' }).fill('2:0');
  await expect(settle.getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
  await settle.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} рассчитана`))).toBeVisible();
  // выплата — сумма × 1.30
  expect(await bankBalance(m)).toBeCloseTo(START - stake + stake * 1.3, 2);

  // «Ставки» по виду: ординар — в «Ординарах», не в «Своих»
  const singles = (await (await m.api.get('/api/bets/summary?kind=single')).json()) as { settled: number };
  const own = (await (await m.api.get('/api/bets/summary?kind=own')).json()) as { settled: number };
  expect(singles.settled).toBe(1);
  expect(own.settled).toBe(0);
});

test('своя ставка из двух матчей: «В свою ставку» → окно → «Ставки» с меткой «Своя»', async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Сова Своякова');
  const page = m.page;
  await runAnalysis(page, eventsText(SINNER_RUNE, DJOKOVIC_RUBLEV), 2);

  // на телефоне таблица рынков — на вкладке «Вероятности» карточки матча (по умолчанию)
  await page.getByRole('button', { name: 'В свою ставку: Синнер П1, Синнер — Руне' }).click();
  let dialog = page.getByRole('dialog', { name: 'Своя ставка' });
  await expect(dialog.getByText('Своя', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрыть' }).click();
  // второй рынок того же матча заменяет первый
  await page.getByRole('button', { name: 'В свою ставку: Руне П2, Синнер — Руне' }).click();
  dialog = page.getByRole('dialog', { name: 'Своя ставка' });
  await expect(dialog.getByText('Один рынок на матч: «Синнер П1» заменен на «Руне П2».')).toBeVisible();
  await dialog.getByRole('button', { name: 'Убрать «Руне П2»' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'В свою ставку: Синнер П1, Синнер — Руне' }).click();
  await page.getByRole('dialog', { name: 'Своя ставка' }).getByRole('button', { name: 'Закрыть' }).click();
  await page.getByRole('button', { name: 'В свою ставку: Джокович П1, Джокович — Рублев' }).click();
  dialog = page.getByRole('dialog', { name: 'Своя ставка' });
  await expect(dialog.getByText('Экспресс × 2')).toBeVisible();
  await dialog.getByRole('textbox', { name: /Сумма ставки/ }).fill('500');
  await expect(dialog.getByText(/^943\s₽$/)).toBeVisible();
  if (isMobile) await expectNoHorizontalScroll(page);
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  const savedOwn = toast(page, /Ставка №\d+ сохранена · своя/);
  await expect(savedOwn).toBeVisible();
  // номер — из тоста: ?new= в адресе экран убирает, когда подсветил новую ставку
  const id = Number(/№(\d+)/.exec((await savedOwn.textContent()) ?? '')?.[1]);
  await expect(page).toHaveURL(/\/bets/);
  const card = page.getByRole('article', { name: `Открытая ставка №${id}` });
  await expect(card).toContainText('Экспресс из 2 событий');
  await expect(card.getByText('Своя', { exact: true })).toBeVisible();
  expect(await bankBalance(m)).toBe(START - 500);
});
