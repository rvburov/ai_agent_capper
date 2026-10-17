import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';
import { analyticsKeys } from './keys';
import type { AnalyticsQuery } from './types';

/**
 * Все блоки «Аналитики» одним ответом (GET /api/analytics): сервер считает числа и кэширует
 * ответ до изменения ставок и банка. При смене фильтров прежние блоки остаются на экране
 * (приглушенными), пока не придет новый ответ.
 */
export function useAnalytics(query: AnalyticsQuery) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, analyticsKeys.one(query)),
    queryFn: () => unwrap(api.GET('/api/analytics', { params: { query: { ...query, ...asUserQuery(asUser) } } })),
    placeholderData: keepPreviousData,
  });
}

/**
 * Те же фильтры за все время — для пустого состояния с периодом: были ли такие ставки вообще
 * (sample.bets) и когда последняя (sample.last_day). «Показать за все время» предлагается, только
 * если там что-то есть (как canWiden макета); ключ — тот же, что у «Аналитики» за все время, и
 * после нажатия ответ уже в кэше.
 */
export function useAnalyticsEver(query: AnalyticsQuery, enabled: boolean) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, analyticsKeys.one(query)),
    queryFn: () => unwrap(api.GET('/api/analytics', { params: { query: { ...query, ...asUserQuery(asUser) } } })),
    enabled,
  });
}
