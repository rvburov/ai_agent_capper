import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { accountKeys } from './keys';

export interface PasswordChange {
  current: string;
  next: string;
}

/** Смена пароля: сервер завершает остальные сеансы и выдает этому новый токен (cookie). */
export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ current, next }: PasswordChange) =>
      unwrap(
        api.POST('/api/me/password', { body: { current_password: current, new_password: next } }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
}
