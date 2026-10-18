import type { MarketFamily } from '../analysis/markets';
import type { Markets, MarketStatusInfo } from './types';

// Статусы рынков по семействам из ответа GET /api/markets (без текстов: их берет и «Администрирование»).

/** Статусы по семействам: из ответа сервера, в порядке FAMILIES. */
export type MarketStatusMap = ReadonlyMap<MarketFamily, MarketStatusInfo>;

export function statusMap(markets: Markets | null | undefined): MarketStatusMap {
  const map = new Map<MarketFamily, MarketStatusInfo>();
  for (const item of markets?.families ?? []) map.set(item.family, { ...item, need: markets?.need ?? 0, needMax: markets?.need_max ?? 0 });
  return map;
}
