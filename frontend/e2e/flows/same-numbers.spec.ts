import type { Locator, Page } from '@playwright/test';

import { memberDevice } from '../support/analysis';
import { expect, test, type Device } from '../support/test';
import { toast } from '../support/ui';
import { markSpa, navTo, placeBet, rub, START, wonProfit } from './dashboard-steps';

// Сквозной сценарий приемки этапа 4 («Готово, когда»: главная = «Аналитика» без фильтров = итоги
// «Ставок»): анализ (поддельный Claude) → ставка → результат с закрывающими кэфами → банк,
// главная за все время, итоги «Ставок» и «Аналитика» показывают одни и те же числа — и в ответах
// сервера, и на экранах → «Исправить результат» (проигрыш) → числа везде новые и снова одинаковые
// → исправить обратно → числа вернулись к первым. Экраны открываются пунктами меню, без
// перезагрузки: свежие числа видны, только если расчет и сторно сбросили кэш запросов.

interface Kpi {
  settled: number;
  won: number;
  lost: number;
  profit: string;
  roi: number | null;
  winrate: number | null;
  clv: number | null;
  clv_n: number;
}

/** Показатели одного экрана в том виде, как они на экране. */
interface Shown {
  profit: string;
  roi: string;
  winrate: string;
  clv: string;
}

/** Показатели всех трех источников сервера: главная за все время, итоги «Ставок», «Аналитика». */
async function serverKpis(m: Device): Promise<{ dashboard: Kpi; bets: Kpi; analytics: Kpi; balance: number }> {
  const get = async <T>(path: string): Promise<T> => {
    const response = await m.api.get(path);
    expect(response.status(), path).toBe(200);
    return (await response.json()) as T;
  };
  const dashboard = await get<{ kpi: Kpi }>('/api/dashboard?period=all');
  const bets = await get<Kpi>('/api/bets/summary');
  const analytics = await get<{ kpi: Kpi }>('/api/analytics');
  const bank = await get<{ balance: string }>('/api/me/bank');
  return { dashboard: dashboard.kpi, bets, analytics: analytics.kpi, balance: Number(bank.balance) };
}

/** Одни и те же числа у всех трех ответов сервера (деньги — строкой Decimal, доли — числом). */
function expectSameKpis(k: { dashboard: Kpi; bets: Kpi; analytics: Kpi }): void {
  const pick = (x: Kpi) => ({ settled: x.settled, won: x.won, lost: x.lost, profit: x.profit, roi: x.roi, winrate: x.winrate, clv: x.clv, clv_n: x.clv_n });
  expect(pick(k.bets)).toEqual(pick(k.dashboard));
  expect(pick(k.analytics)).toEqual(pick(k.dashboard));
}

