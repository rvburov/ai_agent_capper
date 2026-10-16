// Ключи запросов «Обучения модели» (этап 5): сводка экрана, уроки, версии, модель, отчеты.
// learningKeys.all — префикс всех: уведомления «урок готов», «кандидат проверен», «модель
// перекалибрована» и «отчет недели» сбрасывают его целиком (features/notifications).
export const learningKeys = {
  all: ['learning'] as const,
  /** Сводка экрана (GET /api/learning): плитки, шапка, пороги и цены. */
  summary: ['learning', 'summary'] as const,
  /** Все уроки (GET /api/lessons): вкладка «Уроки», плитки и «Модель учится» на главной. */
  lessons: ['learning', 'lessons'] as const,
  lesson: (id: number) => ['learning', 'lessons', id] as const,
  dictionary: ['learning', 'dictionary'] as const,
  quickCheck: (id: number) => ['learning', 'quick-check', id] as const,
  /** Версии стратегии (GET /api/strategy/versions): инструкции анализа и свои правила суммы. */
  versions: ['learning', 'versions'] as const,
  compare: (a: number, b: number) => ['learning', 'versions', 'compare', a, b] as const,
  /** Проверка версий на замороженном наборе (администратор): наборы, план, прогоны. */
  eval: ['learning', 'eval'] as const,
  evalSets: ['learning', 'eval', 'sets'] as const,
  evalPlan: (versionId: number) => ['learning', 'eval', 'plan', versionId] as const,
  evalRuns: ['learning', 'eval', 'runs'] as const,
  evalRun: (id: number) => ['learning', 'eval', 'runs', id] as const,
  /** Базовая модель (GET /api/ml/model): версии калибровки, проверка по месяцам. */
  model: ['learning', 'model'] as const,
  /** Еженедельные отчеты (GET /api/learning/reports). */
  reports: ['learning', 'reports'] as const,
  report: (id: number) => ['learning', 'reports', id] as const,
};
