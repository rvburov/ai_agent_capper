import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { dashboardKeys } from '../dashboard/keys';
import type { AdminAttention, DashboardPeriod } from '../dashboard/types';
import type { MemberLimit } from './types';

/*
 * Дела администратора — из ответа сервера (AdminAttentionOut в GET /api/dashboard), а не из
 * расчета в браузере: уровень 100 сервер ставит и тогда, когда до 100% расхода не хватает
 * нескольких центов, но остатка уже нет даже на самый маленький вызов оценки матча — анализы
 * участника остановлены. Те же дела и то же число — на главной, во вкладке «Обзор», у вкладки
 * и у пункта меню. Ключ запроса — главной за период по умолчанию: на главной второго запроса
 * нет; действия администратора сбрасывают его вместе с разделом (invalidateAdmin).
 */
// Период главной по умолчанию (DEFAULT_PERIOD в features/dashboard/display — равенство проверяет
// тест). Своя константа: счетчик у пункта меню — в начальной загрузке, а подписи главной — нет
export const ATTENTION_PERIOD: DashboardPeriod = '30d';

export function useAdminAttention(enabled = true) {
  return useQuery({
    queryKey: dashboardKeys.period(ATTENTION_PERIOD),
    queryFn: () => unwrap(api.GET('/api/dashboard', { params: { query: { period: ATTENTION_PERIOD } } })),
    select: (data): AdminAttention | null => data.admin ?? null,
    enabled,
  });
}

export type Decision =
  | { kind: 'return'; member: MemberLimit }
  | { kind: 'limit'; member: MemberLimit; share: number; level: '80' | '100' };

/**
 * Дела «Нужно решение»: сначала просьбы вернуть ключ, затем участники у лимита (по доле расхода,
 * сначала больше). Что считать делом, решает сервер (attention); строки лимитов участников —
 * для подробностей и окон (сколько анализов сегодня, пауза, «Поднять лимит»).
 */
export function decisionsOf(attention: AdminAttention, members: readonly MemberLimit[]): Decision[] {
  const byId = new Map(members.map((member) => [member.id, member]));
  const out: Decision[] = [];
  for (const request of attention.return_requests) {
    const member = byId.get(request.user_id);
    if (member) out.push({ kind: 'return', member });
  }
  const limits = [...attention.limits].sort((a, b) => b.share - a.share);
  for (const item of limits) {
    const member = byId.get(item.user_id);
    if (member) out.push({ kind: 'limit', member, share: item.share, level: item.level });
  }
  return out;
}

/** Уровни лимитов с сервера по участникам: 80 — порог уведомления, 100 — анализы остановлены. */
export function limitLevels(attention: AdminAttention | null | undefined): ReadonlyMap<number, '80' | '100'> {
  return new Map((attention?.limits ?? []).map((item) => [item.user_id, item.level]));
}

/** Сколько дел ждет решения — то же число, что «Администрирование: N дел» на главной. */
export function decisionsCount(attention: AdminAttention | null | undefined): number {
  return attention ? attention.return_requests.length + attention.limits.length : 0;
}
