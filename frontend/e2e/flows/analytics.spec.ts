import { analyticsOut, wideAnalyticsOut } from '../../src/features/analytics/testData';
import { memberDevice } from '../support/analysis';
import { expectScreenLayout } from '../support/layout';
import type { Page } from '@playwright/test';

import { expect, test } from '../support/test';
import { markSpa, navTo, placeBet, rub, settleWon, wonProfit } from './dashboard-steps';

// «Аналитика» (этап 4): рассчитанная ставка попадает в выборку и показатели (числа считает
// сервер), фильтры живут в адресе и уходят в запрос, сводка по рынкам ставит фильтр исхода,
// выгрузка — CSV одной части или ZIP нескольких под теми же фильтрами. Расчет на «Ставках» и
// возврат в «Аналитику» — пунктами меню, без перезагрузки: числа обязаны обновиться из-за сброса
// кэша, а не из-за новой страницы. На телефоне — фильтры шторкой выпадающих списков без прокрутки
// вбок, подписи срезов не обрезаются.

test('аналитика: ставка в показателях, фильтры в адресе, сводка по рынкам и выгрузка', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'на телефоне — отдельный сценарий ниже');
  const m = await memberDevice(device, apiClient, 'Ада Аналитик');
  const page = m.page;
  const { id, stake } = await placeBet(page);

  // до расчета ставки аналитики нет — новый участник идет на «Ставки»
  await page.goto('/analytics');
  await markSpa(page);
  await expect(page.getByText('Рассчитанных ставок пока нет')).toBeVisible();
  await navTo(page, false, 'Ставки');
  await page.getByRole('article', { name: `Открытая ставка №${id}` }).getByRole('button', { name: 'Внести результат' }).click();
  await settleWon(page, id);
  const profit = wonProfit(stake);

  await navTo(page, false, 'Аналитика');
  const filters = page.getByRole('region', { name: 'Фильтры: применяются ко всем блокам ниже' });
  await expect(filters).toContainText('В выборке 1 ставка и 2 события');
  const kpis = page.getByRole('region', { name: 'Ключевые показатели за все время' });
  await expect(kpis).toContainText(rub(profit, { signed: true }));
  await expect(kpis).toContainText(`+${((profit / stake) * 100).toFixed(1).replace('.', ',')}%`);
  await expect(kpis).toContainText('100,0%');
  await expect(page.getByRole('list', { name: 'Выводы' })).toContainText('Выборка слишком мала для выводов');
  await expect(page.getByRole('heading', { level: 3, name: 'Банк по дням' })).toBeVisible();

  // фильтр исхода в выпадающем списке: в адресе и в запросе, ряд — результат отобранных ставок
  const request = page.waitForRequest((r) => r.url().includes('/api/analytics?') && r.url().includes('market=ML') && r.url().includes('selection=1'));
  await page.getByRole('button', { name: 'Рынок: Все рынки' }).click();
  await page.getByRole('listbox', { name: 'Рынок' }).getByRole('option', { name: 'П1' }).click();
  await request;
  await expect(page).toHaveURL(/\/analytics\?market=ML&selection=1$/);
  await expect(page.getByRole('heading', { level: 3, name: 'Результат отобранных ставок' })).toBeVisible();
  await expect(filters.getByRole('button', { name: 'Убрать фильтр: Рынок: П1' })).toBeVisible();

  // сводка по рынкам: «Все рынки» снимает фильтр; строка исхода — ставит снова
  const summary = page.getByRole('table', { name: 'Сводка по рынкам' });
  await summary.getByRole('row', { name: /^Все рынки\./ }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await summary.getByRole('row', { name: 'П1. Нажмите, чтобы отфильтровать страницу' }).click();
  await expect(page).toHaveURL(/\/analytics\?market=ML&selection=1$/);
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await page.getByRole('button', { name: '30 дней' }).click();
  await expect(page).toHaveURL(/\/analytics\?period=30d$/);
  await expect(page.getByRole('region', { name: 'Ключевые показатели за 30 дней' })).toContainText(rub(profit, { signed: true }));

  // выгрузка: по умолчанию ставки и события — ZIP; одна часть — CSV; файлы отдает сервер
  await page.getByRole('button', { name: 'Выгрузить CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Выгрузить аналитику в CSV' });
  const download = dialog.getByRole('link', { name: 'Скачать CSV' });
  await expect(download).toHaveAttribute('href', '/api/analytics/export.zip?period=30d&part=bets&part=events');
  const zip = await m.api.get('/api/analytics/export.zip?period=30d&part=bets&part=events');
  expect(zip.status()).toBe(200);
  expect(zip.headers()['content-type']).toContain('application/zip');
  await dialog.getByRole('checkbox', { name: 'События экспрессов (кэф, закрытие, прогноз модели)' }).click();
  await expect(download).toHaveAttribute('href', '/api/analytics/export.csv?period=30d&part=bets');
  const csv = await m.api.get('/api/analytics/export.csv?period=30d&part=bets');
  expect(csv.status()).toBe(200);
  expect((await csv.text()).split('\n').filter((line) => line.trim()).length).toBeGreaterThanOrEqual(2);
  const downloaded = page.waitForEvent('download');
  await download.click();
  expect((await downloaded).suggestedFilename()).toMatch(/^analytics-bets-\d{4}-\d{2}-\d{2}\.csv$/);
  await expect(dialog).toBeHidden();
  await expectScreenLayout(page);
});

