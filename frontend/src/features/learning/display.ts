import type { TFunction } from 'i18next';

import type { ChipKind, IconName } from '../../components';
import { formatInterval, formatNumber, formatOdds } from '../../lib/format';
import type { Lesson, LessonEstimate, LessonFeature, LessonStatus, ScopeCondition } from './types';

/*
 * Вкладка «Уроки» (lessonsPanel макета learning.js): какие уроки показать, метки статусов,
 * условие из словаря словами и подписи чисел проверки. Числа (случаи, смещение, лог-лосс с
 * ДИ, поправка с усадкой, быстрая проверка) считает сервер; здесь — только выбор и подписи.
 */

// ---------- фильтр ----------

export const LESSON_FILTERS = ['all', 'confirmed', 'ready', 'hypothesis', 'off'] as const;
export type LessonFilter = (typeof LESSON_FILTERS)[number];

/** Урок попадает в группу фильтра: «Отклонены» — и отклоненные, и списанные. */
export function inFilter(lesson: Pick<Lesson, 'status'>, filter: LessonFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'off':
      return lesson.status === 'rejected' || lesson.status === 'retired';
    default:
      return lesson.status === filter;
  }
}

// Порядок карточек, как в макете: ждут решения, подтвержденные, гипотезы, отклоненные,
// списанные; внутри статуса — порядок сервера (новые выше)
const STATUS_ORDER: Record<LessonStatus, number> = { ready: 0, confirmed: 1, hypothesis: 2, rejected: 3, retired: 4 };

/** Уроки в порядке макета; сортировка устойчивая — внутри статуса порядок сервера. */
export function sortLessons<T extends Pick<Lesson, 'status'>>(lessons: readonly T[]): T[] {
  return lessons
    .map((lesson, index) => ({ lesson, index }))
    .sort((a, b) => STATUS_ORDER[a.lesson.status] - STATUS_ORDER[b.lesson.status] || a.index - b.index)
    .map((row) => row.lesson);
}

/** Сколько уроков в каждой группе фильтра. */
export function filterCounts(lessons: readonly Pick<Lesson, 'status'>[]): Record<LessonFilter, number> {
  const out = { all: 0, confirmed: 0, ready: 0, hypothesis: 0, off: 0 } satisfies Record<LessonFilter, number>;
  for (const lesson of lessons) for (const filter of LESSON_FILTERS) if (inFilter(lesson, filter)) out[filter] += 1;
  return out;
}

// ---------- статусы ----------

export const LESSON_CHIP: Record<LessonStatus, { kind: ChipKind; icon: IconName }> = {
  confirmed: { kind: 'good', icon: 'check' },
  ready: { kind: 'accent', icon: 'clock' },
  hypothesis: { kind: 'info', icon: 'flask' },
  rejected: { kind: 'bad', icon: 'x' },
  retired: { kind: 'outline', icon: 'history' },
};

/** Полоса слева у карточки: «ждет решения» — как подтвержденный, списанный — как отклоненный. */
export function lessonTone(status: LessonStatus): 'confirmed' | 'hypothesis' | 'rejected' {
  if (status === 'ready' || status === 'confirmed') return 'confirmed';
  if (status === 'hypothesis') return 'hypothesis';
  return 'rejected';
}

// ---------- условие из словаря ----------

// Значения рынка — ключи локали без точек и знаков: «HCP_-1.5» → minus
const MARKET_VALUE: Readonly<Record<string, string>> = { ML: 'ml', 'HCP_-1.5': 'minus', 'HCP_+1.5': 'plus' };

/** Значение перечня словами: «хард», «П1 / П2», «1/4 финала»; незнакомое — как есть. */
export function scopeValueText(feature: string, value: string, t: TFunction): string {
  const key = feature === 'market' ? MARKET_VALUE[value] : value;
  if (!key) return value;
  // значения приходят из словаря сервера: ключ локали собирается из строки, неизвестный — как есть
  const loose = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return loose(`learning.scope.values.${feature}.${key}`, { defaultValue: value });
}

/** Число условия: кэф — как кэф («2.60»), остальное — целым или с нужными знаками. */
export function scopeNumberText(feature: string, value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (feature === 'odds') return formatOdds(value);
  return formatNumber(value, Number.isInteger(value) ? 0 : 2);
}

/** Условие одной строкой: «покрытие: хард, грунт», «разница Эло меньше 120». */
export function conditionText(condition: ScopeCondition, t: TFunction): string {
  const feature = t(`learning.scope.features.${condition.feature}`);
  if (condition.op === 'in' || condition.op === 'eq') {
    const values = (condition.values ?? []).map((value) => scopeValueText(condition.feature, value, t));
    return t('learning.scope.enum', { feature, values: values.join(', ') });
  }
  return t('learning.scope.number', {
    feature,
    op: t(`learning.scope.ops.${condition.op}`),
    value: scopeNumberText(condition.feature, condition.value),
  });
}

/** Подпись признака в форме: «Кэф стороны на победу». */
export function featureLabel(feature: LessonFeature['feature'], t: TFunction): string {
  return t(`learning.scope.featureLabels.${feature}`);
}

