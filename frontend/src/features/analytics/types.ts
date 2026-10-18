import type { components, operations } from '../../api/schema';

// Типы «Аналитики» — из OpenAPI бэкенда (src/api/schema.d.ts), руками не дублируются.

type Schemas = components['schemas'];

export type Analytics = Schemas['AnalyticsOut'];
export type Thresholds = Schemas['ThresholdsOut'];
export type Sample = Schemas['SampleOut'];
export type Kpi = Schemas['KpiOut'];
export type Prev = Schemas['PrevOut'];
export type Change = Schemas['ChangeOut'];
export type Brier = Schemas['BrierOut'];
export type BrierPoint = Schemas['BrierPointOut'];
export type Ci = Schemas['CiOut'];
export type Insight = Schemas['InsightOut'];
export type InsightCode = Insight['code'];
export type InsightTone = Insight['tone'];
export type InsightAction = NonNullable<Insight['action']>;
export type InsightFilter = Schemas['InsightFilterOut'];
export type Series = Schemas['SeriesOut'];
export type SeriesRow = Schemas['SeriesRowOut'];
export type Slices = Schemas['SlicesOut'];
export type SurfaceSlice = Schemas['SurfaceSliceOut'];
export type MarketSlice = Schemas['MarketSliceOut'];
export type MarketsTotal = Schemas['MarketsTotalOut'];
export type OddsSlice = Schemas['OddsSliceOut'];
export type TotalSlice = Schemas['TotalSliceOut'];
export type Parlays = Schemas['ParlaysOut'];
export type Calibration = Schemas['CalibrationOut'];
export type CalibrationBinOut = Schemas['CalibrationBinOut'];
export type CalibrationFlag = Schemas['CalibrationFlagOut'];
export type Clv = Schemas['ClvOut'];
export type ClvBin = Schemas['ClvBinOut'];

/** Параметры GET /api/analytics (фильтры). */
export type AnalyticsQuery = NonNullable<operations['get_analytics_api_analytics_get']['parameters']['query']>;
/** Часть выгрузки CSV: ставки, события, калибровка, скользящий Brier. */
export type ExportPart = NonNullable<
  NonNullable<operations['export_analytics_zip_api_analytics_export_zip_get']['parameters']['query']>['part']
>[number];

export type Period = NonNullable<AnalyticsQuery['period']>;
export type Market = NonNullable<AnalyticsQuery['market']>;
export type SurfaceFilter = NonNullable<AnalyticsQuery['surface']>[number];
export type SourceFilter = NonNullable<AnalyticsQuery['source']>;
/** Вид ставки (Р29): стратегия, ординары, свои; «все» — значение по умолчанию, в адрес не пишется. */
export type KindFilter = Exclude<NonNullable<AnalyticsQuery['kind']>, 'all'>;
