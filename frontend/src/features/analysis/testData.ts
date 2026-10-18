import done from './fixtures/done.json';
import needsConfirmation from './fixtures/needsConfirmation.json';
import preview from './fixtures/preview.json';
import strategy from './fixtures/strategy.json';
import type { Analysis, AnalysisListItem, Bank, Preview, ProgressEvent, Stake, Step, Strategy, Variant } from './types';

/*
 * Данные для тестов «Нового анализа» и «Анализа». Ответы сняты со стека сквозных тестов
 * (фейковый Claude): анализ 2 матчей с экспрессом Джокович П1 + Синнер П1, черновик разбора
 * тех же матчей, «Перед запуском» и стратегия v3 по умолчанию. Каждый вызов — новая копия.
 */

function copy<T>(value: unknown): T {
  return structuredClone(value) as T;
}

/**
 * Готовый анализ (id 1): 2 матча, экспресс 1.885, сумма 1 320 ₽ из банка 48 000 ₽. Варианты
 * ставки (Р29): экспресс стратегии и два ординара — «надежнее» (Синнер П1 @1.30) и «лучший
 * валуй» (Джокович П1 @1.45). Задана только bet — она же единственная в bets.
 */
export function analysisDone(over: Partial<Analysis> = {}): Analysis {
  const base = copy<Analysis>(done);
  const result = base.result ? { ...base.result, variants: base.result.variants ?? doneVariants(base) } : null;
  const out: Analysis = { ...base, result, bets: [], ...over };
  if (over.bet && !over.bets) out.bets = [over.bet];
  return out;
}

function stakeCalc(amount: string | null, pct: string, total: string, over: Partial<Stake> = {}): Stake {
  return {
    amount,
    currency: 'RUB',
    bank: '48000.00',
    bank_source: 'input',
    total_odds: total,
    pct,
    steps: [
      { kind: 'band', pct, params: { low: '1.01', high: '1.60', pct, table: 'single' } },
      { kind: 'limit', pct, params: { max_pct: '0.03' } },
      { kind: 'round', pct, params: { raw: amount ?? '0', bank: '48000.00', step: '10', amount: amount ?? '0' } },
    ],
    reason: amount === null ? 'no_value' : null,
    drawdown_level: null,
    ...over,
  };
}

/** Вариант ставки: по умолчанию «Ординар · надежнее» — Синнер П1 @1.30, p 0,99, 720 ₽. */
export function variantOut(over: Partial<Variant> = {}): Variant {
  return {
    code: 'safer',
    kind: 'single',
    also: [],
    legs: [{ prediction_id: 1, match_id: 91, market: 'ML', selection: 1, p: 0.99, odds: '1.30' }],
    total_odds: '1.300',
    p: 0.99,
    value: 0.287,
    value_tier: 'strong',
    stake: '720.00',
    stake_calc: stakeCalc('720.00', '0.015', '1.300'),
    why_key: 'analysis.variants.why.safer',
    why_params: { min_odds: '1.30' },
    outside_strategy: false,
    issues: [],
    warnings: [],
    ...over,
  };
}

/** «Ординар · лучший валуй»: Джокович П1 @1.45, p 0,904. */
export function valueVariant(over: Partial<Variant> = {}): Variant {
  return variantOut({
    code: 'value',
    legs: [{ prediction_id: 7, match_id: 92, market: 'ML', selection: 1, p: 0.904, odds: '1.45' }],
    total_odds: '1.450',
    p: 0.904,
    value: 0.3108,
    why_key: 'analysis.variants.why.value',
    why_params: { min_p: '0.5' },
    ...over,
  });
}

/** Ставка «Валуя нет»: суммы нет, предупреждение no_value. */
export function noValueStake(total: string): Stake {
  return stakeCalc(null, '0.015', total, {
    steps: [
      { kind: 'band', pct: '0.015', params: { low: '1.01', high: '1.60', pct: '0.015', table: 'single' } },
      { kind: 'no_value', pct: '0.015', params: { value: '-0.0400' } },
    ],
  });
}

function doneVariants(analysis: Analysis): Variant[] {
  const express = analysis.result?.express;
  const out: Variant[] = [];
  if (express) {
    out.push(
      variantOut({
        code: 'strategy',
        kind: 'strategy',
        legs: express.legs,
        total_odds: express.total_odds,
        p: express.p_express,
        value: express.ev,
        stake: express.stake.amount,
        stake_calc: express.stake,
        why_key: 'analysis.variants.why.strategy',
        why_params: {},
      }),
    );
  }
  out.push(variantOut(), valueVariant());
  return out;
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
