import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { ToastProvider } from '../../components';
import { ThemeProvider } from '../theme/ThemeProvider';
import { apiError, json, ME_ADMIN, ME_MEMBER, mockFetch } from '../../test/fetchMock';
import { RequireAdmin } from './RequireAdmin';
import { RequireAuth } from './RequireAuth';

function LoginProbe() {
  const location = useLocation();
  return <p>Страница входа {location.search}</p>;
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginProbe /> },
      {
        path: '/',
        element: <RequireAuth />,
        children: [
          { path: 'bets', element: <p>Ставки участника</p> },
          {
            path: 'admin',
            element: (
              <RequireAdmin>
                <p>Кабинет администратора</p>
              </RequireAdmin>
            ),
          },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const client = createQueryClient();
  client.setQueryDefaults(meQueryKey, { retry: false });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('RequireAuth', () => {
  it('без сеанса (401) ведет на /login и запоминает, откуда пришли', async () => {
    mockFetch({
      'GET /api/me': () => apiError(401, 'auth.not_authenticated', 'Войдите в аккаунт'),
    });
    const router = renderAt('/bets?status=open');
    expect(await screen.findByText(/Страница входа/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/bets?status=open');
    expect(screen.queryByText('Ставки участника')).not.toBeInTheDocument();
  });

  it('пока сеанс проверяется — индикатор, потом экран', async () => {
    mockFetch({ 'GET /api/me': () => json(ME_MEMBER) });
    renderAt('/bets');
    expect(screen.getByRole('status', { name: 'Проверяем вход' })).toBeInTheDocument();
    expect(await screen.findByText('Ставки участника')).toBeInTheDocument();
  });

  it('сервер недоступен — ошибка и «Повторить»', async () => {
    let up = false;
    mockFetch({
      'GET /api/me': () => (up ? json(ME_MEMBER) : new Response('Bad Gateway', { status: 502 })),
    });
    renderAt('/bets');
    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер временно недоступен');
    up = true;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Ставки участника')).toBeInTheDocument();
  });
});

describe('RequireAuth без связи', () => {
  it('запрос не дошел до сервера, данных нет — «Нет связи с интернетом»; «Повторить» со связью — экран', async () => {
    let online = false;
    mockFetch({
      'GET /api/me': () => {
        if (!online) throw new TypeError('Failed to fetch');
        return json(ME_MEMBER);
      },
      'GET /api/health': () => {
        if (!online) throw new TypeError('Failed to fetch');
        return json({ status: 'ok' });
      },
    });
    renderAt('/bets');
    expect(await screen.findByRole('heading', { name: 'Нет связи с интернетом' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Связи по-прежнему нет. Попробуйте еще раз через минуту')).toBeInTheDocument();
    online = true;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByText('Ставки участника')).toBeInTheDocument();
    expect(await screen.findByText('Связь восстановлена')).toBeInTheDocument();
  });
});

describe('RequireAdmin', () => {
  it('участник видит объяснение вместо кабинета администратора', async () => {
    mockFetch({ 'GET /api/me': () => json(ME_MEMBER) });
    renderAt('/admin');
    expect(await screen.findByText('Раздел только для администратора')).toBeInTheDocument();
    expect(screen.queryByText('Кабинет администратора')).not.toBeInTheDocument();
  });

  it('администратор попадает в раздел', async () => {
    mockFetch({ 'GET /api/me': () => json(ME_ADMIN) });
    renderAt('/admin');
    expect(await screen.findByText('Кабинет администратора')).toBeInTheDocument();
  });
});
