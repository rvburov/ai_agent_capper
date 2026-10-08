import i18n from '../../i18n';
import { formatUsd } from '../../lib/format';
import type { InviteLimit } from './types';

/*
 * Стартовый лимит в приглашении: в месяц ($), анализов в день, потолок на один анализ ($).
 * Значения по умолчанию совпадают с настройками программы из миграции 0001
 * (app_settings: $10, 3 в день, $1). Своего адреса API у этих настроек пока нет —
 * он появится вместе с вкладкой «Ключ и бюджет» (этап 3), тогда форма возьмет их оттуда.
 */
export const DEFAULT_LIMIT = { monthly: 10, daily: 3, perAnalysis: 1 } as const;

export interface LimitDraft {
  monthly: string;
  daily: string;
  perAnalysis: string;
}

export type LimitField = keyof LimitDraft;

export function defaultLimitDraft(): LimitDraft {
  return {
    monthly: String(DEFAULT_LIMIT.monthly),
    daily: String(DEFAULT_LIMIT.daily),
    perAnalysis: String(DEFAULT_LIMIT.perAnalysis),
  };
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

interface LimitLike {
  monthly_usd: number | string;
  daily_analyses: number;
  per_analysis_usd: number | string;
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
