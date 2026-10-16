import type { TFunction } from 'i18next';

import type { ChipKind, IconName } from '../../components';
import { formatInterval, formatNumber, formatPercent, formatPp } from '../../lib/format';
import { reasonKey } from './display';
import type { CiNum, Comparison, EvalRun, MetricDiff, VersionStatus } from './types';

/*
 * Подписи вкладок «Версии стратегии» и «Базовая модель» (versionsPanel и mlPanel макета):
 * метки статусов, причины отказа сервера словами, разницы с ДИ. Числа (лог-лосс, Brier, ECE,
 * разницы и ДИ бутстрэпа, решение по правилу) считает сервер (Т15); здесь — только вид.
 */

export const VERSION_CHIP: Record<VersionStatus, { kind: ChipKind; icon: IconName }> = {
  active: { kind: 'good', icon: 'check' },
  candidate: { kind: 'info', icon: 'flask' },
  archived: { kind: 'outline', icon: 'history' },
  rejected: { kind: 'outline', icon: 'x' },
};

export { findActive, findCandidate, newestFirst, versionShort } from './versionList';

// ---------- числа ----------

/** Лог-лосс и Brier различаются в третьем знаке: «0,612». */
export const dec3 = (value: number | null | undefined) => formatNumber(value, 3);
/** Brier версий модели различается в четвертом знаке: «0,1942». */
export const dec4 = (value: number | null | undefined) => formatNumber(value, 4);
/** Разница со знаком: «+0,012», «−0,004». */
export const signed3 = (value: number | null | undefined) => formatNumber(value, 3, { signed: true });
/** 95% ДИ разницы: «−0,012…+0,005». */
export const ci3 = (low: number | null | undefined, high: number | null | undefined) => formatInterval(low, high, signed3);
export const ciNum3 = (ci: Pick<CiNum, 'low' | 'high'> | null | undefined) => ci3(ci?.low, ci?.high);

/** ECE — доля: 0,021 → «2,1%» (везде со знаком процента); разница — в п.п. */
export const ecePct = (value: number | null | undefined) => formatPercent(value, { digits: 1 });
export const eceDiff = (value: number | null | undefined) => formatPp(value);

/** «≈ 9,4 тыс.» токенов на анализ; нет — прочерк. */
export function tokensText(value: number | null | undefined, t: TFunction): string {
  if (value === null || value === undefined) return '—';
  return t('learning.versions.tokens', { n: formatNumber(value / 1000, 1) });
}

// ---------- причины отказа ----------

const loose = (t: TFunction) => t as unknown as (key: string, options: Record<string, unknown>) => string;

/** Почему версию нельзя включить (activate_reason) или прогон нельзя запустить (reason плана). */
export function reasonText(code: string | null | undefined, t: TFunction, params: Record<string, unknown> = {}): string {
  if (!code) return '';
  return loose(t)(`learning.reasons.${reasonKey(code)}`, { ...params, defaultValue: t('learning.reasons.other') });
}

/** Почему прогон закончился без итога (error прогона): «canceled», «budget», «version_closed». */
export function runErrorText(run: Pick<EvalRun, 'error'>, t: TFunction): string {
  return loose(t)(`learning.eval.errors.${reasonKey(run.error ?? 'other')}`, { defaultValue: t('learning.eval.errors.other') });
}

// ---------- сравнение версий ----------

export type CompareKey = 'log_loss' | 'brier' | 'ece' | 'format_errors' | 'tokens' | 'cost';

export interface CompareRow {
  key: CompareKey;
  a: string;
  b: string;
  diff: string;
  ci: string | null;
  tolerance: string | null;
  ok: boolean | null;
}

