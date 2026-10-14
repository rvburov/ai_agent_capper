import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { isApiError } from '../../api/errors';
import { parseAmount } from '../analysis/amount';
import { codeText } from '../analysis/codes';
import { playKeys, refreshAfterCurrencyChange } from './currency';
import type { PlayLimits, PlayLimitsIn } from './types';

/*
 * Ответственная игра (В8): лимиты числа и суммы ставок в день и пауза (GET/PUT
 * /api/me/play-limits, POST /api/me/pause). Что сейчас блокирует ставки и анализы, сколько
 * поставлено сегодня и когда вступит повышение — считает сервер; здесь — запросы, разбор полей
 * и выбор текста.
 */

export { playKeys, refreshAfterCurrencyChange };

/** Лимиты, пауза и «сегодня» участника. */
export function usePlayLimits() {
  return useQuery({
    queryKey: playKeys.limits,
    queryFn: () => unwrap(api.GET('/api/me/play-limits')),
    staleTime: 30_000,
  });
}

function usePlayMutation<V>(request: (value: V) => Promise<PlayLimits>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => client.setQueryData(playKeys.limits, data),
    onError: (error) => {
      refreshAfterCurrencyChange(client, error);
      // Пауза короче действующей: на экране, видимо, старое состояние — перечитать
      if (isApiError(error) && error.code === 'play.pause_shorter') void client.invalidateQueries({ queryKey: playKeys.limits });
    },
  });
}

/** «Сохранить лимиты»: строже — сразу, мягче — через 24 часа (pending). */
export function useSavePlayLimits() {
  return usePlayMutation((body: PlayLimitsIn) => unwrap(api.PUT('/api/me/play-limits', { body })));
}

/** «Взять паузу»: 1, 7, 30 или 90 дней, досрочно не снимается. */
export function useTakePause() {
  return usePlayMutation((days: PauseDays) => unwrap(api.POST('/api/me/pause', { body: { days } })));
}

export type PauseDays = 1 | 7 | 30 | 90;
export const PAUSE_DAYS: readonly PauseDays[] = [1, 7, 30, 90];

export function isPauseDays(value: number): value is PauseDays {
  return (PAUSE_DAYS as readonly number[]).includes(value);
}

// ---------- поля формы ----------

export type LimitFieldError = 'count' | 'amount';

export interface LimitDraft {
  count: string;
  amount: string;
}

/**
 * Поля лимитов → тело PUT. Пустое поле — без лимита (так сервер хранит лимит по умолчанию).
 * Число ставок — целое от 1 до max, сумма — больше нуля, 2 знака.
 */
export function parseLimits(
  draft: LimitDraft,
  max: number,
): { body: Pick<PlayLimitsIn, 'bets_per_day' | 'stake_per_day'> } | { errors: LimitFieldError[] } {
  const errors: LimitFieldError[] = [];
  const countText = draft.count.replace(/\s/g, '');
  let count: number | null = null;
  if (countText) {
    count = /^\d+$/.test(countText) ? Number(countText) : Number.NaN;
    if (!Number.isInteger(count) || count < 1 || count > max) errors.push('count');
  }
  const amountText = draft.amount.trim();
  let amount: string | null = null;
  if (amountText) {
    const value = parseAmount(amountText);
    if (value === null || value >= 1e10 || /^\s*[-−–]/.test(amountText)) errors.push('amount');
    else amount = value.toFixed(2);
  }
  return errors.length ? { errors } : { body: { bets_per_day: count, stake_per_day: amount } };
}

function sameMoney(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return Number(a) === Number(b);
}

/**
 * Поля формы равны действующим лимитам. Такой PUT сервер понимает как «без смягчений» и
 * отменяет ждущее повышение — поэтому форма его не отправляет (отмена — своей кнопкой).
 */
export function sameAsCurrent(body: Pick<PlayLimitsIn, 'bets_per_day' | 'stake_per_day'>, limits: PlayLimits): boolean {
  return (body.bets_per_day ?? null) === limits.bets_per_day && sameMoney(body.stake_per_day, limits.stake_per_day);
}

/** Что изменилось после сохранения: снижено сразу, повышение ждет, повышение отменено, ничего. */
export function savedOutcome(
  before: PlayLimits,
  after: PlayLimits,
): 'pending' | 'pendingAndLowered' | 'lowered' | 'cancelled' | 'same' {
  const lowered = before.bets_per_day !== after.bets_per_day || !sameMoney(before.stake_per_day, after.stake_per_day);
  const pendingChanged =
    after.pending !== null &&
    (before.pending === null ||
      before.pending.starts_at !== after.pending.starts_at ||
      before.pending.bets_per_day !== after.pending.bets_per_day ||
      !sameMoney(before.pending.stake_per_day, after.pending.stake_per_day));
  if (pendingChanged) return lowered ? 'pendingAndLowered' : 'pending';
  if (lowered) return 'lowered';
  if (before.pending !== null && after.pending === null) return 'cancelled';
  return 'same';
}

/** Запрос без смягчений отменяет ждущее повышение: те же действующие лимиты еще раз. */
export function cancelPendingBody(limits: PlayLimits): PlayLimitsIn {
  return { bets_per_day: limits.bets_per_day, stake_per_day: limits.stake_per_day, currency: limits.currency };
}

/** Какая часть ждущего повышения мягче действующей: число, сумма (null — снять лимит). */
export function pendingParts(limits: PlayLimits): { count?: number | null; amount?: string | null } {
  const pending = limits.pending;
  if (!pending) return {};
  const parts: { count?: number | null; amount?: string | null } = {};
  if (pending.bets_per_day !== limits.bets_per_day) parts.count = pending.bets_per_day;
  if (!sameMoney(pending.stake_per_day, limits.stake_per_day)) parts.amount = pending.stake_per_day;
  return parts;
}

// ---------- даты паузы ----------

const DAY_MS = 86_400_000;

export { pauseLastDay } from './pauseDay';

/** Сегодняшняя дата в поясе: «2026-10-14». */
function todayIn(timeZone: string | undefined, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Последний день паузы, которую предлагают взять (до ответа сервера): сегодня по поясу
 * участника плюс days — как считает сервер (pause в services/play_limits.py). Календарный
 * день «2026-10-21» — formatDateLong показывает его без сдвига поясом.
 */
export function pausePreviewDay(days: number, timeZone: string | undefined, now: Date = new Date()): string {
  const today = todayIn(timeZone, now);
  const day = new Date(Date.parse(`${today}T12:00:00Z`) + days * DAY_MS);
  return day.toISOString().slice(0, 10);
}

/** Доля лимита для полосы: у порога (≥ 75%) — предупреждение, исчерпан — красная. */
export function usageKind(value: number, max: number): 'warn' | 'bad' | undefined {
  if (max <= 0) return undefined;
  if (value >= max) return 'bad';
  return value / max >= 0.75 ? 'warn' : undefined;
}

/**
 * Что сейчас закрывает новые ставки и анализы (blocked с сервера) — тем же текстом, что
 * ошибка сервера при попытке: «Перед запуском» говорит об этом до нажатия, а не после.
 */
export function playBlockedText(limits: PlayLimits | undefined): string | null {
  if (!limits?.blocked) return null;
  const until = limits.blocked_until ?? limits.paused_until;
  if (limits.blocked === 'paused') return codeText('play.paused', { until });
  if (limits.blocked === 'bets_limit') return codeText('play.bets_limit', { until, limit: limits.bets_per_day });
  return codeText('play.stake_used', { until, limit: limits.stake_per_day, currency: limits.currency });
}
