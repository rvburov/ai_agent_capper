import type { components } from '../../api/schema';

// Типы главной — из OpenAPI бэкенда (src/api/schema.d.ts), руками не дублируются.

type Schemas = components['schemas'];

export type Dashboard = Schemas['DashboardOut'];
export type DashboardPeriod = Dashboard['period'];
export type Greeting = Dashboard['greeting'];
export type RecentBet = Schemas['RecentBetOut'];
export type OpenBet = Schemas['OpenBetOut'];
export type MyMatch = Schemas['MyMatchOut'];
export type MyMatchBet = Schemas['MyMatchBetOut'];
export type AdminAttention = Schemas['AdminAttentionOut'];
export type ArchiveStale = Schemas['ArchiveStaleOut'];
export type LimitAlert = Schemas['LimitAlertOut'];
export type KeyReturnRequest = Schemas['KeyReturnRequestOut'];
export type PlayerRef = Schemas['PlayerRefOut'];
/** Свой расход на ИИ за месяц (GET /api/ai/usage): прогноз, доля кэша, задачи по цене. */
export type AiUsage = Schemas['AiUsageOut'];
