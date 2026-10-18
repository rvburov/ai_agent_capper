import { memberDevice } from '../support/analysis';
import { expectScreenLayout } from '../support/layout';
import { expect, test } from '../support/test';
import { toast } from '../support/ui';

// Личный кабинет → «Банк и стратегия» (этап 4): пустой банк нового участника, пополнение,
// вывод и корректировка через «Движение банка» с журналом; правила стратегии и адаптации —
// только просмотр. На телефоне (375 px, с меткой @360 — и 360 px) — та же вкладка без прокрутки
// вбок, в светлой и темной темах.

test('движение банка: пополнение, вывод больше баланса, вывод и корректировка', { tag: '@360' }, async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Бора Банкова');
  const page = m.page;
  await page.goto('/profile/bank');
  await expect(page).toHaveURL(/\/profile\/bank$/);
  await expect(page.getByText('Валюта программы: рубли (₽)')).toBeVisible();
  await expect(page.getByText(/Банк появится после первой ставки или пополнения/)).toBeVisible();

  const moves = page.getByRole('region', { name: 'Движение банка' });
  const amount = moves.getByRole('textbox', { name: 'Сумма' });
  await amount.fill('10 000');
  await moves.getByRole('textbox', { name: 'Комментарий' }).fill('Стартовый банк в Fonbet');
  await moves.getByRole('button', { name: 'Записать' }).click();
  await expect(toast(page, 'Пополнение +10 000 ₽ записано. Банк 10 000 ₽, в прибыль и ROI не входит')).toBeVisible();
  await expect(moves.getByText('Стартовый банк', { exact: true })).toBeVisible();

  // Вывести больше баланса нельзя — подсказка под полем, запроса нет
  await moves.getByRole('group', { name: 'Что записать' }).getByRole('button', { name: 'Вывод' }).click();
  await expect(moves.getByText('Свободно 10 000 ₽: ставки в игре вывести нельзя')).toBeVisible();
  await amount.fill('20000');
  await moves.getByRole('button', { name: 'Записать' }).click();
  await expect(moves.getByText('Вывести можно не больше баланса (10 000 ₽): ставки в игре вывести нельзя')).toBeVisible();
  await amount.fill('2 500');
  await moves.getByRole('button', { name: 'Записать' }).click();
  await expect(toast(page, 'Вывод −2 500 ₽ записан. Банк 7 500 ₽, в прибыль и ROI не входит')).toBeVisible();

  await moves.getByRole('group', { name: 'Что записать' }).getByRole('button', { name: 'Корректировка' }).click();
  await moves.getByRole('textbox', { name: 'Сумма со знаком' }).fill('−500');
  await moves.getByRole('textbox', { name: 'Комментарий' }).fill('Ставка учтена дважды');
  await moves.getByRole('button', { name: 'Записать' }).click();
  await expect(toast(page, 'Корректировка −500 ₽ записана. Банк 7 000 ₽, в прибыль и ROI не входит')).toBeVisible();

  // Журнал — новые сверху, банк по учету — 7 000 ₽
  const journal = moves.locator('.profile-list .profile-item');
  await expect(journal).toHaveCount(3);
  await expect(journal.first()).toContainText('Корректировка');
  await expect(journal.first()).toContainText('Ставка учтена дважды');
  await expect(journal.first()).toContainText('баланс после 7 000 ₽');
  const bank = (await (await m.api.get('/api/me/bank')).json()) as { balance: string; invested: string };
  expect(Number(bank.balance)).toBe(7000);
  await expect(page.getByText('старт и движения банка')).toBeVisible();

  // Правила стратегии и адаптации — только просмотр; рост ставки выключен (В7)
  const strategy = page.locator('#profile-strategy');
  await expect(strategy).toContainText('П1 и П2, фора ±1.5 по сетам');
  await expect(strategy).toContainText('только экспресс из 3 событий');
  const adapt = page.locator('#profile-adapt');
  await expect(adapt.getByRole('switch', { name: /^Банк \+15% к вложенному/ })).toBeDisabled();
  await expect(adapt.getByRole('switch', { name: /^Банк \+15% к вложенному/ })).not.toBeChecked();
  await expect(adapt.getByRole('switch', { name: /^Просадка от пика −10%/ })).toBeChecked();
  await expect(adapt.getByText('Выключены по умолчанию')).toBeVisible();

  await expectScreenLayout(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectScreenLayout(page);
});
