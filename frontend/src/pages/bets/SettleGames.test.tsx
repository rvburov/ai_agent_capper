import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bankOut } from '../../features/analysis/testData';
import { betLeg, betLeg2, betOpen, betPage, betsSummary, newsResult } from '../../features/bets/testData';
import type { BetItem } from '../../features/bets/types';
import { marketsOut } from '../../features/markets/testData';
import { json } from '../../test/fetchMock';
import { bodyOf, renderPage } from '../../test/renderPage';
import { BetsPage } from './BetsPage';

// Р28: ручной расчет ноги по геймам — «Счет по геймам», исход по линии, «ровно» — возврат

/** Своя ставка: «Тотал геймов меньше 23» (Синнер — Руне) и Джокович П1. */
function gamesBet(): BetItem {
  return betOpen({
    kind: 'own',
    legs: [
      betLeg({ market: 'GTOT_23', family: 'gtot', line: 23, selection: 2, score_kind: 'games', void_hint: true, score_outcomes: {}, p_final: null, p_base: null, p_claude: null }),
      betLeg2(),
    ],
  });
}

function api(bet: BetItem, saved: BetItem) {
  return {
    'GET /api/me/bank': () => json(bankOut({ equity: '48000.00', balance: '46680.00', in_play: '1320.00' })),
    'GET /api/bets/summary': () => json(betsSummary()),
    'GET /api/bets': () => json(betPage([bet])),
    'GET /api/bets/7': () => json(bet),
    'GET /api/markets': () => json(marketsOut()),
    'PUT /api/bets/7/result': () => json(saved),
  };
}

describe('Ставки: расчет по счету по геймам (Р28)', () => {
  it('6:4 7:6 — 23 гейма, ровно линия: возврат; в запрос уходит счет по геймам', async () => {
    const bet = gamesBet();
    const saved = { ...bet, status: 'won' as const, profit: '594.00', payout: '1914.00', settled_at: '2026-10-13T12:00:00Z' };
    const { user, calls } = renderPage(<BetsPage />, { path: '/bets', url: '/bets', api: api(bet, saved) });
    const open = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    expect(within(open).getByText(/Тотал геймов меньше 23/)).toBeInTheDocument();
    await user.click(within(open).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №7' });
    expect(within(dialog).getByText(/Для тоталов и фор по геймам подсказываем «возврат»/)).toBeInTheDocument();

    const games = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    const score = within(games).getByRole('textbox', { name: 'Счет по геймам' });
    expect(score).toHaveAttribute('placeholder', '6:4 7:6');
    await user.type(score, '6:4 7');
    expect(within(games).queryByRole('alert')).toBeNull();
    await user.type(score, ':6(5)');
    expect(within(games).getByRole('button', { name: 'Возврат' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(games).getByText('23 гейма — ровно линия 23: возврат, кэф 1,00')).toBeInTheDocument();

    // недоигранный матч — исход выбирает участник по правилам букмекера
    await user.clear(score);
    await user.type(score, '6:4 3:2');
    expect(within(games).getByText(/Матч не доигран — исход по правилам букмекера/)).toBeInTheDocument();
    await user.clear(score);
    await user.type(score, '6:4 6:1');
    expect(within(games).getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(games).getByText('17 геймов против линии 23')).toBeInTheDocument();

    const second = within(dialog).getByRole('group', { name: 'Событие 2: Джокович — Рублев' });
    await user.type(within(second).getByRole('textbox', { name: 'Счет по сетам' }), '2:0');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить результат' }));
    await waitFor(() => expect(calls.some((r) => r.method === 'PUT')).toBe(true));
    const put = calls.find((r) => r.method === 'PUT');
    expect(await bodyOf(put as Request)).toMatchObject({
      legs: [
        { leg_id: 11, result: 'win', score: '6:4 6:1' },
        { leg_id: 12, result: 'win', score: '2:0' },
      ],
    });
  });

  it('подсказка из новостей: Руне выиграл 6-4 7-6 — фора Синнера −2.5 по геймам проиграла (первым — игрок 1)', async () => {
    const news = newsResult({ winner: 2, sets: '0:2', games: '4:6 6:7(5)', score: '6-4 7-6(5)' });
    const leg = betLeg({ market: 'GHCP_-2.5', family: 'ghcp', line: -2.5, selection: 1, score_kind: 'games', void_hint: true, score_outcomes: {}, p_final: null, p_base: null, p_claude: null, news_result: news });
    const bet = betOpen({ kind: 'own', awaiting_result: true, legs: [leg] });
    const saved = { ...bet, status: 'lost' as const, profit: '-1320.00', payout: '0.00', settled_at: '2026-10-13T12:00:00Z' };
    const { user, calls } = renderPage(<BetsPage />, { path: '/bets', url: '/bets', api: api(bet, saved) });
    const open = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    await user.click(within(open).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №7' });
    const hint = await within(dialog).findByRole('note');
    // счет в новости — со стороны победителя; подставляется счет первым игрок 1 (Синнер)
    expect(hint).toHaveTextContent('Руне выиграл 6:4 7:6(5)');
    await user.click(within(hint).getByRole('button', { name: 'Подставить 4:6 6:7(5)' }));
    const games = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    expect(within(games).getByRole('textbox', { name: 'Счет по геймам' })).toHaveValue('4:6 6:7(5)');
    expect(within(games).getByRole('button', { name: 'Проиграл' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(games).getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить результат' }));
    await waitFor(() => expect(calls.some((r) => r.method === 'PUT')).toBe(true));
    const put = calls.find((r) => r.method === 'PUT');
    expect(await bodyOf(put as Request)).toMatchObject({ legs: [{ leg_id: 11, result: 'loss' }] });
  });
});
