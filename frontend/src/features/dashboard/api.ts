import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';
import { aiUsageKey, dashboardKeys } from './keys';
import type { DashboardPeriod } from './types';

/**
 * Главная одним ответом (GET /api/dashboard): банк, показатели периода с изменением к прошлому,
 * ряд банка и последние ставки, открытые ставки, мои матчи сегодня, дела администратора. При
 * смене периода прежние числа остаются на экране, пока не придут новые. При каждом открытии
 * главной ответ перечитывается (прежний виден, пока идет запрос): «Мои матчи сегодня» и дела
 * администратора меняются и без ставок — новым анализом, просьбой ключа, загрузкой архива, — а
 * такие события кэш главной не сбрасывают.
 */
export function useDashboard(period: DashboardPeriod) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, dashboardKeys.period(period)),
    queryFn: () => unwrap(api.GET('/api/dashboard', { params: { query: { period, ...asUserQuery(asUser) } } })),
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
  });
}

/**
 * Главная участника для карточки участника в «Администрировании» (Р27): тот же GET /api/dashboard
 * с as_user и тот же ключ кэша, что у режима просмотра. Свой id — без as_user (свои данные).
 */
export function useMemberDashboard(userId: number, period: DashboardPeriod, own: boolean) {
  const asUser = own ? null : userId;
  return useQuery({
    queryKey: viewKey(asUser, dashboardKeys.period(period)),
    queryFn: () => unwrap(api.GET('/api/dashboard', { params: { query: { period, ...asUserQuery(asUser) } } })),
  });
}

/**
 * Свой расход на ИИ за текущий месяц (GET /api/ai/usage): прогноз на месяц, доля кэша и самая
 * дорогая задача в «Расходах ИИ» участника. Администратору на главной не нужен (enabled).
 */
export function useAiUsage(enabled: boolean) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, aiUsageKey(null)),
    queryFn: () => unwrap(api.GET('/api/ai/usage', { params: { query: asUserQuery(asUser) } })),
    staleTime: 30_000,
    enabled,
  });
}
