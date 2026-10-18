import { SINNER_RUNE, eventsText, memberDevice, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expectScreenLayout } from '../support/layout';
import { expect, test } from '../support/test';

// «ИИ и расходы» (этап 4): после анализа с поддельным Claude экран показывает вызовы и их цену —
// те же, что отдает сервер (GET /api/ai/runs): число вызовов и сумма в итоге журнала, цена
// вызова в строке и в окне разбора. На телефоне (375 px, с меткой @360 — и 360 px) — журнал
// списком, без прокрутки вбок, в обеих темах.

interface Runs {
  items: { id: number; kind: string; cost_usd: number; analysis_id: number | null }[];
  total_runs: number;
  total_cost_usd: number;
}

/** Доллары как на экране: «$0,07», «$0,071» (formatUsd). */
function usd(value: number, digits = 2): string {
  return `$${value.toFixed(digits).replace('.', ',')}`;
}

/** «#A-0042» — номер анализа, как на остальных экранах (features/analysis/number.ts). */
function analysisNo(id: number): string {
  return `#A-${String(id).padStart(4, '0')}`;
}

/** «2 вызова» — как costs.calls. */
function calls(n: number): string {
  const tail = n % 10 === 1 && n % 100 !== 11 ? 'вызов' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'вызова' : 'вызовов';
  return `${n} ${tail}`;
}

test('анализ → «ИИ и расходы»: вызовы и цена, как в GET /api/ai/runs', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Роза Расходова');
  const page = m.page;
  await parseEvents(page, eventsText(SINNER_RUNE), 1);
  await withFakeClaude(async () => {
    await page.getByRole('button', { name: /^Запустить/ }).last().click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресса стратегии нет · \d варианта? ставки$|^Анализ 1 матча готов/ })).toBeVisible({ timeout: 30_000 });
  });
  const analysisId = Number(/\/analysis\/(\d+)/.exec(page.url())?.[1]);
  // имена игроков в сравнении — ссылки на их карточки (plink макета); на телефоне сравнение —
  // за переключателем разделов матча
  if (!isMobile) await expect(page.locator('.analysis-vs-name a[href^="/players/"]')).toHaveCount(2);

  const runs = (await (await m.api.get('/api/ai/runs?limit=20')).json()) as Runs;
  expect(runs.total_runs).toBeGreaterThanOrEqual(2);
  expect(runs.items.every((run) => run.analysis_id === null || run.analysis_id === analysisId)).toBe(true);

  await page.goto('/costs');
  await expect(page.getByRole('heading', { level: 2, name: /^Расходы на Claude в / })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Ваш лимит на ключе администратора' })).toBeVisible();
  // итог журнала — число вызовов и сумма с сервера
  await expect(page.getByText(`Всего: ${calls(runs.total_runs)} · ${usd(runs.total_cost_usd)}`)).toBeVisible();

  // первая строка журнала — самый новый вызов: цена как в ответе сервера
  const first = runs.items[0]!;
  const price = usd(first.cost_usd, first.cost_usd > 0 && first.cost_usd < 0.001 ? 4 : 3);
  if (isMobile) {
    const list = page.getByRole('list', { name: 'Вызовы Claude, сначала новые' });
    await expect(list.getByRole('button')).toHaveCount(Math.min(runs.total_runs, 20));
    await expect(list.getByRole('button').first()).toContainText(price);
    await expect(list.getByRole('button').first()).toContainText(analysisNo(analysisId));
    await list.getByRole('button').first().click();
  } else {
    const table = page.getByRole('table', { name: 'Вызовы Claude, сначала новые' });
    await expect(table.locator('tbody tr')).toHaveCount(Math.min(runs.total_runs, 20));
    const row = table.locator('tbody tr').first();
    await expect(row).toContainText(price);
    await expect(row.getByRole('link', { name: analysisNo(analysisId) })).toHaveAttribute('href', `/analysis/${analysisId}`);
    await row.click();
  }
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Цена вызова')).toBeVisible();
  await expect(dialog.locator('.stat-value')).toHaveText(price);
  await expect(dialog.getByText(/Ключ администратора — входит в ваш лимит/)).toBeVisible();
  if (isMobile) {
    // на телефоне части цены — списком (как в макете), а не таблицей шире окна
    await expect(dialog.getByRole('list', { name: 'Части цены вызова' })).toBeVisible();
    await expect(dialog.getByRole('table', { name: 'Части цены вызова' })).toHaveCount(0);
  }
  // ничего в окне не уходит за край: ни таблица, ни список
  const wide = await dialog.evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('.table-wrap, .costs-mlist')].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
  );
  expect(wide).toBe(0);
  await expectScreenLayout(page, { root: dialog });
  await dialog.getByRole('button', { name: 'Закрыть' }).last().click();
  await expect(dialog).toBeHidden();

  // «Цены моделей» — окно с таблицей цен
  await page.getByRole('button', { name: 'Цены моделей' }).click();
  const prices = page.getByRole('dialog', { name: 'Цены моделей' });
  await expect(prices).toBeVisible();
  await prices.getByRole('button', { name: 'Понятно' }).click();
  await expect(prices).toBeHidden();

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }
});
