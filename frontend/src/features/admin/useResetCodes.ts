import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { adminKeys, invalidateAdmin } from './keys';

/** Действующие коды сброса пароля. Использованные и отозванные — в журнале. */
export function useActiveResetCodes() {
  return useQuery({
    queryKey: adminKeys.resetCodes,
    queryFn: () =>
      unwrap(api.GET('/api/admin/reset-codes', { params: { query: { status: 'active' } } })),
  });
}

/** Код RST-XXXX-XXXX на 24 часа: приходит один раз, прежний код участника отзывается. */
export function useCreateResetCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: number) =>
      unwrap(api.POST('/api/admin/reset-codes', { body: { user_id: userId } })),
    onSuccess: () => invalidateAdmin(client),
  });
}

export function useRevokeResetCode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      unwrap(api.DELETE('/api/admin/reset-codes/{code_id}', { params: { path: { code_id: id } } })),
    onSuccess: () => invalidateAdmin(client),
  });
}
