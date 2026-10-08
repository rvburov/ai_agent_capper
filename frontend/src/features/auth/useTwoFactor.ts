import { useMutation, useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';

export type TwoFactorIn = components['schemas']['TwoFactorIn'];
export type TotpSetupOut = components['schemas']['TotpSetupOut'];
export type TotpSetupDoneOut = components['schemas']['TotpSetupDoneOut'];

/** Шаг 2 входа: код из приложения или резервный код. */
export function useTwoFactor() {
  return useMutation({
    mutationFn: (body: TwoFactorIn) => unwrap(api.POST('/api/auth/2fa', { body })),
  });
}

/**
 * Секрет и QR-код для настройки 2FA. Сервер в пределах незавершенного входа отдает тот же
 * секрет, поэтому повторный запрос безопасен; кэш не нужен — после экрана секрет не хранится.
 */
export function useTotpSetup() {
  return useQuery({
    queryKey: ['auth', 'totpSetup'],
    queryFn: () => unwrap(api.POST('/api/auth/2fa/setup')),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Код из приложения включает 2FA, завершает вход и дает 8 резервных кодов (один раз). */
export function useConfirmTotpSetup() {
  return useMutation({
    mutationFn: (code: string) =>
      unwrap(api.POST('/api/auth/2fa/setup/confirm', { body: { code } })),
  });
}
