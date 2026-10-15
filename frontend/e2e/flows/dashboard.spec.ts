import type { Page } from '@playwright/test';

import { memberDevice } from '../support/analysis';
import { expectScreenLayout } from '../support/layout';
import { expect, test } from '../support/test';
import { toast } from '../support/ui';
import { markSpa, navTo, placeBet, rub, settleWon, START, wonProfit } from './dashboard-steps';

// Главная (этап 4): ставка по анализу (поддельный Claude) видна в «Открытых ставках» и «Моих
// матчах сегодня»; «Внести результат» ведет на «Ставки» с окном результата; после расчета и
// после исправления результата главная и «Аналитика» показывают новые числа при переходе пунктом
// меню, без перезагрузки (кэш сброшен расчетом). На телефоне (375 px, с меткой @360 — и 360 px) —
// та же главная без прокрутки вбок, в светлой и темной темах, и «Аналитика».

/**
 * Фамилии-ссылки на телефоне: зона нажатия не меньше 40×40 и ровно на 10 px шире текста с каждой
 * стороны — текст не сдвинут, перед тире нет пустого места (как давал min-width у короткой фамилии).
 * Короткой фамилии («Ли») ширину до 40 px добирает невидимый ::before — он тоже зона нажатия.
 */
async function expectPlayerLinks(page: Page): Promise<void> {
  const boxes = await page.locator('#view .dashboard-player').evaluateAll((links) => {
    const measure = (link: Element) => {
      const box = link.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(link);
      const text = range.getBoundingClientRect();
      const pseudo = getComputedStyle(link, '::before');
      const zone = pseudo.position === 'absolute' ? [parseFloat(pseudo.width) || 0, parseFloat(pseudo.height) || 0] : [0, 0];
      return {
        name: link.textContent ?? '',
        left: text.left - box.left,
        right: box.right - text.right,
        width: Math.max(box.width, zone[0] ?? 0),
        height: Math.max(box.height, zone[1] ?? 0),
      };
    };
    const shown = links.filter((link) => link.getBoundingClientRect().width > 0);
    const all = shown.map(measure);
    // короткая настоящая фамилия: та же ссылка с текстом «Ли»
    const first = shown[0];
    if (first) {
      const saved = first.textContent;
      first.textContent = 'Ли';
      all.push(measure(first));
      first.textContent = saved;
    }
    return all;
  });
  expect(boxes.length).toBeGreaterThan(1);
  for (const box of boxes) {
    expect(box.width, box.name).toBeGreaterThanOrEqual(40);
    expect(box.height, box.name).toBeGreaterThanOrEqual(40);
    expect(Math.abs(box.left - 10), box.name).toBeLessThan(1);
    expect(Math.abs(box.right - 10), box.name).toBeLessThan(1);
  }
}

