import { gzipSync } from 'node:zlib';

import type { Browser, BrowserContextOptions } from '@playwright/test';

import { memberDevice } from '../support/analysis';
import { expect, test } from '../support/test';

// Бюджет JS первого экрана (docs/PLAN.md, «Целевые показатели»: < 250 КБ gzip) в настоящем
// браузере: открываем экран по ссылке в новой вкладке и считаем все файлы JS, которые она
// скачала, пока не затихла сеть, — начальную загрузку, файл экрана и его тексты. Тексты всех
// экранов разом (запасной файл rest) при обычной работе не грузятся.

const BUDGET_KB = 250;

async function firstLoad(browser: Browser, state: BrowserContextOptions['storageState'], path: string) {
  const context = await browser.newContext({ storageState: state });
  const page = await context.newPage();
  const files = new Map<string, number>();
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.endsWith('.js')) return;
    const body = await response.body().catch(() => Buffer.alloc(0));
    files.set(url.pathname, gzipSync(body, { level: 9 }).length / 1024);
  });
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await context.close();
  return files;
}

test('первый экран по ссылке: JS меньше 250 КБ gzip, без текстов всех экранов', async ({ device, apiClient, browser }) => {
  const m = await memberDevice(device, apiClient, 'Проба Веса');
  const state = await m.context.storageState();
  for (const path of ['/', '/bets', '/profile/bank', '/profile/data', '/analytics', '/costs']) {
    const files = await firstLoad(browser, state, path);
    const total = [...files.values()].reduce((sum, kb) => sum + kb, 0);
    expect([...files.keys()].filter((file) => /\/rest-[^/]*\.js$/.test(file)), path).toEqual([]);
    expect(total, `${path}: ${[...files].map(([file, kb]) => `${file} ${kb.toFixed(1)}`).join(', ')}`).toBeLessThan(BUDGET_KB);
  }
  const files = await firstLoad(browser, undefined, '/login');
  expect([...files.values()].reduce((sum, kb) => sum + kb, 0)).toBeLessThan(BUDGET_KB);
});
