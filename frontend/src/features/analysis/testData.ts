import done from './fixtures/done.json';
import needsConfirmation from './fixtures/needsConfirmation.json';
import preview from './fixtures/preview.json';
import strategy from './fixtures/strategy.json';
import type { Analysis, AnalysisListItem, Bank, Preview, ProgressEvent, Step, Strategy } from './types';

/*
 * Данные для тестов «Нового анализа» и «Анализа». Ответы сняты со стека сквозных тестов
 * (фейковый Claude): анализ 2 матчей с экспрессом Джокович П1 + Синнер П1, черновик разбора
 * тех же матчей, «Перед запуском» и стратегия v3 по умолчанию. Каждый вызов — новая копия.
 */

function copy<T>(value: unknown): T {
  return structuredClone(value) as T;
}

/** Готовый анализ (id 1): 2 матча, экспресс 1.885, сумма 1 320 ₽ из банка 48 000 ₽. */
export function analysisDone(over: Partial<Analysis> = {}): Analysis {
  return { ...copy<Analysis>(done), ...over };
}

/** Черновик после разбора текста (id 6): оба игрока в обоих матчах найдены уверенно. */
export function analysisDraft(over: Partial<Analysis> = {}): Analysis {
  return { ...copy<Analysis>(needsConfirmation), ...over };
}

/** Анализ в работе: шаги до «Claude» включительно; остальные ждут. */
export function analysisRunning(over: Partial<Analysis> = {}): Analysis {
  const base = analysisDone();
  const steps: Step[] = base.steps.map((step) => {
    if (step.index < 6) return step;
    if (step.index === 6) return { ...step, state: 'running', tokens: 0, cost_usd: 0, elapsed_ms: 0, detail_key: null, detail_params: {} };
    return { ...step, state: 'pending', model: step.model, tokens: 0, cost_usd: 0, elapsed_ms: 0, detail_key: null, detail_params: {} };
  });
  return {
    ...base,
    status: 'llm_review',
    finished_at: null,
    steps,
    totals: { elapsed_ms: 1000, tokens: 19704, cost_usd: 0.064156, step: 7, steps: 9 },
    result: null,
    cost_usd: 0.064156,
    ...over,
  };
}

/** Остановленный анализ: шаг 7 «Claude» упал с перегрузкой API. */
export function analysisFailed(over: Partial<Analysis> = {}): Analysis {
  const running = analysisRunning();
  const steps = running.steps.map((step) => (step.index === 6 ? { ...step, state: 'failed' as const } : step));
  return {
    ...running,
    status: 'failed',
    finished_at: '2026-10-11T21:10:53.000000Z',
    steps,
    error: { code: 'ai.overloaded', params: {}, step: 'claude' },
    ...over,
  };
}

export function previewOut(over: Partial<Preview> = {}): Preview {
  return { ...copy<Preview>(preview), ...over };
}

export function strategyV3(): Strategy {
  return copy<Strategy>(strategy);
}

export function bankOut(over: Partial<Bank> = {}): Bank {
  return {
    currency: 'RUB',
    empty: false,
    balance: '48000.00',
    in_play: '0.00',
    equity: '48000.00',
    peak: '48000.00',
    drawdown: '0.0000',
    invested: '48000.00',
    growth: null,
    week_change: null,
    winrate: null,
    settled_bets: 0,
    drawdown_level: null,
    adaptations: [],
    ...over,
  };
}

export function listItem(over: Partial<AnalysisListItem> = {}): AnalysisListItem {
  return {
    id: 1,
    status: 'done',
    created_at: '2026-10-11T21:10:49Z',
    finished_at: '2026-10-11T21:10:53Z',
    input_kind: 'text',
    matches: ['Jannik Sinner vs Holger Rune', 'Novak Djokovic vs Andrey Rublev'],
    pairs: [
      { player1: { name: 'Jannik Sinner', name_ru: 'Янник Синнер' }, player2: { name: 'Holger Rune', name_ru: 'Хольгер Руне' } },
      { player1: { name: 'Novak Djokovic', name_ru: 'Новак Джокович' }, player2: { name: 'Andrey Rublev', name_ru: 'Андрей Рублев' } },
    ],
    decision: null,
    cost_usd: 0.13,
    ...over,
  };
}

/** Событие потока: снимок или шаг поверх анализа. */
export function progressEvent(analysis: Analysis, over: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    type: 'snapshot',
    analysis_id: analysis.id,
    status: analysis.status,
    step: null,
    steps: analysis.steps,
    totals: analysis.totals,
    error: analysis.error,
    ...over,
  };
}
