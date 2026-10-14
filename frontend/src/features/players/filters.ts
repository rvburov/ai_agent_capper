import type { DataFilter, EloSurface, RankingQuery, RankingSort } from './types';

/*
 * Фильтры списка «Игроки» живут в адресе (/players?q=синер&data=all&surface=clay&sort=elo&page=2):
 * ссылку можно сохранить, «Назад» возвращает прежнюю выборку. Как в макете (players.js): какие
 * игроки (за 52 недели, со свежими новостями, вся база), покрытие для колонки «Эло на покрытии»,
 * сортировка и сколько страниц по 50 показано. Значения — как в API (GET /api/players/ranking):
 * что сервер не примет, из адреса не берется.
 */

export interface PlayerFilters {
  q: string;
  data: DataFilter;
  surface: EloSurface;
  sort: RankingSort;
  /** Сколько страниц по PAGE_SIZE показано («Показать еще 50»). */
  page: number;
}

/** Строк на странице — как в макете и на сервере по умолчанию. */
export const PAGE_SIZE = 50;
/** Больше страниц из адреса не берем: вся база (≈ 2 800 игроков) — около 56 страниц. */
export const PAGE_MAX = 60;
/** Поиск — до 100 знаков (как у сервера). */
export const SEARCH_MAX = 100;

export const DATA_FILTERS: readonly DataFilter[] = ['active', 'news', 'all'];
export const SURFACES: readonly EloSurface[] = ['hard', 'clay', 'grass'];
export const SORTS: readonly RankingSort[] = ['rank', 'elo', 'last'];

export const DEFAULT_FILTERS: PlayerFilters = { q: '', data: 'active', surface: 'hard', sort: 'rank', page: 1 };

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function pageOf(value: string | null): number {
  if (!value || !/^\d{1,3}$/.test(value)) return 1;
  return Math.min(PAGE_MAX, Math.max(1, Number(value)));
}

/** Фильтры из адреса. */
export function filtersFromSearch(params: URLSearchParams): PlayerFilters {
  return {
    q: (params.get('q') ?? '').slice(0, SEARCH_MAX),
    data: pick(params.get('data'), DATA_FILTERS) ?? DEFAULT_FILTERS.data,
    surface: pick(params.get('surface'), SURFACES) ?? DEFAULT_FILTERS.surface,
    sort: pick(params.get('sort'), SORTS) ?? DEFAULT_FILTERS.sort,
    page: pageOf(params.get('page')),
  };
}

const FILTER_PARAMS = ['q', 'data', 'surface', 'sort', 'page'];

/** Адрес с фильтрами: значения по умолчанию не пишутся, поиск — без лишних пробелов по краям. */
export function searchWithFilters(filters: PlayerFilters, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const name of FILTER_PARAMS) params.delete(name);
  const q = filters.q.trim();
  if (q) params.set('q', q);
  if (filters.data !== DEFAULT_FILTERS.data) params.set('data', filters.data);
  if (filters.surface !== DEFAULT_FILTERS.surface) params.set('surface', filters.surface);
  if (filters.sort !== DEFAULT_FILTERS.sort) params.set('sort', filters.sort);
  if (filters.page > 1) params.set('page', String(filters.page));
  return params;
}

/** Запрос одной страницы списка (page — с 1). */
export function rankingQuery(filters: PlayerFilters, page: number): RankingQuery {
  const query: RankingQuery = {
    data: filters.data,
    surface: filters.surface,
    sort: filters.sort,
    offset: (page - 1) * PAGE_SIZE,
    limit: PAGE_SIZE,
  };
  const q = filters.q.trim();
  if (q) query.q = q;
  return query;
}

/** Смена фильтра — снова первая страница. */
export function withFilter(filters: PlayerFilters, change: Partial<Omit<PlayerFilters, 'page'>>): PlayerFilters {
  return { ...filters, ...change, page: 1 };
}
