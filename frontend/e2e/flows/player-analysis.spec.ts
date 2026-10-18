import { SINNER_RUNE, eventsText, memberDevice, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expectScreenLayout } from '../support/layout';
import { expect, test } from '../support/test';

// «Игроки» → поиск → карточка → сегодняшний матч → анализ (этап 4): участник разобрал матч
// Синнер — Руне (поддельный Claude); в карточке Синнера матч виден в шапке («сегодня» — только из
// своих анализов и ставок), в «Эло по покрытиям» — Эло обоих на покрытии матча и вероятность по
// Эло (числа сервера: today[].elo, opponent_elo, elo_prob), «Открыть анализ» ведет в этот анализ.
// На телефоне (375 px, с меткой @360 — и 360 px) — без прокрутки вбок, в обеих темах.

interface Today {
  match_id: number;
  side: 1 | 2 | null;
  elo: number | null;
  opponent_elo: number | null;
  elo_prob: number | null;
  analyses: number[];
  opponent: { name_ru: string | null };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

test('игроки → поиск → карточка → матч → анализ', { tag: '@360' }, async ({ device, apiClient }) => {
  const m = await memberDevice(device, apiClient, 'Карта Матчевая');
  const page = m.page;
  await parseEvents(page, eventsText(SINNER_RUNE), 1);
  await withFakeClaude(async () => {
    await page.getByRole('button', { name: /^Запустить/ }).last().click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресса стратегии нет · \d варианта? ставки$|^Анализ 1 матча готов/ })).toBeVisible({ timeout: 30_000 });
  });
  const analysisId = Number(/\/analysis\/(\d+)/.exec(page.url())?.[1]);

  await page.goto('/players');
  await page.getByRole('search', { name: 'Поиск игроков' }).getByRole('searchbox', { name: 'Поиск' }).fill('синер');
  await expect(page.getByText(/^Найден 1 игрок по всей базе/)).toBeVisible();
  await page.getByRole('link', { name: /Янник Синнер/ }).first().click();
  await expect(page).toHaveURL(/\/players\/\d+$/);
  const playerId = Number(/\/players\/(\d+)/.exec(page.url())?.[1]);

  // «сегодня» — из своего анализа; числа Эло — те же, что в ответе сервера
  const card = (await (await m.api.get(`/api/players/${playerId}`)).json()) as { today: Today[] };
  expect(card.today).toHaveLength(1);
  const today = card.today[0]!;
  expect(today.analyses).toContain(analysisId);
  expect(today.side).toBe(1);
  const hero = page.getByRole('region', { name: 'Игрок Янник Синнер' });
  await expect(hero.getByText(/соперник —/).first()).toContainText('Хольгер Руне');
  await expect(hero.getByText(/соперник —/).first()).toContainText(`в вашем анализе #A-${String(analysisId).padStart(4, '0')}`);
  const elo = page.getByRole('heading', { level: 3, name: 'Эло по покрытиям' }).locator('xpath=ancestor::section[1]');
  await expect(elo.getByText('Сегодня: Синнер — Руне')).toBeVisible();
  expect(today.elo).not.toBeNull();
  expect(today.opponent_elo).not.toBeNull();
  expect(today.elo_prob).not.toBeNull();
  await expect(elo.getByText(`Эло на харде: ${today.elo} против ${today.opponent_elo} → ${pct(today.elo_prob!)} на победу`)).toBeVisible();
  await expectScreenLayout(page);
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }

  // матч → анализ: ссылка шапки ведет в тот самый анализ
  await hero.getByRole('link', { name: 'Открыть анализ' }).click();
  await expect(page).toHaveURL(new RegExp(`/analysis/${analysisId}$`));
  await expect(page.getByRole('heading', { level: 2, name: /^Экспресса стратегии нет · \d варианта? ставки$|^Анализ 1 матча готов/ })).toBeVisible();
});
