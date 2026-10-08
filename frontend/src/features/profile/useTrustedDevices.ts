import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { accountKeys } from './keys';

/** Доверенные устройства: там вход не спрашивает код 2FA до expires_at. */
export function useTrustedDevices() {
  return useQuery({
    queryKey: accountKeys.trustedDevices,
    queryFn: () => unwrap(api.GET('/api/me/trusted-devices')),
  });
}

/** Забыть устройство: на нем снова спросят код 2FA. */
export function useForgetDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      unwrap(
        api.DELETE('/api/me/trusted-devices/{device_id}', { params: { path: { device_id: id } } }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: accountKeys.trustedDevices }),
  });
}
