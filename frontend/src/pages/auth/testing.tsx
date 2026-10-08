import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';

import { meQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { ThemeProvider } from '../../app/theme/ThemeProvider';
import { ToastProvider } from '../../components';
import { LoginPage } from './LoginPage';
import { RegisterPage } from './RegisterPage';
import { ResetPage } from './ResetPage';

// Тесты экранов входа: настоящие страницы и маршрутизатор в памяти, API — подмена fetch.

function AppProbe({ client }: { client: QueryClient }) {
  const location = useLocation();
  const me = client.getQueryData<{ display_name: string }>(meQueryKey);
  return (
    <p>
      Приложение {location.pathname} {me ? `вошел ${me.display_name}` : 'без пользователя'}
    </p>
  );
}

export function renderAuth(entry: string | { pathname: string; state?: unknown }) {
  document.cookie = 'capper_csrf=tok; path=/';
  const client = createQueryClient();
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/reset', element: <ResetPage /> },
      { path: '*', element: <AppProbe client={client} /> },
    ],
    { initialEntries: [entry] },
  );
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { router, client };
}

export async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  return (await request.clone().json()) as Record<string, unknown>;
}
