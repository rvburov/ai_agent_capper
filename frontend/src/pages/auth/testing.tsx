import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';

import { meQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { ThemeProvider } from '../../app/theme/ThemeProvider';
import { ToastProvider } from '../../components';
import { setViewportWidth } from '../../test/setup';
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

/**
 * Ширина окна, которую можно менять посреди теста: подмена matchMedia из test/setup не
 * сообщает подписчикам о смене, а здесь resize() их оповещает (как поворот планшета).
 * Вызвать restore() в конце теста.
 */
export function resizableViewport(width: number) {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  const original = window.matchMedia.bind(window);
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList =>
      Object.assign(original(query), {
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      }),
  });
  setViewportWidth(width);
  return {
    resize(next: number) {
      setViewportWidth(next);
      act(() => listeners.forEach((listener) => listener()));
    },
    restore() {
      if (descriptor) Object.defineProperty(window, 'matchMedia', descriptor);
    },
  };
}
