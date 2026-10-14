import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { ATTENTION_PERIOD } from '../../features/admin/useAdminAttention';
import { DEFAULT_PERIOD } from '../../features/dashboard/display';
import { adminAttention, dashboardOut } from '../../features/dashboard/testData';
import { json, mockFetch } from '../../test/fetchMock';
import { createTestQueryClient } from '../../test/renderPage';
import { ThemeProvider } from '../theme/ThemeProvider';
import { Sidebar } from './Sidebar';

function renderSidebar(isAdmin: boolean, attention = adminAttention()) {
  const { calls } = mockFetch({ 'GET /api/dashboard': () => json(dashboardOut({ admin: isAdmin ? attention : null })) });
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
  it('дела берутся из ответа главной за ее период по умолчанию — на главной второго запроса нет', () => {
    expect(ATTENTION_PERIOD).toBe(DEFAULT_PERIOD);
  });

  it('у пункта «Администрирование» — число дел с сервера (просьбы ключа и участники у лимита)', async () => {
    const { sidebar } = renderSidebar(true);
    const link = within(sidebar).getByRole('link', { name: /Администрирование/ });
    await waitFor(() => expect(link.querySelector('.nav-badge')).toHaveTextContent('2'));
    expect(link).toHaveAccessibleName(/^Администрирование\s?\(нужно решение: 2\)$/);
  });

  it('дел нет — счетчика нет', async () => {
    const { sidebar, calls } = renderSidebar(true, adminAttention({ return_requests: [], limits: [] }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const link = within(sidebar).getByRole('link', { name: 'Администрирование' });
    expect(link.querySelector('.nav-badge')).toBeNull();
  });

  it('участнику — ни пункта, ни запроса главной ради дел', () => {
    const { sidebar, calls } = renderSidebar(false);
    expect(within(sidebar).queryByRole('link', { name: /Администрирование/ })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
