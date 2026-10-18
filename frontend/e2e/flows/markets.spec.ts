import type { Page } from '@playwright/test';

import { eventsText, expectReadyToLaunch, memberDevice, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expect, test, type Device } from '../support/test';
import { expectNoHorizontalScroll, toast } from '../support/ui';

// Р28: новые рынки. Ввод с «Другими рынками» и спорной форой → анализ с группами рынков и
// статусом «для сравнения» → своя ставка на тотал сетов → расчет по счету по сетам. Тотал геймов
// (волна 3): вероятность модели, возврат на целой линии и валуй → своя ставка → ручной расчет по
// счету по геймам: «ровно» — возврат. Если модель геймов не прошла проверку на истории (сервер:
// model_state = failed), вместо вероятности — «модель не прошла проверку».

const START = 48_000;

const SINNER_RUNE_MARKETS = [
  'Синнер vs Руне, Test Open 9, хард, 1/8',
  'Кэфы: П1 = 1.30, П2 = 3.60',
  'Тотал сетов: Б(2.5) = 2.30, М(2.5) = 1.60',
  'Тотал геймов: Б(22) = 1.75, М(22) = 2.05',
];
const DJOKOVIC_RUBLEV_DISPUTED = ['Джокович vs Рублев, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.45, П2 = 2.80', 'Ф1(-1.5) = 2.05, Ф2(+1.5) = 1.72'];

/** Состояние модели тотала геймов с сервера: ok — вероятность есть, failed — не прошла проверку. */
async function gamesTotalModel(device: Device): Promise<string> {
  const markets = (await (await device.api.get('/api/markets')).json()) as { families: { family: string; model_state: string }[] };
  return markets.families.find((f) => f.family === 'gtot')?.model_state ?? 'none';
}

async function bankBalance(device: Device): Promise<number> {
  const bank = (await (await device.api.get('/api/me/bank')).json()) as { balance: string };
  return Number(bank.balance);
}

async function launch(page: Page): Promise<void> {
  await expectReadyToLaunch(page);
  await withFakeClaude(async () => {
    await page.getByRole('button', { name: /^Запустить/ }).last().click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 3, name: 'Варианты ставки' })).toBeVisible({ timeout: 30_000 });
  });
}

/** Своя ставка на один исход таблицы рынков: «В свою ставку» → сумма → «Сохранить ставку» → номер. */
async function ownBet(page: Page, outcome: string, amount: string, legHint?: RegExp): Promise<number> {
  await page.getByRole('button', { name: `В свою ставку: ${outcome}, Синнер — Руне` }).click();
  const dialog = page.getByRole('dialog', { name: 'Своя ставка' });
  await expect(dialog.getByText('рынок для сравнения')).toBeVisible();
  if (legHint) await expect(dialog.getByText(legHint)).toBeVisible();
  await dialog.getByRole('textbox', { name: /Сумма ставки/ }).fill(amount);
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  const saved = toast(page, /Ставка №\d+ сохранена · своя/);
  await expect(saved).toBeVisible();
  const id = Number(/№(\d+)/.exec((await saved.textContent()) ?? '')?.[1]);
  await expect(page).toHaveURL(/\/bets/);
  return id;
}

