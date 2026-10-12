import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { api, unwrap } from '../../api/client';
import { notificationsQueryKey } from '../../api/keys';
import { markAllRead, markOneRead, staleQueriesFor, type NotificationsOut } from './notifications';

const LIMIT = 50;
const POLL_MS = 60_000;

/**
 * Уведомления пользователя (GET /api/me/notifications). Опрос раз в минуту, пока вкладка
 * видима: TanStack Query не опрашивает скрытую вкладку и сразу обновляет данные при возврате.
 * Пришло новое уведомление (опрос или открытие колокольчика) — данные, о которых оно, на
 * открытых экранах перечитываются: просьба вернуть ключ видна в «Участниках», решение по ней —
 * во вкладке «Ключ Claude», не дожидаясь перезагрузки.
 */
export function useNotifications() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: notificationsQueryKey,
    queryFn: () => unwrap(api.GET('/api/me/notifications', { params: { query: { limit: LIMIT } } })),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
  // Самое новое уже виденное уведомление; null — список еще не приходил (экраны и так свежие)
  const newest = useRef<number | null>(null);
  const items = query.data?.items;

  useEffect(() => {
    if (!items) return;
    const seen = newest.current;
    newest.current = items.reduce((max, item) => Math.max(max, item.id), seen ?? 0);
    if (seen === null) return;
    const keys = items.filter((item) => item.id > seen).flatMap((item) => staleQueriesFor(item.kind));
    for (const queryKey of keys) void client.invalidateQueries({ queryKey });
  }, [items, client]);

  return query;
}

/** Отметка прочитанного: сразу в кэше, при ошибке — откат. */
function useOptimisticRead<V>(
  request: (value: V) => Promise<unknown>,
  update: (data: NotificationsOut | undefined, value: V, at: string) => NotificationsOut | undefined,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onMutate: async (value: V) => {
      await queryClient.cancelQueries({ queryKey: notificationsQueryKey });
      const previous = queryClient.getQueryData<NotificationsOut>(notificationsQueryKey);
      queryClient.setQueryData<NotificationsOut>(notificationsQueryKey, (data) =>
        update(data, value, new Date().toISOString()),
      );
      return { previous };
    },
    onError: (_error, _value, context) => {
      if (context?.previous) queryClient.setQueryData(notificationsQueryKey, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationsQueryKey }),
  });
}

export function useMarkNotificationRead() {
  return useOptimisticRead(
    (id: number) =>
      unwrap(
        api.POST('/api/me/notifications/{notification_id}/read', {
          params: { path: { notification_id: id } },
        }),
      ),
    markOneRead,
  );
}

export function useMarkAllNotificationsRead() {
  return useOptimisticRead(
    () => unwrap(api.POST('/api/me/notifications/read-all')),
    (data, _value: undefined, at) => markAllRead(data, at),
  );
}
