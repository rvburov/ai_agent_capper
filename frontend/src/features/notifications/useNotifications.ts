import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { notificationsQueryKey } from '../../api/keys';
import { markAllRead, markOneRead, type NotificationsOut } from './notifications';

const LIMIT = 50;
const POLL_MS = 60_000;

/**
 * Уведомления пользователя (GET /api/me/notifications). Опрос раз в минуту, пока вкладка
 * видима: TanStack Query не опрашивает скрытую вкладку и сразу обновляет данные при возврате.
 */
export function useNotifications() {
  return useQuery({
    queryKey: notificationsQueryKey,
    queryFn: () => unwrap(api.GET('/api/me/notifications', { params: { query: { limit: LIMIT } } })),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
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