// ---------- числа словами ----------

/** Число с существительным в нужной форме: «34 матча», «на 21 матче», «с 20 своих случаев». */
export type PluralKey = 'matches' | 'onMatches' | 'onCases' | 'fromCases';

export function plural(t: TFunction, key: PluralKey, count: number): string {
  return t(`learning.plural.${key}`, { count, n: formatNumber(count) });
}

// ---------- числа проверки ----------

/** Лог-лосс и Brier различаются в третьем знаке: «0,612». */
export function dec3(value: number | null | undefined): string {
  return formatNumber(value, 3);
}

/** Разница со знаком: «+0,012», «−0,004». */
export function signed3(value: number | null | undefined): string {
  return formatNumber(value, 3, { signed: true });
}

/** 95% ДИ разницы: «−0,012…+0,005». */
export function ci3(estimate: Pick<LessonEstimate, 'low' | 'high'> | null | undefined): string {
  return formatInterval(estimate?.low, estimate?.high, signed3);
}

/** Почему проверка на истории не подтвердила урок (history.reason). */
export const HISTORY_REASONS = ['direction', 'no_bias', 'no_gain', 'holdout', 'few_history', 'no_history'] as const;
export type HistoryReason = (typeof HISTORY_REASONS)[number];

export function historyReason(code: string | null | undefined): HistoryReason | null {
  return (HISTORY_REASONS as readonly string[]).includes(code ?? '') ? (code as HistoryReason) : null;
}

/**
 * Случаи урока по ставкам всех участников: число — администратору всегда, участнику — с
 * пяти (сервер, n_cases); меньше — «меньше 5 случаев»: по малому числу вычислялась бы чужая
 * ставка (n_cases = null).
 */
export function casesText(lesson: Pick<Lesson, 'n_cases'>, t: TFunction): string {
  return lesson.n_cases === null ? t('learning.lessons.casesFew') : t('learning.lessons.cases', { count: lesson.n_cases });
}

/** «21 случай + 412 из архива · из них ваших 2»: основание проверки. */
export function baseText(lesson: Pick<Lesson, 'n_cases' | 'n_hist' | 'own_cases'>, t: TFunction): string {
  const cases = casesText(lesson, t);
  const base = lesson.n_hist ? t('learning.lessons.baseWithHist', { own: cases, hist: formatNumber(lesson.n_hist) }) : cases;
  return lesson.own_cases > 0 ? t('learning.lessons.baseYours', { base, n: formatNumber(lesson.own_cases) }) : base;
}

// ---------- быстрая проверка ----------

/**
 * Состояние быстрой проверки урока: none — не было; running — пакет в работе; failed — прогон не
 * удался; passed — не хуже, ждет решения; worse — с уроком хуже или ошибки формата; reset —
 * прошла «не хуже», но урок выключали (сервер ставит passed = false при тех же числах): для
 * включения нужна новая; stale — прошла раньше последней проверки на истории: тоже нужна новая.
 */
export type QuickState = 'none' | 'running' | 'failed' | 'passed' | 'worse' | 'reset' | 'stale';

export function quickState(lesson: Pick<Lesson, 'quick' | 'validated_at'>): QuickState {
  const quick = lesson.quick;
  if (!quick) return 'none';
  if (quick.status === 'pending' || quick.status === 'running') return 'running';
  if (quick.status === 'failed') return 'failed';
  const worse =
    quick.diff === null || quick.diff.high > quick.margin || quick.format_errors > 0 || quick.unrated > 0;
  if (!quick.passed && worse) return 'worse';
  const stale =
    lesson.validated_at !== null && quick.finished_at !== null && Date.parse(quick.finished_at) < Date.parse(lesson.validated_at);
  if (stale) return 'stale';
  return quick.passed ? 'passed' : 'reset';
}

/**
 * Что показать в окне «Урок … в анализ»: intro — цена и запуск; running — пакет в работе;
 * passed — не хуже, ждет решения; worse — с уроком хуже или ошибки формата; failed — прогон
 * не удался. Прошлая проверка старше проверки на истории или сброшенная выключением урока
 * (passed = false при числах «не хуже») — снова intro: нужна новая.
 */
export type QuickView = 'intro' | 'running' | 'passed' | 'worse' | 'failed';

export function quickView(lesson: Pick<Lesson, 'quick' | 'validated_at'>): QuickView {
  const state = quickState(lesson);
  if (state === 'none' || state === 'reset' || state === 'stale') return 'intro';
  // «хуже» старше проверки на истории — тоже снова запуск
  if (state === 'worse' && isStale(lesson)) return 'intro';
  return state;
}

function isStale(lesson: Pick<Lesson, 'quick' | 'validated_at'>): boolean {
  const finished = lesson.quick?.finished_at ?? null;
  return lesson.validated_at !== null && finished !== null && Date.parse(finished) < Date.parse(lesson.validated_at);
}

/** Код причины с сервера («lesson.quick_check_budget») — ключ локали без точек. */
export function reasonKey(code: string): string {
  return code.replace(/[^a-z0-9_]/gi, '_');
}
