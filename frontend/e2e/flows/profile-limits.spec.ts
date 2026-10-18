import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, memberDevice, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expectScreenLayout } from '../support/layout';
import { expect, test } from '../support/test';
import { toast } from '../support/ui';
import { placeBet } from './dashboard-steps';

// Кабинет → «Банк и стратегия» (этап 4, В8, В9) на настоящем API: пауза и лимит ставок в день
// закрывают ставки и анализы на сервере — экраны ставки и «Нового анализа» говорят, до какого
// времени; «Мои букмекеры» — добавить, переименовать, скрыть и вернуть, удалить.

/** «Разобрать» на «Новом анализе»: сервер отказал до вызова Claude — текст ошибки на экране. */
async function parseRefused(page: import('@playwright/test').Page, text: RegExp) {
  await page.goto('/new');
  await page.getByRole('textbox', { name: 'Текст событий' }).fill(eventsText(SINNER_RUNE));
  await page.getByRole('button', { name: 'Разобрать', exact: true }).click();
  await expect(page.getByText(text).first()).toBeVisible();
}

test('пауза: ставка по готовому анализу и новый анализ закрыты, текст «до какого времени»', async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Пауза Паузина');
  const page = m.page;
  // готовый анализ, ставка еще не сохранена
  await parseEvents(page, eventsText(SINNER_RUNE, DJOKOVIC_RUBLEV), 2);
  await withFakeClaude(async () => {
    await page.getByRole('button', { name: /^Запустить/ }).last().click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из 2 событий/ })).toBeVisible({ timeout: 30_000 });
  });
  const analysisUrl = page.url();

  await page.goto('/profile/bank');
  const rg = page.locator('#profile-rg');
  await expect(rg.getByText('Лимитов нет')).toBeVisible();
  await rg.getByRole('group', { name: 'Длительность паузы' }).getByRole('button', { name: '1 день' }).click();
  await rg.getByRole('button', { name: 'Взять паузу на 1 день' }).click();
  await expect(rg.getByRole('alert')).toContainText('Отменить ее досрочно будет нельзя — ни вам, ни администратору.');
  await rg.getByRole('button', { name: 'Да, взять паузу' }).click();
  await expect(toast(page, /^Пауза до \d+ \S+\. Новые анализы и ставки недоступны$/)).toBeVisible();
  const pausedText = rg.getByText(/^Пауза до \d+ \S+ \d{4} включительно\.$/);
  await expect(pausedText).toBeVisible();
  // последний день паузы — один и тот же в кабинете, в окне ставки и на «Новом анализе»
  const lastDay = /^Пауза до (\d+ \S+) /.exec((await pausedText.textContent()) ?? '')?.[1] ?? '';
  expect(lastDay).not.toBe('');
  await expect(rg.getByRole('button', { name: /Взять паузу/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Сводка аккаунта' }).getByText(/^Пауза до \d+ \S+$/)).toBeVisible();
  // сервер: пауза действует, анализы и ставки закрыты
  const limits = (await (await m.api.get('/api/me/play-limits')).json()) as { blocked: string | null; paused_until: string | null };
  expect(limits.blocked).toBe('paused');
  expect(limits.paused_until).not.toBeNull();

  // ставка по готовому анализу — понятный текст в окне ставки
  await page.goto(analysisUrl);
  await page.getByRole('region', { name: 'Экспресс стратегии' }).getByRole('button', { name: 'Сохранить ставку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить ставку' });
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  await expect(dialog.getByText(`Вы взяли паузу до ${lastDay} включительно: новые ставки и анализы недоступны. Досрочно пауза не снимается`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // новый анализ: сервер отказывает до вызова Claude
  await parseRefused(page, new RegExp(`^Вы взяли паузу до ${lastDay} включительно`));
});

test('лимит ставок в день: после ставки анализы закрыты до полуночи; повышение — через 24 часа', async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Лимит Лимитов');
  const page = m.page;
  await page.goto('/profile/bank');
  const rg = page.locator('#profile-rg');
  await rg.getByRole('textbox', { name: 'Ставок в день, не больше' }).fill('1');
  await rg.getByRole('button', { name: 'Сохранить лимиты' }).click();
  await expect(toast(page, 'Лимит снижен и уже действует')).toBeVisible();
  await expect(rg.getByText('Лимиты включены')).toBeVisible();
  await expect(rg.getByText('0 из 1')).toBeVisible();

  // одна ставка — можно; после нее лимит дня исчерпан
  await placeBet(page);
  await page.goto('/profile/bank');
  await expect(rg.getByText('1 из 1')).toBeVisible();
  await expect(rg.getByText(/^Лимит ставок на сегодня исчерпан: новые ставки и анализы будут доступны .+, 00:00\.$/)).toBeVisible();
  // букмекер ставки появился в «Моих букмекерах»; со ставкой в игре его не скрыть
  const books = page.locator('#profile-books');
  await expect(books.getByText('Fonbet', { exact: true })).toBeVisible();
  await books.getByRole('button', { name: 'Скрыть Fonbet' }).click();
  const blocked = page.getByRole('dialog', { name: 'Пока нельзя скрыть Fonbet' });
  await expect(blocked.getByText(/^В игре 1 ставка у Fonbet на [\d\s]+₽\. Скрыть букмекера можно после расчета\.$/)).toBeVisible();
  await blocked.getByRole('button', { name: 'Понятно' }).click();

  await parseRefused(page, /^Лимит ставок в день \(1\) исчерпан\. Новые ставки и анализы будут доступны .+, 00:00$/);

  // повышение — только через 24 часа; запрос можно отменить
  await page.goto('/profile/bank');
  await rg.getByRole('textbox', { name: 'Ставок в день, не больше' }).fill('3');
  await rg.getByRole('button', { name: 'Сохранить лимиты' }).click();
  await expect(toast(page, /^Повышение лимита вступит в силу .+, через 24 часа$/)).toBeVisible();
  const pending = rg.getByText(/^Запрошено повышение: до 3 ставок в день\. Вступит в силу .+, через 24 часа после запроса\.$/);
  await expect(pending).toBeVisible();
  await expect(rg.getByText('1 из 1')).toBeVisible();
  // «Сохранить лимиты» без правки полей — ничего не меняет и повышение не отменяет
  await rg.getByRole('button', { name: 'Сохранить лимиты' }).click();
  await expect(toast(page, 'Лимиты не изменились')).toBeVisible();
  await expect(pending).toBeVisible();
  expect(((await (await m.api.get('/api/me/play-limits')).json()) as { pending: unknown }).pending).not.toBeNull();
  await rg.getByRole('button', { name: 'Отменить запрос' }).click();
  await expect(toast(page, 'Запрос на повышение лимита отменен')).toBeVisible();
  await expect(pending).toBeHidden();
});

test('мои букмекеры: добавить, переименовать, скрыть и вернуть, удалить', { tag: '@360' }, async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Букмекер Списков');
  const page = m.page;
  await page.goto('/profile/bank');
  const books = page.locator('#profile-books');
  await expect(books.getByText('Список пуст. Добавьте букмекеров, у которых ставите.')).toBeVisible();

  for (const name of ['Betfair', 'Pinnacle']) {
    await books.getByRole('button', { name: 'Добавить букмекера' }).click();
    const add = page.getByRole('dialog', { name: 'Новый букмекер' });
    await add.getByRole('textbox', { name: 'Букмекер' }).fill(name);
    await add.getByRole('button', { name: 'Добавить' }).click();
    await expect(toast(page, `${name} добавлен`)).toBeVisible();
    await expect(add).toBeHidden();
  }
  // повтор без учета регистра и «Другой» — под полем, без записи
  await books.getByRole('button', { name: 'Добавить букмекера' }).click();
  const add = page.getByRole('dialog', { name: 'Новый букмекер' });
  await add.getByRole('textbox', { name: 'Букмекер' }).fill('betfair');
  await add.getByRole('button', { name: 'Добавить' }).click();
  await expect(add.getByText('«betfair» уже есть в списке букмекеров')).toBeVisible();
  await add.getByRole('textbox', { name: 'Букмекер' }).fill('Другой');
  await add.getByRole('button', { name: 'Добавить' }).click();
  await expect(add.getByText('«Другой» уже есть в выборе при анализе — укажите название букмекера')).toBeVisible();
  await page.keyboard.press('Escape');

  await books.getByRole('button', { name: 'Переименовать Betfair' }).click();
  const rename = page.getByRole('dialog', { name: 'Переименовать Betfair' });
  await rename.getByRole('textbox', { name: 'Новое название' }).fill('Betfair Ex');
  await rename.getByRole('button', { name: 'Сохранить' }).click();
  await expect(toast(page, 'Betfair теперь называется Betfair Ex')).toBeVisible();

  await books.getByRole('button', { name: 'Скрыть Pinnacle' }).click();
  await page.getByRole('dialog', { name: 'Скрыть Pinnacle?' }).getByRole('button', { name: 'Скрыть' }).click();
  await expect(toast(page, 'Pinnacle скрыт. История ставок осталась')).toBeVisible();
  await expect(books.getByText('Скрытые')).toBeVisible();
  // формы ставки и «Нового анализа» скрытого не предлагают
  expect(await (await m.api.get('/api/me/bookmakers')).json()).toEqual(['Betfair Ex']);

  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);

  await books.getByRole('button', { name: 'Вернуть Pinnacle в список' }).click();
  await expect(toast(page, 'Pinnacle снова в списке')).toBeVisible();
  await books.getByRole('button', { name: 'Скрыть Pinnacle' }).click();
  await page.getByRole('dialog', { name: 'Скрыть Pinnacle?' }).getByRole('button', { name: 'Скрыть' }).click();
  await books.getByRole('button', { name: 'Удалить Pinnacle из списка' }).click();
  await page.getByRole('dialog', { name: 'Удалить Pinnacle из списка?' }).getByRole('button', { name: 'Удалить' }).click();
  await expect(toast(page, 'Pinnacle удален из списка')).toBeVisible();
  await expect(books.getByText('Pinnacle', { exact: true })).toHaveCount(0);
  await expect(books.getByText('Скрытые')).toHaveCount(0);
});
