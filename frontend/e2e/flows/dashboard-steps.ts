import { expect, type Page } from '@playwright/test';

import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { toast } from '../support/ui';

/*
 * Шаги сценариев главной и «Аналитики» (dashboard.spec.ts, analytics.spec.ts): ставка по анализу
 * (поддельный Claude), расчет со страницы «Ставки» по ссылке главной и переходы пунктами меню
 * без перезагрузки. Банк из текста анализа — 48 000 ₽; экспресс — Синнер П1 @1.30 и Джокович П1
 * @1.45, итоговый кэф 1.885.
 */

export const START = 48_000;
export const TOTAL_MILLI = 1885;

/** Анализ двух матчей и «Сохранить ставку»: номер ставки и сумма в рублях. */
export async function placeBet(page: Page): Promise<{ id: number; stake: number }> {
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

/** Окно результата открыто ссылкой: оба события выиграли — «Сохранить результат». */
export async function settleWon(page: Page, id: number): Promise<void> {
  const dialog = page.getByRole('dialog', { name: `Результат ставки №${id}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('group', { name: /Синнер — Руне$/ }).getByRole('button', { name: 'Выиграл' }).click();
  await dialog.getByRole('group', { name: /Джокович — Рублев$/ }).getByRole('button', { name: 'Выиграл' }).click();
  await dialog.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} рассчитана`))).toBeVisible();
  await expect(dialog).toBeHidden();
}

/** Пункт меню: боковая панель на компьютере, нижние вкладки на телефоне. */
export type NavItem = 'Главная' | 'Ставки' | 'Аналитика';

/**
 * Переход пунктом меню внутри приложения, без перезагрузки: кэш запросов (TanStack Query)
 * остается, поэтому свежие числа после расчета видны, только если расчет сбросил ключи
 * ['dashboard'] и ['analytics'] (у запросов staleTime 30 с). Перезагрузку ловит метка на window.
 */
const NAV_URL: Record<NavItem, RegExp> = { Главная: /\/$/, Ставки: /\/bets$/, Аналитика: /\/analytics$/ };

export async function navTo(page: Page, isMobile: boolean, item: NavItem): Promise<void> {
  const nav = isMobile ? page.getByRole('navigation', { name: 'Нижняя навигация' }) : page.getByRole('complementary', { name: 'Основная навигация' });
  // у «Ставок» после названия — счетчик открытых ставок («Ставки Открытых ставок: 1»)
  await nav.getByRole('link', { name: new RegExp(`^${item}(\\s|$)`) }).click();
  await expect(page).toHaveURL(NAV_URL[item]);
  expect(await page.evaluate(() => (window as Window & { __spa?: boolean }).__spa)).toBe(true);
}

/** Метка «страница не перезагружалась» для navTo: ставится после page.goto. */
export async function markSpa(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __spa?: boolean }).__spa = true;
  });
}

/** Прибыль выигранного экспресса: выплата до копеек половиной вверх минус сумма. */
export function wonProfit(stake: number): number {
  return Math.round((stake * TOTAL_MILLI) / 10) / 100 - stake;
}

/** Рубли как на экране: «2 488 ₽» (разделитель тысяч — неразрывный пробел), со знаком при signed. */
export function rub(value: number, { signed = false } = {}): RegExp {
  const digits = String(Math.round(Math.abs(value))).replace(/\B(?=(\d{3})+$)/g, '\\s');
  const sign = value < 0 ? '−' : signed && value > 0 ? '\\+' : '';
  return new RegExp(`${sign}${digits}\\s₽`);
}
