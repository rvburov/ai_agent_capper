import { keepPreviousData, useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';
import { rankingQuery, type PlayerFilters } from './filters';
import type { PlayerRanking, PlayerRow, RankingQuery } from './types';

export type PlayerHit = components['schemas']['PlayerHitOut'];

// Ключи запросов игроков — под общим префиксом ['players']: список, карточка, матчи, новости,
// личные встречи и подсказки формы ввода. Игроки и матчи общие для всех участников; личное —
// только «сегодня» в карточке и метка today в строке (свои ставки и анализы).
export const playerKeys = {
  all: ['players'] as const,
  search: (q: string) => ['players', 'search', q] as const,
  ranking: (query: RankingQuery) => ['players', 'ranking', query] as const,
  card: (id: number) => ['players', 'card', id] as const,
  matches: (id: number) => ['players', 'matches', id] as const,
  news: (id: number) => ['players', 'news', id] as const,
  h2h: (id: number, opponent: number) => ['players', 'h2h', id, opponent] as const,
};

const MIN_CHARS = 2;
const DELAY_MS = 250;
/** Матчей и новостей на странице карточки. */
export const CARD_PAGE = 20;

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

export interface RankingState {
  /** Первая страница: итоги, счетчики, архив (null — еще не пришла). */
  head: PlayerRanking | null;
  /** Строки загруженных страниц подряд, без дыр. */
  rows: PlayerRow[];
  /** Сколько страниц загружено подряд. */
  loadedPages: number;
  /** Первая страница грузится впервые. */
  loading: boolean;
  /** Фильтры сменились, на экране прежний список: он приглушен. */
  pending: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * Список «Игроки» (GET /api/players/ranking) страницами по 50 с сервера: показано
 * filters.page страниц, каждая — свой запрос со своим ключом кэша (offset). Так номер страницы
 * живет в адресе, «Назад» и ссылка открывают то же, а «Показать еще 50» дочитывает одну страницу.
 * При смене фильтров прежний список виден, пока не придет новый.
 */
export function usePlayerRanking(filters: PlayerFilters): RankingState {
  const pages = Array.from({ length: filters.page }, (_, i) => i + 1);
  const results = useQueries({
    queries: pages.map((page) => {
      const query = rankingQuery(filters, page);
      return {
        queryKey: playerKeys.ranking(query),
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          unwrap(api.GET('/api/players/ranking', { params: { query }, signal })),
        staleTime: 60_000,
        placeholderData: page === 1 ? keepPreviousData : undefined,
      };
    }),
  });
  const first = results[0];
  const rows: PlayerRow[] = [];
  let loadedPages = 0;
  for (const result of results) {
    if (!result.data || (result !== first && result.isPlaceholderData)) break;
    rows.push(...result.data.items);
    loadedPages += 1;
  }
  const error = results.find((r) => r.isError)?.error ?? null;
  return {
    head: first?.data ?? null,
    rows,
    loadedPages,
    loading: first?.isPending ?? true,
    pending: first?.isPlaceholderData ?? false,
    error,
    refetch: () => {
      for (const result of results) if (result.isError) void result.refetch();
    },
  };
}

/**
 * Карточка игрока (GET /api/players/{id}): общее и «сегодня» из своих ставок и анализов.
 * Перечитывается при каждом открытии: новая ставка или анализ меняют «сегодня».
 */
export function usePlayerCard(id: number | null) {
  return useQuery({
    queryKey: playerKeys.card(id ?? 0),
    queryFn: ({ signal }) => unwrap(api.GET('/api/players/{player_id}', { params: { path: { player_id: id ?? 0 } }, signal })),
    enabled: id !== null,
    refetchOnMount: 'always',
  });
}

/** Матчи игрока страницами, сначала последние (курсор before — id матча). */
export function usePlayerMatches(id: number, enabled = true) {
  return useInfiniteQuery({
    queryKey: playerKeys.matches(id),
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/api/players/{player_id}/matches', {
          params: { path: { player_id: id }, query: pageParam === null ? { limit: CARD_PAGE } : { limit: CARD_PAGE, before: pageParam } },
          signal,
        }),
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.next_before,
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Новости игрока за 14 дней страницами, новые сверху. */
export function usePlayerNews(id: number, enabled = true) {
  return useInfiniteQuery({
    queryKey: playerKeys.news(id),
    queryFn: ({ pageParam, signal }) =>
      unwrap(
        api.GET('/api/players/{player_id}/news', {
          params: { path: { player_id: id }, query: pageParam === null ? { limit: CARD_PAGE } : { limit: CARD_PAGE, before: pageParam } },
          signal,
        }),
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.next_before,
    enabled,
  });
}

/** Личные встречи игрока и соперника (GET /api/players/{id}/h2h/{opponent}). */
export function usePlayerH2H(id: number, opponent: number, enabled: boolean) {
  return useQuery({
    queryKey: playerKeys.h2h(id, opponent),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/api/players/{player_id}/h2h/{opponent_id}', {
          params: { path: { player_id: id, opponent_id: opponent } },
          signal,
        }),
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}
