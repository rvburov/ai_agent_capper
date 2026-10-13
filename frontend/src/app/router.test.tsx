import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ToastProvider } from '../components';
import { json, ME_MEMBER, mockFetch } from '../test/fetchMock';
import { createTestQueryClient } from '../test/renderPage';
import { routes } from './router';
import { ThemeProvider } from './theme/ThemeProvider';

// Настоящая таблица маршрутов: экраны грузятся лениво (lazyPage) и открываются по адресу.

function renderApp(path: string) {
  const client = createTestQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
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

describe('Маршруты', () => {
  it('вход — ленивый экран без оболочки', async () => {
    mockFetch({});
    renderApp('/login');
    expect(await screen.findByRole('heading', { level: 1, name: 'Вход в AI Capper' })).toBeInTheDocument();
  });

  it('главная в оболочке: меню на месте, экран — заглушка этапа 4', async () => {
    mockFetch({
      'GET /api/me': () => json(ME_MEMBER),
      'GET /api/me/notifications': () => json({ items: [], unread: 0 }),
    });
    renderApp('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Главная' })).toBeInTheDocument();
    expect(screen.getByText('Раздел появится на этапе 4')).toBeInTheDocument();
  });

  it('участнику «Администрирование» не открывается, файл экрана не нужен', async () => {
    mockFetch({
      'GET /api/me': () => json(ME_MEMBER),
      'GET /api/me/notifications': () => json({ items: [], unread: 0 }),
    });
    renderApp('/admin/users');
    expect(await screen.findByText('Раздел только для администратора')).toBeInTheDocument();
  });
});
