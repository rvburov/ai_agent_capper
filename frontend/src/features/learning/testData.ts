import type {
  Comparison,
  EvalPlan,
  EvalRun,
  EvalSet,
  LearningSummary,
  Lesson,
  LessonDictionary,
  LessonHistory,
  LessonQuick,
  LessonsList,
  MlModel,
  MlVersion,
  QuickCheck,
  StrategyVersion,
  StrategyVersions,
  VersionEval,
  WeeklyReport,
  WeeklyReportBrief,
  WeeklyReports,
} from './types';

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
    public_cases_min: 5,
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
    last_report_end: null,
    last_report_id: null,
    ...overrides,
  };
}

// ---------- версии стратегии, прогоны, базовая модель, отчеты (волна 4) ----------

/** Замороженный набор S-2026-08: 250 матчей с 1 августа, 45 трудных. */
export function evalSet(overrides: Partial<EvalSet> = {}): EvalSet {
  return {
    id: 1,
    code: 'S-2026-08',
    frozen_at: '2026-10-02T08:00:00Z',
    sha256: '9f2c41ab77e0d3c5aa61b2f4e7d1c09b88aa0f1e2d3c4b5a69788796a5b4c3d2',
    n_events: 250,
    hard: 45,
    hard_share: 0.18,
    since: '2026-08-01',
    until: '2026-09-30',
    with_news: false,
    market_n: 248,
    market_log_loss: 0.598,
    market_brier: 0.205,
    ...overrides,
  };
}

export function versionEval(overrides: Partial<VersionEval> = {}): VersionEval {
  return {
    eval_set_code: 'S-2026-08',
    runs: 1,
    run_ids: [11],
    n: 250,
    log_loss: 0.612,
    brier: 0.211,
    ece: 0.031,
    format_errors: 0,
    max_tokens: 0,
    refusals: 0,
    to_market: { value: 0.014, low: -0.004, high: 0.031, n: 248 },
    noise: null,
    tokens_per_event: 9400,
    cost_per_event_usd: 0.031,
    ...overrides,
  };
}

/** Сравнение v4 (экономия) с v3: не хуже с допуском, токенов −31%. */
export function comparison(overrides: Partial<Comparison> = {}): Comparison {
  return {
    id: 5,
    candidate_run_id: 13,
    baseline_run_id: 12,
    noise_run_id: 11,
    candidate_version_id: 2,
    candidate_code: 'v4',
    baseline_version_id: 1,
    baseline_code: 'v3',
    rule: 'non_inferior',
    n: 250,
    log_loss: { a: 0.612, b: 0.615, diff: 0.003, low: -0.004, high: 0.008, margin: 0.01, ok: true },
    brier: { a: 0.211, b: 0.212, diff: 0.001, low: -0.002, high: 0.004, margin: 0.005, ok: true },
    ece: { a: 0.031, b: 0.035, diff: 0.004, low: -0.006, high: 0.012, margin: 0.02, ok: true },
    format_errors: { a: 0, b: 0, ok: true },
    max_tokens: { a: 0, b: 0, ok: true },
    refusals: { a: 0, b: 0, ok: true },
    cost_per_event: { a: 0.031, b: 0.022, change: -0.29, ok: true },
    tokens_per_event: { a: 9400, b: 6500, change: -0.31, ok: true },
    agreement: { value: 0.94, mean_abs_dp: 0.012, noise_value: 0.95, noise_abs_dp: 0.01, ok: true },
    passed: true,
    verdict: 'not_worse',
    seed: 2026,
    bootstrap: 10000,
    created_at: '2026-10-14T12:00:00Z',
    ...overrides,
  };
}

export function strategyVersion(overrides: Partial<StrategyVersion> = {}): StrategyVersion {
  return {
    id: 1,
    line: 'instructions',
    code: 'v3',
    name: 'v3 · основная',
    status: 'active',
    goal: 'quality',
    parent_id: null,
    parent_code: null,
    changes: ['Инструкции этапа 3'],
    created_at: '2026-10-01T09:00:00Z',
    activated_at: '2026-10-01T09:00:00Z',
    archived_at: null,
    prompt_version: 'analysis.v1+lessons_block.v1:abc',
    base_prompt: 'analysis.v1',
    lessons: [],
    params: null,
    eval: null,
    comparison: null,
    check: null,
    can_activate: false,
    activate_reason: null,
    can_rollback: false,
    ...overrides,
  };
}