test('телефон: фильтры «Аналитики» шторкой, сброс и сводка по рынкам кнопками', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  test.skip(!isMobile, 'сценарий для телефона');
  const m = await memberDevice(device, apiClient, 'Ася Аналитик');
  const page = m.page;
  const { id } = await placeBet(page);
  await page.goto('/analytics');
  await markSpa(page);
  await expect(page.getByText('Рассчитанных ставок пока нет')).toBeVisible();
  await navTo(page, true, 'Ставки');
  await page.getByRole('article', { name: `Открытая ставка №${id}` }).getByRole('button', { name: 'Внести результат' }).click();
  await settleWon(page, id);

  await navTo(page, true, 'Аналитика');
  await expect(page.getByRole('region', { name: 'Фильтры: применяются ко всем блокам ниже' })).toContainText('В выборке 1 ставка');
  await page.getByRole('button', { name: 'Источник: Все источники' }).click();
  const sheet = page.getByRole('dialog', { name: 'Источник' });
  await sheet.getByRole('option', { name: 'Приложение' }).click();
  await expect(page).toHaveURL(/\/analytics\?source=app$/);
  await expect(page.getByRole('heading', { level: 3, name: 'Результат отобранных ставок' })).toBeVisible();
  await expectScreenLayout(page);
  await page.getByRole('list', { name: 'Сводка по рынкам' }).getByRole('button', { name: 'П1. Нажмите, чтобы отфильтровать страницу' }).click();
  await expect(page).toHaveURL(/\/analytics\?market=ML&selection=1&source=app$/);
  await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
  await expect(page).toHaveURL(/\/analytics$/);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);
});

test('телефон: итоговый кэф вне таблицы стратегии — подпись целиком, «Ср. кэф» в одну строку', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  test.skip(!isMobile, 'сценарий для телефона');
  const m = await memberDevice(device, apiClient, 'Вера Вне Таблицы');
  const page = m.page;
  // Ответ «Аналитики» подменен: экспрессы с итоговым кэфом выше таблицы стратегии на стеке
  // пришлось бы ставить анализами
  const base = analyticsOut();
  const outside = { low: null, high: null, stake_pct: null, triple: false, bets: 8, voids: 0, turnover: '8000.00', profit: '1200.00', roi: 0.15, roi_ci: { low: -0.2, high: 0.5 }, small: true };
  const body = analyticsOut({ slices: { ...base.slices, totals: [...base.slices.totals, outside] } });
  await page.route(/\/api\/analytics(\?.*)?$/, (route) => route.fulfill({ json: body }));
  await page.goto('/analytics?period=90d');
  const name = page.getByRole('list', { name: 'ROI по итоговому кэфу' }).getByText('Вне таблицы', { exact: true });
  await expect(name).toBeVisible();
  // текст не обрезан многоточием: вся ширина текста помещается в подпись
  expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 0.5)).toBe(true);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }
});

/** Открытые таблицы, которые шире своей рамки (прокрутка вбок внутри карточки): «Подпись: 395/296». */
async function wideTables(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.table-wrap')]
      .filter((wrap) => wrap.clientWidth > 0 && wrap.scrollWidth > wrap.clientWidth + 1)
      .map((wrap) => `${wrap.querySelector('caption')?.textContent ?? '?'}: ${wrap.scrollWidth}/${wrap.clientWidth}`),
  );
}

test('таблицы «Аналитики» не шире своих карточек: телефон, две колонки карточек, компьютер', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Таня Таблицы');
  const page = m.page;
  // Ответ подменен широкими данными: длинные интервалы, большие суммы, все покрытия
  await page.route(/\/api\/analytics(\?.*)?$/, (route) => route.fulfill({ json: wideAnalyticsOut() }));
  await page.goto('/analytics');
  await expect(page.getByRole('heading', { level: 3, name: 'ROI по покрытиям' })).toBeVisible();
  const toggles = page.getByRole('button', { name: 'Показать таблицей' });
  for (let n = await toggles.count(); n > 0; n -= 1) await toggles.first().click();
  await expect(page.getByRole('table', { name: 'ROI по итоговому кэфу' })).toBeVisible();
  // компьютер: 1366 — две колонки карточек по ~470 px, 1200 — по ~390 px, 1024 — одна колонка
  const widths = isMobile ? [page.viewportSize()?.width ?? 375] : [1366, 1200, 1024];
  for (const width of widths) {
    if (!isMobile) await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => wideTables(page), { message: `ширина ${width}` }).toEqual([]);
  }
  await expectScreenLayout(page);
});
