import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';

export type PlayerHit = components['schemas']['PlayerHitOut'];

export const playerKeys = {
  search: (q: string) => ['players', 'search', q] as const,
};

const MIN_CHARS = 2;
const DELAY_MS = 250;

/** Значение с задержкой: запрос подсказок уходит, когда участник перестал печатать. */
export function useDebounced<T>(value: T, delay = DELAY_MS): T {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return shown;
}

/**
 * Подсказки игроков (GET /api/players?q=): кириллица и латиница, до 10 игроков. Пустой и
 * короткий запрос не уходит. fresh — подсказки именно к тому, что сейчас в поле (пока
 * запрос ждет паузы в наборе или идет, видны прошлые): только по ним можно подставлять
 * игрока самим.
 */
export function usePlayerSearch(query: string) {
  const typed = query.trim().slice(0, 200);
  const q = useDebounced(typed);
  const enabled = q.length >= MIN_CHARS;
  const result = useQuery({
    queryKey: playerKeys.search(q),
    queryFn: ({ signal }) => unwrap(api.GET('/api/players', { params: { query: { q, limit: 8 } }, signal })),
    enabled,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  const short = typed.length < MIN_CHARS;
  const settled = q === typed && !result.isFetching && !result.isPlaceholderData;
  return {
    hits: enabled && !short ? (result.data ?? []) : [],
    loading: enabled && !short && (result.isFetching || q !== typed),
    fresh: short || (enabled && settled && result.isSuccess),
  };
}
