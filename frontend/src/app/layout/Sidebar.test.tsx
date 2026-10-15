import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { adminAttention } from '../../features/dashboard/testData';
import { json, mockFetch } from '../../test/fetchMock';
import { createTestQueryClient } from '../../test/renderPage';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';
import { openBetsText } from './useOpenBets';

function api(attention = adminAttention(), open = 0) {
  return mockFetch({
    'GET /api/admin/attention': () => json(attention),
    'GET /api/bets/counts': () => json({ open, awaiting_result: 0 }),
  });
}

function wrap(children: ReactNode) {
  return (
    <QueryClientProvider client={createTestQueryClient()}>
      <ThemeProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function renderSidebar(isAdmin: boolean, attention = adminAttention(), open = 0) {
  const { calls } = api(attention, open);
  render(wrap(<Sidebar navId="dashboard" isAdmin={isAdmin} onLogout={() => undefined} />));
  const paths = () => calls.map((request) => new URL(request.url).pathname);
  return { paths, sidebar: screen.getByRole('complementary', { name: 'Основная навигация' }) };
}

describe('Боковое меню: счетчик дел администратора', () => {
  it('у пункта «Администрирование» — число дел с сервера (GET /api/admin/attention, не вся главная)', async () => {
    const { sidebar, paths } = renderSidebar(true);
    const link = within(sidebar).getByRole('link', { name: /Администрирование/ });
    await waitFor(() => expect(link.querySelector('.nav-badge')).toHaveTextContent('2'));
    expect(link).toHaveAccessibleName(/^Администрирование\s?\(нужно решение: 2\)$/);
    expect(paths().filter((path) => path !== '/api/bets/counts')).toEqual(['/api/admin/attention']);
    expect(paths()).not.toContain('/api/dashboard');
  });

  it('дел нет — счетчика нет', async () => {
    const { sidebar, paths } = renderSidebar(true, adminAttention({ return_requests: [], limits: [] }));
    await waitFor(() => expect(paths()).toContain('/api/admin/attention'));
    const link = within(sidebar).getByRole('link', { name: 'Администрирование' });
    expect(link.querySelector('.nav-badge')).toBeNull();
  });

  it('участнику — ни пункта, ни запроса дел', async () => {
    const { sidebar, paths } = renderSidebar(false);
    await waitFor(() => expect(paths()).toEqual(['/api/bets/counts']));
    expect(within(sidebar).queryByRole('link', { name: /Администрирование/ })).toBeNull();
  });
});

describe('Счетчик открытых ставок у «Ставок» (этап 5)', () => {
  it('боковое меню: число ставок в игре с сервера, читалке — «Открытых ставок: N»', async () => {
    const { sidebar, paths } = renderSidebar(false, adminAttention(), 3);
    const link = within(sidebar).getByRole('link', { name: /^Ставки/ });
    await waitFor(() => expect(link.querySelector('.nav-badge')).toHaveTextContent('3'));
    expect(link).toHaveAccessibleName(/^Ставки\s?Открытых ставок: 3$/);
    // легкий запрос счетчиков, а не итоги ставок
    expect(paths()).toEqual(['/api/bets/counts']);
  });

  it('ставок в игре нет — счетчика нет', async () => {
    const { sidebar, paths } = renderSidebar(false, adminAttention(), 0);
    await waitFor(() => expect(paths()).toEqual(['/api/bets/counts']));
    const link = within(sidebar).getByRole('link', { name: 'Ставки' });
    expect(link.querySelector('.nav-badge')).toBeNull();
  });

  it('нижнее меню телефона: кружок над иконкой «Ставок», больше 99 — «99+»', async () => {
    api(adminAttention(), 120);
    render(wrap(<TabBar navId="dashboard" moreOpen={false} onMore={() => undefined} />));
    const nav = screen.getByRole('navigation', { name: 'Нижняя навигация' });
    const link = within(nav).getByRole('link', { name: /^Ставки/ });
    await waitFor(() => expect(link.querySelector('.tab-badge')).toHaveTextContent('99+'));
    expect(link).toHaveAccessibleName(/Открытых ставок: 120$/);
    // у других вкладок счетчика нет
    expect(nav.querySelectorAll('.tab-badge')).toHaveLength(1);
  });

  it('текст счетчика', () => {
    expect(openBetsText(1)).toBe('1');
    expect(openBetsText(99)).toBe('99');
    expect(openBetsText(100)).toBe('99+');
  });
});
