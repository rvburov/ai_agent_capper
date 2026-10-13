import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';

import { meQueryKey } from '../api/keys';
import { createQueryClient } from '../api/queryClient';
import { ThemeProvider } from '../app/theme/ThemeProvider';
import { ToastProvider } from '../components';
import { baseApi, type Currency, type Me } from './factories';
import { mockFetch, ME_MEMBER, type Handler } from './fetchMock';
import { setViewportWidth } from './setup';

export interface RenderPageOptions {
  /** Шаблон адреса экрана, как в src/app/router.tsx: '/profile/:tab?'. */
  path: string;
  /** Адрес, с которого начинается тест; по умолчанию — path (если в нем нет параметров). */
  url?: string;
  /**
   * Вошедший пользователь — сразу в кэше, как после входа (по умолчанию участник);
   * null — без пользователя.
   */
  me?: Me | null;
  /**
   * Ответы API поверх общих (baseApi: CSRF, /api/me, валюта, колокольчик): { 'GET /api/bets':
   * () => json(...) }. Без api fetch не подменяется — тест подменяет его сам (mockFetch).
   */
  api?: Record<string, Handler>;
  /** Валюта программы в общем ответе GET /api/settings. */
  currency?: Currency;
  /** Соседние экраны, куда уводят ссылки и переходы: путь → текст заглушки. */
  stubs?: Record<string, string>;
  /** Ширина окна для matchMedia: 375 — телефон (по умолчанию компьютер, 1366). */
  width?: number;
}

/**
 * QueryClient приложения для тестов: те же настройки (staleTime 30 с, свои правила повторов,
 * обработка 401), только запросы не повторяются — ошибка видна сразу. setDefaultOptions
 * заменяет настройки целиком, поэтому они сливаются с настройками приложения.
 */
export function createTestQueryClient(): QueryClient {
  const client = createQueryClient();
  const defaults = client.getDefaultOptions();
  client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
  return client;
}

/**
 * Экран в тесте: роутер в памяти, QueryClient приложения (без повторов запросов), тема,
 * всплывающие сообщения и подмена API. Возвращает роутер (адрес после переходов), клиент
 * запросов, все запросы к API (calls) и user для userEvent.
 */
export function renderPage(element: ReactNode, options: RenderPageOptions) {
  const { path, url, me = ME_MEMBER, api, currency, stubs = {}, width } = options;
  if (width !== undefined) setViewportWidth(width);
  const user = userEvent.setup();
  const calls = api ? mockFetch({ ...baseApi(me, currency), ...api }).calls : [];

  const routes: RouteObject[] = [
    { path, element },
    ...Object.entries(stubs).map(([stubPath, text]) => ({ path: stubPath, element: <p>{text}</p> })),
  ];
  const router = createMemoryRouter(routes, { initialEntries: [url ?? path] });
  const client = createTestQueryClient();
  if (me) client.setQueryData(meQueryKey, me);

  const view = render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...view, router, client, calls, user };
}

/** Тело запроса из calls как объект. */
export async function bodyOf<T = unknown>(request: Request): Promise<T> {
  return JSON.parse(await request.clone().text()) as T;
}
