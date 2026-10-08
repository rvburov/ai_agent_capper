import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { accountKeys } from './keys';

/** Действующие сеансы пользователя (GET /api/me/sessions); текущий помечен current. */
export function useSessions() {
  return useQuery({
    queryKey: accountKeys.sessions,
    queryFn: () => unwrap(api.GET('/api/me/sessions')),
  });
}

/** «Завершить» один свой сеанс. */
export function useEndSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      unwrap(api.DELETE('/api/me/sessions/{session_id}', { params: { path: { session_id: id } } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
}

/** «Выйти на всех других устройствах»: остается только этот сеанс. */
export function useEndOtherSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/me/sessions/revoke-others')),
    onSettled: () => queryClient.invalidateQueries({ queryKey: accountKeys.sessions }),
  });
}
