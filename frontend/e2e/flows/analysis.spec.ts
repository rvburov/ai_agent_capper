import { withFakeClaude } from '../support/fakeClaude';
import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { expectNoHorizontalScroll, heading, signInWithBackupCode, toast } from '../support/ui';

// Анализ от текста до ставки: разбор двух матчей, «Перед запуском», запуск, ход по шагам до
// итога, экспресс и «Сохранить ставку» с правкой кэфа; банк по учету уменьшился на сумму.
// Игроки и матчи — маленький мир стека (scripts/e2e-stack.sh), Claude — поддельный.

export const TWO_MATCHES = [
  'Текущий банк: 48 000 ₽',
  'Букмекер: Fonbet',
  '',
  'События:',
  'Синнер vs Руне, Test Open 9, хард, 1/8',
  'Кэфы: П1 = 1.30, П2 = 3.60',
  'Джокович vs Рублев, Test Open 9, хард, 1/8',
  'Кэфы: П1 = 1.45, П2 = 2.80',
].join('\n');

test.skip(({ isMobile }) => isMobile, 'сценарий для компьютера; телефон — analysis-mobile.spec.ts');

test('текст из двух матчей → разбор → анализ → экспресс → ставка с правкой кэфа', async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const member = await registeredMember(admin, apiClient, uniqueName('Аня Анализова'));
  const m = await device();
  await signInWithBackupCode(m.page, member);
  const page = m.page;

  await page.goto('/new');
  await expect(heading(page, 'Новый анализ')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Что разбираем сегодня?' })).toBeVisible();
  // Режим один: «Точный», два других выключены до проверки на истории
  await expect(page.getByRole('radio', { name: /Точный/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Сбалансированный/ })).toBeDisabled();
  await expect(page.getByRole('radio', { name: /Экономный/ })).toBeDisabled();

  await page.getByRole('textbox', { name: 'Текст событий' }).fill(TWO_MATCHES);
  await expect(page.getByText('Еще не разобрано')).toBeVisible();
  await page.getByRole('button', { name: 'Разобрать', exact: true }).click();
  const result = page.getByRole('region', { name: 'Что распознано' });
  await expect(result.getByRole('heading', { name: 'Что распознано' })).toBeVisible();
  await expect(result.getByText('2 события').first()).toBeVisible();
  await expect(page).toHaveURL(/\/new\?draft=\d+$/);
  // Игроки сверены с базой: кириллица из текста нашла игроков архива
  await expect(result.getByRole('heading', { name: 'Синнер — Руне' })).toBeVisible();
  await expect(result.getByRole('heading', { name: 'Джокович — Рублев' })).toBeVisible();

  // «Перед запуском»: цена и время из расчета сервера, лимит участника
  const launch = page.getByRole('complementary', { name: 'Перед запуском' });
  await expect(launch.getByText(/^≈\$\d/).first()).toBeVisible();
  await expect(launch.getByText(/Ваш лимит ИИ на/)).toBeVisible();
  const run = launch.getByRole('button', { name: 'Запустить анализ' });
  await expect(run).toBeEnabled();
  await expectNoHorizontalScroll(page);

  await withFakeClaude(async () => {
    await run.click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    // Ход по шагам, затем итог (поддельный Claude отвечает за секунды)
    await expect(page.getByRole('heading', { level: 2, name: /Экспресс из 2 событий · кэф 1\.89/ })).toBeVisible({ timeout: 30_000 });
  });
  await expect(page.getByText('Анализ готов')).toBeVisible();
  await page.getByRole('button', { name: 'Показать шаги' }).click();
  const steps = page.getByRole('list', { name: 'Шаги анализа' });
  await expect(steps.getByRole('listitem')).toHaveCount(9);
  await expect(steps.getByText('Claude: Синнер — Руне')).toBeVisible();

  // Карточки матчей: вероятности по рынкам с моделью, Claude и рынком
  const table = page.getByRole('table', { name: 'Вероятности и валуй по рынкам: Синнер — Руне' });
  await expect(table.getByRole('columnheader', { name: /ML-модель/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /Синнер П1/ })).toContainText('1.30');
  const express = page.getByRole('region', { name: 'Экспресс стратегии' });
  await expect(express.getByText('Ждет решения')).toBeVisible();
  await express.getByRole('button', { name: 'Как посчитана сумма' }).click();
  await expect(express.getByText('Банк из вашего ввода')).toBeVisible();
  const stakeText = (await express.locator('.analysis-stake-value').innerText()).replace(/\D/g, '');
  const stake = Number(stakeText);
  expect(stake).toBeGreaterThan(0);

  // «Сохранить ставку»: кэф одной ноги у букмекера оказался другим
  await express.getByRole('button', { name: 'Сохранить ставку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить ставку' });
  const sinner = dialog.getByRole('textbox', { name: /^Синнер П1/ });
  await expect(sinner).toHaveValue('1.30');
  await sinner.fill('1.32');
  await expect(dialog.getByText(/1\.91 \(в анализе 1\.89\)/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  await expect(toast(page, /Ставка №\d+ сохранена/)).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(express.getByText('Ставка сохранена')).toBeVisible();
  const savedText = new RegExp(`Ставка №\\d+ в игре: ${stakeText.replace(/\B(?=(\d{3})+$)/g, '\\s')}\\s₽ на экспресс @1\\.91`);
  await expect(express.getByText(savedText)).toBeVisible();
  // После перезагрузки — та же сохраненная ставка: сумма и кэф при ставке, а не из анализа
  await page.reload();
  await expect(express.getByText(savedText)).toBeVisible();
  await expect(express.getByText('при ставке', { exact: true })).toBeVisible();
  await expect(express.getByText('Кэф при ставке', { exact: true })).toBeVisible();

  // Банк по учету: начальный банк из ввода и списанная ставка
  const bank = (await (await m.api.get('/api/me/bank')).json()) as { balance: string; in_play: string };
  expect(Number(bank.balance)).toBe(48000 - stake);
  expect(Number(bank.in_play)).toBe(stake);

  // «Новый анализ» после запуска — пустой; в «Последних анализах» анализ готов, ставка сохранена
  await page.goto('/new');
  await expect(page.getByRole('textbox', { name: 'Текст событий' })).toHaveValue('');
  const recent = page.getByRole('link', { name: /^Анализ #A-\d+: Синнер — Руне, Джокович — Рублев, готов$/ });
  await expect(recent.first()).toContainText('ставка сохранена');
});