/** Активная v3 (два прогона, шум 0,003) и кандидат v4 ради экономии, проверенный. */
export function versionsWithCandidate(): StrategyVersion[] {
  return [
    strategyVersion({ eval: versionEval({ runs: 2, run_ids: [11, 12], noise: 0.003 }) }),
    strategyVersion({
      id: 2,
      code: 'v4',
      name: 'v4 · сжатое досье',
      status: 'candidate',
      goal: 'saving',
      parent_id: 1,
      parent_code: 'v3',
      changes: ['Досье короче на треть', 'Служебные инструкции на английском'],
      created_at: '2026-10-10T09:00:00Z',
      activated_at: null,
      prompt_version: 'analysis.v2+lessons_block.v1:def',
      base_prompt: 'analysis.v2',
      eval: versionEval({ run_ids: [13], log_loss: 0.615, brier: 0.212, ece: 0.035, tokens_per_event: 6500, cost_per_event_usd: 0.022, to_market: { value: 0.017, low: -0.002, high: 0.034, n: 248 } }),
      comparison: comparison(),
      can_activate: true,
    }),
  ];
}

/** Свои правила суммы: действует r2. */
export function ruleVersion(overrides: Partial<StrategyVersion> = {}): StrategyVersion {
  return strategyVersion({
    id: 20,
    line: 'rules',
    code: 'r2',
    name: 'r2 · рост ставки выключен',
    goal: 'rules',
    changes: ['Выключены «Банк +15%» и «Итог 7 дней +10%»'],
    prompt_version: null,
    base_prompt: null,
    ...overrides,
  });
}

/** Исходные правила участника (стратегия этапа 3): на экране — r1. */
export function firstRules(overrides: Partial<StrategyVersion> = {}): StrategyVersion {
  return ruleVersion({
    id: 19,
    code: 'v3',
    name: 'v3 · стратегия этапа 3',
    status: 'archived',
    created_at: '2026-07-01T09:00:00Z',
    archived_at: '2026-10-01T09:00:00Z',
    changes: [],
    ...overrides,
  });
}

export function strategyVersions(overrides: Partial<StrategyVersions> = {}): StrategyVersions {
  return { instructions: [strategyVersion()], rules: [firstRules(), ruleVersion()], eval_set: null, ...overrides };
}

export function evalPlan(overrides: Partial<EvalPlan> = {}): EvalPlan {
  return {
    version_id: 2,
    version_code: 'v4',
    eval_set: evalSet(),
    repeat_no: 1,
    events: 250,
    chunks: 3,
    batch_size: 100,
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    estimate_usd: 3.1,
    estimate_source: 'live',
    worst_usd: 38.5,
    worst_chunk_usd: 11,
    per_event_worst_usd: 0.11,
    budget: { budget_usd: 30, spent_usd: 4.2, reserved_usd: 0, left_usd: 25.8, first_month: true, next_usd: 25 },
    can_run: true,
    reason: null,
    running_run_id: null,
    retry_events: 100,
    set_model: 'claude-opus-5-5',
    set_seen_since: '2026-08-01',
    overlap_lesson: null,
    ...overrides,
  };
}

export function evalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: 13,
    kind: 'eval',
    version_id: 2,
    version_code: 'v4',
    eval_set_code: 'S-2026-08',
    repeat_no: 1,
    status: 'running',
    events: 250,
    chunks_done: 1,
    chunks_total: 3,
    created_at: '2026-10-15T09:00:00Z',
    finished_at: null,
    cost_usd: 1.2,
    worst_usd: 11,
    estimate_usd: 3.1,
    model: 'claude-opus-5-5',
    error: null,
    waiting: null,
    metrics: null,
    seed: null,
    bootstrap: null,
    ...overrides,
  };
}

export function mlVersion(overrides: Partial<MlVersion> = {}): MlVersion {
  return {
    id: 'elo-v1@2026-10-12',
    status: 'active',
    created_at: '2026-10-12T06:12:00Z',
    activated_at: '2026-10-12T06:12:00Z',
    auto: true,
    parent_id: 'elo-v1@2026-10-05',
    train_from: '2024-10-12',
    train_to: '2026-04-30',
    n_train: 4200,
    n_holdout: 1400,
    brier: 0.1942,
    log_loss: 0.571,
    ece: 0.021,
    prev_brier: 0.1951,
    prev_log_loss: 0.573,
    diff_log_loss: { value: -0.002, low: -0.006, high: 0.002, n: 1400 },
    diff_brier: { value: -0.0009, low: -0.002, high: 0.0004, n: 1400 },
    platt_a: 1.02,
    platt_b: -0.01,
    reason: null,
    can_rollback: false,
    ...overrides,
  };
}

