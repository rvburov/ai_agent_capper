import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { api, unwrap } from '../../../api/client';
import { meQueryKey } from '../../../api/keys';
import { createQueryClient } from '../../../api/queryClient';
import { RequireAuth } from '../../../app/guards/RequireAuth';
import { ToastProvider } from '../../../components';
import { apiError, json, ME_MEMBER, mockFetch, type Handler } from '../../../test/fetchMock';

// Аккаунт ждет удаления (В10): вместо экранов — один экран с датой и «Отменить удаление».
// Сервер в это время на все, кроме профиля, отмены и выхода, отвечает 403 account.deletion_pending.

const PENDING = { ...ME_MEMBER, deletion_requested_at: '2026-12-14T10:00:00Z', deletion_at: '2026-12-21T10:00:00Z' };

/** Экран приложения, который спрашивает сервер (как любой экран): ставки. */
function BetsProbe() {
  const bets = useQuery({ queryKey: ['bets-probe'], queryFn: () => unwrap(api.GET('/api/bets/summary')), retry: false });
  return <p>{bets.isError ? 'Ошибка ставок' : 'Ставки участника'}</p>;
}

function renderApp(routes: Record<string, Handler>) {
  const { calls } = mockFetch({ 'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }), ...routes });
  const router = createMemoryRouter(
    [
      { path: '/login', element: <p>Страница входа</p> },
      { path: '/', element: <RequireAuth />, children: [{ path: 'bets', element: <BetsProbe /> }] },
    ],
    { initialEntries: ['/bets'] },
  );
  const client = createQueryClient();
  client.setQueryDefaults(meQueryKey, { retry: false });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { calls, router, client };
}

describe('Аккаунт ждет удаления', () => {
  it('один экран с датой вместо приложения: экраны не спрашивают сервер', async () => {
    const { calls } = renderApp({ 'GET /api/me': () => json(PENDING) });
    expect(await screen.findByRole('heading', { name: 'Аккаунт будет удален 21 декабря 2026' })).toBeInTheDocument();
    expect(screen.getByText(/^До этой даты войти можно только для отмены/)).toBeInTheDocument();
    expect(screen.getByText('Аккаунт: anna@example.com')).toBeInTheDocument();
    expect(screen.queryByText('Ставки участника')).toBeNull();
    expect(calls.map((r) => new URL(r.url).pathname)).toEqual(['/api/me']);
  });

  it('«Отменить удаление» — DELETE /api/me/deletion, профиль перечитан, приложение снова открыто', async () => {
    let pending = true;
    const user = userEvent.setup();
    const { calls } = renderApp({
      'GET /api/me': () => json(pending ? PENDING : ME_MEMBER),
      'DELETE /api/me/deletion': () => {
        pending = false;
        return new Response(null, { status: 204 });
      },
      'GET /api/bets/summary': () => json({}),
    });
    await user.click(await screen.findByRole('button', { name: 'Отменить удаление' }));
    expect(await screen.findByText('Удаление отменено. Аккаунт работает как раньше')).toBeInTheDocument();
    expect(await screen.findByText('Ставки участника')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/me/deletion'))).toBe(true);
  });

  it('403 account.deletion_pending на любом запросе — профиль перечитан, тот же экран, а не ошибки', async () => {
    let deletion = false;
    renderApp({
      'GET /api/me': () => json(deletion ? PENDING : ME_MEMBER),
      'GET /api/bets/summary': () => {
        // удаление запросили в другой вкладке
        deletion = true;
        return apiError(403, 'account.deletion_pending', 'Аккаунт ждет удаления', { delete_at: PENDING.deletion_at });
      },
    });
    expect(await screen.findByRole('heading', { name: 'Аккаунт будет удален 21 декабря 2026' })).toBeInTheDocument();
    expect(screen.queryByText('Ошибка ставок')).toBeNull();
  });

  it('«Выйти» — выход и страница входа', async () => {
    const user = userEvent.setup();
    const { router } = renderApp({
      'GET /api/me': () => json(PENDING),
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
    });
    await user.click(await screen.findByRole('button', { name: 'Выйти' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  });
});
