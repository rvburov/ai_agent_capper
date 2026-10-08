import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { adminKeys, invalidateAdmin } from './keys';
import type { InviteRequest } from './types';

/** Все приглашения (активные, использованные, истекшие, отозванные); экран делит их на группы. */
export function useInvites() {
  return useQuery({
    queryKey: adminKeys.invites,
    queryFn: () => unwrap(api.GET('/api/admin/invites')),
  });
}

/** Новое приглашение: код CAP-XXXX-XXXX приходит один раз, в ответе на создание. */
export function useCreateInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: InviteRequest) => unwrap(api.POST('/api/admin/invites', { body })),
    onSuccess: () => invalidateAdmin(client),
  });
}

export function useRevokeInvite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      unwrap(api.DELETE('/api/admin/invites/{invite_id}', { params: { path: { invite_id: id } } })),
    onSuccess: () => invalidateAdmin(client),
  });
}
