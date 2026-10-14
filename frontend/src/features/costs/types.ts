import type { components, operations } from '../../api/schema';

// Типы «ИИ и расходов» и «Администрирование → Расход ИИ» — из OpenAPI бэкенда
// (src/api/schema.d.ts), руками не дублируются.

type Schemas = components['schemas'];

export type AiUsage = Schemas['AiUsageOut'];
export type UsageSums = Schemas['UsageSumsOut'];
export type UsageDay = Schemas['UsageDayOut'];
export type UsageKind = Schemas['UsageKindOut'];
export type UsageVersion = Schemas['UsageVersionOut'];
export type AnalysisCost = Schemas['AnalysisCostOut'];
export type ModelPrice = Schemas['ModelPriceOut'];
export type AgentSettings = Schemas['AgentSettingsOut'];

export type AiRun = Schemas['AiRunOut'];
export type AiRuns = Schemas['AiRunsOut'];
export type RunCost = Schemas['RunCostOut'];
export type CostPart = Schemas['CostPartOut'];
/** Фильтр журнала: вид вызова или shared — общие задачи и приемка (только администратор). */
export type RunFilter = NonNullable<NonNullable<operations['runs_api_ai_runs_get']['parameters']['query']>['kind']>;

export type AdminAiUsage = Schemas['AdminAiUsageOut'];
export type PersonUsage = Schemas['PersonUsageOut'];
export type TaskUsage = Schemas['TaskUsageOut'];
export type SharedUsage = Schemas['SharedUsageOut'];
export type EvalUsage = Schemas['EvalUsageOut'];
export type Activity = Schemas['ActivityOut'];
export type PersonActivity = Schemas['PersonActivityOut'];
export type ActivityPeriod = Activity['period'];