test('другие рынки и спорная фора → анализ с рынками «для сравнения» → своя ставка на тотал сетов → расчет', async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Тото Тоталова');
  const page = m.page;
  await parseEvents(page, eventsText(SINNER_RUNE_MARKETS, DJOKOVIC_RUBLEV_DISPUTED), 2);

  // «Другие рынки» в карточке события; спорная фора — вопрос, без ответа запуск закрыт
  await expect(page.getByRole('group', { name: 'Тотал сетов 2.5', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Тотал геймов 22', exact: true }).getByText(/целая линия: ровно 22 — возврат/)).toBeVisible();
  const question = page.getByText(/фора по сетам или по геймам\?/);
  await expect(question).toBeVisible();
  const side = page.getByRole('complementary', { name: 'Перед запуском' });
  await expect(side.getByText(/уточните «Ф1\(−1.5\)»: фора по сетам или по геймам/)).toBeVisible();
  await expect(side.getByRole('button', { name: 'Запустить анализ' })).toBeDisabled();
  if (isMobile) await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'По сетам' }).click();
  await expect(question).toBeHidden();
  await launch(page);

  // Таблица рынков: группы с линией и статусом с сервера
  await expect(page.getByText('Тотал сетов 2.5', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^для сравнения · \d+ из 150$/).first()).toBeVisible();
  await expect(page.getByText('Тотал геймов меньше 22').first()).toBeVisible();
  await expect(page.getByText('оценка модели — скоро')).toHaveCount(0);
  if (isMobile) await expectNoHorizontalScroll(page);

  const id = await ownBet(page, 'Тотал сетов меньше 2.5', '500');
  expect(await bankBalance(m)).toBe(START - 500);
  const card = page.getByRole('article', { name: `Открытая ставка №${id}` });
  await expect(card).toContainText('Тотал сетов меньше 2.5');
  await card.getByRole('button', { name: 'Внести результат' }).click();
  const settle = page.getByRole('dialog', { name: `Результат ставки №${id}` });
  // меньше 2.5 сетов — два сета: 2:0 — выигрыш
  await settle.getByRole('textbox', { name: 'Счет по сетам' }).fill('2:0');
  await expect(settle.getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
  await settle.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} рассчитана`))).toBeVisible();
  expect(await bankBalance(m)).toBeCloseTo(START - 500 + 500 * 1.6, 2);
});

test('тотал геймов: вероятность модели и валуй с возвратом → своя ставка → «Счет по геймам» 6:4 7:5 — ровно линия, возврат', async ({ device, apiClient, isMobile }) => {
  const m = await memberDevice(device, apiClient, 'Гена Геймов');
  const page = m.page;
  const model = await gamesTotalModel(m);
  await parseEvents(page, eventsText(SINNER_RUNE_MARKETS), 1);
  await launch(page);

  // Строка «Тотал геймов меньше 22»: на телефоне — карточка группы, на компьютере — строка таблицы
  const group = isMobile ? page.getByRole('region', { name: 'Тотал геймов 22' }) : page.getByRole('row').filter({ hasText: 'Тотал геймов меньше 22' });
  const under = isMobile ? group.getByRole('listitem').filter({ hasText: 'Тотал геймов меньше 22' }) : group;
  let legHint: RegExp;
  if (model === 'failed') {
    await expect(under.getByText('модель не прошла проверку')).toBeVisible();
    legHint = /модель этого рынка не прошла проверку/;
  } else {
    expect(model).toBe('ok');
    // целая линия: вероятность возврата; валуй = p·кэф + P(возврат) − 1 — числом со знаком
    await expect(under.getByText(/^возврат \d+\s?%$/)).toBeVisible();
    await expect(under.getByText('оценка модели — скоро')).toHaveCount(0);
    await expect(under.getByText(/^[+−-]\d+,\d\s?%$/).first()).toBeVisible();
    legHint = /модель \d+\s?% · валуй [+−-]\d+,\d\s?%/;
  }
  // шаг модели называет цепь по геймам
  await page.getByRole('button', { name: 'Показать шаги' }).click();
  const steps = page.getByRole('list', { name: 'Шаги анализа' });
  await expect(steps.getByText(model === 'failed' ? /^Базовая модель посчитана: матчей 1$/ : /геймы — цепь очко → гейм → сет → матч/)).toBeVisible();
  if (isMobile) await expectNoHorizontalScroll(page);

  const id = await ownBet(page, 'Тотал геймов меньше 22', '400', legHint);
  const card = page.getByRole('article', { name: `Открытая ставка №${id}` });
  await card.getByRole('button', { name: 'Внести результат' }).click();
  const settle = page.getByRole('dialog', { name: `Результат ставки №${id}` });
  await expect(settle.getByText(/Для тоталов и фор по геймам подсказываем «возврат»/)).toBeVisible();
  const score = settle.getByRole('textbox', { name: 'Счет по геймам' });
  await score.fill('6:4 7:5');
  await expect(settle.getByText('22 гейма — ровно линия 22: возврат, кэф 1,00')).toBeVisible();
  await expect(settle.getByRole('button', { name: 'Возврат' })).toHaveAttribute('aria-pressed', 'true');
  if (isMobile) await expectNoHorizontalScroll(page);
  await settle.getByRole('button', { name: 'Сохранить результат' }).click();
  await expect(toast(page, new RegExp(`Ставка №${id} рассчитана: возврат`))).toBeVisible();
  expect(await bankBalance(m)).toBe(START);
  const bet = (await (await m.api.get(`/api/bets/${id}`)).json()) as { status: string; legs: { score: string | null }[] };
  expect(bet.status).toBe('void');
  expect(bet.legs[0]?.score).toBe('6:4 7:5');
});
