import { useInfiniteQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { groupActions, type AuditGroup } from './audit';
import { adminKeys } from './keys';

/** Записей на страницу журнала: «Показать еще» загружает следующие. */
export const AUDIT_PAGE = 50;

/** Журнал действий, новые сверху. Следующая страница — before_id = id последней записи. */
export function useAudit(group: AuditGroup) {
  return useInfiniteQuery({
    queryKey: [...adminKeys.audit, group],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => {
      const actions = groupActions(group);
      return unwrap(
        api.GET('/api/admin/audit', {
          params: {
            query: { limit: AUDIT_PAGE, before_id: pageParam, action: actions ? [...actions] : undefined },
          },
        }),
      );
    },
    getNextPageParam: (last) => (last.length < AUDIT_PAGE ? undefined : last[last.length - 1]?.id),
  });
}
