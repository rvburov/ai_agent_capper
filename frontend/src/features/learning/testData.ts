import type { LearningSummary, Lesson, LessonDictionary, LessonHistory, LessonQuick, LessonsList, QuickCheck } from './types';

// Ответы API уроков для тестов (как их отдает сервер волны 2): урок, список с порогами,
// проверка на истории, быстрая проверка до запуска и ее итог, словарь признаков.

export function lessonHistory(overrides: Partial<LessonHistory> = {}): LessonHistory {
  return {
    checked_at: '2026-10-12T06:33:00Z',
    status: 'ready',
    reason: null,
    method: 'p_base',
    n_hist: 412,
    n_history: 309,
    n_holdout: 103,
    n_shrink: 309,
    holdout_since: '2025-04-01',
    bias: { value: -0.05, low: -0.071, high: -0.029, n: 309 },
    // −0,05 × 309 / (309 + 200)
    shift: -0.0304,
    log_loss_without: 0.634,
    log_loss_with: 0.612,
    gain: { value: 0.022, low: 0.012, high: 0.031, n: 309 },
    holdout_gain: { value: 0.009, low: 0.001, high: 0.018, n: 103 },
    seed: 20261015,
    ...overrides,
  };
}

export function lessonQuick(overrides: Partial<LessonQuick> = {}): LessonQuick {
  return {
    eval_run_id: 7,
    status: 'done',
    started_at: '2026-10-14T10:00:00Z',
    finished_at: '2026-10-14T10:12:00Z',
    events: 40,
    requests: 40,
    passed: true,
    diff: { value: -0.004, low: -0.012, high: 0.005, n: 40 },
    margin: 0.01,
    format_errors: 0,
    refusals: 0,
    unrated: 0,
    cost_usd: 0.61,
    worst_usd: 4.4,
    error: null,
    ...overrides,
  };
}

let nextId = 1;

export function lesson(overrides: Partial<Lesson> = {}): Lesson {
  const id = overrides.id ?? nextId++;
  return {
    id,
    code: `L-${String(id).padStart(3, '0')}`,
    text: 'На грунте модель завышает аутсайдера с кэфом 2.60+',
    kind: 'numeric',
    status: 'hypothesis',
    origin: 'postmortem',
    shared: true,
    scope: {
      direction: 'lower',
      conditions: [
        { feature: 'surface', op: 'eq', values: ['clay'] },
        { feature: 'role', op: 'eq', values: ['underdog'] },
        { feature: 'odds', op: 'ge', value: 2.6 },
      ],
    },
    scope_ok: true,
    in_prompt: false,
    created_at: '2026-10-08T09:00:00Z',
    n_cases: 3,
    n_cases_few: false,
    own_cases: 0,
    need_cases: 20,
    n_hist: 0,
    effect: null,
    effect_ci: null,
    effect_shrunk: null,
    holdout_effect: null,
    holdout_ci: null,
    validated_at: null,
    decided_at: null,
    retired_at: null,
    rechecked_at: null,
    history: null,
    quick: null,
    own_bets: [],
    watching: false,
    ...overrides,
  };
}

/** Урок подтвержден на истории и ждет решения. */
export function readyLesson(overrides: Partial<Lesson> = {}): Lesson {
  return lesson({
    status: 'ready',
    n_cases: 21,
    n_hist: 412,
    effect: -0.05,
    effect_ci: [-0.071, -0.029],
    effect_shrunk: -0.0304,
    holdout_effect: 0.009,
    holdout_ci: [0.001, 0.018],
    validated_at: '2026-10-12T06:33:00Z',
    history: lessonHistory(),
    ...overrides,
  });
}

export function lessonsList(items: Lesson[] = [], overrides: Partial<LessonsList> = {}): LessonsList {
  return {
    items,
    active: items.filter((item) => item.in_prompt).length,
    max_active: 15,
    min_cases: 20,
    min_cases_process: 10,
    shrink_k: 200,
    ...overrides,
  };
}

export function quickCheck(overrides: Partial<QuickCheck> = {}): QuickCheck {
  return {
    lesson_id: 1,
    events: 40,
    requests: 40,
    baseline_reused: 40,
    model: 'claude-opus-5-5',
    estimate_usd: 0.61,
    worst_usd: 4.4,
    budget_usd: 30,
    spent_usd: 3.2,
    reserved_usd: 0,
    left_usd: 26.8,
    active: 2,
    max_active: 15,
    can_run: true,
    reason: null,
    eval_run_id: null,
    status: null,
    ...overrides,
  };
}

export function lessonDictionary(): LessonDictionary {
  const number = (feature: LessonDictionary['features'][number]['feature'], low: number, high: number, step = 1, side = false) => ({
    feature,
    kind: 'number' as const,
    ops: ['lt' as const, 'le' as const, 'gt' as const, 'ge' as const],
    values: [],
    low,
    high,
    step,
    side,
  });
  const enumOf = (feature: LessonDictionary['features'][number]['feature'], values: string[], side = false) => ({
    feature,
    kind: 'enum' as const,
    ops: ['in' as const, 'eq' as const],
    values,
    low: null,
    high: null,
    step: null,
    side,
  });
  return {
    features: [
      enumOf('market', ['ML', 'HCP_-1.5', 'HCP_+1.5']),
      enumOf('surface', ['hard', 'clay', 'grass']),
      enumOf('round', ['R128', 'R64', 'R32', 'R16', 'RR', 'QF', 'SF', 'F']),
      enumOf('best_of', ['3', '5']),
      enumOf('role', ['favorite', 'underdog'], true),
      number('elo_gap', 0, 1000),
      number('odds', 1.01, 100, 0.01, true),
      number('sets_48h', 0, 20, 1, true),
      number('opp_sets_48h', 0, 20, 1, true),
      number('rest_days', 0, 400, 1, true),
      number('h2h_matches', 0, 100),
      number('h2h_wins', 0, 100, 1, true),
    ],
    directions: ['lower', 'raise'],
    max_conditions: 6,
  };
}

/** Сводка обучения новой установки: ставок и уроков нет, версия инструкций v3, модели нет. */
export function learningSummary(overrides: Partial<LearningSummary> = {}): LearningSummary {
  return {
    settled: 0,
    settled_auto: 0,
    settled_legs: 0,
    awaiting: 0,
    events_with_outcome: 0,
    lessons: { in_prompt: 0, max_active: 15, total: 0, hypotheses: 0, ready: 0, confirmed: 0, rejected: 0, retired: 0, ready_codes: [], last: null },
    versions: {
      active: { id: 1, code: 'v3', name: 'v3 · основная', status: 'active', activated_at: '2026-10-01T09:00:00Z', checked: false, passed: null, rule: null },
      candidate: null,
      rules_active: null,
      rules_candidate: null,
    },
    model: null,
    eval_set: null,
    thresholds: {
      lessons_max: 15,
      lesson_min_cases: 20,
      lesson_min_process: 10,
      shrink_k: 200,
      claude_min_events: 300,
      quick_check_events: 40,
      eval_set_size: 250,
      eval_batch_size: 100,
      eval_hard_share: 0.175,
      eval_min_answered: 0.9,
    },
    prices: {
      postmortem_usd: 0.01,
      quick_check_usd: 0.6,
      eval_event_worst_usd: 0.11,
      budget: { budget_usd: 30, spent_usd: 0, reserved_usd: 0, left_usd: 30, first_month: true, next_usd: 25 },
    },
    next_report: '2026-10-19',
    last_report: null,
    ...overrides,
  };
}
