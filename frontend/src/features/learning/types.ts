import type { components } from '../../api/schema';

// Типы «Обучения модели» — из OpenAPI бэкенда (src/api/schema.d.ts), руками не дублируются.

type Schemas = components['schemas'];

export type Lesson = Schemas['LessonOut'];
export type LessonsList = Schemas['LessonsOut'];
export type LessonStatus = Lesson['status'];
export type LessonKind = Lesson['kind'];
export type LessonHistory = Schemas['LessonHistoryOut'];
export type LessonQuick = Schemas['LessonQuickOut'];
export type LessonEstimate = Schemas['LessonEstimateOut'];
export type LessonDictionary = Schemas['LessonDictionaryOut'];
export type LessonFeature = Schemas['FeatureOut'];
export type FeatureName = LessonFeature['feature'];
export type ScopeOp = LessonFeature['ops'][number];
export type Scope = Schemas['ScopeIO'];
export type ScopeDirection = Scope['direction'];
export type ScopeCondition = Schemas['ScopeConditionIO'];
export type LessonIn = Schemas['LessonIn'];
/** Быстрая проверка до запуска (GET /api/lessons/{id}/quick-check): цена, бюджет, можно ли. */
export type QuickCheck = Schemas['QuickCheckOut'];
/** Сводка «Обучения модели» и «Модели учится» на главной (GET /api/learning, DashboardOut.learning). */
export type LearningSummary = Schemas['LearningOut'];

/** Версии стратегии (GET /api/strategy/versions): инструкции анализа — общая линия, правила суммы — свои. */
export type StrategyVersions = Schemas['StrategyVersionsOut'];
export type StrategyVersion = Schemas['StrategyVersionOut'];
export type VersionStatus = StrategyVersion['status'];
export type VersionEval = Schemas['VersionEvalOut'];
export type Comparison = Schemas['ComparisonOut'];
export type MetricDiff = Schemas['MetricDiffOut'];
export type VersionCompare = Schemas['VersionCompareOut'];
export type RulesCheck = Schemas['RulesCheckOut'];
export type RulesCandidateIn = Schemas['RulesCandidateIn'];
export type CiNum = Schemas['CiNumOut'];

/** Замороженный набор и прогоны версий на нем (администратор). */
export type EvalSet = Schemas['EvalSetOut'];
export type EvalSets = Schemas['EvalSetsOut'];
export type EvalPlan = Schemas['EvalPlanOut'];
export type EvalBudget = Schemas['EvalBudgetOut'];
export type EvalRun = Schemas['EvalRunOut'];
export type EvalRuns = Schemas['EvalRunsOut'];
export type EvalMetrics = Schemas['EvalMetricsOut'];

/** Базовая модель (GET /api/ml/model): версии калибровки, проверка по месяцам, калибровка. */
export type MlModel = Schemas['MlModelOut'];
export type MlVersion = Schemas['MlVersionOut'];
export type WalkForward = Schemas['WalkForwardOut'];
export type Recalibration = Schemas['RecalibrationOut'];

/** Еженедельные отчеты (GET /api/learning/reports, /reports/{id}): только свои. */
export type WeeklyReports = Schemas['WeeklyReportsOut'];
export type WeeklyReportBrief = Schemas['WeeklyReportBriefOut'];
export type WeeklyReport = Schemas['WeeklyReportOut'];
