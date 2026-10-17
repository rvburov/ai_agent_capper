import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';
import { adminKeys } from './keys';

/*
 * «Администрирование → Сводка» (Р27, PANELS.summary макета): итоги по всем участникам вместе с
 * администратором и строка на каждого. Числа считает сервер (GET /api/admin/summary) теми же
 * функциями, что «Главная» участника; открытие сводки сервер пишет в журнал.
 */

export type AdminSummary = components['schemas']['AdminSummaryOut'];
export type SummaryMember = components['schemas']['SummaryMemberOut'];
export type SummaryPeriod = AdminSummary['period'];

export const SUMMARY_PERIODS = ['7d', '30d', '90d', 'all'] as const satisfies readonly SummaryPeriod[];

export function useAdminSummary(period: SummaryPeriod) {
  return useQuery({
    queryKey: adminKeys.summary(period),
    queryFn: () => unwrap(api.GET('/api/admin/summary', { params: { query: { period } } })),
    placeholderData: keepPreviousData,
  });
}

/** Строку можно открыть: у человека есть банк или ставки (у пустого смотреть нечего). */
export function canOpen(row: Pick<SummaryMember, 'empty' | 'bets'>): boolean {
  return !row.empty || row.bets > 0;
}

/** Brier модели против рынка: «модель точнее», «рынок точнее» или «наравне» (до тысячных). */
export function brierVerdict(model: number | null, market: number | null): 'model' | 'market' | 'even' | null {
  if (model === null || market === null) return null;
  const diff = Math.round((model - market) * 1000);
  if (diff === 0) return 'even';
  return diff < 0 ? 'model' : 'market';
}
