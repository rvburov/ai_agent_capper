import { useQuery } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { useState } from 'react';
import { Link } from 'react-router';
import { describe, expect, it } from 'vitest';

import { useMe } from '../api/hooks/useMe';
import { api, unwrap } from '../api/client';
import { formatMoney } from '../lib/format';
import { useMediaQuery, SHEET_QUERY } from '../lib/useMediaQuery';
import { bankOut, dashboardApi, ME_ADMIN } from './factories';
import { json } from './fetchMock';
import { bodyOf, createTestQueryClient, renderPage } from './renderPage';

// Помощник экранов: роутер, кэш пользователя, общие ответы API, заглушки соседних экранов.

function Probe() {
  const { data: me } = useMe();
  const phone = useMediaQuery(SHEET_QUERY);
  const bank = useQuery({ queryKey: ['bank'], queryFn: () => unwrap(api.GET('/api/me/bank')) });
  return (
    <div>
      <p>{me ? `Вошел ${me.display_name}` : 'Без пользователя'}</p>
      <p>{phone ? 'Телефон' : 'Компьютер'}</p>
      {bank.data && <p>Банк {formatMoney(bank.data.equity, 'RUB')}</p>}
      <Link to="/bets">К ставкам</Link>
    </div>
  );
}

describe('renderPage', () => {
  it('участник в кэше, ответы фабрик, переход на заглушку соседнего экрана', async () => {
    const { router, calls, user } = renderPage(<Probe />, {
      path: '/',
      api: dashboardApi(),
      stubs: { '/bets': 'Экран ставок' },
    });
    expect(screen.getByText('Вошел Анна Петрова')).toBeInTheDocument();
    expect(screen.getByText('Компьютер')).toBeInTheDocument();
    expect(await screen.findByText(/^Банк 48/)).toBeInTheDocument();
    expect(calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toContain('GET /api/me/bank');
    await user.click(screen.getByRole('link', { name: 'К ставкам' }));
    expect(await screen.findByText('Экран ставок')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/bets');
  });

  it('адрес с параметрами, администратор, телефон, свой ответ поверх фабрик', async () => {
    renderPage(<Probe />, {
      path: '/profile/:tab?',
      url: '/profile/bank',
      me: ME_ADMIN,
      width: 375,
      api: { ...dashboardApi(), 'GET /api/me/bank': () => json(bankOut({ equity: '51200.00' })) },
    });
    expect(screen.getByText('Вошел Роман Буров')).toBeInTheDocument();
    expect(screen.getByText('Телефон')).toBeInTheDocument();
    expect(await screen.findByText(/^Банк 51/)).toBeInTheDocument();
  });

  it('QueryClient — настройки приложения, только без повторов: кэш 30 с, мутации без повторов', async () => {
    const options = createTestQueryClient().getDefaultOptions();
    expect(options.queries?.staleTime).toBe(30_000);
    expect(options.queries?.retry).toBe(false);
    expect(options.mutations?.retry).toBe(false);
    // второй компонент с тем же запросом берет ответ из кэша, как в приложении (staleTime)
    let fetched = 0;
    const fetchOnce = async () => ++fetched;
    function Second() {
      const query = useQuery({ queryKey: ['pair'], queryFn: fetchOnce });
      return <p>Второй {query.data}</p>;
    }
    function Pair() {
      const [second, setSecond] = useState(false);
      const query = useQuery({ queryKey: ['pair'], queryFn: fetchOnce });
      return (
        <div>
          <p>Первый {query.data}</p>
          {second ? <Second /> : <button onClick={() => setSecond(true)}>Еще</button>}
        </div>
      );
    }
    const { client, user } = renderPage(<Pair />, { path: '/' });
    expect(client.getDefaultOptions().queries?.staleTime).toBe(30_000);
    expect(await screen.findByText('Первый 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Еще' }));
    expect(await screen.findByText('Второй 1')).toBeInTheDocument();
    expect(fetched).toBe(1);
  });

  it('без api fetch не подменяется; bodyOf читает тело запроса', async () => {
    renderPage(<p>Пусто</p>, { path: '/', me: null });
    expect(screen.getByText('Пусто')).toBeInTheDocument();
    const request = new Request('http://localhost/api/x', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(await bodyOf(request)).toEqual({ a: 1 });
  });
});
