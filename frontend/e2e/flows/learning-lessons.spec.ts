import type { Locator, Page } from '@playwright/test';

import { withFakeClaude } from '../support/fakeClaude';
import { learningSeed } from '../support/learning';
import { expectScreenLayout } from '../support/layout';
import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { signInWithBackupCode } from '../support/ui';

// «Уроки» (этап 5, волна 3): администратор предлагает урок → урок-гипотеза → проверка на
// истории (на стеке ее заменяет learning_seed.py: архива за годы нет) → «Использовать в
// анализе»: цена и худший случай до запуска, быстрая проверка пакетом Batch на поддельном
// Claude, итог «не хуже» → «Включить в инструкции» → карточка «в инструкциях» у участника.
// Раскладка «Уроков» и окна — на 375 и 360 px в обеих темах. Урок общий для всего стека и
// меняет инструкции анализа: сценарий идет один раз (desktop), в конце выключает урок, а
// learning_seed.py cleanup убирает его след (версии инструкций, прогоны быстрой проверки и их
// расход бюджета проверок, сам урок) — сценарий повторяется на одном стеке сколько угодно раз.

const THEMES = ['light', 'dark'] as const;
const PAGE_LAYOUT = { exclude: '.skip-link' } as const;

async function layoutPhones(page: Page, root?: () => Locator): Promise<void> {
  for (const width of [375, 360]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of THEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectScreenLayout(page, { ...PAGE_LAYOUT, ...(root ? { root: root() } : {}) });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1366, height: 900 });
}

