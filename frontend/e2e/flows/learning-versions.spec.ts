import type { Locator, Page } from '@playwright/test';

import { withFakeClaude } from '../support/fakeClaude';
import { learningSeed } from '../support/learning';
import { expectScreenLayout } from '../support/layout';
import { expect, signedInAdmin, test, uniqueName, type Account } from '../support/test';

// «Версии стратегии» (этап 5, волна 4) на настоящем API: администратор замораживает набор →
// прогоняет действующую v3 и кандидата на поддельном Claude (план, код 2FA, ход пакетами) →
// сравнение с выводом кода → «Включить» кандидата → «Вернуть» прежнюю. На стеке сыгранных
// матчей после 1 августа мало, поэтому архив для набора дает learning_seed.py eval-world, а
// сбор пакетов по расписанию воркера — eval-collect. Инструкции анализа и набор общие для
// всего стека: сценарий идет отдельно, когда остальные закончились (проект exclusive или
// вручную: E2E_EXCLUSIVE=1 CI=1 npx playwright test learning-versions --workers=1), и в конце
// eval-cleanup и cleanup убирают его след — повторяется на одном стеке сколько угодно раз.

const EXCLUSIVE = process.env.E2E_EXCLUSIVE === '1';
const THEMES = ['light', 'dark'] as const;

async function layoutPhones(page: Page, root?: () => Locator): Promise<void> {
  for (const width of [375, 360]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of THEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectScreenLayout(page, { exclude: '.skip-link', ...(root ? { root: root() } : {}) });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1366, height: 900 });
}

/** Прогон версии из окна «Оценить на наборе»: выбрать версию, код 2FA, запустить, собрать. */
async function runEval(page: Page, admin: Account, option: RegExp, layout = false): Promise<void> {
  const panel = page.getByRole('tabpanel', { name: 'Версии стратегии' });
  await panel.getByRole('button', { name: 'Оценить на наборе' }).click();
  const dialog = page.getByRole('dialog', { name: 'Оценить версию на наборе' });
  await dialog.getByRole('button', { name: /^Что прогнать:/ }).click();
  await page.getByRole('option', { name: option }).click();
  await expect(dialog.getByText('Бюджет проверок', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/пакет.* по ≤ 100 через Batch/)).toBeVisible();
  const run = dialog.getByRole('button', { name: 'Запустить прогон' });
  await expect(run).toBeEnabled();
  if (layout) await layoutPhones(page, () => page.getByRole('dialog'));
  await dialog.getByRole('textbox', { name: 'Код 2FA' }).fill(await admin.totp!.next());
  await run.click();
  const progress = page.getByRole('dialog', { name: /^Прогон v\d+ на наборе / });
  await expect(progress.getByText(/^Пакетов собрано: \d+ из \d+/)).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Остановить' })).toBeVisible();
  await progress.getByRole('button', { name: 'Закрыть, ждать итога' }).click();
  // пакеты собирает задача воркера по расписанию; на стеке — тем же кодом
  await learningSeed(['eval-collect']);
}

test('набор → прогоны v3 и кандидата на поддельном Claude → сравнение → «Включить» → «Вернуть»', async ({ device }) => {
  test.skip(!EXCLUSIVE && test.info().project.name !== 'exclusive', 'меняет инструкции анализа у всех: идет отдельно от остальных');
  test.setTimeout(420_000);
  await learningSeed(['eval-world']);
  const admin = await device();
  const account = await signedInAdmin(admin, uniqueName('Админ Версий'));
  const page = admin.page;
  let lesson = '';
  try {
    await page.goto('/learning/versions');
    const panel = page.getByRole('tabpanel', { name: 'Версии стратегии' });
    await expect(panel.getByText('Набор для проверки версий еще не заморожен.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Оценить на наборе' })).toBeDisabled();
    await layoutPhones(page);

    // 1. Заморозить набор: список матчей и sha256 больше не меняются
    await panel.getByRole('button', { name: 'Заморозить набор' }).click();
    await expect(page.getByText(/^Набор \S+ заморожен: \d+ матч/)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/версии проверяются на замороженном наборе/i)).toBeVisible();

    // 2. Кандидат инструкций: v3 + урок, подтвержденный на истории (на стеке — learning_seed)
    const odds = (2 + Math.floor(Math.random() * 4800) / 100).toFixed(2);
    const created = await admin.api.ok<{ code: string }>('/api/lessons', {
      text: `Аутсайдер на харде с кэфом от ${odds} берет матч чаще, чем дает модель`,
      kind: 'numeric',
      scope: { direction: 'raise', conditions: [{ feature: 'odds', op: 'ge', value: Number(odds) }] },
    });
    lesson = created.code;
    await learningSeed(['ready', lesson, 'now']);
    const candidate = await admin.api.ok<{ code: string }>('/api/admin/strategy/versions', { lessons: [lesson], goal: 'quality' });

    await withFakeClaude(async () => {
      // 3. Прогон действующей v3 и кандидата: план, 2FA, ход пакетами
      await page.reload();
      await runEval(page, account, /^v3 · активная/, true);
      await page.reload();
      await runEval(page, account, new RegExp(`^${candidate.code} · кандидат`));
    });

    // 4. Сравнение кандидата с v3 — вывод кода; «Включить»
    await page.reload();
    const table = panel.getByRole('table', { name: 'Инструкции анализа' });
    await expect(table.getByRole('row', { name: new RegExp(`^${candidate.code}`) })).toContainText(/\d,\d{3} · 1 прогон/);
    await panel.getByRole('button', { name: `Сравнить v3 и ${candidate.code}` }).click();
    const compare = page.getByRole('dialog', { name: `Сравнение v3 и ${candidate.code}` });
    await expect(compare.getByText('Вывод кода:')).toBeVisible();
    await expect(compare.getByText('Лог-лосс', { exact: true })).toBeVisible();
    await layoutPhones(page, () => page.getByRole('dialog'));
    await compare.getByRole('button', { name: `Включить ${candidate.code}` }).click();
    await expect(page.getByText(new RegExp(`^${candidate.code} работает со следующего анализа у всех участников`))).toBeVisible();
    await expect(table.getByRole('row', { name: new RegExp(`^${candidate.code}`) })).toContainText('Активная');

    // 5. «Вернуть» прежнюю v3: она снова активна, кандидат — снова кандидат
    await table.getByRole('row', { name: /^v3/ }).click();
    const version = page.getByRole('dialog', { name: /^Версия v3/ });
    await version.getByRole('button', { name: 'Вернуть v3' }).click();
    await expect(page.getByText(`Снова активна v3 · ${candidate.code} вернулась в кандидаты`)).toBeVisible();
    await expect(table.getByRole('row', { name: /^v3/ })).toContainText('Активная');
    await layoutPhones(page);
  } finally {
    // Сначала прогоны (с их расходом бюджета проверок), набор и архив, потом урок и версии с ним
    await learningSeed(['eval-cleanup']);
    if (lesson) await learningSeed(['cleanup', lesson]);
  }
});
