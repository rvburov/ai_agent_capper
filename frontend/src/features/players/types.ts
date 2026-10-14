import type { components, operations } from '../../api/schema';

// Типы «Игроков» и карточки игрока — из OpenAPI бэкенда (src/api/schema.d.ts), руками не
// дублируются.

type Schemas = components['schemas'];

export type PlayerRanking = Schemas['PlayerRankingOut'];
export type PlayerRow = Schemas['PlayerRowOut'];
export type PlayerCounts = Schemas['PlayerCountsOut'];
export type ArchiveInfo = Schemas['ArchiveInfoOut'];
export type LastMatch = Schemas['LastMatchOut'];

export type PlayerCard = Schemas['PlayerCardOut'];
export type EloInfo = Schemas['EloOut'];
export type SurfaceElo = Schemas['SurfaceEloOut'];
export type FormMatch = Schemas['FormMatchOut'];
export type PlayerForm = Schemas['PlayerFormOut'];
export type ServeInfo = Schemas['ServeOut'];
export type ServeMetrics = Schemas['ServeMetricsOut'];
export type Results = Schemas['ResultsOut'];
export type SurfaceResult = Schemas['SurfaceResultOut'];
export type WinLoss = Schemas['WinLossOut'];
export type KeyMatches = Schemas['KeyMatchesOut'];
export type NewsStatus = Schemas['NewsStatusOut'];
export type LegacyProfile = Schemas['LegacyProfileOut'];
export type TodayMatch = Schemas['TodayOut'];
export type TodayH2H = Schemas['TodayH2HOut'];
export type PlayerRef = Schemas['PlayerRefOut'];

export type PlayerMatches = Schemas['PlayerMatchesOut'];
export type PlayerMatch = Schemas['PlayerMatchOut'];
export type MatchesSummary = Schemas['PlayerMatchesSummaryOut'];
export type PlayerNews = Schemas['PlayerNewsOut'];
export type NewsItem = Schemas['PlayerNewsItemOut'];
export type NewsKind = NewsItem['kind'];
export type H2H = Schemas['H2HOut'];
export type H2HMatch = Schemas['H2HMatchOut'];

/** Параметры GET /api/players/ranking. */
export type RankingQuery = NonNullable<operations['players_ranking_api_players_ranking_get']['parameters']['query']>;
export type DataFilter = PlayerRanking['data'];
export type EloSurface = PlayerRanking['surface'];
export type RankingSort = PlayerRanking['sort'];
