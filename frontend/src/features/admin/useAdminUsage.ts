import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { ActivityPeriod } from '../costs/types';
import { adminKeys } from './keys';

/*
 * «Администрирование → Обзор» и «Расход ИИ» (этап 4, Р14): расход на Claude по людям и задачам
 * за текущий месяц (UTC) и активность — входы и число анализов. Ставок, банка и анализов
 * участников в ответах нет. Под ['admin']: действия администратора перечитывают и их.
 */

/** Расход ключа администратора за месяц: по людям, задачам, общие задачи и проверки (eval). */
export function useAdminAiUsage(enabled = true) {
  return useQuery({
    queryKey: adminKeys.aiUsage,
    queryFn: ({ signal }) => unwrap(api.GET('/api/admin/ai/usage', { signal })),
    enabled,
    staleTime: 30_000,
  });
}

/** Входы и анализы по людям за период (по умолчанию 30 дней; журнал входов хранится 90 дней). */
export function useAdminActivity(period: ActivityPeriod = '30d', enabled = true) {
  return useQuery({
    queryKey: adminKeys.activity(period),
    queryFn: ({ signal }) => unwrap(api.GET('/api/admin/activity', { params: { query: { period } }, signal })),
    enabled,
    staleTime: 30_000,
  });
}
