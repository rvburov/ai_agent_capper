import { ALCARAZ_MEDVEDEV, DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, expectReadyToLaunch, memberDevice, parseEvents } from '../support/analysis';
import { failNext, resetFake, withFakeClaude } from '../support/fakeClaude';
import { expect, test } from '../support/test';
import { toast } from '../support/ui';

// Отмена: анализ из трех матчей (Claude отвечает с повторами — ход идет несколько секунд),
// «Отменить анализ» с подтверждением → анализ отменен, «Продолжить с шага N» → итог.

test.skip(({ isMobile }) => isMobile, 'сценарий для компьютера');

test('отмена анализа и продолжение с того же шага', async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Отто Отменов');
  const page = m.page;
  await parseEvents(page, eventsText(SINNER_RUNE, DJOKOVIC_RUBLEV, ALCARAZ_MEDVEDEV), 3);
  await expectReadyToLaunch(page);

  await withFakeClaude(async () => {
    // Каждый вызов оценки отвечает с третьей попытки: на отмену есть несколько секунд
    await failNext('analysis', 'overloaded', 6);
    await page.getByRole('complementary', { name: 'Перед запуском' }).getByRole('button', { name: 'Запустить анализ' }).click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Анализирую 3 матча' })).toBeVisible();
    await page.getByRole('button', { name: 'Отменить анализ' }).click();
    const dialog = page.getByRole('dialog', { name: 'Отменить анализ?' });
    await expect(dialog.getByText(/Шаг, который идет сейчас, доработает/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Отменить анализ' }).click();
    await expect(toast(page, /Анализ #A-\d+ отменен/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Анализ 3 матчей отменен' })).toBeVisible();
    const banner = page.getByRole('alert').filter({ hasText: 'Анализ отменен на шаге' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('События сохранены в «Новом анализе»');
    // Шаг, который шел при отмене, не крутится «в работе» и после перезагрузки
    const steps = page.getByRole('list', { name: 'Шаги анализа' });
    await expect(steps.getByRole('listitem')).toHaveCount(11);
    await expect(steps.locator('.is-active')).toHaveCount(0);
    await page.reload();
    await expect(banner).toBeVisible();
    await expect(steps.locator('.is-active')).toHaveCount(0);

    await resetFake();
    // Шаг, который шел при отмене, дорабатывает (без повторной оплаты): «Продолжить» — после него
    const resume = banner.getByRole('button', { name: /^Продолжить с шага \d+$/ });
    await expect(resume).toBeEnabled({ timeout: 30_000 });
    await resume.click();
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из \d событий|^Анализ 3 матчей готов$/ })).toBeVisible({ timeout: 30_000 });
  });

  // «Изменить события» ведет в «Новый анализ» с теми же событиями
  await page.getByRole('link', { name: 'Изменить события' }).click();
  await expect(page).toHaveURL(/\/new\?draft=\d+$/);
  await expect(page.getByRole('heading', { name: 'Алькарас — Медведев' })).toBeVisible();
});
