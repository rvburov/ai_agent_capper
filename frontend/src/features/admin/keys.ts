import type { QueryClient } from '@tanstack/react-query';

import { accountKeys } from '../profile/keys';

// Ключи запросов кабинета администратора: по одному месту на ресурс.
export const adminKeys = {
  all: ['admin'] as const,
  users: ['admin', 'users'] as const,
  user: (id: number) => ['admin', 'users', id] as const,
  invites: ['admin', 'invites'] as const,
  resetCodes: ['admin', 'reset-codes'] as const,
  audit: ['admin', 'audit'] as const,
  // «Ключ и бюджет» (этап 3): ключ администратора, общий бюджет, лимиты участников
  aiKey: ['admin', 'ai', 'key'] as const,
  aiBudget: ['admin', 'ai', 'budget'] as const,
  aiLimits: ['admin', 'ai', 'limits'] as const,
};

/**
 * После любого действия администратора: перечитать данные раздела (участники, коды, журнал,
 * ключ, бюджет и лимиты) и сводку «Доступ к аккаунту» в личном кабинете администратора.
 */
export function invalidateAdmin(client: QueryClient): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: adminKeys.all }),
    client.invalidateQueries({ queryKey: accountKeys.adminPeople }),
    client.invalidateQueries({ queryKey: accountKeys.adminInvites }),
  ]);
}
