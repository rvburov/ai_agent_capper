import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { accountKeys } from './keys';

// Неиспользованных кодов меньше этого — «осталось мало» (как в макете)
export const RECOVERY_CODES_LOW = 4;

/** Сколько резервных кодов осталось (сами коды сервер не хранит и не показывает). */
export function useRecoveryCodesStatus() {
  return useQuery({
    queryKey: accountKeys.recoveryCodes,
    queryFn: () => unwrap(api.GET('/api/me/recovery-codes')),
  });
}

/** Перевыпуск 8 резервных кодов по текущему коду 2FA; прежние перестают действовать. */
export function useReissueRecoveryCodes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (code: string) =>
      (await unwrap(api.POST('/api/me/recovery-codes', { body: { code } }))).recovery_codes,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountKeys.recoveryCodes }),
  });
}
