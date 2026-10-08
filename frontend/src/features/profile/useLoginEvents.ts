import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { accountKeys } from './keys';

// Сколько последних попыток входа показывать: за 90 дней их обычно меньше
export const LOGIN_EVENTS_LIMIT = 100;

/** Журнал входов за 90 дней, новые сверху (GET /api/me/login-events). */
export function useLoginEvents() {
  return useQuery({
    queryKey: accountKeys.loginEvents,
    queryFn: () =>
      unwrap(api.GET('/api/me/login-events', { params: { query: { limit: LOGIN_EVENTS_LIMIT } } })),
  });
}
