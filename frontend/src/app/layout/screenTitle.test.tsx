import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { ToastProvider } from '../../components';
import { baseApi } from '../../test/factories';
import { ME_MEMBER, mockFetch } from '../../test/fetchMock';
import { createTestQueryClient } from '../../test/renderPage';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AppShell } from './AppShell';
import { useScreenTitle } from './screenTitle';

function Player() {
  useScreenTitle('Синнер');
  return <p>Карточка</p>;
}

function renderShell() {
  const routes: RouteObject[] = [
    {
      path: '/',
      element: <AppShell />,
      children: [
        { path: 'players', element: <p>Список</p>, handle: { title: 'players', nav: 'players' } },
        { path: 'players/:id', element: <Player />, handle: { title: 'player', nav: 'players', crumbs: 'player' } },
      ],
    },
  ];
  mockFetch(baseApi(ME_MEMBER));
  const client = createTestQueryClient();
  client.setQueryData(meQueryKey, ME_MEMBER);
  const router = createMemoryRouter(routes, { initialEntries: ['/players/1'] });
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

describe('Заголовок экрана из данных', () => {
  it('карточка игрока — фамилия в шапке и во вкладке, «Игроки / карточка игрока» над ней; ушли — заголовок маршрута', async () => {
    const router = renderShell();
    expect(await screen.findByRole('heading', { level: 1, name: 'Синнер' })).toBeInTheDocument();
    expect(screen.getByText('Игроки / карточка игрока')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Синнер · AI Capper'));
    await act(() => router.navigate('/players'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Игроки' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Игроки · AI Capper'));
  });
});
