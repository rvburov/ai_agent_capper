import { useMutation } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';

export type ResetIn = components['schemas']['ResetIn'];

/** Новый пароль по коду сброса от администратора. Все сеансы пользователя завершаются. */
export function useReset() {
  return useMutation({
    mutationFn: (body: ResetIn) => unwrap(api.POST('/api/auth/reset', { body })),
  });
}
