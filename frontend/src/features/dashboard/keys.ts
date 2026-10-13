import { aiKeys } from '../ai/keys';
import { DASHBOARD_PREFIX } from '../bets/keys';
import type { DashboardPeriod } from './types';

// Ключи запросов главной — под общим префиксом ['dashboard']: новая ставка, расчет, сторно,
// закрытие и движение банка сбрасывают его целиком (features/bets/api.ts, features/bank/api.ts).
export const dashboardKeys = {
  all: DASHBOARD_PREFIX,
  period: (period: DashboardPeriod) => [...DASHBOARD_PREFIX, period] as const,
};

/**
 * Свой расход на ИИ за месяц (GET /api/ai/usage) — под ['ai'], как лимит: конец анализа,
 * уведомления о расходе и смена ключа перечитывают его вместе с GET /api/ai/budget
 * (invalidateAiBudget). month null — текущий месяц; экран «ИИ и расходы» берет тот же ключ.
 */
export const aiUsageKey = (month: string | null) => [...aiKeys.all, 'usage', month ?? 'current'] as const;
