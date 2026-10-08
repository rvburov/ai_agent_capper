import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../client';
import { meQueryKey } from '../keys';
import type { components } from '../schema';

export type Me = components['schemas']['MeOut'];

/**
 * Вошедший пользователь (GET /api/me). Ошибка 401 — сеанса нет: RequireAuth ведет на /login.
 * Роль из ответа решает, видна ли группа «Управление». Пояс показа дат из users.tz ставит
 * клиент запросов (queryClient.ts) — и после загрузки, и после setQueryData при входе.
 */
export function useMe() {
  return useQuery({
    queryKey: meQueryKey,
    queryFn: () => unwrap(api.GET('/api/me')),
    staleTime: 60_000,
  });
}
