import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bankOut } from '../../features/analysis/testData';
import { analyticsOut, slicesOut } from '../../features/analytics/testData';
import { marketsOut } from '../../features/markets/testData';
import { fixClock } from '../../test/clock';
import { json } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { AnalyticsPage } from './AnalyticsPage';

// «Аналитика» (Р28): блок «Рынки: в экспрессе, на проверке, для сравнения», фильтр семейства,
// новые рынки в «Сводке по рынкам» строкой семейства с пометкой «для сравнения»

fixClock('2026-10-15T09:00:00Z');

function card(title: string): HTMLElement {
  return screen.getByRole('heading', { level: 3, name: title }).closest('section')!;
}

function render(url = '/analytics', width?: number) {
  const slices = slicesOut();
  slices.families = [
    ...slices.families,
    { family: 'gtot', n: 12, wins: 7, winrate: 0.583, roi: 0.064, roi_ci: null, avg_odds: 1.88, small: true },
  ];
  return renderPage(<AnalyticsPage />, {
    path: '/analytics',
    url,
    api: {
      'GET /api/analytics': () => json(analyticsOut({ slices })),
      'GET /api/me/bank': () => json(bankOut()),
      'GET /api/markets': () => json(marketsOut()),
    },
    ...(width ? { width } : {}),
  });
}

describe('Аналитика: рынки (Р28)', () => {
  it('блок рынков: статусы, «47 из 150», ROI и CLV с ДИ, сколько с закрытием', async () => {
    render();
    await screen.findByRole('heading', { level: 3, name: 'Рынки: в экспрессе, на проверке, для сравнения' });
    const block = card('Рынки: в экспрессе, на проверке, для сравнения');
    const rows = await within(block).findAllByRole('row');
    const ghcp = rows.find((r) => r.textContent?.includes('Фора по геймам'))!;
    expect(within(ghcp).getByText('для сравнения')).toBeInTheDocument();
    expect(within(ghcp).getByText('47 из 150 событий')).toBeInTheDocument();
    expect(within(ghcp).getByText('с закрытием: 18 из 50')).toBeInTheDocument();
    expect(within(ghcp).getByRole('meter')).toHaveAttribute('aria-valuenow', '47');
    const ml = rows.find((r) => r.textContent?.includes('Победа в матче'))!;
    expect(within(ml).getByText('в экспрессе')).toBeInTheDocument();
    expect(within(ml).getByText('с закрытием: 300')).toBeInTheDocument();
    // У тотала геймов событий 160, но модель не прошла проверку: порог не пройден, метка с причиной
    const gtot = rows.find((r) => r.textContent?.includes('Тотал геймов'))!;
    expect(within(gtot).queryByText('порог пройден')).toBeNull();
    expect(within(gtot).getByText('модель не прошла проверку').closest('[title]')).toHaveAttribute('title', expect.stringMatching(/^Модель этого рынка на проверке по архиву/));
    expect(within(ghcp).queryByText('модель не прошла проверку')).toBeNull();
  });

  it('«Сводка по рынкам»: семейство новых рынков — строкой «для сравнения», нажатие ставит фильтр family', async () => {
    const { user, router, calls } = render();
    await screen.findByRole('heading', { level: 3, name: 'Сводка по рынкам' });
    const table = card('Сводка по рынкам');
    const rowOf = () => within(table).getAllByRole('row').find((r) => r.textContent?.includes('Тотал геймов'))!;
    await waitFor(() => expect(within(rowOf()).getByText('для сравнения')).toBeInTheDocument());
    const row = rowOf();
    await user.click(row);
    await waitFor(() => expect(router.state.location.search).toBe('?family=gtot'));
    await waitFor(() => expect(calls.some((r) => r.url.includes('/api/analytics') && new URL(r.url).searchParams.get('family') === 'gtot')).toBe(true));
    expect(screen.getByRole('button', { name: 'Рынок: Тотал геймов — все линии' })).toBeInTheDocument();
  });

  it('на телефоне — карточки рынков', async () => {
    render('/analytics', 375);
    await screen.findByRole('heading', { level: 3, name: 'Рынки: в экспрессе, на проверке, для сравнения' });
    const block = card('Рынки: в экспрессе, на проверке, для сравнения');
    expect(await within(block).findAllByRole('listitem')).toHaveLength(6);
    // Почему модель не прошла проверку — текстом, а не только в title (на телефоне его не видно)
    const gtot = within(block).getAllByRole('listitem').find((li) => li.textContent?.includes('Тотал геймов'))!;
    expect(within(gtot).getByText(/^Модель этого рынка на проверке по архиву/)).toBeVisible();
  });
});
