import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
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
  return useQuery({
    queryKey: dashboardKeys.period(period),
    queryFn: () => unwrap(api.GET('/api/dashboard', { params: { query: { period } } })),
    placeholderData: keepPreviousData,
    refetchOnMount: 'always',
  });
}

/**
 * Свой расход на ИИ за текущий месяц (GET /api/ai/usage): прогноз на месяц, доля кэша и самая
 * дорогая задача в «Расходах ИИ» участника. Администратору на главной не нужен (enabled).
 */
export function useAiUsage(enabled: boolean) {
  return useQuery({
    queryKey: aiUsageKey(null),
    queryFn: () => unwrap(api.GET('/api/ai/usage')),
    staleTime: 30_000,
    enabled,
  });
}
