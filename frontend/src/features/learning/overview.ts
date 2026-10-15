import { useStrategy } from '../analysis/api';
import { useBetSummary } from '../bets/api';
import { nextReportDay } from './schedule';

/*
 * Сводка «Обучения модели» (плитки, шапка, пустые состояния вкладок). Числа считает сервер
 * (Т15): сейчас экран берет то, что уже отдает API, — рассчитанные ставки приложения
 * (GET /api/bets/summary) и активную версию стратегии (GET /api/strategy/active). Уроков,
 * кандидатов, версий модели и отчетов до волн 2–4 этапа 5 нет — поля пустые, вкладки
 * показывают пустые состояния макета (#learning-empty). Сводку целиком заменит GET /learning.
 */

/**
 * Значения настроек обучения по умолчанию (app_settings.agent_config, сводка этапа 5, 6.1):
 * предел уроков в анализе, порог случаев для проверки урока и событий для поправки Claude
 * числом. С GET /learning придут с сервера.
 */
export const LEARNING_DEFAULTS = {
  lessonsMax: 15,
  lessonMinCases: 20,
  lessonMinProcess: 10,
  claudeMinEvents: 300,
} as const;

export interface LearningOverview {
  /** Рассчитано ставок приложения (без ставок бота); null — еще не загрузилось или ошибка. */
  settled: number | null;
  settledPending: boolean;
  /** Уроков в инструкциях анализа и предел. */
  lessonsInPrompt: number;
  lessonsMax: number;
  /** Гипотез и уроков, ждущих решения; всего уроков (для пустых состояний). */
  hypotheses: number;
  ready: number;
  lessonsTotal: number;
  lessonMinCases: number;
  lessonMinProcess: number;
  claudeMinEvents: number;
  /** Активная версия инструкций («v3») и кандидат; null — не загрузилось или нет. */
  activeVersion: string | null;
  candidate: string | null;
  /** Версия инструкций загружается. */
  versionPending: boolean;
  /** Активная базовая модель: Brier на проверке и когда включена; null — данных еще нет. */
  model: { brier: number; at: string; auto: boolean } | null;
  /** Последний отчет недели; null — отчетов нет. */
  lastReport: { from: string; to: string } | null;
  /** День следующего отчета (понедельник по поясу участника). */
  nextReport: string;
}

const APP_BETS = { period: 'all', source: 'app' } as const;

/** Сводка экрана из того, что уже есть в API. now — для тестов с зафиксированными часами. */
export function useLearningOverview(timeZone: string, now: Date = new Date()): LearningOverview {
  const summary = useBetSummary(APP_BETS);
  const strategy = useStrategy();
  return {
    settled: summary.data?.settled ?? null,
    settledPending: summary.isPending,
    lessonsInPrompt: 0,
    lessonsMax: LEARNING_DEFAULTS.lessonsMax,
    hypotheses: 0,
    ready: 0,
    lessonsTotal: 0,
    lessonMinCases: LEARNING_DEFAULTS.lessonMinCases,
    lessonMinProcess: LEARNING_DEFAULTS.lessonMinProcess,
    claudeMinEvents: LEARNING_DEFAULTS.claudeMinEvents,
    activeVersion: strategy.data?.code ?? null,
    candidate: null,
    versionPending: strategy.isPending,
    model: null,
    lastReport: null,
    nextReport: nextReportDay(now, timeZone),
  };
}