/** Число плитки (Stat) по точной подписи. */
function statValue(scope: Locator, label: string): Locator {
  return scope
    .locator('.stat')
    .filter({ has: scope.page().locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('.stat-value');
}

/** Ячейка итогов «Ставок» по подписи. */
function cellValue(scope: Locator, label: string): Locator {
  return scope
    .locator('.bets-sum-cell')
    .filter({ has: scope.page().locator('.bets-sum-l', { hasText: new RegExp(`^${label}`) }) })
    .locator('.bets-sum-v');
}

const text = async (locator: Locator): Promise<string> => (await locator.innerText()).trim();

/*
 * Экран после перехода сначала показывает прежний ответ из кэша и перечитывает его в фоне
 * (TanStack Query): читать числа с первой отрисовки нельзя — можно взять старые и новые вперемешку.
 * Поэтому сначала ждем ожидаемую прибыль (она меняется при каждом исправлении), и только потом
 * читаем остальное: все плитки экрана — из одного ответа сервера.
 */

/** Главная за все время: прибыль из полосы под графиком, ROI, винрейт и CLV — плитки. */
async function dashboardShown(page: Page, expected: RegExp): Promise<Shown> {
  await navTo(page, false, 'Главная');
  const period = page.getByRole('group', { name: 'Период для показателей' });
  await period.getByRole('button', { name: 'Все' }).click();
  await expect(period.getByRole('button', { name: 'Все' })).toHaveAttribute('aria-pressed', 'true');
  const view = page.locator('#view');
  const profit = view.locator('.dashboard-strip > div').filter({ hasText: 'Прибыль' }).locator('dd');
  await expect(profit).toHaveText(expected);
  return {
    profit: await text(profit),
    roi: await text(statValue(view, 'ROI')),
    winrate: await text(statValue(view, 'Винрейт')),
    clv: await text(statValue(view, 'Средний CLV')),
  };
}

/** Итоги «Ставок» без фильтров: прибыль, ROI, CLV — ячейки, винрейт — подпись под «В · П · в». */
async function betsShown(page: Page, expected: RegExp): Promise<Shown> {
  await navTo(page, false, 'Ставки');
  const summary = page.getByRole('region', { name: 'Итоги по ставкам' });
  await expect(cellValue(summary, 'Прибыль')).toHaveText(expected);
  const winrate = /винрейт (\S+)/.exec(await summary.innerText())?.[1] ?? '';
  return {
    profit: await text(cellValue(summary, 'Прибыль')),
    roi: await text(cellValue(summary, 'ROI')),
    winrate,
    clv: await text(cellValue(summary, 'Средний CLV')),
  };
}

/** «Аналитика» без фильтров (все время): плитки показателей. */
async function analyticsShown(page: Page, expected: RegExp): Promise<Shown> {
  await navTo(page, false, 'Аналитика');
  const kpis = page.getByRole('region', { name: 'Ключевые показатели за все время' });
  await expect(statValue(kpis, 'Прибыль')).toHaveText(expected);
  return {
    profit: await text(statValue(kpis, 'Прибыль')),
    roi: await text(statValue(kpis, 'ROI')),
    winrate: await text(statValue(kpis, 'Винрейт')),
    clv: await text(statValue(kpis, 'Средний CLV')),
  };
}

/** Все три экрана показывают одно и то же; возвращает показанное. */
async function expectSameOnScreens(page: Page, expected: { profit: RegExp }): Promise<Shown> {
  const dashboard = await dashboardShown(page, expected.profit);
  const bets = await betsShown(page, expected.profit);
  const analytics = await analyticsShown(page, expected.profit);
  expect(bets).toEqual(dashboard);
  expect(analytics).toEqual(dashboard);
  return dashboard;
}

/** Рубли со знаком, как на экране (рубли — без копеек): «+1 168 ₽». */
function signedRub(value: number): RegExp {
  return new RegExp(`^${rub(value, { signed: true }).source}$`);
}

/** «Исправить результат» из сообщения после расчета: сторно и новый исход ноги Джоковича. */
async function correct(page: Page, id: number, djokovic: 'Выиграл' | 'Проиграл'): Promise<void> {
  await navTo(page, false, 'Ставки');
  const row = page.locator(`tr[data-bet="${id}"]`);
  await expect(row).toBeVisible();
  // строка раскрывается нажатием; уже раскрытую (после расчета) второй раз не нажимаем
  const fix = page.getByRole('button', { name: 'Исправить результат' }).first();
  if (!(await fix.isVisible())) await row.click();
  await fix.click();
  await page.getByRole('dialog', { name: `Исправить результат №${id}` }).getByRole('button', { name: 'Отменить расчет и исправить' }).click();
  const again = page.getByRole('dialog', { name: `Исправить результат №${id}` });
  // у проигрыша выплаты не было — «уже отменен.», у выигрыша — «уже отменен сторно.»
  await expect(again.getByText(/^Прошлый расчет уже отменен/)).toBeVisible();
  await again.getByRole('group', { name: /Джокович — Рублев$/ }).getByRole('button', { name: djokovic }).click();
  await again.getByRole('button', { name: 'Сохранить исправление' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} пересчитана`))).toBeVisible();
  await expect(again).toBeHidden();
}

test('ставка → результат с закрытием → главная, «Ставки» и «Аналитика» с одними числами → исправить → числа вернулись', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'раскладку телефона проверяют сценарии экранов и all-routes.spec.ts');
  const m = await memberDevice(device, apiClient, 'Сверка Чисел');
  const page = m.page;
  const { id, stake } = await placeBet(page);
  // деньги в игре уже списаны с остатка: банк из текста анализа минус сумма ставки
  expect((await serverKpis(m)).balance).toBeCloseTo(START - stake, 2);

  // Результат на «Ставках»: оба события выиграли, закрывающие кэфы у обоих — CLV считается
  await page.goto('/bets');
  await markSpa(page);
  await page.getByRole('article', { name: `Открытая ставка №${id}` }).getByRole('button', { name: 'Внести результат' }).click();
  const dialog = page.getByRole('dialog', { name: `Результат ставки №${id}` });
  const sinner = dialog.getByRole('group', { name: /Синнер — Руне$/ });
  const djokovic = dialog.getByRole('group', { name: /Джокович — Рублев$/ });
  await sinner.getByRole('button', { name: 'Выиграл' }).click();
  await sinner.getByRole('textbox', { name: 'На ваш исход' }).fill('1.25');
  await djokovic.getByRole('button', { name: 'Выиграл' }).click();
  await djokovic.getByRole('textbox', { name: 'На ваш исход' }).fill('1.50');
  await dialog.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} рассчитана`))).toBeVisible();
  await expect(dialog).toBeHidden();

  // Сервер: три ответа сходятся, банк вырос на прибыль
  const profit = wonProfit(stake);
  const won = await serverKpis(m);
  expectSameKpis(won);
  expect(Number(won.dashboard.profit)).toBeCloseTo(profit, 2);
  expect(won.balance).toBeCloseTo(START + profit, 2);
  expect(won.dashboard.clv_n).toBe(1);
  expect(won.dashboard.clv).not.toBeNull();

  // Экраны: те же числа на главной, в итогах «Ставок» и в «Аналитике»
  const first = await expectSameOnScreens(page, { profit: signedRub(profit) });
  expect(first.winrate).toBe('100,0%');

  // Исправление: Джокович проиграл — ставка проиграна, числа новые и снова одинаковые
  await correct(page, id, 'Проиграл');
  const lost = await serverKpis(m);
  expectSameKpis(lost);
  expect(Number(lost.dashboard.profit)).toBeCloseTo(-stake, 2);
  expect(lost.balance).toBeCloseTo(START - stake, 2);
  const second = await expectSameOnScreens(page, { profit: signedRub(-stake) });
  expect(second.winrate).toBe('0,0%');
  expect(second.roi).not.toBe(first.roi);

  // Исправление обратно: выигрыш — числа вернулись к первым до символа
  await correct(page, id, 'Выиграл');
  const back = await serverKpis(m);
  expectSameKpis(back);
  expect(back.dashboard).toEqual(won.dashboard);
  expect(back.balance).toBeCloseTo(won.balance, 2);
  expect(await expectSameOnScreens(page, { profit: signedRub(profit) })).toEqual(first);
});
