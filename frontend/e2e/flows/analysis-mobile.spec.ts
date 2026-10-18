import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, memberDevice, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expect, test } from '../support/test';
import { expectNoHorizontalScroll } from '../support/ui';

// Телефон (375 px, а с меткой @360 — и 360 px в проекте mobile-360): липкая панель запуска над
// нижними вкладками, итог анализа — переключатель «Вероятности / Сравнение / Факторы» в карточке
// матча и список вместо таблицы.

test.skip(({ isMobile }) => !isMobile, 'сценарий для телефона');

test('телефон: панель запуска и вкладки карточки матча', { tag: '@360' }, async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Мила Мобайлова');
  const page = m.page;
  await parseEvents(page, eventsText(SINNER_RUNE, DJOKOVIC_RUBLEV), 2);
  await expectNoHorizontalScroll(page);

  // Основная кнопка запуска далеко внизу — видна панель над вкладками
  const bar = page.getByRole('region', { name: 'Запуск анализа' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('2 события · Точный');
  const run = bar.getByRole('button', { name: 'Запустить' });
  await expect(run).toBeEnabled();
  const box = await run.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

  await withFakeClaude(async () => {
    await run.click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из 2 событий/ })).toBeVisible({ timeout: 30_000 });
  });

  // Карточка матча: на телефоне список исходов и переключатель разделов
  const sections = page.getByRole('group', { name: 'Раздел анализа матча' }).first();
  await expect(sections).toBeVisible();
  await expect(page.getByRole('list', { name: 'Вероятности по рынкам' }).first()).toBeVisible();
  await sections.getByRole('button', { name: 'Сравнение' }).click();
  await expect(page.getByText('Место по Эло').first()).toBeVisible();
  await sections.getByRole('button', { name: 'Факторы' }).click();
  await expect(page.getByRole('heading', { level: 5, name: /^За ставку/ }).first()).toBeVisible();
  // Экспресс на телефоне — первым после хода анализа
  await expect(page.getByRole('region', { name: 'Экспресс стратегии' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
