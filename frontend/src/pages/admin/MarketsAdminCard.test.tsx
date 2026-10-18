import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { marketsOut } from '../../features/markets/testData';
import { json, ME_ADMIN } from '../../test/fetchMock';
import { bodyOf, renderPage } from '../../test/renderPage';
import { AdminPage } from './AdminPage';

// «Администрирование → Настройки → Новые рынки» (Р28): перевод в экспресс при пройденном пороге

describe('Администрирование: новые рынки', () => {
  it('порог пройден — «Перевести в экспресс» с подтверждением; без порога кнопка неактивна', async () => {
    const ready = marketsOut();
    ready.families = ready.families.map((m) => (m.family === 'stot' ? { ...m, events: 160, clv_n: 60, ready: true, can_promote: true } : m));
    const promoted = marketsOut();
    promoted.families = promoted.families.map((m) => (m.family === 'stot' ? { ...m, status: 'express', promoted: true } : m));
    const { user, calls } = renderPage(<AdminPage />, {
      path: '/admin/:tab?',
      url: '/admin/settings',
      me: ME_ADMIN,
      api: {
        'GET /api/admin/users': () => json([]),
        'GET /api/admin/invites': () => json([]),
        'GET /api/admin/settings': () => json({ currency: 'RUB', default_tz: 'Europe/Helsinki', currency_changed: null, updated_at: '2026-09-01T09:00:00Z' }),
        'GET /api/markets': () => json(ready),
        'PUT /api/admin/markets/stot': () => json(promoted),
      },
    });
    const card = (await screen.findByRole('heading', { name: 'Новые рынки' })).closest('section')!;
    const items = await within(card).findAllByRole('listitem');
    expect(items).toHaveLength(4);
    const stot = items.find((li) => li.textContent?.includes('Тотал сетов'))!;
    expect(within(stot).getByText('порог пройден')).toBeInTheDocument();
    expect(within(stot).getByText(/160 из 150 событий · CLV \+0,4%, с закрытием: 60 из 50/)).toBeInTheDocument();
    const games = items.find((li) => li.textContent?.includes('Фора по геймам'))!;
    expect(within(games).getByRole('button', { name: 'Перевести в экспресс' })).toBeDisabled();
    expect(within(games).getByText(/оценка модели — скоро/)).toBeInTheDocument();
    const total = items.find((li) => li.textContent?.includes('Тотал геймов'))!;
    expect(within(total).getByText(/модель не прошла проверку/)).toBeInTheDocument();
    expect(within(total).getByRole('button', { name: 'Перевести в экспресс' })).toBeDisabled();

    await user.click(within(stot).getByRole('button', { name: 'Перевести в экспресс' }));
    const dialog = screen.getByRole('dialog', { name: '«Тотал сетов» — в экспресс?' });
    await user.click(within(dialog).getByRole('button', { name: 'Перевести в экспресс' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const put = calls.find((r) => r.method === 'PUT');
    expect(await bodyOf(put as Request)).toEqual({ express: true });
    expect(await screen.findByText('Готово: «Тотал сетов» — в экспрессе')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Вернуть «для сравнения»' })).toBeInTheDocument();
  });
});
