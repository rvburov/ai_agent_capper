import type { QueryClient } from '@tanstack/react-query';

import { isApiError } from '../../api/errors';
import { analysisKeys } from '../analysis/keys';
import { publicSettingsKey } from '../profile/keys';

// Ключ лимитов ответственной игры (GET /api/me/play-limits) — здесь, а не в playLimits.ts:
// сброс после смены валюты нужен формам ставки и анализа, а им ни к чему код лимитов
export const playKeys = {
  limits: ['play-limits'] as const,
};

/**
 * Валюта программы сменилась, пока форма была открыта (409 common.currency_changed): суммы на
 * экране — в прежней валюте. Перечитываем валюту, банк, лимиты и анализы — форма покажет
 * новые суммы, и человек повторит действие уже в новой валюте.
 */
export function refreshAfterCurrencyChange(client: QueryClient, error: unknown): void {
  if (!isApiError(error) || error.code !== 'common.currency_changed') return;
  for (const queryKey of [publicSettingsKey, analysisKeys.bank, analysisKeys.all, playKeys.limits]) {
    void client.invalidateQueries({ queryKey });
  }
}
