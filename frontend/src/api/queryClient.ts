import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { watchProgramCurrency } from '../features/bank/currency';
import { setDisplayTimeZone } from '../lib/format';
import { ApiError, isUnauthorized } from './errors';
import { meQueryKey } from './keys';
import type { components } from './schema';

/**
 * Ответ значит, что профиль надо перечитать: 401 — сеанс закончился (RequireAuth уведет на
 * вход), 403 account.deletion_pending — аккаунт ждет удаления (RequireAuth покажет экран отмены).
 */
function needsMe(error: unknown): boolean {
  return isUnauthorized(error) || (error instanceof ApiError && error.code === 'account.deletion_pending');
}

/**
 * Клиент TanStack Query. Ошибки 4xx не повторяем (повтор ничего не изменит), прочие — до двух раз.
 * Ответ 401 на любой запрос значит, что сеанс закончился: перепроверяем /api/me,
 * и RequireAuth уводит на страницу входа.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (needsMe(error) && query.queryKey[0] !== meQueryKey[0]) {
          void client.invalidateQueries({ queryKey: meQueryKey });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (needsMe(error)) void client.invalidateQueries({ queryKey: meQueryKey });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
  // Даты показываются в поясе пользователя (users.tz). Пояс берем из данных /api/me в кэше,
  // а не из запроса: так он ставится и после queryClient.setQueryData(meQueryKey, user)
  // при входе. Событие приходит до того, как экраны получат новые данные.
  // Выход (кэш очищен) — снова пояс браузера.
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== meQueryKey[0]) return;
    if (event.type === 'removed') {
      setDisplayTimeZone(undefined);
    } else if (event.type === 'updated' && event.action.type === 'success') {
      const me = event.query.state.data as components['schemas']['MeOut'] | undefined;
      setDisplayTimeZone(me?.tz);
    }
  });
  watchProgramCurrency(client);
  return client;
}
