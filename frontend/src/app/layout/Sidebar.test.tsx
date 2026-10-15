import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { adminAttention } from '../../features/dashboard/testData';
import { json, mockFetch } from '../../test/fetchMock';
import { createTestQueryClient } from '../../test/renderPage';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Sidebar } from './Sidebar';

function renderSidebar(isAdmin: boolean, attention = adminAttention()) {
  const { calls } = mockFetch({ 'GET /api/admin/attention': () => json(attention) });
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ThemeProvider>
        <MemoryRouter>
          <Sidebar navId="dashboard" isAdmin={isAdmin} onLogout={() => undefined} />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { calls, sidebar: screen.getByRole('complementary', { name: 'Основная навигация' }) };
}

describe('Боковое меню: счетчик дел администратора', () => {
  it('у пункта «Администрирование» — число дел с сервера (GET /api/admin/attention, не вся главная)', async () => {
    const { sidebar, calls } = renderSidebar(true);
    const link = within(sidebar).getByRole('link', { name: /Администрирование/ });
    await waitFor(() => expect(link.querySelector('.nav-badge')).toHaveTextContent('2'));
    expect(link).toHaveAccessibleName(/^Администрирование\s?\(нужно решение: 2\)$/);
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(['/api/admin/attention']);
  });

  it('дел нет — счетчика нет', async () => {
    const { sidebar, calls } = renderSidebar(true, adminAttention({ return_requests: [], limits: [] }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const link = within(sidebar).getByRole('link', { name: 'Администрирование' });
    expect(link.querySelector('.nav-badge')).toBeNull();
  });

  it('участнику — ни пункта, ни запроса дел', () => {
    const { sidebar, calls } = renderSidebar(false);
    expect(within(sidebar).queryByRole('link', { name: /Администрирование/ })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
