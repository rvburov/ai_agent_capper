import { ANALYTICS_PREFIX } from '../bets/keys';
import type { AnalyticsQuery } from './types';

// Ключи запросов «Аналитики» — под общим префиксом ['analytics']: расчет, сторно, закрытие
// ставки и движение банка сбрасывают его целиком (features/bets/api.ts, features/bank/api.ts).
export const analyticsKeys = {
  all: ANALYTICS_PREFIX,
  one: (query: AnalyticsQuery) => [...ANALYTICS_PREFIX, query] as const,
};
