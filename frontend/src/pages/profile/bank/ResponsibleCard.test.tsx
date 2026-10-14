import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { pausePreviewDay } from '../../../features/bank/playLimits';
import { playLimitsOut } from '../../../features/bank/testData';
import type { PlayLimitsIn } from '../../../features/bank/types';
import { formatDateLong } from '../../../lib/format';
import { apiError, json } from '../../../test/fetchMock';
import { bodyOf } from '../../../test/renderPage';
import { bankTabApi, renderBankTab } from './testApi';

// Ответственная игра (В8): лимиты числа и суммы ставок в день, отложенное повышение и пауза.
// Числа и состояние («что блокирует», «сколько сегодня») — с сервера.

const LIMITS = playLimitsOut({
  bets_per_day: 5,
  stake_per_day: '3000.00',
  today: { bets: 3, stake: '2250.00', starts_at: '2026-10-13T21:00:00Z', ends_at: '2026-10-14T21:00:00Z' },
});

async function card() {
  return (await screen.findByRole('heading', { name: 'Ответственная игра' })).closest('section') as HTMLElement;
}

describe('Кабинет: ответственная игра', () => {
  it('лимиты и сколько поставлено сегодня — с сервера; поля заполнены', async () => {
    renderBankTab(bankTabApi({ 'GET /api/me/play-limits': () => json(LIMITS) }));
    const rg = await card();
    expect(await within(rg).findByText('Лимиты включены')).toBeInTheDocument();
    expect(within(rg).getByText('3 из 5')).toBeInTheDocument();
    expect(within(rg).getByText('2 250 ₽ из 3 000 ₽')).toBeInTheDocument();
    expect(within(rg).getByRole('meter', { name: 'Ставок сегодня' })).toHaveAttribute('aria-valuenow', '3');
    expect(within(rg).getByRole('meter', { name: 'Сумма сегодня' })).toHaveClass('warn');
    expect(within(rg).getByRole('textbox', { name: 'Ставок в день, не больше' })).toHaveValue('5');
    expect(within(rg).getByRole('textbox', { name: 'Сумма ставок в день' })).toHaveValue('3\u00a0000');
  });

  it('без лимитов: «без лимита», поля пустые; снижение — сразу и с валютой формы', async () => {
    let saved: PlayLimitsIn | null = null;
    const { user, calls } = renderBankTab(
      bankTabApi({
        'PUT /api/me/play-limits': async (request) => {
          saved = (await request.clone().json()) as PlayLimitsIn;
          return json(playLimitsOut({ bets_per_day: 3, stake_per_day: null }));
        },
      }),
    );
    const rg = await card();
    expect(await within(rg).findByText('Лимитов нет')).toBeInTheDocument();
    expect(within(rg).getAllByText('0 · без лимита')).toHaveLength(1);
    expect(within(rg).getByText('0 ₽ · без лимита')).toBeInTheDocument();
    await user.type(within(rg).getByRole('textbox', { name: 'Ставок в день, не больше' }), '3');
    await user.click(within(rg).getByRole('button', { name: 'Сохранить лимиты' }));
    expect(await screen.findByText('Лимит снижен и уже действует')).toBeInTheDocument();
    expect(saved).toEqual({ bets_per_day: 3, stake_per_day: null, currency: 'RUB' });
    expect(calls.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(await within(rg).findByText('Лимиты включены')).toBeInTheDocument();
  });

  it('неверные поля — подсказка под полем, без запроса', async () => {
    const { user, calls } = renderBankTab(bankTabApi({ 'GET /api/me/play-limits': () => json(LIMITS) }));
    const rg = await card();
    const count = await within(rg).findByRole('textbox', { name: 'Ставок в день, не больше' });
    await user.clear(count);
    await user.type(count, '25');
    const amount = within(rg).getByRole('textbox', { name: 'Сумма ставок в день' });
    await user.clear(amount);
    await user.type(amount, '0');
    await user.click(within(rg).getByRole('button', { name: 'Сохранить лимиты' }));
    expect(within(rg).getByText('Целое число от 1 до 20 или пусто — без лимита')).toBeInTheDocument();
    expect(within(rg).getByText('Сумма больше нуля или пусто — без лимита')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('повышение — через 24 часа: плашка «Запрошено повышение» и отмена запроса', async () => {
    const pending = { bets_per_day: 8, stake_per_day: null, starts_at: '2026-12-15T10:00:00Z' };
    const bodies: PlayLimitsIn[] = [];
    let current = LIMITS;
    const { user } = renderBankTab(
      bankTabApi({
        'GET /api/me/play-limits': () => json(current),
        'PUT /api/me/play-limits': async (request) => {
          const body = (await request.clone().json()) as PlayLimitsIn;
          bodies.push(body);
          current = body.bets_per_day === 8 ? { ...LIMITS, pending } : LIMITS;
          return json(current);
        },
      }),
    );
    const rg = await card();
    const count = await within(rg).findByRole('textbox', { name: 'Ставок в день, не больше' });
    await user.clear(count);
    await user.type(count, '8');
    await user.clear(within(rg).getByRole('textbox', { name: 'Сумма ставок в день' }));
    await user.click(within(rg).getByRole('button', { name: 'Сохранить лимиты' }));
    expect(await screen.findByText('Повышение лимита вступит в силу 15 дек, 12:00, через 24 часа')).toBeInTheDocument();
    expect(bodies[0]).toEqual({ bets_per_day: 8, stake_per_day: null, currency: 'RUB' });
    const note = await within(rg).findByText('Запрошено повышение: до 8 ставок и без лимита суммы в день. Вступит в силу 15 дек, 12:00, через 24 часа после запроса.');
    // поля снова показывают действующие лимиты; сохранить их без правки — не отмена повышения
    expect(within(rg).getByRole('textbox', { name: 'Ставок в день, не больше' })).toHaveValue('5');
    await user.click(within(rg).getByRole('button', { name: 'Сохранить лимиты' }));
    expect(await screen.findByText('Лимиты не изменились')).toBeInTheDocument();
    expect(screen.queryByText('Лимит снижен и уже действует')).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(within(rg).getByText(/^Запрошено повышение/)).toBeInTheDocument();
    await user.click(within(note.closest('.callout') as HTMLElement).getByRole('button', { name: 'Отменить запрос' }));
    expect(await screen.findByText('Запрос на повышение лимита отменен')).toBeInTheDocument();
    // отмена — те же действующие лимиты: запрос без смягчений сервер считает отменой
    expect(bodies[1]).toEqual({ bets_per_day: 5, stake_per_day: '3000.00', currency: 'RUB' });
    await waitFor(() => expect(within(rg).queryByText(/Запрошено повышение/)).toBeNull());
  });

  it('пауза: подтверждение «досрочно не снять», затем «Пауза до … включительно» и метка в сводке', async () => {
    let paused = false;
    const PAUSED = playLimitsOut({ paused_until: '2026-12-13T22:00:00Z', blocked: 'paused', blocked_until: '2026-12-13T22:00:00Z' });
    const { user, calls } = renderBankTab(
      bankTabApi({
        'GET /api/me/play-limits': () => json(paused ? PAUSED : playLimitsOut()),
        'POST /api/me/pause': () => {
          paused = true;
          return json(PAUSED);
        },
      }),
    );
    const rg = await card();
    await user.click(await within(rg).findByRole('button', { name: '30 дней' }));
    await user.click(within(rg).getByRole('button', { name: 'Взять паузу на 30 дней' }));
    const confirm = within(rg).getByRole('alert');
    expect(confirm).toHaveTextContent(`Пауза до ${formatDateLong(pausePreviewDay(30, 'Europe/Helsinki'))} включительно.`);
    expect(confirm).toHaveTextContent('Отменить ее досрочно будет нельзя — ни вам, ни администратору.');
    await waitFor(() => expect(within(rg).getByRole('button', { name: 'Да, взять паузу' })).toHaveFocus());
    await user.click(within(rg).getByRole('button', { name: 'Да, взять паузу' }));
    expect(await screen.findByText('Пауза до 13 декабря. Новые анализы и ставки недоступны')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'POST') as Request)).toEqual({ days: 30 });
    expect(within(rg).getByText('Пауза до 13 декабря 2026 включительно.')).toBeInTheDocument();
    expect(within(rg).queryByRole('button', { name: /Взять паузу/ })).toBeNull();
    expect(within(rg).getByText('Пауза', { selector: '.chip' })).toBeInTheDocument();
    const hero = screen.getByRole('region', { name: 'Сводка аккаунта' });
    expect(await within(hero).findByText('Пауза до 13 декабря')).toBeInTheDocument();
  });

  it('пауза короче действующей — текст сервера и лимиты перечитаны', async () => {
    const { user, calls } = renderBankTab(
      bankTabApi({
        'POST /api/me/pause': () =>
          apiError(409, 'play.pause_shorter', 'Пауза уже действует', { until: '2026-12-13T22:00:00Z', until_text: '14.12.2026 00:00' }),
      }),
    );
    const rg = await card();
    await user.click(await within(rg).findByRole('button', { name: 'Взять паузу на 7 дней' }));
    const reads = calls.filter((r) => r.url.endsWith('/api/me/play-limits')).length;
    await user.click(within(rg).getByRole('button', { name: 'Да, взять паузу' }));
    expect(await within(rg).findByText('Пауза уже действует до 13 декабря включительно: сократить ее нельзя, только продлить')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((r) => r.url.endsWith('/api/me/play-limits')).length).toBeGreaterThan(reads));
  });

  it('лимит дня исчерпан — до какого времени закрыты ставки и анализы', async () => {
    renderBankTab(
      bankTabApi({
        'GET /api/me/play-limits': () =>
          json({ ...LIMITS, today: { ...LIMITS.today, bets: 5 }, blocked: 'bets_limit', blocked_until: '2026-12-20T22:00:00Z' }),
      }),
    );
    const rg = await card();
    expect(await within(rg).findByText('Лимит ставок на сегодня исчерпан: новые ставки и анализы будут доступны 21 дек, 00:00.')).toBeInTheDocument();
    expect(within(rg).getByRole('meter', { name: 'Ставок сегодня' })).toHaveClass('bad');
  });

  it('валюта программы сменилась, пока форма была открыта — текст и перечитанные суммы', async () => {
    const { user, calls } = renderBankTab(
      bankTabApi({
        'GET /api/me/play-limits': () => json(LIMITS),
        'PUT /api/me/play-limits': () => apiError(409, 'common.currency_changed', 'Валюта сменилась', { currency: 'EUR' }),
        'GET /api/settings': () => json({ currency: 'RUB' }),
      }),
    );
    const rg = await card();
    const count = await within(rg).findByRole('textbox', { name: 'Ставок в день, не больше' });
    await user.clear(count);
    await user.type(count, '4');
    const before = calls.filter((r) => r.url.endsWith('/api/me/play-limits')).length;
    await user.click(within(rg).getByRole('button', { name: 'Сохранить лимиты' }));
    expect(await within(rg).findByText(/^Валюта программы сменилась: теперь €\. Суммы обновлены в новой валюте/)).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((r) => r.url.endsWith('/api/me/play-limits')).length).toBeGreaterThan(before));
  });
});
