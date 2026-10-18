import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { ExtraFamily } from '../analysis/markets';
import { marketKeys } from './keys';
import { statusMap, type MarketStatusMap } from './map';
import type { Markets } from './types';

// GET /api/markets: статусы семейств рынков и общий счетчик «для сравнения» (данные общие для
// всех участников, параметра as_user нет). PUT /api/admin/markets/{family} — перевод в экспресс.


// Счетчик меняется только с расчетом ставок и решением администратора: минуты хватает
const STALE_MS = 60_000;

export function useMarkets() {
  return useQuery({
    queryKey: marketKeys.all,
    queryFn: () => unwrap(api.GET('/api/markets')),
    staleTime: STALE_MS,
  });
}

/** Статусы рынков по семействам; пока нет ответа — undefined. */
export function useMarketStatuses(): MarketStatusMap | undefined {
  const { data } = useMarkets();
  return data ? statusMap(data) : undefined;
}

/** «Перевести в экспресс» или вернуть «для сравнения» (только администратор). */
export function useSetMarketExpress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ family, express }: { family: ExtraFamily; express: boolean }) =>
      unwrap(api.PUT('/api/admin/markets/{family}', { params: { path: { family } }, body: { express } })),
    onSuccess: (data: Markets) => {
      client.setQueryData(marketKeys.all, data);
      // правила стратегии и анализы читают статусы рынков заново
      void client.invalidateQueries({ queryKey: ['strategy'] });
    },
  });
}
