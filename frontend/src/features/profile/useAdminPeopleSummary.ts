import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { accountKeys } from './keys';

export interface PeopleSummary {
  /** Участники и администраторы, кроме себя и удаленных. */
  others: number;
  /** Действующие приглашения. */
  waiting: number;
}

/**
 * «Доступ к аккаунту» у администратора: сколько людей в программе и сколько приглашений ждут.
 * Данные кабинета администратора: хук вызывается только в карточке администратора.
 */
export function useAdminPeopleSummary(meId: number) {
  const users = useQuery({
    queryKey: accountKeys.adminPeople,
    queryFn: () => unwrap(api.GET('/api/admin/users')),
  });
  const invites = useQuery({
    queryKey: accountKeys.adminInvites,
    queryFn: () =>
      unwrap(api.GET('/api/admin/invites', { params: { query: { status: 'active' } } })),
  });
  const data: PeopleSummary | undefined = users.data
    ? {
        others: users.data.filter((u) => u.id !== meId && u.status !== 'deleted').length,
        waiting: invites.data?.length ?? 0,
      }
    : undefined;
  return { data, isError: users.isError };
}
