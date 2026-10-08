import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { meQueryKey } from '../../api/keys';
import type { ProfileUpdate } from './types';

/**
 * Имя и часовой пояс (PATCH /api/me). Ответ — новый профиль: он сразу кладется в кэш,
 * и клиент запросов переключает пояс показа дат (queryClient.ts).
 */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileUpdate) => unwrap(api.PATCH('/api/me', { body })),
    onSuccess: (me) => queryClient.setQueryData(meQueryKey, me),
  });
}