/** Выбор в выпадающем списке приложения (Dropdown): кнопка «Поле: значение» и вариант. */
async function choose(page: Page, scope: Locator, field: string, option: string): Promise<void> {
  await scope.getByRole('button', { name: new RegExp(`^${field}:`) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('урок-гипотеза → быстрая проверка на поддельном Claude → «в инструкциях анализа»', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile || test.info().project.name !== 'desktop', 'урок общий для стека: сценарий — один раз, телефоны — внутри');
  test.setTimeout(180_000);
  const admin = await device();
  await signedInAdmin(admin, uniqueName('Админ Уроков'));
  const page = admin.page;
  await page.goto('/learning');
  await expect(page.getByRole('heading', { level: 2, name: 'Как модель учится на ставках' })).toBeVisible();

  // 1. «Предложить урок»: условие из словаря. Сервер ищет повтор по условию — случайный кэф в
  // самом условии дает новый урок на каждом прогоне (одинаковый текст повтором не считается)
  const odds = (2 + Math.floor(Math.random() * 4800) / 100).toFixed(2);
  await page.getByRole('button', { name: 'Предложить урок' }).first().click();
  const form = page.getByRole('dialog', { name: 'Предложить урок' });
  await form.getByLabel('Что вы заметили').fill(`Аутсайдер на грунте с кэфом от ${odds} берет матч чаще, чем дает модель`);
  await choose(page, form, 'Что не так с прогнозом', 'Модель занижает вероятность');
  await choose(page, form, 'Покрытие', 'грунт');
  await choose(page, form, 'Признак из словаря', 'Кэф стороны на победу (архив)');
  await form.getByRole('textbox', { name: 'Значение' }).fill(odds);
  await layoutPhones(page, () => page.getByRole('dialog'));
  await form.getByRole('button', { name: 'Добавить как гипотезу' }).click();
  const toast = page.getByText(/^Урок L-\d+ добавлен как гипотеза/);
  await expect(toast).toBeVisible();
  const code = /L-\d+/.exec((await toast.textContent()) ?? '')?.[0] ?? '';
  expect(code).toBeTruthy();
  try {
    const card = page.getByRole('article', { name: `Урок ${code}` });
    await expect(card.getByText('Гипотеза', { exact: true })).toBeVisible();
    await expect(card.getByText('Пока не влияет на прогнозы')).toBeVisible();
    await expect(card.getByRole('list', { name: 'Условие урока' })).toContainText(`кэф на победу не меньше ${odds}`);

    // 2. Проверка на истории — кодом по архиву; на стеке — learning_seed.py
    await learningSeed(['ready', code]);
    await page.reload();
    await expect(card.getByText('Ждет решения', { exact: true })).toBeVisible();
    await expect(card.getByText('лог-лосс 0,612 с уроком, 0,634 без · выигрыш +0,022, ДИ +0,012…+0,031')).toBeVisible();
    // модель занижает вероятность — поправка вверх: +5,0 × 309 / (309 + 200) = +3,0
    await expect(card.getByText('+3,0 п.п. с усадкой (сырая +5,0 п.п.)')).toBeVisible();

    await withFakeClaude(async () => {
      // 3. «Использовать в анализе»: цена, худший случай и бюджет проверок — до запуска
      await card.getByRole('button', { name: 'Использовать в анализе' }).click();
      const dialog = page.getByRole('dialog', { name: `Урок ${code} в анализ` });
      await expect(dialog.getByText('Бюджет проверок')).toBeVisible();
      await expect(dialog.getByText('Худший случай')).toBeVisible();
      const run = dialog.getByRole('button', { name: /^Запустить проверку · ≈ \$/ });
      await expect(run).toBeEnabled();
      await layoutPhones(page, () => page.getByRole('dialog'));
      await run.click();
      await expect(dialog.getByText(/Пакет отправлен: \d+ запрос/)).toBeVisible();

      // 4. Пакет ушел к поддельному Claude — собираем тем же кодом, что воркер по расписанию
      await learningSeed(['collect']);
      await expect(dialog.getByText('Ждет вашего решения')).toBeVisible({ timeout: 20_000 });
      await expect(dialog.getByText(/ошибок формата 0 — не хуже$/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Включить в инструкции' }).click();
    });
    await expect(page.getByText(new RegExp(`^Урок ${code} в инструкциях со следующего анализа — для всех участников`))).toBeVisible();
    await expect(card.getByText('Подтвержден', { exact: true })).toBeVisible();
    const toggle = card.getByRole('switch', { name: /Использовать в анализе/ });
    await expect(toggle).toBeChecked();
    // кнопка, открывшая окно, исчезла — фокус на выключателе карточки
    await expect(toggle).toBeFocused();

    // 5. Участник: урок «в инструкциях анализа», решений у него нет; раскладка на телефонах
    const member = await registeredMember(admin, apiClient, uniqueName('Участник Уроков'));
    const m = await device();
    await signInWithBackupCode(m.page, member);
    await m.page.goto('/learning');
    const seen = m.page.getByRole('article', { name: `Урок ${code}` });
    await expect(seen.getByText('В инструкциях анализа')).toBeVisible();
    await expect(seen.getByRole('switch')).toHaveCount(0);
    await seen.getByRole('button', { name: 'Подробнее' }).click();
    await expect(m.page.getByRole('dialog', { name: `Урок ${code}` }).getByText(/^не хуже: \d+ матч/)).toBeVisible();
    await layoutPhones(m.page, () => m.page.getByRole('dialog'));
    await m.page.keyboard.press('Escape');
    await layoutPhones(m.page);

    // 6. Выключить урок, как администратор: анализ снова без него
    await admin.api.ok(`/api/lessons/${await lessonId(admin.page, code)}/disable`);
  } finally {
    // Убрать след со стека: версии инструкций, прогоны быстрой проверки (и их расход бюджета
    // проверок), урок — следующий прогон на этом же стеке начинается с того же места
    await learningSeed(['cleanup', code]);
  }
});

async function lessonId(page: Page, code: string): Promise<number> {
  const response = await page.request.get('/api/lessons');
  const list = (await response.json()) as { items: { id: number; code: string }[] };
  const found = list.items.find((item) => item.code === code);
  if (!found) throw new Error(`нет урока ${code}`);
  return found.id;
}
