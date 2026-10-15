import { QueryClientProvider } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { json, mockFetch } from '../../test/fetchMock';
import { adminKeys } from '../admin/keys';
import { aiKeys } from '../ai/keys';
import { staleQueriesFor, uniqueQueryKeys } from './notifications';
import { useNotifications } from './useNotifications';

const note = (id: number, kind: string) => ({
  id,
  kind,
  title: `Уведомление ${id}`,
  body: '',
  link: null,
  created_at: '2026-10-12T09:00:00Z',
  read_at: null,
});

describe('уведомления и данные открытых экранов', () => {
  it('вид уведомления — какие данные устарели', () => {
    // дела администратора (счетчик у пункта меню, «Обзор») — GET /api/admin/attention
    expect(staleQueriesFor('ai_mode_request')).toEqual([adminKeys.users, adminKeys.aiLimits, adminKeys.attention]);
    expect(staleQueriesFor('limit_100')).toEqual(expect.arrayContaining([adminKeys.attention]));
    expect(staleQueriesFor('data_stale')).toEqual([adminKeys.attention]);
    expect(staleQueriesFor('ai_mode_decision')).toEqual(expect.arrayContaining([aiKeys.all, meQueryKey]));
    expect(staleQueriesFor('limit_80')).toEqual(expect.arrayContaining([aiKeys.all, adminKeys.aiLimits]));
    expect(staleQueriesFor('budget_100')).toEqual(expect.arrayContaining([adminKeys.aiBudget]));
    expect(staleQueriesFor('ai_key_failed')).toEqual(expect.arrayContaining([aiKeys.all, adminKeys.aiKey]));
    expect(staleQueriesFor('new_device')).toEqual([]);
  });

  it('пришло новое уведомление — его данные перечитываются; при первой загрузке и без новых — нет', async () => {
    let items = [note(5, 'new_device')];
    mockFetch({ 'GET /api/me/notifications': () => json({ items, unread: items.length }) });
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useNotifications(), { wrapper });
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    expect(invalidate).not.toHaveBeenCalled();

    // участник попросил вернуть ключ администратора: опрос принес уведомление
    items = [note(6, 'ai_mode_request'), ...items];
    await act(() => result.current.refetch());
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: adminKeys.users }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: adminKeys.aiLimits });

    // тот же список еще раз — ничего нового
    invalidate.mockClear();
    await act(() => result.current.refetch());
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ключи без повторов: одинаковые схлопываются, ключ под префиксом — лишний', () => {
    expect(uniqueQueryKeys([['bets'], ['dashboard'], ['bets'], ['bets', 'counts'], ['dashboard', '30d'], ['learning']])).toEqual([
      ['bets'],
      ['dashboard'],
      ['learning'],
    ]);
    // префикс пришел позже — уточненный ключ убирается
    expect(uniqueQueryKeys([['bets', 'counts'], ['bets', { status: 'open' }], ['bets']])).toEqual([['bets']]);
    expect(uniqueQueryKeys([['bets', 'counts'], ['bets', 'list']])).toEqual([['bets', 'counts'], ['bets', 'list']]);
    expect(uniqueQueryKeys([])).toEqual([]);
  });

  it('пачка из 3 «рассчитана автоматически» — один сброс и один запрос на ключ', async () => {
    let items = [note(1, 'new_device')];
    mockFetch({ 'GET /api/me/notifications': () => json({ items, unread: items.length }) });
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const dashboard = vi.fn(() => Promise.resolve({ ok: true }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    // открытая главная — активный запрос под префиксом ['dashboard']
    const { result } = renderHook(
      () => {
        useQuery({ queryKey: ['dashboard', '30d'], queryFn: dashboard });
        return useNotifications();
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.items).toHaveLength(1));
    await waitFor(() => expect(dashboard).toHaveBeenCalledTimes(1));

    items = [note(4, 'bet_settled'), note(3, 'bet_settled'), note(2, 'bet_settled'), ...items];
    await act(() => result.current.refetch());
    await waitFor(() => expect(dashboard).toHaveBeenCalledTimes(2));
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys).toHaveLength(staleQueriesFor('bet_settled').length);
    // повторного перезапуска нет
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dashboard).toHaveBeenCalledTimes(2);
  });
});
