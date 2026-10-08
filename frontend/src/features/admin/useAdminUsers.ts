import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { adminKeys, invalidateAdmin } from './keys';
import type { Role } from './types';

/** Участники (GET /api/admin/users): без удаленных, расход на ИИ за месяц и лимит. */
export function useAdminUsers() {
  return useQuery({
    queryKey: adminKeys.users,
    queryFn: () => unwrap(api.GET('/api/admin/users')),
  });
}

/** Карточка участника: число сеансов и последние 20 входов. null — окно закрыто. */
export function useAdminUser(id: number | null) {
  return useQuery({
    queryKey: adminKeys.user(id ?? 0),
    queryFn: () =>
      unwrap(api.GET('/api/admin/users/{user_id}', { params: { path: { user_id: id ?? 0 } } })),
    enabled: id !== null,
  });
}

// Любое действие меняет и список, и журнал: после ответа перечитываем весь раздел
function useAdminMutation<V, R>(fn: (vars: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => invalidateAdmin(client),
  });
}

const path = (id: number) => ({ params: { path: { user_id: id } } });

// Код 2FA нужен, только если цель — администратор; для участника тело пустое
const actionBody = (totpCode?: string) => (totpCode ? { body: { totp_code: totpCode } } : {});

/** Блокировка. Администратора — с текущим кодом 2FA (опасное действие). */
export function useBlockUser() {
  return useAdminMutation((vars: { id: number; totpCode?: string }) =>
    unwrap(api.POST('/api/admin/users/{user_id}/block', { ...path(vars.id), ...actionBody(vars.totpCode) })),
  );
}

export function useUnblockUser() {
  return useAdminMutation((id: number) =>
    unwrap(api.POST('/api/admin/users/{user_id}/unblock', path(id))),
  );
}

/** Завершить все сеансы. Сеансы администратора — с текущим кодом 2FA. */
export function useRevokeSessions() {
  return useAdminMutation((vars: { id: number; totpCode?: string }) =>
    unwrap(
      api.POST('/api/admin/users/{user_id}/sessions/revoke', {
        ...path(vars.id),
        ...actionBody(vars.totpCode),
      }),
    ),
  );
}

/** Смена роли — опасное действие: нужен текущий код 2FA администратора. */
export function useChangeRole() {
  return useAdminMutation((vars: { id: number; role: Role; totpCode: string }) =>
    unwrap(
      api.POST('/api/admin/users/{user_id}/role', {
        ...path(vars.id),
        body: { role: vars.role, totp_code: vars.totpCode },
      }),
    ),
  );
}

/** Сброс 2FA участника (код 2FA администратора). Администратору — только в терминале. */
export function useResetTwoFactor() {
  return useAdminMutation((vars: { id: number; totpCode: string }) =>
    unwrap(
      api.POST('/api/admin/users/{user_id}/2fa-reset', {
        ...path(vars.id),
        body: { totp_code: vars.totpCode },
      }),
    ),
  );
}

/** Удаление по Р15: email участника для подтверждения и код 2FA. */
export function useDeleteUser() {
  return useAdminMutation((vars: { id: number; confirmEmail: string; totpCode: string }) =>
    unwrap(
      api.DELETE('/api/admin/users/{user_id}', {
        ...path(vars.id),
        body: { confirm_email: vars.confirmEmail, totp_code: vars.totpCode },
      }),
    ),
  );
}
