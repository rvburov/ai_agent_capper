import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { publicSettingsKey } from './keys';

/** Настройки программы, видные всем вошедшим: валюта (Р17). */
export function usePublicSettings() {
  return useQuery({
    queryKey: publicSettingsKey,
    queryFn: () => unwrap(api.GET('/api/settings')),
    staleTime: 5 * 60_000,
  });
}
