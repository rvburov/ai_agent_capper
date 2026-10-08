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

// Попытки, среди которых ищется подозрительный вход: успешные и непройденная 2FA. Неверные
// пароли и отказы 429 сюда не попадают: тот, кто знает только email, не вытеснит ими из выборки
// след входа с верным паролем (в общем журнале их может быть сколько угодно)
export const SUSPICIOUS_RESULTS = ['ok', 'bad_totp', 'bad_recovery'] as const;
const SUSPICIOUS_LIMIT = 200;

/** Входы для предупреждения «кто-то ввел верный пароль, но не прошел 2FA». */
export function useSuspiciousCandidates() {
  return useQuery({
    queryKey: [...accountKeys.loginEvents, 'suspicious'],
    queryFn: () =>
      unwrap(
        api.GET('/api/me/login-events', {
          params: { query: { limit: SUSPICIOUS_LIMIT, result: [...SUSPICIOUS_RESULTS] } },
        }),
      ),
  });
}
