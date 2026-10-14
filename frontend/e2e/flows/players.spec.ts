import { memberDevice } from '../support/analysis';
import { expectScreenLayout } from '../support/layout';
import { expect, test } from '../support/test';

// «Игроки» и карточка игрока (этап 4): поиск идет на сервер (с опечатками, по-русски и
// латиницей) и живет в адресе, строка ведет в карточку, вкладки карточки — адреса
// /players/:id/:tab. Игроки — маленький мир стека (scripts/e2e-stack.sh): Синнер, Алькарас,
// Джокович, Медведев, Рублев, Руне с матчами за последние полгода. На телефоне (375 px, с меткой
// @360 — и 360 px) — список карточками и вкладки без прокрутки вбок, в обеих темах.

test('игроки: поиск «синер» → карточка → вкладки', { tag: '@360' }, async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Илья Игроков');
  const page = m.page;
  await page.goto('/players');
  await expect(page.getByRole('heading', { level: 2, name: 'База игроков' })).toBeVisible();
  // по умолчанию — все шестеро с матчами за 52 недели, место по Эло считает сервер
  await expect(page.getByText(/^Показано 6 из 6/)).toBeVisible();
  await expectScreenLayout(page);

  // поиск с опечаткой: запрос на сервер, строка поиска — в адресе
  const request = page.waitForRequest((r) => r.url().includes('/api/players/ranking') && decodeURIComponent(r.url()).includes('q=синер'));
  await page.getByRole('search', { name: 'Поиск игроков' }).getByRole('searchbox', { name: 'Поиск' }).fill('синер');
  await request;
  await expect(page).toHaveURL(/\/players\?q=%D1%81%D0%B8%D0%BD%D0%B5%D1%80$/);
  await expect(page.getByText(/^Найден 1 игрок по всей базе/)).toBeVisible();
  const sinner = page.getByRole('link', { name: /Янник Синнер/ }).first();
  await expect(sinner).toBeVisible();
  await sinner.click();

  // карточка: шапка, Эло по покрытиям; профиля из бота у игрока стека нет — вкладки тоже нет
  await expect(page).toHaveURL(/\/players\/\d+$/);
  const id = Number(/\/players\/(\d+)/.exec(page.url())?.[1]);
  await expect(page.getByRole('heading', { level: 2, name: 'Янник Синнер' })).toBeVisible();
  // в шапке и во вкладке браузера — фамилия игрока, как в макете
  await expect(page.getByRole('heading', { level: 1, name: 'Синнер' })).toBeVisible();
  await expect(page).toHaveTitle('Синнер · AI Capper');
  const tabs = page.getByRole('tablist', { name: 'Разделы карточки игрока' });
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Эло по покрытиям' })).toBeVisible();
  const card = (await (await m.api.get(`/api/players/${id}`)).json()) as { legacy_profile: unknown };
  expect(card.legacy_profile).toBeNull();
  await expectScreenLayout(page);

  await tabs.getByRole('tab', { name: 'Матчи' }).click();
  await expect(page).toHaveURL(new RegExp(`/players/${id}/matches$`));
  await expect(page.getByRole('heading', { name: 'Последние матчи в базе' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Матчи' })).toContainText('Руне');
  await expectScreenLayout(page);

  await tabs.getByRole('tab', { name: 'Новости' }).click();
  await expect(page).toHaveURL(new RegExp(`/players/${id}/news$`));
  await expect(page.getByRole('tabpanel', { name: 'Новости' })).toBeVisible();
  await expectScreenLayout(page);

  // вкладки профиля нет — адрес профиля уводит на обзор
  await page.goto(`/players/${id}/profile`);
  await expect(page).toHaveURL(new RegExp(`/players/${id}$`));
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }
});
