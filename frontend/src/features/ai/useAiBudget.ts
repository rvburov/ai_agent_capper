import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';
import { aiKeys } from './keys';

// Расход меняется анализами, которые идут без этой страницы (участник ушел с экрана анализа),
// поэтому лимит перечитывается при каждом открытии и, пока страница видна, по таймеру: чаще,
// пока на ключе администратора идет анализ (занят резерв)
const POLL_MS = 60_000;
const RUNNING_POLL_MS = 15_000;

/**
 * Режим ключа, лимит и расход за месяц, анализы сегодня, потолок анализа, свой ключ и причина,
 * по которой анализ сейчас не запустится (GET /api/ai/budget). Администратору — еще общий бюджет.
 */
export function useAiBudget() {
  // Р27: на экранах режима просмотра — лимит участника (без его ключа)
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, aiKeys.budget),
    queryFn: () => unwrap(api.GET('/api/ai/budget', { params: { query: asUserQuery(asUser) } })),
    staleTime: 30_000,
    refetchOnMount: 'always',
    refetchInterval: (query) => ((query.state.data?.reserved_usd ?? 0) > 0 ? RUNNING_POLL_MS : POLL_MS),
    refetchIntervalInBackground: false,
  });
}
