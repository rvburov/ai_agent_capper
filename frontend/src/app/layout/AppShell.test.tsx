import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { ToastProvider } from '../../components';
import { baseApi } from '../../test/factories';
import { ME_MEMBER, mockFetch } from '../../test/fetchMock';
import { createTestQueryClient } from '../../test/renderPage';
import { lazyPage } from '../lazyPage';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AppShell } from './AppShell';

// Переход на экран, файл которого еще грузится: роутер держит прежний экран (startTransition),
// и без оболочки нажатие выглядело бы потерянным — адрес новый, а экран, заголовок и меню старые.

function renderShell() {
  let finish!: (component: ComponentType) => void;
  const SlowPage = lazyPage(() => new Promise<ComponentType>((resolve) => (finish = resolve)));
  const routes: RouteObject[] = [
    {
      path: '/',
      element: <AppShell />,
      children: [
        { index: true, element: <p>Экран главной</p>, handle: { title: 'dashboard', nav: 'dashboard' } },
        { path: 'new', element: <SlowPage />, handle: { title: 'new', nav: 'new' } },
      ],
    },
  ];
  mockFetch(baseApi(ME_MEMBER));
  const client = createTestQueryClient();
  client.setQueryData(meQueryKey, ME_MEMBER);
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { router, finish: (component: ComponentType) => finish(component) };
}

const sidebar = () => screen.getByRole('complementary', { name: 'Основная навигация' });

describe('AppShell: долгий переход на экран, который грузится', () => {
  it('через 300 мс — заголовок и меню нового экрана, индикатор вместо прежнего; потом экран', async () => {
    const { router, finish } = renderShell();
    expect(await screen.findByText('Экран главной')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Главная' })).toBeInTheDocument();

    act(() => {
      void router.navigate('/new');
    });
    // сразу ничего не мигает: быстрые переходы выглядят как раньше
    expect(screen.getByText('Экран главной')).toBeVisible();
    expect(screen.queryByRole('status', { name: 'Загружаем экран' })).toBeNull();

    expect(await screen.findByRole('status', { name: 'Загружаем экран' }, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Новый анализ' })).toBeInTheDocument();
    expect(within(sidebar()).getByRole('link', { name: 'Новый анализ' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Экран главной')).not.toBeVisible();
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');

    act(() => finish(() => <p>Экран нового анализа</p>));
    expect(await screen.findByText('Экран нового анализа')).toBeVisible();
    expect(screen.queryByRole('status', { name: 'Загружаем экран' })).toBeNull();
    expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy');
    expect(screen.queryByText('Экран главной')).toBeNull();
  });

  it('экран загрузился быстрее 300 мс — индикатора нет; обратно на загруженный — тоже', async () => {
    const { router, finish } = renderShell();
    await screen.findByText('Экран главной');
    act(() => {
      void router.navigate('/new');
    });
    act(() => finish(() => <p>Экран нового анализа</p>));
    expect(await screen.findByText('Экран нового анализа')).toBeVisible();
    await act(() => router.navigate('/'));
    await act(() => router.navigate('/new'));
    expect(screen.getByText('Экран нового анализа')).toBeVisible();
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(screen.queryByRole('status', { name: 'Загружаем экран' })).toBeNull();
    expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy');
  });
});
