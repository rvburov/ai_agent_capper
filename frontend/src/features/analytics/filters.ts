import { FAMILIES, type MarketFamily } from '../analysis/markets';
import type { AnalyticsQuery, ExportPart, KindFilter, Market, Period, SourceFilter, SurfaceFilter } from './types';

/*
 * Фильтры «Аналитики» живут в адресе (/analytics?period=30d&market=ML&selection=1&surface=clay):
 * ссылку можно сохранить, «Назад» возвращает прежнюю выборку. Как в макете (analytics.js):
 * период — 30 дней, 3 месяца или все время; рынок — один из шести исходов (П1, Ф2(+1.5)…);
 * покрытие и источник — по одному. Значения — как в API (GET /api/analytics): что сервер не
 * примет, из адреса не берется.
 */

export interface AnalyticsFilters {
  period: Period;
  /** Свой диапазон дат (по поясу участника, включительно): если задан, period не действует. */
  from: string | null;
  to: string | null;
  market: Market | null;
  /** Сторона исхода (1 или 2) — только вместе с market. */
  selection: 1 | 2 | null;
  /** Семейство рынков (Р28): все исходы и линии; вместе с market не выбирается. */
  family: MarketFamily | null;
  surface: SurfaceFilter | null;
  source: SourceFilter | null;
  /** Вид ставки (Р29): null — все ставки. */
  kind: KindFilter | null;
}

/** Периоды переключателя (как в макете): 7 дней есть только у главной. */
export const PERIODS: readonly Period[] = ['30d', '90d', 'all'];
export const MARKETS: readonly Market[] = ['ML', 'HCP_-1.5', 'HCP_+1.5'];
export const SURFACES: readonly SurfaceFilter[] = ['hard', 'clay', 'grass', 'carpet', 'unknown'];
export const SOURCES: readonly SourceFilter[] = ['app', 'legacy'];
export const KINDS: readonly KindFilter[] = ['strategy', 'single', 'own'];

/** Шесть исходов в порядке макета и сервера: П1, П2, Ф1(−1.5), Ф2(−1.5), Ф1(+1.5), Ф2(+1.5). */
export const OUTCOMES: readonly (readonly [Market, 1 | 2])[] = [
  ['ML', 1],
  ['ML', 2],
  ['HCP_-1.5', 1],
  ['HCP_-1.5', 2],
  ['HCP_+1.5', 1],
  ['HCP_+1.5', 2],
];

export const EMPTY_FILTERS: AnalyticsFilters = {
  period: 'all',
  from: null,
  to: null,
  market: null,
  selection: null,
  family: null,
  surface: null,
  source: null,
  kind: null,
};

// Даты фильтра сервер принимает только в этих пределах
const DATE_MIN = '2000-01-01';
const DATE_MAX = '2100-12-31';

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function validDay(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < DATE_MIN || value > DATE_MAX) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/** Фильтры из адреса. */
export function filtersFromSearch(params: URLSearchParams): AnalyticsFilters {
  let from = validDay(params.get('from'));
  let to = validDay(params.get('to'));
  if (from && to && from > to) [from, to] = [to, from];
  const market = pick(params.get('market'), MARKETS);
  const side = params.get('selection');
  const selection = market && (side === '1' || side === '2') ? (Number(side) as 1 | 2) : null;
  const family = market ? null : pick(params.get('family'), FAMILIES);
  return {
    period: pick(params.get('period'), PERIODS) ?? 'all',
    from,
    to,
    market,
    selection,
    family,
    surface: pick(params.get('surface'), SURFACES),
    source: pick(params.get('source'), SOURCES),
    kind: pick(params.get('kind'), KINDS),
  };
}

const FILTER_PARAMS = ['period', 'from', 'to', 'market', 'selection', 'family', 'surface', 'source', 'kind'];

/** Адрес с фильтрами: прочие параметры остаются; значения по умолчанию не пишутся. */
export function searchWithFilters(
  filters: AnalyticsFilters,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const name of FILTER_PARAMS) params.delete(name);
  if (filters.period !== 'all') params.set('period', filters.period);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.market) {
    params.set('market', filters.market);
    if (filters.selection) params.set('selection', String(filters.selection));
  } else if (filters.family) params.set('family', filters.family);
  if (filters.surface) params.set('surface', filters.surface);
  if (filters.source) params.set('source', filters.source);
  if (filters.kind) params.set('kind', filters.kind);
  return params;
}

