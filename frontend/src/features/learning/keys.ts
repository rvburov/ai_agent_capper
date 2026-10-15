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
};