test('главная: открытая ставка → «Внести результат» → банк и показатели; исправление результата — без перезагрузки', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile, 'на телефоне — отдельный сценарий ниже');
  const m = await memberDevice(device, apiClient, 'Глеб Главный');
  const page = m.page;
  const { id, stake } = await placeBet(page);

  await page.goto('/');
  await markSpa(page);
  await expect(page.getByRole('heading', { level: 2, name: /, Глеб$/ })).toBeVisible();
  await expect(page.getByText(/· 1 ставка в игре/)).toBeVisible();
  const hero = page.getByRole('region', { name: 'Банк' });
  await expect(hero.locator('.stat-value')).toHaveText(rub(START));
  await expect(page.locator('.topbar .bank-pill')).toContainText(rub(START));

  const open = page.getByRole('article', { name: `Ставка №${id}` });
  await expect(open).toContainText('Экспресс из 2 событий');
  await expect(open).toContainText(/модель \d+% · по кэфу 77%/);
  const matches = page.locator('.dashboard-matches-card');
  await expect(matches.getByText(`В ставке №${id} · П1 1.30`)).toBeVisible();
  await expect(matches.getByText(`В ставке №${id} · П1 1.45`)).toBeVisible();
  // ставок еще не рассчитано — не «всего 0 ставок», а «рассчитанных ставок нет»
  await expect(page.getByRole('status').filter({ hasText: 'За 30 дней рассчитанных ставок нет.' })).toBeVisible();
  await expect(page.getByText(/всего 0 ставок/)).toHaveCount(0);

  // «Аналитика» до расчета — в кэше запросов: после расчета она обязана перечитаться
  await navTo(page, false, 'Аналитика');
  await expect(page.getByText('Рассчитанных ставок пока нет')).toBeVisible();
  await navTo(page, false, 'Главная');

  await open.getByRole('link', { name: `Внести результат ставки №${id}` }).click();
  await expect(page).toHaveURL(/\/bets$/);
  await settleWon(page, id);

  const profit = wonProfit(stake);
  await navTo(page, false, 'Главная');
  await expect(hero.locator('.stat-value')).toHaveText(rub(START + profit));
  await expect(hero).toContainText(rub(profit, { signed: true }));
  // банк появился в этом периоде: старт — стартовый банк (пополнение), а не «0 ₽» дня перед периодом
  await expect(hero.locator('.dashboard-hero-kv > div').filter({ hasText: 'Старт периода' })).toContainText(rub(START));
  // В7: пунктир «вложено» от старта периода; пополнение — стартовое, внутри периода движений нет
  await expect(page.locator('.dashboard-card').filter({ hasText: 'Динамика банка' })).toContainText(new RegExp(`Вложено: старт ${rub(START).source}`));
  await expect(page.locator('.topbar .bank-pill')).toContainText(rub(START + profit));
  await expect(page.getByText('Открытых ставок нет. Запустите анализ матчей дня — ИИ предложит экспресс.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'всего 1 ставка' })).toBeVisible();
  const strip = page.locator('.dashboard-strip');
  await expect(strip).toContainText(rub(profit, { signed: true }));
  await expect(strip.locator('div').filter({ hasText: 'Прибыль ставок' })).toContainText(rub(profit, { signed: true }));
  await expect(page.getByText('1 В · 0 П')).toBeVisible();
  await page.getByRole('button', { name: 'Показать таблицей' }).click();
  const table = page.getByRole('table', { name: 'Последние рассчитанные ставки' });
  await expect(table).toContainText('Выигрыш');
  await expect(table).toContainText(rub(profit, { signed: true }));
  await expect(table).toContainText(rub(START + profit));
  await expectScreenLayout(page);

  await navTo(page, false, 'Аналитика');
  await expect(page.getByRole('region', { name: 'Фильтры: применяются ко всем блокам ниже' })).toContainText('В выборке 1 ставка и 2 события');
  await expect(page.getByRole('region', { name: 'Ключевые показатели за все время' })).toContainText(rub(profit, { signed: true }));

  // Исправление результата (сторно и новый расчет: Джокович проиграл) со строки последних ставок
  await navTo(page, false, 'Главная');
  // экран главной грузится по требованию: пока он не открылся, видна прежняя «Аналитика» со
  // своими «Показать таблицей» — кнопку берем из карточки «Динамика банка»
  const dynamics = page.getByRole('heading', { level: 3, name: 'Динамика банка' }).locator('xpath=ancestor::section[1]');
  await dynamics.getByRole('button', { name: 'Показать таблицей' }).click();
  await table.getByRole('row').filter({ hasText: 'Выигрыш' }).click();
  await expect(page).toHaveURL(/\/bets$/);
  await page.getByRole('button', { name: 'Исправить результат' }).click();
  await page.getByRole('dialog', { name: `Исправить результат №${id}` }).getByRole('button', { name: 'Отменить расчет и исправить' }).click();
  const again = page.getByRole('dialog', { name: `Исправить результат №${id}` });
  await expect(again.getByText('Прошлый расчет уже отменен сторно.')).toBeVisible();
  await again.getByRole('group', { name: /Джокович — Рублев$/ }).getByRole('button', { name: 'Проиграл' }).click();
  await again.getByRole('button', { name: 'Сохранить исправление' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} пересчитана`))).toBeVisible();

  await navTo(page, false, 'Главная');
  await expect(hero.locator('.stat-value')).toHaveText(rub(START - stake));
  await expect(strip).toContainText(rub(-stake));
  await expect(page.getByText('0 В · 1 П')).toBeVisible();
  await navTo(page, false, 'Аналитика');
  await expect(page.getByRole('region', { name: 'Ключевые показатели за все время' })).toContainText(rub(-stake));
});

test('телефон: главная и «Аналитика» без прокрутки вбок, обе темы; после расчета — переход вкладкой', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  test.skip(!isMobile, 'сценарий для телефона');
  const m = await memberDevice(device, apiClient, 'Тома Телефонная');
  const page = m.page;
  const { id, stake } = await placeBet(page);

  await page.goto('/');
  await markSpa(page);
  const open = page.getByRole('article', { name: `Ставка №${id}` });
  await expect(open).toBeVisible();
  await expectScreenLayout(page);
  await expectPlayerLinks(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'light' });

  await open.getByRole('link', { name: `Внести результат ставки №${id}` }).click();
  await settleWon(page, id);
  await navTo(page, true, 'Главная');
  await expect(page.getByRole('region', { name: 'Банк' }).locator('.stat-value')).toHaveText(rub(START + wonProfit(stake)));
  await expect(page.getByText('Показатели за 30 дней')).toBeVisible();
  await page.getByRole('button', { name: 'Показать таблицей' }).click();
  await expect(page.getByRole('list', { name: 'Последние рассчитанные ставки' }).getByRole('link')).toHaveCount(1);
  await expectScreenLayout(page);

  await navTo(page, true, 'Аналитика');
  await expect(page.getByRole('region', { name: 'Фильтры: применяются ко всем блокам ниже' })).toContainText('В выборке 1 ставка и 2 события');
  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);
});
