import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, expectReadyToLaunch, memberDevice, parseEvents } from '../support/analysis';
import { failNext, resetFake, withFakeClaude } from '../support/fakeClaude';
import { expect, test } from '../support/test';
import { expectNoHorizontalScroll, toast } from '../support/ui';

// Сбой шага анализа: Claude перегружен (529 трижды — запрос и два повтора SDK) → анализ
// остановлен на шаге оценки, причина и «Перезапустить с этого шага» → тот же анализ до итога.

test.skip(({ isMobile }) => isMobile, 'сценарий для компьютера');

test('сбой шага Claude → «Перезапустить с этого шага» → итог', async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Федор Сбоев');
  const page = m.page;
  await parseEvents(page, eventsText(SINNER_RUNE, DJOKOVIC_RUBLEV), 2);
  await expectReadyToLaunch(page);

  await withFakeClaude(async () => {
    await failNext('analysis', 'overloaded', 3);
    await page.getByRole('complementary', { name: 'Перед запуском' }).getByRole('button', { name: 'Запустить анализ' }).click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    const banner = page.getByRole('alert').filter({ hasText: 'Анализ остановлен на шаге' });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText(/Анализ остановлен на шаге 7 из 9 «Claude: (Синнер — Руне|Джокович — Рублев)»/);
    await expect(banner).toContainText('Claude сейчас перегружен');
    await expect(banner).toContainText('Уже выполненные шаги повторно не оплачиваются');
    await expect(page.getByRole('heading', { level: 2, name: 'Анализ 2 матчей остановлен' })).toBeVisible();
    const steps = page.getByRole('list', { name: 'Шаги анализа' });
    await expect(steps.getByText(/^Не выполнен: Claude сейчас перегружен/)).toBeVisible();
    await expectNoHorizontalScroll(page);

    await resetFake();
    await banner.getByRole('button', { name: 'Перезапустить с этого шага' }).click();
    await expect(toast(page, /перезапущен с шага 7: выполненные шаги не повторяются/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из 2 событий/ })).toBeVisible({ timeout: 30_000 });
  });
  await expect(page.getByText('Анализ готов')).toBeVisible();
  // Вторая попытка того же анализа: номер попытки в шагах не теряется, результат — тот же экран
  const id = Number(new URL(page.url()).pathname.split('/').pop());
  const analysis = (await (await m.api.get(`/api/analyses/${id}`)).json()) as { attempt: number; status: string };
  expect(analysis).toMatchObject({ attempt: 2, status: 'done' });
});
