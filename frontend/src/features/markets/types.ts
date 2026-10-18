import type { components } from '../../api/schema';

// Рынки (Р28): статус семейств и общий счетчик «для сравнения» — из OpenAPI бэкенда.

type Schemas = components['schemas'];

export type Markets = Schemas['MarketsOut'];
export type MarketFamilyOut = Schemas['MarketFamilyOut'];
export type MarketStatusKind = MarketFamilyOut['status'];

/** Семейство со статусом и порогом (need — 150 событий). */
export type MarketStatusInfo = MarketFamilyOut & { need: number; needMax: number };
