import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { Button, ToastProvider } from '../../components';
import { adminUser } from '../../features/admin/testData';
import { useBank } from '../../features/analysis/api';
import { bankOut } from '../../features/analysis/testData';
import { baseApi, type Me } from '../../test/factories';
import { json, ME_ADMIN, ME_MEMBER, mockFetch } from '../../test/fetchMock';
import { createTestQueryClient } from '../../test/renderPage';
import { ThemeProvider } from '../theme/ThemeProvider';
import { AppShell } from './AppShell';

// Р27: режим просмотра данных участника в оболочке — выбор «Чьи данные смотреть», плашка,
// запросы с as_user, отдельный кэш, «Вернуться к своим», выход на экране без режима.

const OLGA = 7;

/** Экран-проба: банк из того же хука, что у главной и плашки «Банк» в шапке. */
function Probe({ name }: { name: string }) {
  const bank = useBank();
  return (
    <>
      <p>
        {name}: {bank.data?.balance ?? '…'}
      </p>
      <Button ro onClick={() => undefined}>
        Внести результат
      </Button>
    </>
  );
}

function renderShell(me: Me, url: string) {
  const routes: RouteObject[] = [
    {
      path: '/',
      element: <AppShell />,
      children: [
        { index: true, element: <Probe name="Главная" />, handle: { title: 'dashboard', nav: 'dashboard' } },
        { path: 'bets', element: <Probe name="Ставки" />, handle: { title: 'bets', nav: 'bets' } },
        { path: 'players', element: <p>Игроки</p>, handle: { title: 'players', nav: 'players' } },
      ],
    },
  ];
  const { calls } = mockFetch({
    ...baseApi(me),
    'GET /api/me/bank': (request) => {
      const amount = new URL(request.url).searchParams.get('as_user') === String(OLGA) ? '555.00' : '1000.00';
      return json(bankOut({ balance: amount, equity: amount }));
    },
    'GET /api/admin/users': () =>
      json([
        adminUser({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin' }),
        adminUser({ id: OLGA }),
        adminUser({ id: 8, display_name: 'Дмитрий Шульц', email: 'd@example.com', status: 'blocked' }),
      ]),
    'GET /api/bets/counts': () => json({ open: 0, awaiting_result: 0 }),
  });
  const client: QueryClient = createTestQueryClient();
  client.setQueryData(meQueryKey, me);
  const router = createMemoryRouter(routes, { initialEntries: [url] });
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  const where = () => router.state.location.pathname + router.state.location.search;
  const asUserCalls = () => calls.filter((r) => new URL(r.url).searchParams.has('as_user'));
  return { router, client, calls, where, asUserCalls, user: userEvent.setup() };
}

const banner = () => screen.queryByRole('region', { name: 'Режим просмотра данных участника' });

describe('режим просмотра данных участника (Р27)', () => {
  it('администратор выбирает участника: адрес ?as=, запросы с as_user, плашка, кнопки изменения неактивны', async () => {
    const { where, user, calls, client } = renderShell(ME_ADMIN, '/');
    expect(await screen.findByText('Главная: 1000.00')).toBeInTheDocument();
    expect(banner()).toBeNull();

    await user.click(screen.getByRole('button', { name: /^Чьи данные смотреть: Мои данные/ }));
    const list = await screen.findByRole('listbox');
    expect(within(list).getByRole('option', { name: 'Дмитрий Шульц · заблокирован' })).toBeInTheDocument();
    await user.click(within(list).getByRole('option', { name: 'Ольга Лехтинен' }));

    await waitFor(() => expect(where()).toBe(`/?as=${OLGA}`));
    expect(await screen.findByText('Главная: 555.00')).toBeInTheDocument();
    expect(within(banner()!).getByText('Ольга Лехтинен', { selector: 'b' })).toBeInTheDocument();
    expect(within(banner()!).getByText(/только просмотр/)).toBeInTheDocument();
    // запрос банка участника — с as_user; свой — без него
    const bankCalls = calls.filter((r) => new URL(r.url).pathname === '/api/me/bank');
    expect(bankCalls.some((r) => new URL(r.url).searchParams.get('as_user') === String(OLGA))).toBe(true);
    expect(bankCalls.some((r) => !new URL(r.url).searchParams.has('as_user'))).toBe(true);
    // в шапке — банк участника с глазом, кнопки «Новый анализ» нет
    expect(await screen.findByTitle('Банк участника · только просмотр')).toHaveTextContent('555');
    const topbar = document.querySelector<HTMLElement>('.topbar')!;
    expect(within(topbar).queryByRole('link', { name: 'Новый анализ' })).toBeNull();
    // кэш: свои данные и данные участника — разные записи
    expect(client.getQueryData(['bank'])).toMatchObject({ balance: '1000.00' });
    expect(client.getQueryData(['view', OLGA, 'bank'])).toMatchObject({ balance: '555.00' });

    // кнопка изменения неактивна: нажатие объясняет почему
    const settle = screen.getByRole('button', { name: /^Внести результат\. Только просмотр/ });
    expect(settle).toHaveAttribute('aria-disabled', 'true');
    await user.click(settle);
    expect(await screen.findByText('Только просмотр: менять данные участника может только он сам')).toBeInTheDocument();
  });

  it('переход по ссылке без ?as= между экранами режима сохраняет режим; «Вернуться к своим» — свои данные', async () => {
    const { router, where, user, client } = renderShell(ME_ADMIN, `/?as=${OLGA}`);
    expect(await screen.findByText('Главная: 555.00')).toBeInTheDocument();

    await router.navigate('/bets');
    await waitFor(() => expect(where()).toBe(`/bets?as=${OLGA}`));
    expect(await screen.findByText('Ставки: 555.00')).toBeInTheDocument();

    await user.click(within(banner()!).getByRole('button', { name: 'Вернуться к своим' }));
    await waitFor(() => expect(where()).toBe('/bets'));
    expect(await screen.findByText('Ставки: 1000.00')).toBeInTheDocument();
    expect(banner()).toBeNull();
    expect(await screen.findByText('Вы снова смотрите свои данные')).toBeInTheDocument();
    // чужие данные из кэша убраны
    await waitFor(() => expect(client.getQueryCache().findAll({ queryKey: ['view'] })).toHaveLength(0));
  });

  it('экран без режима просмотра (игроки) возвращает к своим данным', async () => {
    const { router, where } = renderShell(ME_ADMIN, `/bets?as=${OLGA}`);
    expect(await screen.findByText('Ставки: 555.00')).toBeInTheDocument();
    await router.navigate('/players');
    expect(await screen.findByText('Игроки', { selector: 'p' })).toBeInTheDocument();
    expect(where()).toBe('/players');
    expect(banner()).toBeNull();
    expect(await screen.findByText('Вы снова смотрите свои данные')).toBeInTheDocument();
    // назад на ставки без ?as= — свои
    await router.navigate('/bets');
    expect(await screen.findByText('Ставки: 1000.00')).toBeInTheDocument();
    expect(where()).toBe('/bets');
  });

  it('свой id в ?as= — свои данные без плашки', async () => {
    const { where, asUserCalls } = renderShell(ME_ADMIN, `/?as=${ME_ADMIN.id}`);
    expect(await screen.findByText('Главная: 1000.00')).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe('/'));
    expect(banner()).toBeNull();
    expect(asUserCalls()).toHaveLength(0);
  });

  it('участник: выбора нет, ?as= чужого — понятная ошибка без запросов чужих данных', async () => {
    const { asUserCalls } = renderShell(ME_MEMBER, `/bets?as=${OLGA}`);
    expect(await screen.findByRole('heading', { name: 'Чужие данные недоступны' })).toBeInTheDocument();
    expect(screen.getByText(/может смотреть только администратор/)).toBeInTheDocument();
    expect(screen.queryByText(/^Ставки:/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Чьи данные смотреть/ })).toBeNull();
    expect(banner()).toBeNull();
    expect(asUserCalls()).toHaveLength(0);
  });

  it('участник на своих экранах выбора «Чьи данные смотреть» не видит', async () => {
    renderShell(ME_MEMBER, '/');
    expect(await screen.findByText('Главная: 1000.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Чьи данные смотреть/ })).toBeNull();
    // кнопка изменения в своих данных работает как обычно
    expect(screen.getByRole('button', { name: 'Внести результат' })).not.toHaveAttribute('aria-disabled');
  });
});
