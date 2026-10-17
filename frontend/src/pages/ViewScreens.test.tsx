import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminUser } from '../features/admin/testData';
import { aiBudget } from '../features/ai/testData';
import { bankOut, strategyV3 } from '../features/analysis/testData';
import { betLost, betOpen, betPage, betsSummary, betWon } from '../features/bets/testData';
import { aiUsageOut, dashboardOut, openBetOut } from '../features/dashboard/testData';
import { fixClock } from '../test/clock';
import { json, ME_ADMIN, type Handler } from '../test/fetchMock';
import { renderPage } from '../test/renderPage';
import { analyticsOut } from '../features/analytics/testData';
import { AnalyticsPage } from './analytics/AnalyticsPage';
import { BetsPage } from './bets/BetsPage';
import { DashboardPage } from './dashboard/DashboardPage';
import { NewAnalysisPage } from './new/NewAnalysisPage';
import { bankTabApi, renderBankTab } from './profile/bank/testApi';

// Р27: экраны в режиме просмотра данных участника (?as=7): все запросы — с as_user, кнопки
// изменения неактивны и объясняют почему, выгрузка CSV работает, анализ за участника не запускается.

const OLGA = 7;

fixClock('2026-10-15T09:00:00Z');

const users: Handler = () =>
  json([adminUser({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin' }), adminUser({ id: OLGA })]);

/** Все запросы экрана к данным участника несут as_user=7. */
function expectAllViewed(calls: Request[], prefixes: string[]): void {
  const data = calls.filter((r) => prefixes.some((p) => new URL(r.url).pathname.startsWith(p)));
  expect(data.length).toBeGreaterThan(0);
  for (const request of data) expect(new URL(request.url).searchParams.get('as_user'), request.url).toBe(String(OLGA));
}

describe('режим просмотра: «Ставки» участника', () => {
  function api(): Record<string, Handler> {
    return {
      'GET /api/me/bank': () => json(bankOut()),
      'GET /api/bets/summary': () => json(betsSummary()),
      'GET /api/bets': (request) =>
        json(new URL(request.url).searchParams.get('status') === 'open' ? betPage([betOpen()]) : betPage([betWon(), betLost()])),
      'GET /api/bets/7': () => json(betOpen()),
      'GET /api/bets/5': () => json(betWon()),
      'GET /api/bets/5/review': () => json({ state: 'not_reviewed', reason: 'no_prediction', legs: [] }),
    };
  }

  it('запросы с as_user, «Внести результат» неактивна, «Экспорт CSV» — с as_user', async () => {
    const { calls, user } = renderPage(<BetsPage />, {
      path: '/bets',
      url: `/bets?as=${OLGA}`,
      me: ME_ADMIN,
      api: api(),
      stubs: { '/analysis/:id': 'Анализ', '/players/:id': 'Игрок' },
    });
    const open = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    const settle = within(open).getByRole('button', { name: /^Внести результат\. Только просмотр/ });
    expect(settle).toHaveAttribute('aria-disabled', 'true');
    await user.click(settle);
    expect(await screen.findByText('Только просмотр: менять данные участника может только он сам')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();

    const exportLink = screen.getByRole('link', { name: /Экспорт CSV/ });
    expect(new URL(exportLink.getAttribute('href') ?? '', 'http://x').searchParams.get('as_user')).toBe(String(OLGA));
    await waitFor(() => expectAllViewed(calls, ['/api/bets', '/api/me/bank']));
  });

  it('ссылка на открытую ставку (?bet=) — карточка ставки, а не окно результата', async () => {
    renderPage(<BetsPage />, {
      path: '/bets',
      url: `/bets?as=${OLGA}&bet=7`,
      me: ME_ADMIN,
      api: api(),
      stubs: { '/analysis/:id': 'Анализ', '/players/:id': 'Игрок' },
    });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Сохранить результат' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /^Внести результат\. Только просмотр/ })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('режим просмотра: главная участника', () => {
  it('приветствие участника, его лимит ИИ, запросы с as_user, «Новый анализ» неактивен', async () => {
    const data = dashboardOut({ open_bets: [openBetOut()], open_count: 1 });
    const { calls } = renderPage(<DashboardPage />, {
      path: '/',
      url: `/?as=${OLGA}`,
      me: ME_ADMIN,
      api: {
        'GET /api/dashboard': () => json(data),
        'GET /api/me/bank': () => json(data.bank),
        'GET /api/strategy/active': () => json(strategyV3()),
        'GET /api/ai/budget': () => json(aiBudget()),
        'GET /api/ai/usage': () => json(aiUsageOut()),
        'GET /api/admin/users': users,
      },
      stubs: { '/bets': 'Ставки', '/new': 'Новый анализ', '/analysis/:id': 'Анализ', '/players/:id': 'Игрок', '/costs': 'Расходы', '/profile/:tab?': 'Кабинет' },
    });
    expect(await screen.findByRole('heading', { level: 2, name: /, Ольга$/ })).toBeInTheDocument();
    const settle = await screen.findByRole('button', { name: /^Внести результат ставки №\d+\. Только просмотр/ });
    expect(settle).toHaveAttribute('aria-disabled', 'true');
    await waitFor(() => expectAllViewed(calls, ['/api/dashboard', '/api/me/bank', '/api/strategy', '/api/ai/']));
  });
});

describe('режим просмотра: «Новый анализ» участника', () => {
  it('только список его анализов и пояснение, формы запуска нет', async () => {
    const { calls } = renderPage(<NewAnalysisPage />, {
      path: '/new',
      url: `/new?as=${OLGA}`,
      me: ME_ADMIN,
      api: {
        'GET /api/analyses': () =>
          json({
            items: [],
            next_before: null,
          }),
        'GET /api/admin/users': users,
      },
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Анализы участника' })).toBeInTheDocument();
    expect(await screen.findByText(/^Ольга Лехтинен: последние анализы/)).toBeInTheDocument();
    expect(screen.getByText(/новый анализ запускает сам участник/)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Вставить текстом/ })).toBeNull();
    await waitFor(() => expectAllViewed(calls, ['/api/analyses']));
  });
});

describe('режим просмотра: «Банк и стратегия» участника', () => {
  it('без сводки кабинета и вкладок; формы движения банка и лимитов заменены пояснениями', async () => {
    const { calls, user } = renderBankTab(bankTabApi({ 'GET /api/admin/users': users }), {
      me: ME_ADMIN,
      url: `/profile/bank?as=${OLGA}`,
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Банк и стратегия' })).toBeInTheDocument();
    expect(await screen.findByText(/^Ольга Лехтинен: банк, правила суммы/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(await screen.findByText('Только просмотр: пополнение, вывод и корректировку записывает сам участник.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Записать' })).toBeNull();
    expect(await screen.findByText('Только просмотр: лимиты и паузу меняет сам участник.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить лимиты' })).toBeNull();
    // «Предложить изменение» правил — неактивна
    const propose = (await screen.findAllByRole('button', { name: /^Предложить изменение\. Только просмотр/ }))[0]!;
    await user.click(propose);
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expectAllViewed(calls, ['/api/me/bank', '/api/me/play-limits', '/api/me/bookmakers', '/api/strategy']),
    );
  });
});

describe('режим просмотра: «Аналитика» участника', () => {
  it('запрос с as_user; выгрузка CSV — тоже с as_user (В2)', async () => {
    const { calls, user } = renderPage(<AnalyticsPage />, {
      path: '/analytics',
      url: `/analytics?as=${OLGA}`,
      me: ME_ADMIN,
      api: { 'GET /api/analytics': () => json(analyticsOut()), 'GET /api/me/bank': () => json(bankOut()) },
      stubs: { '/bets': 'Ставки' },
    });
    await user.click(await screen.findByRole('button', { name: 'Выгрузить CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Выгрузить аналитику в CSV' });
    const href = within(dialog).getByRole('link', { name: /Скачать/ }).getAttribute('href') ?? '';
    expect(new URL(href, 'http://x').searchParams.get('as_user')).toBe(String(OLGA));
    await waitFor(() => expectAllViewed(calls, ['/api/analytics']));
  });
});
