import { useMutation } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';

export type LoginIn = components['schemas']['LoginIn'];
export type LoginOut = components['schemas']['LoginOut'];

/** Шаг 1 входа: email и пароль → ok, totp_required или totp_setup_required. */
export function useLogin() {
  return useMutation({
    mutationFn: (body: LoginIn) => unwrap(api.POST('/api/auth/login', { body })),
  });
}
