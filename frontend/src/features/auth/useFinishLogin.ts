import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { Me } from '../../api/hooks/useMe';
import { meQueryKey } from '../../api/keys';

/**
 * Вход завершен: данные прежнего сеанса (другого пользователя) из кэша убираем,
 * пользователя из ответа кладем в кэш — оболочка не спрашивает /api/me еще раз.
 */
export function useFinishLogin(): (user: Me) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (user: Me) => {
      queryClient.clear();
      queryClient.setQueryData(meQueryKey, user);
    },
    [queryClient],
  );
}
