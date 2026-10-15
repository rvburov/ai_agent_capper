import type { Page } from '@playwright/test';

import { memberDevice } from '../support/analysis';
import { expectScreenLayout } from '../support/layout';
import { expect, signedInAdmin, test, uniqueName } from '../support/test';
import { placeBet, settleWon } from './dashboard-steps';

// Основа экранов этапа 5 (волна 1): «Обучение модели» — каркас по макету (learning.js, Р25) с
// пустыми состояниями на 375 и 360 px (метка @360) в обеих темах, без прокрутки вбок и с зонами
// нажатия от 40 px; счетчик открытых ставок у «Ставок» в боковом и нижнем меню.

const THEMES = ['light', 'dark'] as const;
// «Перейти к содержимому» спрятана за верхним краем, пока на ней нет фокуса
const PAGE_LAYOUT = { exclude: '.skip-link' } as const;

async function layoutBothThemes(page: Page): Promise<void> {
  for (const scheme of THEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page, { ...PAGE_LAYOUT, root: page.locator('body') });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('«Обучение модели»: плитки, цикл и вкладки с пустыми состояниями', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Ульяна Урокова');
  const page = m.page;
  await page.goto('/learning');
  await expect(page.getByRole('heading', { level: 1, name: 'Обучение модели' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Как модель учится на ставках' })).toBeVisible();
  // ставок нет — шапка так и говорит; версия инструкций — с сервера
  await expect(page.getByText(/^Рассчитанных ставок пока нет/)).toBeVisible();
  const tiles = page.getByRole('group', { name: 'Что учится сейчас' }).getByRole('link');
  await expect(tiles).toHaveCount(4);
  await expect(tiles.nth(1)).toContainText(/v\d+активна/);
  await expect(page.getByRole('list', { name: 'Цикл обучения, 6 шагов' }).getByRole('listitem')).toHaveCount(6);
  await expect(page.getByText(/^Уроков пока нет/)).toBeVisible();
  await layoutBothThemes(page);

  // вкладки — адреса: «Версии стратегии», «Базовая модель», «Отчеты»
  const tabs = page.getByRole('tablist', { name: 'Разделы обучения' });
  const names = isMobile ? ['Версии', 'Модель', 'Отчеты'] : ['Версии стратегии', 'Базовая модель', 'Отчеты'];
  const urls = [/\/learning\/versions$/, /\/learning\/model$/, /\/learning\/reports$/];
  const texts = [/^Набор для проверки версий еще не заморожен/, /^Версии модели, проверка по месяцам/, /^Отчетов пока нет\. Первый придет в понедельник/];
  for (const [i, name] of names.entries()) {
    await tabs.getByRole('tab', { name, exact: true }).click();
    await expect(page).toHaveURL(urls[i]!);
    await expect(tabs.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel').getByText(texts[i]!)).toBeVisible();
    await layoutBothThemes(page);
  }

  // плитка «Уроки в анализе» возвращает на «Уроки»
  await tiles.first().click();
  await expect(page).toHaveURL(/\/learning$/);
  await expect(tiles.first()).toHaveAttribute('aria-current', 'true');
});

test('администратор: «Оценить на наборе» видна, но недоступна, пока набор не заморожен', async ({ device, isMobile }) => {
  test.skip(isMobile, 'не зависит от ширины');
  const admin = await device();
  await signedInAdmin(admin, uniqueName('Админ Обучения'));
  await admin.page.goto('/learning/versions');
  const panel = admin.page.getByRole('tabpanel', { name: 'Версии стратегии' });
  await expect(panel.getByRole('button', { name: 'Оценить на наборе' })).toBeDisabled();
  await expect(panel.getByText(/Загрузите свежий файл и заморозьте набор/)).toBeVisible();
});

test('счетчик открытых ставок у «Ставок»: после сохранения — 1, после расчета — нет', { tag: '@360' }, async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Семен Счетчиков');
  const page = m.page;
  const nav = isMobile ? page.getByRole('navigation', { name: 'Нижняя навигация' }) : page.getByRole('complementary', { name: 'Основная навигация' });
  const bets = nav.getByRole('link', { name: /^Ставки/ });
  const badge = bets.locator(isMobile ? '.tab-badge' : '.nav-badge');
  await page.goto('/');
  await expect(bets).toBeVisible();
  await expect(badge).toHaveCount(0);

  const { id } = await placeBet(page);
  await expect(badge).toHaveText('1');
  await expect(bets).toHaveAccessibleName(/Открытых ставок: 1$/);
  await layoutBothThemes(page);

  await page.goto(`/bets?bet=${id}`);
  await settleWon(page, id);
  await expect(badge).toHaveCount(0);
});