function metricRow(key: 'log_loss' | 'brier' | 'ece', m: MetricDiff, rule: Comparison['rule'], t: TFunction): CompareRow {
  const value = key === 'ece' ? ecePct : dec3;
  const diff = key === 'ece' ? eceDiff : signed3;
  let ci: string | null = null;
  if (m.low !== null && m.high !== null) {
    ci =
      key === 'ece'
        ? t('learning.compare.ciPp', { ci: formatInterval(m.low, m.high, (v) => formatPp(v, { unit: false })) })
        : t('learning.compare.ci', { ci: ci3(m.low, m.high) });
  }
  // у правила улучшения допуска нет (margin 0): ДИ разницы лог-лосса должен быть ниже нуля
  let tolerance: string | null = null;
  if (m.margin !== null && m.margin !== 0) tolerance = t('learning.compare.tolerance', { value: key === 'ece' ? eceDiff(m.margin) : signed3(m.margin) });
  else if (m.margin === 0 && key === 'log_loss' && rule === 'improve') tolerance = t('learning.compare.belowZero');
  return { key, a: value(m.a), b: value(m.b), diff: diff(m.diff), ci, tolerance, ok: m.ok };
}

/**
 * Строки сравнения кандидата с базой: лог-лосс, Brier, ECE — с ДИ и допуском правила
 * экономии (у правила улучшения допуск только у лог-лосса — «ниже нуля»), ошибки формата,
 * токены и цена на событие по логам прогонов.
 */
export function compareRows(c: Comparison, t: TFunction): CompareRow[] {
  const rows = [metricRow('log_loss', c.log_loss, c.rule, t), metricRow('brier', c.brier, c.rule, t), metricRow('ece', c.ece, c.rule, t)];
  rows.push({
    key: 'format_errors',
    a: t('learning.compare.ofN', { value: formatNumber(c.format_errors.a), n: formatNumber(c.n) }),
    b: t('learning.compare.ofN', { value: formatNumber(c.format_errors.b), n: formatNumber(c.n) }),
    diff: formatNumber(c.format_errors.b - c.format_errors.a, 0, { signed: true }),
    ci: null,
    tolerance: null,
    ok: c.format_errors.ok,
  });
  if (c.tokens_per_event.a !== null || c.tokens_per_event.b !== null) {
    rows.push({
      key: 'tokens',
      a: tokensText(c.tokens_per_event.a, t),
      b: tokensText(c.tokens_per_event.b, t),
      diff: c.tokens_per_event.change !== null ? formatNumber(c.tokens_per_event.change * 100, 0, { signed: true }) + '%' : '—',
      ci: t('learning.compare.byLogs'),
      tolerance: null,
      ok: c.tokens_per_event.ok,
    });
  }
  return rows;
}

/** Вывод по строке: «не хуже» / «лучше» / «хуже»; у токенов — «дешевле» / «дороже». */
export type VerdictWord = 'notWorse' | 'worse' | 'better' | 'notBetter' | 'notMore' | 'more' | 'cheaper' | 'pricier';

export function rowVerdict(row: CompareRow, rule: Comparison['rule']): { text: VerdictWord; kind: ChipKind; icon: IconName } | null {
  if (row.ok === null) return null;
  if (row.key === 'tokens' || row.key === 'cost') return row.ok ? { text: 'cheaper', kind: 'good', icon: 'check' } : { text: 'pricier', kind: 'warn', icon: 'alert' };
  if (row.key === 'format_errors') return row.ok ? { text: 'notMore', kind: 'good', icon: 'check' } : { text: 'more', kind: 'bad', icon: 'x' };
  if (rule === 'improve' && row.key === 'log_loss') return row.ok ? { text: 'better', kind: 'good', icon: 'check' } : { text: 'notBetter', kind: 'outline', icon: 'info' };
  return row.ok ? { text: 'notWorse', kind: 'good', icon: 'check' } : { text: 'worse', kind: 'bad', icon: 'x' };
}

/** Итог кода по сравнению: better, not_worse, worse, noise, failed. */
export const VERDICT_CALLOUT: Record<Comparison['verdict'], { kind: 'good' | 'warn' | 'bad' | 'info'; icon: IconName }> = {
  better: { kind: 'good', icon: 'check' },
  not_worse: { kind: 'good', icon: 'check' },
  noise: { kind: 'info', icon: 'info' },
  worse: { kind: 'bad', icon: 'x' },
  failed: { kind: 'bad', icon: 'alert' },
};
