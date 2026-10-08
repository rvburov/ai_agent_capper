import { useMutation } from '@tanstack/react-query';

import { api, unwrap } from '../client';
import { isUnauthorized } from '../errors';

/**
 * Выход: POST /api/auth/logout. Сеанс уже истек (401) — тоже успешный выход.
 * Переход на страницу входа и очистку кэша делает вызывающий (оболочка).
 */
export function useLogout() {
  return useMutation({
    mutationFn: async () => {
      try {
        await unwrap(api.POST('/api/auth/logout'));
      } catch (error) {
        if (!isUnauthorized(error)) throw error;
      }
    },
  });
}
