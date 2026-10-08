import { useMutation } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';

export type RegisterIn = components['schemas']['RegisterIn'];

/** Регистрация по коду приглашения; следующий шаг — настройка 2FA. */
export function useRegister() {
  return useMutation({
    mutationFn: (body: RegisterIn) => unwrap(api.POST('/api/auth/register', { body })),
  });
}
