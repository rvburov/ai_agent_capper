import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { publicSettingsKey } from './keys';

/** Запрос настроек программы, видных всем вошедшим: валюта (Р17). */
export const publicSettingsQuery = {
  queryKey: publicSettingsKey,
  queryFn: () => unwrap(api.GET('/api/settings')),
  staleTime: 5 * 60_000,
};

export function usePublicSettings() {
  return useQuery(publicSettingsQuery);
}
