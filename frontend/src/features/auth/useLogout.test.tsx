import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { meQueryKey, notificationsQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { ToastProvider } from '../../components';
import { apiError, ME_MEMBER, mockFetch, type Handler } from '../../test/fetchMock';
import { useLogout } from './useLogout';

// Выход из меню пользователя: запрос, страница входа, пустой кэш, тост.

function LogoutButton() {
  const { logout, pending } = useLogout();
  return (
    <button type="button" disabled={pending} onClick={logout}>
      logout
    </button>
  );
}

function setup(answer: Handler): { client: QueryClient; calls: Request[]; router: ReturnType<typeof createMemoryRouter> } {
  document.cookie = 'capper_csrf=tok; path=/';
  const { calls } = mockFetch({ 'POST /api/auth/logout': answer });
  const client = createQueryClient();
  client.setQueryData(meQueryKey, ME_MEMBER);
  client.setQueryData(notificationsQueryKey, { items: [], unread: 3 });
  const router = createMemoryRouter(
    [
      { path: '/bets', element: <LogoutButton /> },
      { path: '/login', element: <p>login page</p> },
    ],
    { initialEntries: ['/bets'] },
  );
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client, calls, router };
}

describe('выход', () => {
  it('POST /api/auth/logout → /login, кэш очищен, тост', async () => {
    const { client, calls, router } = setup(() => new Response(null, { status: 204 }));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('login page');
    expect(router.state.location.pathname).toBe('/login');
    expect(calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /api/auth/logout']);
    expect(calls[0]?.headers.get('X-CSRF-Token')).toBe('tok');
    await waitFor(() => expect(client.getQueryData(meQueryKey)).toBeUndefined());
    expect(client.getQueryData(notificationsQueryKey)).toBeUndefined();
    expect(await screen.findByText('Вы вышли из аккаунта')).toBeInTheDocument();
  });

  it('сеанс уже закончился (401) — тоже выход', async () => {
    const { router } = setup(() => apiError(401, 'auth.not_authenticated', 'Войдите в аккаунт'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('login page');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('сбой сервера — остаемся, текст ошибки в тосте, данные на месте', async () => {
    const { client, router } = setup(() => apiError(500, 'common.internal', 'Ошибка сервера'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    expect(await screen.findByText('Ошибка сервера')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/bets');
    expect(client.getQueryData(meQueryKey)).toEqual(ME_MEMBER);
  });
});
