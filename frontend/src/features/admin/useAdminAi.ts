import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { invalidateAiBudget } from '../ai/keys';
import { adminKeys, invalidateAdmin } from './keys';
import type { AlertPct, LimitPatch, LimitRequest } from './types';

/*
 * «Администрирование → Ключ и бюджет» (Р9, Р12, Р13): ключ администратора, общий бюджет на
 * месяц, лимиты участников и решения по просьбам вернуть ключ администратора. После действия —
 * весь раздел заново (invalidateAdmin) и свой лимит (/api/ai/budget: у администратора там бюджет).
 * networkMode 'always': без сети — сразу ошибка «Нет связи с сервером», а не пауза до появления
 * сети с молчаливой отправкой потом.
 */

function useAdminAiMutation<V, R>(request: (value: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    networkMode: 'always',
    onSuccess: () => Promise.all([invalidateAdmin(client), invalidateAiBudget(client)]),
  });
}

export function useAdminKey() {
  return useQuery({
    queryKey: adminKeys.aiKey,
    queryFn: () => unwrap(api.GET('/api/admin/ai/key')),
  });
}

/** Замена ключа администратора: формат, код 2FA, проверка в Anthropic (PUT /api/admin/ai/key). */
export function useReplaceAdminKey() {
  return useAdminAiMutation((body: { key: string; totpCode: string }) =>
    unwrap(api.PUT('/api/admin/ai/key', { body: { key: body.key, totp_code: body.totpCode } })),
  );
}

export function useAdminBudget() {
  return useQuery({
    queryKey: adminKeys.aiBudget,
    queryFn: () => unwrap(api.GET('/api/admin/ai/budget')),
  });
}

export function useUpdateBudget() {
  return useAdminAiMutation((body: { monthlyUsd: string; alertPct: AlertPct }) =>
    unwrap(
      api.PUT('/api/admin/ai/budget', {
        body: { monthly_usd: body.monthlyUsd, alert_pct: body.alertPct },
      }),
    ),
  );
}

/** Лимиты по умолчанию и все люди программы с расходом и лимитами (GET /api/admin/ai/limits). */
export function useAdminLimits() {
  return useQuery({
    queryKey: adminKeys.aiLimits,
    queryFn: () => unwrap(api.GET('/api/admin/ai/limits')),
  });
}

export function useUpdateMemberLimit() {
  return useAdminAiMutation(({ id, patch }: { id: number; patch: LimitPatch }) =>
    unwrap(api.PUT('/api/admin/ai/limits/{user_id}', { params: { path: { user_id: id } }, body: patch })),
  );
}

export function useUpdateDefaults() {
  return useAdminAiMutation((limit: LimitRequest) => unwrap(api.PUT('/api/admin/ai/defaults', { body: limit })));
}

/** Решение по просьбе вернуть ключ администратора: approve — с лимитом на ключе администратора. */
export function useDecideReturn() {
  return useAdminAiMutation(
    ({ id, decision, limit }: { id: number; decision: 'approve' | 'reject'; limit?: LimitRequest }) =>
      unwrap(
        api.POST('/api/admin/users/{user_id}/ai-mode', {
          params: { path: { user_id: id } },
          body: { decision, limit: limit ?? null },
        }),
      ),
  );
}
