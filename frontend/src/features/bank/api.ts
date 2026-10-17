import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { isApiError } from '../../api/errors';
import { analysisKeys } from '../analysis/keys';
import { ANALYTICS_PREFIX, DASHBOARD_PREFIX } from '../bets/keys';
import { refreshAfterCurrencyChange } from './currency';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';
import type { BankEntryIn } from './types';

// Журнал банка и движение денег (пополнение, вывод, корректировка). Банк (GET /api/me/bank) —
// useBank из features/analysis/api.ts: ключ ['bank'] общий, его префикс сбрасывает и журнал.

export const bankKeys = {
  all: analysisKeys.bank,
  entries: (flowsOnly: boolean) => [...analysisKeys.bank, 'entries', flowsOnly] as const,
};

/** Строк журнала на странице. */
export const ENTRIES_PAGE = 20;

/** Журнал банка, новые сверху; flowsOnly — только пополнения, выводы и корректировки. */
export function useBankEntries({ flowsOnly = true }: { flowsOnly?: boolean } = {}) {
  const asUser = useViewAs();
  return useInfiniteQuery({
    queryKey: viewKey(asUser, bankKeys.entries(flowsOnly)),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/me/bank/entries', {
          params: {
            query: {
              flows_only: flowsOnly,
              limit: ENTRIES_PAGE,
              ...(pageParam === null ? {} : { before: pageParam }),
              ...asUserQuery(asUser),
            },
          },
        }),
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
  });
}

/**
 * «Записать» (POST /api/me/bank/entries) с последней строкой журнала, которую видел участник:
 * двойная отправка вернет ту же запись, изменение журнала в другой вкладке — 409 bank.changed.
 * После записи банк, журнал, главная и аналитика перечитываются; запрос завершается, когда
 * банк и журнал уже перечитаны, — сообщение показывает новый банк, а не прежний.
 */
export function useAddBankEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BankEntryIn) => unwrap(api.POST('/api/me/bank/entries', { body })),
    onSuccess: async () => {
      void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
      void client.invalidateQueries({ queryKey: ANALYTICS_PREFIX });
      await client.invalidateQueries({ queryKey: bankKeys.all });
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'bank.changed') void client.invalidateQueries({ queryKey: bankKeys.all });
      refreshAfterCurrencyChange(client, error);
    },
  });
}
