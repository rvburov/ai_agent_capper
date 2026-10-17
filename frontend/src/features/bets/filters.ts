import type { BetFiltersQuery, Market, Period, SourceFilter, StatusFilter, SurfaceFilter } from './types';

/*
 * Фильтры «Ставок» живут в адресе (/bets?period=30d&status=won&surface=clay&q=синнер): ссылку
 * можно сохранить и открыть заново, «Назад» возвращает прежнюю выборку. Значения — как в API
 * (GET /api/bets): что сервер не примет, из адреса просто не берется.
 */

export interface BetFilters {
  period: Period;
  /** Свой диапазон дат (по поясу участника, включительно): если задан, period не действует. */
  from: string | null;
  to: string | null;
  status: StatusFilter | null;
  market: Market | null;
  surfaces: SurfaceFilter[];
  source: SourceFilter | null;
  q: string;
}

export const PERIODS: readonly Period[] = ['7d', '30d', '90d', 'all'];
// «Рассчитанные» (settled) — выигрыш, проигрыш и возврат вместе: так ссылка «Все N ставок за
// период» с главной открывает ровно те ставки, что посчитаны в показателях периода
export const STATUSES: readonly StatusFilter[] = ['open', 'settled', 'won', 'lost', 'void'];
export const MARKETS: readonly Market[] = ['ML', 'HCP_-1.5', 'HCP_+1.5'];
export const SURFACES: readonly SurfaceFilter[] = ['hard', 'clay', 'grass', 'carpet', 'unknown'];
export const SOURCES: readonly SourceFilter[] = ['app', 'legacy'];

/** Поиск — до 100 знаков (как у сервера). */
export const SEARCH_MAX = 100;
// Даты фильтра сервер принимает только в этих пределах
const DATE_MIN = '2000-01-01';
const DATE_MAX = '2100-12-31';

export const EMPTY_FILTERS: BetFilters = {
  period: 'all',
  from: null,
  to: null,
  status: null,
  market: null,
  surfaces: [],
  source: null,
  q: '',
};

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function validDay(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < DATE_MIN || value > DATE_MAX) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** Фильтры из адреса. */
export function filtersFromSearch(params: URLSearchParams): BetFilters {
  let from = validDay(params.get('from'));
  let to = validDay(params.get('to'));
  if (from && to && from > to) [from, to] = [to, from];
  const surfaces = SURFACES.filter((s) => params.getAll('surface').includes(s));
  return {
    period: pick(params.get('period'), PERIODS) ?? 'all',
    from,
    to,
    status: pick(params.get('status'), STATUSES),
    market: pick(params.get('market'), MARKETS),
    surfaces,
    source: pick(params.get('source'), SOURCES),
    q: (params.get('q') ?? '').slice(0, SEARCH_MAX),
  };
}

const FILTER_PARAMS = ['period', 'from', 'to', 'status', 'market', 'surface', 'source', 'q'];

/** Адрес с фильтрами: прочие параметры (bet) остаются; значения по умолчанию не пишутся. */
export function searchWithFilters(filters: BetFilters, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const name of FILTER_PARAMS) params.delete(name);
  if (filters.period !== 'all') params.set('period', filters.period);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.status) params.set('status', filters.status);
  if (filters.market) params.set('market', filters.market);
  for (const surface of SURFACES) if (filters.surfaces.includes(surface)) params.append('surface', surface);
  if (filters.source) params.set('source', filters.source);
  const q = filters.q.trim();
  if (q) params.set('q', q);
  return params;
}

/** Фильтры для API: порядок покрытий постоянный, пустое не передается (ключ кэша один). */
export function filtersQuery(filters: BetFilters): BetFiltersQuery {
  const query: BetFiltersQuery = {};
  if (filters.from || filters.to) {
    if (filters.from) query.from = filters.from;
    if (filters.to) query.to = filters.to;
  } else if (filters.period !== 'all') {
    query.period = filters.period;
  }
  if (filters.status) query.status = filters.status;
  if (filters.market) query.market = filters.market;
  const surfaces = SURFACES.filter((s) => filters.surfaces.includes(s));
  if (surfaces.length) query.surface = surfaces;
  if (filters.source) query.source = filters.source;
  const q = filters.q.trim().slice(0, SEARCH_MAX);
  if (q) query.q = q;
  return query;
}

/** Сколько фильтров выбрано в шторке (статус, рынок, источник, покрытия) — число на кнопке «Фильтры». */
export function sheetActiveCount(filters: BetFilters): number {
  return (filters.status ? 1 : 0) + (filters.market ? 1 : 0) + (filters.source ? 1 : 0) + filters.surfaces.length;
}

/** Выбран хоть один фильтр (вместе с периодом, датами и поиском). */
export function anyActive(filters: BetFilters): boolean {
  return (
    sheetActiveCount(filters) > 0 ||
    filters.period !== 'all' ||
    filters.from !== null ||
    filters.to !== null ||
    filters.q.trim() !== ''
  );
}

/** Строка CSV по тем же фильтрам (GET /api/bets/export.csv). */
export function exportHref(filters: BetFilters, asUser: number | null = null): string {
  const params = new URLSearchParams();
  // Р27: администратор выгружает ставки участника, чьи данные смотрит (выгрузка — в журнал)
  if (asUser !== null) params.set('as_user', String(asUser));
  for (const [name, value] of Object.entries(filtersQuery(filters))) {
    if (Array.isArray(value)) for (const item of value) params.append(name, String(item));
    else if (value !== undefined && value !== null) params.set(name, String(value));
  }
  const query = params.toString();
  return `/api/bets/export.csv${query ? `?${query}` : ''}`;
}
