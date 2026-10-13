import { parseAmount } from '../analysis/amount';
import { moneyRules, stakeForShare } from '../analysis/stake';
import type { Adaptation, AdaptationKey, Bank, MoveKind, StrategyParams } from './types';

/*
 * Вкладка «Банк и стратегия»: разбор суммы движения банка, строки правил стратегии и статус
 * адаптаций. Банк, просадку, рост и итог недели считает сервер (GET /api/me/bank); здесь —
 * только вид: какие строки показать и с какими числами из ответа.
 */

// ---------- движение банка ----------

export type MoveError = 'empty' | 'positive' | 'zero' | 'tooBig';

/** Сумма из поля: пополнение и вывод — больше нуля, корректировка — со знаком («−500»). */
export function parseMove(kind: MoveKind, text: string): { amount: string } | { error: MoveError } {
  const trimmed = text.trim().replace(/^[−–—]/, '-');
  if (!trimmed || !/\d/.test(trimmed)) return { error: 'empty' };
  const negative = trimmed.startsWith('-');
  const value = parseAmount(trimmed.replace(/^[-+]/, ''));
  if (value === null) return { error: kind === 'correction' ? 'zero' : 'positive' };
  if (value >= 1e10) return { error: 'tooBig' };
  if (negative && kind !== 'correction') return { error: 'positive' };
  const fixed = value.toFixed(2);
  if (Number(fixed) === 0) return { error: kind === 'correction' ? 'zero' : 'positive' };
  return { amount: negative ? `-${fixed}` : fixed };
}

// ---------- правила стратегии ----------

export interface StakeRow {
  low: string;
  high: string;
  pct: number;
  /** Диапазон только для экспресса из 3 событий (выше итогового кэфа экспресса из 2). */
  triple: boolean;
  /** Сумма ставки сейчас (по капиталу, вниз до шага округления стратегии). */
  stake: number | null;
}

export function stakeRows(params: StrategyParams, equity: number | null, currency: string): StakeRow[] {
  const doubleMax = Number(params.double_total[1] ?? '0');
  const rules = moneyRules(currency, params);
  return params.stake_bands.map((band) => {
    const pct = Number(band.pct);
    return {
      low: band.low,
      high: band.high,
      pct,
      triple: Number(band.low) > doubleMax,
      stake: equity !== null && equity > 0 ? stakeForShare(equity, pct, rules) : null,
    };
  });
}

export type ValueTier = 'strong' | 'good' | 'small' | 'none';

export interface ValueRow {
  tier: ValueTier;
  /** Перевес от, % (null — «меньше» нижнего порога). */
  from: number | null;
  /** Перевес до, % включительно (null — без верхней границы). */
  to: number | null;
  add: number;
}

const TIERS: readonly ValueTier[] = ['strong', 'good', 'small', 'none'];

/** Поправка ставки на валуй по порогам перевеса (value_adjust стратегии), сверху — сильный. */
export function valueRows(params: StrategyParams): ValueRow[] {
  const items = [...params.value_adjust].sort((a, b) => (b.min_value === null ? -1 : a.min_value === null ? 1 : Number(b.min_value) - Number(a.min_value)));
  let prev: number | null = null;
  return items.map((item, i) => {
    const from = item.min_value === null ? null : Math.round(Number(item.min_value) * 100);
    const row: ValueRow = {
      tier: item.min_value === null ? 'none' : (TIERS[i] ?? 'small'),
      from,
      to: prev === null ? null : prev - 1,
      add: Number(item.add),
    };
    if (from !== null) prev = from;
    else row.to = prev;
    return row;
  });
}

// ---------- адаптации (Р22, В7) ----------

/** Защита банка и рост ставки — две группы карточки «Адаптации ставки». */
export const PROTECTION: readonly AdaptationKey[] = ['dd10', 'dd20', 'week_loss'];
export const GROWTH: readonly AdaptationKey[] = ['up15', 'week_win'];

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Число из params адаптации: «0.10» → 0.1. */
export function param(rule: Adaptation, name: string): number | null {
  return num(rule.params[name]);
}

/**
 * Выполнено ли условие правила сейчас — для выключенного правила («с правилом оно бы
 * действовало»): у включенного это уже active из ответа сервера. Сравниваются числа банка
 * из ответа сервера с порогами правила.
 */
export function conditionMet(rule: Adaptation, bank: Bank): boolean {
  if (rule.enabled) return rule.active;
  const drawdown = num(bank.drawdown);
  const week = num(bank.week_change);
  const growth = num(bank.growth);
  const winrate = num(bank.winrate);
  switch (rule.key) {
    case 'dd10':
    case 'dd20': {
      const from = param(rule, 'from');
      return drawdown !== null && from !== null && drawdown >= from;
    }
    case 'week_loss': {
      const loss = param(rule, 'loss');
      return week !== null && loss !== null && week <= loss;
    }
    case 'week_win': {
      const win = param(rule, 'win');
      return week !== null && win !== null && week >= win;
    }
    case 'up15': {
      const up = param(rule, 'bank_up');
      const min = param(rule, 'min_winrate');
      return growth !== null && winrate !== null && up !== null && min !== null && growth >= up && winrate >= min;
    }
    default:
      return false;
  }
}

/**
 * Правило сейчас действует — чип «Действует сейчас». Сервер отмечает active только у самого
 * строгого из правил просадки (при −25% — у −20%), но порог −10% при этом тоже пройден: как в
 * макете (adaptCard), действующими показаны оба. Остальное — active из ответа сервера.
 */
export function ruleActing(rule: Adaptation, bank: Bank): boolean {
  if (!rule.enabled) return false;
  if (rule.active) return true;
  if (rule.key !== 'dd10' && rule.key !== 'dd20') return false;
  const drawdown = num(bank.drawdown);
  const from = param(rule, 'from');
  return drawdown !== null && from !== null && drawdown >= from;
}

/** Шкала просадки 0–25% с отметками порогов −10% и −20% (как в макете). */
export const DRAWDOWN_SCALE = 0.25;
