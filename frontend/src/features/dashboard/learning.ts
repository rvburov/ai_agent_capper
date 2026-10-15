import type { LearningSummary } from '../learning/types';

/*
 * «Модель учится» на главной (learningCard макета, этап 5) и решения администратора по
 * обучению в «Требует внимания»: сводка обучения приходит в ответе главной (DashboardOut.
 * learning — то же, что GET /api/learning). Здесь — только то, что показать в строках.
 */

export interface LearningSnapshot {
  settled: number;
  settledAuto: number;
  inPrompt: number;
  max: number;
  hypotheses: number;
  /** Коды уроков, готовых к быстрой проверке и решению. */
  readyCodes: string[];
  /** Последний живой урок. */
  last: { code: string; text: string } | null;
  /** Активная версия инструкций и кандидат («v3», «v4»); прошел ли кандидат правило. */
  active: string | null;
  candidate: string | null;
  candidatePassed: boolean | null;
  /** Цена быстрой проверки урока по живым числам (≈ $), с сервера. */
  quickPrice: number;
  /** День следующего отчета недели (понедельник по поясу участника) и последнего. */
  nextReport: string;
  lastReport: string | null;
}

export function learningSnapshot(summary: LearningSummary): LearningSnapshot {
  const { lessons, versions } = summary;
  return {
    settled: summary.settled,
    settledAuto: summary.settled_auto,
    inPrompt: lessons.in_prompt,
    max: lessons.max_active,
    hypotheses: lessons.hypotheses,
    readyCodes: lessons.ready_codes,
    last: lessons.last ? { code: lessons.last.code, text: lessons.last.text } : null,
    active: versions.active?.code ?? null,
    candidate: versions.candidate?.code ?? null,
    candidatePassed: versions.candidate?.passed ?? null,
    quickPrice: summary.prices.quick_check_usd,
    nextReport: summary.next_report,
    lastReport: summary.last_report,
  };
}