export function mlModel(overrides: Partial<MlModel> = {}): MlModel {
  const active = mlVersion();
  return {
    active,
    versions: [
      active,
      mlVersion({ id: 'elo-v1@2026-10-05', status: 'archived', created_at: '2026-10-05T06:12:00Z', activated_at: '2026-10-05T06:12:00Z', brier: 0.1951, log_loss: 0.573, can_rollback: true }),
      mlVersion({ id: 'elo-v1@2026-09-28', status: 'rejected', created_at: '2026-09-28T06:12:00Z', activated_at: null, brier: 0.2013, log_loss: 0.586, reason: 'ml.worse_brier' }),
    ],
    walk_forward: [
      { month: '2026-04-01', n: 410, model_brier: 0.212, model_log_loss: 0.61, market_n: 405, market_brier: 0.198 },
      { month: '2026-05-01', n: 520, model_brier: 0.205, model_log_loss: 0.6, market_n: 515, market_brier: 0.197 },
      { month: '2026-09-01', n: 380, model_brier: 0.201, model_log_loss: 0.59, market_n: 377, market_brier: 0.196 },
    ],
    calibration: [
      { low: 0.5, high: 0.6, n: 300, p: 0.55, actual: 0.54, ci_low: 0.48, ci_high: 0.6 },
      { low: 0.6, high: 0.7, n: 260, p: 0.65, actual: 0.66, ci_low: 0.6, ci_high: 0.72 },
    ],
    events_with_outcome: 21,
    claude_min_events: 300,
    rule: { log_loss_margin: 0.01, brier_margin: 0.005, holdout_share: 0.25 },
    next_run: '2026-10-19',
    ...overrides,
  };
}

export function weeklyReport(overrides: Partial<WeeklyReport> = {}): WeeklyReport {
  return {
    id: 7,
    week_start: '2026-10-05',
    week_end: '2026-10-11',
    created_at: '2026-10-12T04:00:00Z',
    tz: 'Europe/Helsinki',
    currency: 'RUB',
    empty: false,
    bets: { settled: 6, auto: 4, manual: 2, won: 4, lost: 2, void: 0, turnover: '9000', profit: '1240', roi: 0.138, placed: 7, open: 2 },
    clv: { mean: 0.021, n: 5, positive: 4 },
    accuracy: { n: 13, model: 0.198, market: 0.203, diff: -0.005, source: 'pred' },
    calibration: { n: 13, mean_p: 0.71, hit_rate: 0.69 },
    reviews: { done: 6, pending: 1, cost_usd: 0.06 },
    lessons: { new: ['L-021'], confirmed: [], enabled: ['L-004'], retired: [], in_prompt: 3 },
    eval: { spent_usd: 0.61, runs: 1, budget_usd: 30, month_spent_usd: 4.2 },
    model: { id: 'elo-v1@2026-10-05', brier: 0.1942, log_loss: 0.571, recalibrated_at: '2026-10-05T06:12:00Z', recalibration_activated: true },
    shared: null,
    ...overrides,
  };
}

export function weeklyBrief(overrides: Partial<WeeklyReportBrief> = {}): WeeklyReportBrief {
  return {
    id: 7,
    week_start: '2026-10-05',
    week_end: '2026-10-11',
    created_at: '2026-10-12T04:00:00Z',
    empty: false,
    currency: 'RUB',
    settled: 6,
    profit: '1240',
    roi: 0.138,
    clv: 0.021,
    ...overrides,
  };
}

export function weeklyReports(overrides: Partial<WeeklyReports> = {}): WeeklyReports {
  return {
    items: [weeklyBrief(), weeklyBrief({ id: 6, week_start: '2026-09-28', week_end: '2026-10-04', created_at: '2026-10-05T04:00:00Z', settled: 4, profit: '-560', roi: -0.09, clv: -0.004 })],
    next_report: '2026-10-19',
    report_hour: 7,
    ...overrides,
  };
}
