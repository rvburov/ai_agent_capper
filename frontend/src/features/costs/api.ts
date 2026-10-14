import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { aiKeys } from '../ai/keys';
import type { RunFilter } from './types';

// «ИИ и расходы»: свой расход за месяц — useAiUsage (features/dashboard/api.ts, тот же ключ
// кэша, что у главной), журнал вызовов — здесь. Оба под ['ai']: конец анализа, уведомления о
// расходе и смена ключа перечитывают их вместе с лимитом (invalidateAiBudget).

/** Вызовов на странице журнала. */
export const RUNS_PAGE = 20;

/** Журнал вызовов текущего месяца: kind null — все виды. */
export const aiRunsKey = (kind: RunFilter | null) => [...aiKeys.all, 'runs', 'current', kind ?? 'all'] as const;

/**
 * Журнал вызовов Claude (GET /api/ai/runs) страницами, новые сверху: строка — вызов с шагом и
 * effort, разбором цены (price) и ссылкой на свой анализ. При смене фильтра прежний журнал виден,
 * пока не придет новый.
 */
export function useAiRuns(kind: RunFilter | null, enabled = true) {
  return useInfiniteQuery({
    queryKey: aiRunsKey(kind),
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/api/ai/runs', {
          params: {
            query: {
              limit: RUNS_PAGE,
              ...(kind ? { kind } : {}),
              ...(pageParam !== null ? { before: pageParam } : {}),
            },
          },
          signal,
        }),
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.next_before,
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 30_000,
  });
}
