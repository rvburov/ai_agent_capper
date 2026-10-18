import type { components, operations } from '../../api/schema';

// Типы «Ставок» — из OpenAPI бэкенда (src/api/schema.d.ts), руками не дублируются.

type Schemas = components['schemas'];

export type BetItem = Schemas['BetItemOut'];
export type BetLeg = Schemas['BetLegItemOut'];
export type BetPage = Schemas['BetPageOut'];
export type BetsSummary = Schemas['BetsSummaryOut'];
export type BetCounts = Schemas['BetCountsOut'];
export type Closing = Schemas['ClosingOut'];
export type ClosingIn = Schemas['ClosingIn'];
export type SettleIn = Schemas['SettleIn'];
export type LegSettleIn = Schemas['LegSettleIn'];

export type BetStatus = BetItem['status'];
export type Verdict = NonNullable<BetItem['verdict']>;
export type Market = BetLeg['market'];
export type LegResult = NonNullable<BetLeg['result']>;
export type ClosingBy = Closing['by'];

/** Параметры GET /api/bets (фильтры, курсор и размер страницы). */
export type BetListQuery = NonNullable<operations['list_bets_api_bets_get']['parameters']['query']>;
/** Фильтры без курсора: GET /api/bets/summary и /api/bets/export.csv. */
export type BetFiltersQuery = Omit<BetListQuery, 'before' | 'limit'>;

export type Period = NonNullable<BetListQuery['period']>;
/** Фильтр статуса: статус ставки или settled — все рассчитанные. */
export type StatusFilter = NonNullable<BetListQuery['status']>;
export type SurfaceFilter = NonNullable<BetListQuery['surface']>[number];
export type SourceFilter = NonNullable<BetListQuery['source']>;
/** Вид ставки (Р29): экспресс стратегии, ординар варианта, своя; all — в адрес не пишется. */
export type KindFilter = Exclude<NonNullable<BetListQuery['kind']>, 'all'>;