/** Фильтры для API: пустое не передается (ключ кэша один на одну выборку). */
export function filtersQuery(filters: AnalyticsFilters): AnalyticsQuery {
  const query: AnalyticsQuery = {};
  if (filters.from || filters.to) {
    if (filters.from) query.from = filters.from;
    if (filters.to) query.to = filters.to;
  } else if (filters.period !== 'all') {
    query.period = filters.period;
  }
  if (filters.market) {
    query.market = filters.market;
    if (filters.selection) query.selection = filters.selection;
  } else if (filters.family) query.family = filters.family;
  if (filters.surface) query.surface = [filters.surface];
  if (filters.source) query.source = filters.source;
  if (filters.kind) query.kind = filters.kind;
  return query;
}

/** Выбран рынок, покрытие, источник или вид ставки (период и даты фильтром выборки не считаются). */
export function hasSliceFilter(filters: AnalyticsFilters): boolean {
  return filters.market !== null || filters.family !== null || filters.surface !== null || filters.source !== null || filters.kind !== null;
}

/** Хоть что-то отличается от «все время без фильтров» — видна кнопка «Сбросить фильтры». */
export function isDefault(filters: AnalyticsFilters): boolean {
  return filters.period === 'all' && filters.from === null && filters.to === null && !hasSliceFilter(filters);
}

/** Без рынка, покрытия, источника и вида (действие вывода «Снять фильтры»): период остается. */
export function withoutSlices(filters: AnalyticsFilters): AnalyticsFilters {
  return { ...filters, market: null, selection: null, family: null, surface: null, source: null, kind: null };
}

/**
 * Значение в выпадающем списке «Рынок»: исход «ML:1»; рынок без стороны (пришел ссылкой) —
 * «ML»; семейство (Р28) — «f:gtot».
 */
export function outcomeValue(market: Market | null, selection: 1 | 2 | null, family: MarketFamily | null = null): string {
  if (!market) return family ? `f:${family}` : 'all';
  return selection ? `${market}:${selection}` : market;
}

/** Обратно: «HCP_-1.5:2» → рынок и сторона, «f:gtot» → семейство. */
export function parseOutcome(value: string): { market: Market | null; selection: 1 | 2 | null; family: MarketFamily | null } {
  if (value.startsWith('f:')) return { market: null, selection: null, family: pick(value.slice(2), FAMILIES) };
  const [market, side] = value.split(':');
  const found = pick(market ?? null, MARKETS);
  if (!found) return { market: null, selection: null, family: null };
  return { market: found, selection: side === '1' || side === '2' ? (Number(side) as 1 | 2) : null, family: null };
}

/** Тот же исход, что выбран в фильтре. */
export function sameOutcome(filters: AnalyticsFilters, market: Market, selection: number): boolean {
  return filters.market === market && (filters.selection === null || filters.selection === selection);
}

function queryString(query: AnalyticsQuery, parts: readonly ExportPart[]): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) params.append(name, String(item));
    else if (value !== undefined && value !== null) params.set(name, String(value));
  }
  for (const part of parts) params.append('part', part);
  return params.toString();
}

/**
 * Выгрузка под теми же фильтрами (В13): одна часть — CSV, несколько — ZIP, в котором каждая часть
 * отдельным CSV. Пусто — null (выгружать нечего).
 */
export function exportHref(
  filters: AnalyticsFilters,
  parts: readonly ExportPart[],
  asUser: number | null = null,
): string | null {
  if (!parts.length) return null;
  // Р27: администратор выгружает данные участника, чьи данные смотрит (as_user; выгрузка — в журнал)
  const query = queryString({ ...filtersQuery(filters), ...(asUser === null ? {} : { as_user: asUser }) }, parts);
  return parts.length === 1 ? `/api/analytics/export.csv?${query}` : `/api/analytics/export.zip?${query}`;
}
