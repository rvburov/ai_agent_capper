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
