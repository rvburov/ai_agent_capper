import i18n from '../../i18n';
import { formatNumber, formatUsd } from '../../lib/format';
import type { InviteLimit, LimitPatch, UserLimit } from './types';

/*
 * Лимит на ключе администратора: в месяц ($), анализов в день, потолок на один анализ ($).
 * Лимиты по умолчанию для новых участников задает администратор во вкладке «Ключ и бюджет»;
 * формы берут их из API (GET /api/admin/ai/limits → defaults), а не из кода.
 */

/** Лимит по решению Р13 — подсказка «Как решено» и кнопка «Подставить» в лимитах по умолчанию. */
export const R13_LIMIT = { monthly_usd: 10, daily_analyses: 3, per_analysis_usd: 1 } as const;

export interface LimitDraft {
  monthly: string;
  daily: string;
  perAnalysis: string;
}

export type LimitField = keyof LimitDraft;

export const LIMIT_FIELDS: readonly LimitField[] = ['monthly', 'daily', 'perAnalysis'];

/** Сумма для поля ввода: «10», «0,50», «1 000». */
export function amountInput(amount: number | string): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  return formatNumber(n, Number.isInteger(n) ? 0 : 2);
}

/** Поля формы по лимиту (действующему или по умолчанию); нет лимита — пустые поля. */
export function limitDraftOf(limit: LimitLike | null | undefined): LimitDraft {
  if (!limit) return { monthly: '', daily: '', perAnalysis: '' };
  return {
    monthly: amountInput(limit.monthly_usd),
    daily: String(limit.daily_analyses),
    perAnalysis: amountInput(limit.per_analysis_usd),
  };
}

interface LimitLike {
  monthly_usd: number | string;
  daily_analyses: number;
  per_analysis_usd: number | string;
}

/** «12,5», «12.50», «1 000» → число; мусор — null. */
export function parseAmount(text: string): number | null {
  const clean = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  return Number(clean);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface LimitCheck {
  limit: InviteLimit | null;
  errors: Partial<Record<LimitField, true>>;
}

/**
 * Проверка как в макете: в месяц от $1 до $500, анализов в день — целое от 1 до 30,
 * на один анализ — от $0,10 до месячного лимита. Суммы уходят на сервер строкой (Decimal).
 */
export function checkLimit(draft: LimitDraft): LimitCheck {
  const monthly = parseAmount(draft.monthly);
  const dailyText = draft.daily.trim();
  const daily = /^\d+$/.test(dailyText) ? Number(dailyText) : Number.NaN;
  const per = parseAmount(draft.perAnalysis);
  const errors: LimitCheck['errors'] = {};
  const monthlyOk = monthly !== null && monthly >= 1 && monthly <= 500;
  if (!monthlyOk) errors.monthly = true;
  if (!(Number.isInteger(daily) && daily >= 1 && daily <= 30)) errors.daily = true;
  const ceiling = monthlyOk && monthly !== null ? monthly : 500;
  if (!(per !== null && per >= 0.1 && per <= ceiling)) errors.perAnalysis = true;
  if (Object.keys(errors).length || monthly === null || per === null) return { limit: null, errors };
  return {
    limit: {
      monthly_usd: round2(monthly).toFixed(2),
      daily_analyses: daily,
      per_analysis_usd: round2(per).toFixed(2),
    },
    errors,
  };
}

/** Доллары лимита: целые без центов («$10», «$1»), иначе с центами («$1,50»). */
export function formatLimitUsd(amount: number | string): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  return formatUsd(n, Number.isInteger(n) ? 0 : 2);
}


/** «$10 в месяц · 3 анализа в день · $1 на анализ». */
export function limitText(limit: LimitLike): string {
  return i18n.t('admin.limitText', {
    monthly: formatLimitUsd(limit.monthly_usd),
    count: limit.daily_analyses,
    per: formatLimitUsd(limit.per_analysis_usd),
  });
}

/** «$10 · 3 в день · $1» — под режимом ключа в таблице участников. */
export function limitShort(limit: LimitLike): string {
  return i18n.t('admin.limitShort', {
    monthly: formatLimitUsd(limit.monthly_usd),
    daily: limit.daily_analyses,
    per: formatLimitUsd(limit.per_analysis_usd),
  });
}

/**
 * Что поменялось в лимите участника: только измененные поля (PUT /api/admin/ai/limits/{id}).
 * Ничего не поменялось — null.
 */
export function limitPatch(before: UserLimit, after: InviteLimit, paused: boolean): LimitPatch | null {
  const patch: LimitPatch = {};
  if (Number(after.monthly_usd) !== before.monthly_usd) patch.monthly_usd = after.monthly_usd;
  if (after.daily_analyses !== before.daily_analyses) patch.daily_analyses = after.daily_analyses;
  if (Number(after.per_analysis_usd) !== before.per_analysis_usd) patch.per_analysis_usd = after.per_analysis_usd;
  if (paused !== before.paused) patch.paused = paused;
  return Object.keys(patch).length ? patch : null;
}

/** Тот же лимит (лимиты по умолчанию не изменились). */
export function sameLimit(a: LimitLike, b: LimitLike): boolean {
  return (
    Number(a.monthly_usd) === Number(b.monthly_usd) &&
    a.daily_analyses === b.daily_analyses &&
    Number(a.per_analysis_usd) === Number(b.per_analysis_usd)
  );
}

export const BUDGET_MIN = 1;
export const BUDGET_MAX = 5000;

export type BudgetProblem = 'range' | 'belowSpent';

/**
 * Общий бюджет на месяц, как в форме макета: от $1 до $5000 и не меньше уже потраченного
 * (проверяется, только если сумма меняется: сервер так же). Сумма уходит строкой (Decimal).
 */
export function checkBudget(
  text: string,
  { spent, current }: { spent: number; current: number },
): { value: string | null; problem: BudgetProblem | null } {
  const amount = parseAmount(text);
  if (amount === null || amount < BUDGET_MIN || amount > BUDGET_MAX) return { value: null, problem: 'range' };
  const value = round2(amount);
  if (value !== current && value < spent) return { value: null, problem: 'belowSpent' };
  return { value: value.toFixed(2), problem: null };
}
