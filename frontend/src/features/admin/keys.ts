import type { QueryClient } from '@tanstack/react-query';

import { dashboardKeys } from '../dashboard/keys';
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
  // «Обзор» и «Расход ИИ» (этап 4): расход по людям и задачам за месяц, входы и анализы
  aiUsage: ['admin', 'ai', 'usage', 'current'] as const,
  activity: (period: string) => ['admin', 'activity', period] as const,
  // Дела администратора (GET /api/admin/attention): «Обзор», точка у вкладки, пункт меню
  attention: ['admin', 'attention'] as const,
  // «Данные» (этап 5): свежесть архива и загрузки файла tennis-data
  dataUploads: ['admin', 'data', 'uploads'] as const,
  dataUpload: (id: number) => ['admin', 'data', 'uploads', id] as const,
};

/**
 * После любого действия администратора: перечитать данные раздела (участники, коды, журнал,
 * ключ, бюджет, лимиты и дела — adminKeys.attention), сводку «Доступ к аккаунту» в личном
 * кабинете администратора и главную: в ней те же дела администратора.
 */
export function invalidateAdmin(client: QueryClient): Promise<unknown> {
  return Promise.all([
    client.invalidateQueries({ queryKey: adminKeys.all }),
    client.invalidateQueries({ queryKey: dashboardKeys.all }),
    client.invalidateQueries({ queryKey: accountKeys.adminPeople }),
    client.invalidateQueries({ queryKey: accountKeys.adminInvites }),
  ]);
}
