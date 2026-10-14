import type { TFunction } from 'i18next';

import type { ChipKind, IconName } from '../../components';
import { formatShare } from '../analysis/markets';
import type { StrategyParams } from '../bank/types';
import { param, ruleActing } from '../bank/display';
import type { Adaptation, AdaptationKey, Bank } from '../bank/types';
import { formatOdds, formatPercent, formatPp, formatUsd } from '../../lib/format';
import type { AdminAttention, AiUsage, DashboardPeriod } from './types';

/*
 * Главная (mockup/js/screens/dashboard.js): период, «Размер ставки» в «Требует внимания»,
 * дела администратора, вид расхода на ИИ. Числа — из GET /api/dashboard, GET /api/me/bank и
 * GET /api/ai/budget; здесь — только какие строки показать и с какими подписями.
 */

/** Периоды главной: 7 дней, 30 дней, 3 месяца, все время (по умолчанию 30 дней). */
export const PERIODS: readonly DashboardPeriod[] = ['7d', '30d', '90d', 'all'];
export const DEFAULT_PERIOD: DashboardPeriod = '30d';

// Выбранный период помнится до конца сеанса вкладки, как в макете (capper.dash.period)
const PERIOD_KEY = 'capper.dash.period';

export function readPeriod(): DashboardPeriod {
  try {
    const saved = window.sessionStorage.getItem(PERIOD_KEY);
    return (PERIODS as readonly string[]).includes(saved ?? '') ? (saved as DashboardPeriod) : DEFAULT_PERIOD;
  } catch {
    return DEFAULT_PERIOD;
  }
}

export function savePeriod(period: DashboardPeriod): void {
  try {
    window.sessionStorage.setItem(PERIOD_KEY, period);
  } catch {
    // хранилище недоступно: период живет до перезагрузки
  }
}

// ---------- «Размер ставки»: адаптации Р22 ----------

/** Порядок правил, как в макете: защита банка, затем рост ставки. */
export const RULE_ORDER: readonly AdaptationKey[] = ['dd10', 'dd20', 'week_loss', 'up15', 'week_win'];

export type RuleStatus = 'off' | 'acting' | 'waiting';

export interface RuleRow {
  key: AdaptationKey;
  /** «Просадка от пика −10%». */
  label: string;
  /** «ставка не больше 2,5% банка». */
  effect: string;
  status: RuleStatus;
  /** Условие выполнено сейчас (у выключенного — «сработало бы»). */
  met: boolean;
}

export const RULE_CHIP: Record<RuleStatus, { kind: ChipKind; icon: IconName }> = {
  off: { kind: 'outline', icon: 'pause' },
  acting: { kind: 'warn', icon: 'alert' },
  waiting: { kind: 'info', icon: 'clock' },
};

function share(value: number | null): string {
  return value === null ? '—' : formatShare(Math.abs(value));
}

/** Подпись и действие правила — те же тексты, что в кабинете «Банк и стратегия». */
function ruleTexts(rule: Adaptation, params: StrategyParams | null, t: TFunction): { label: string; effect: string } {
  switch (rule.key) {
    case 'dd10':
    case 'dd20': {
      const from = param(rule, 'from');
      const level = params?.drawdown.find((d) => from !== null && Math.abs(Number(d.start) - from) < 1e-9);
      const max = share(param(rule, 'max_pct'));
      return {
        label: t('profile.bank.adapt.rules.dd.label', { from: share(from) }),
        effect:
          level?.max_legs != null && level.max_leg_odds != null
            ? t('profile.bank.adapt.rules.dd.effectStrict', { max, legs: level.max_legs, odds: formatOdds(level.max_leg_odds) })
            : t('profile.bank.adapt.rules.dd.effect', { max }),
      };
    }
    case 'week_loss':
      return {
        label: t('profile.bank.adapt.rules.week_loss.label', { loss: share(param(rule, 'loss')) }),
        effect: t('profile.bank.adapt.rules.week_loss.effect', { max: share(param(rule, 'max_pct')) }),
      };
    case 'up15':
      return {
        label: t('profile.bank.adapt.rules.up15.label', { up: share(param(rule, 'bank_up')), winrate: share(param(rule, 'min_winrate')) }),
        effect: t('profile.bank.adapt.rules.up15.effect', { max: share(param(rule, 'max_pct')), base: params ? formatShare(params.max_pct) : '—' }),
      };
    case 'week_win':
      return {
        label: t('profile.bank.adapt.rules.week_win.label', { win: share(param(rule, 'win')) }),
        effect: t('profile.bank.adapt.rules.week_win.effect', { add: formatPp(param(rule, 'add') ?? 0) }),
      };
    default:
      return { label: rule.key, effect: '' };
  }
}

/** Правила адаптации со статусом (действует, ждет условия, выключено) в порядке макета. */
export function ruleRows(bank: Bank, params: StrategyParams | null, t: TFunction): RuleRow[] {
  const byKey = new Map(bank.adaptations.map((rule) => [rule.key, rule]));
  return RULE_ORDER.flatMap((key) => {
    const rule = byKey.get(key);
    if (!rule) return [];
    const status: RuleStatus = !rule.enabled ? 'off' : ruleActing(rule) ? 'acting' : 'waiting';
    // met — условие выполнено, по числам сервера (и у выключенного правила: «сработало бы»)
    return [{ key, ...ruleTexts(rule, params, t), status, met: rule.met }];
  });
}

/**
 * «Банк −3,2% от пика, за 7 дней +1,0%, к вложенному +24,6%, винрейт 61,2%». Банка еще нет
 * (ни ставок, ни пополнений) — так и сказано: нулевой банк «на пике» был бы неправдой.
 */
export function bankStateText(bank: Bank, t: TFunction): string {
  if (bank.empty) return t('dashboard.attention.rules.noBank');
  const drawdown = Number(bank.drawdown);
  const parts = [
    drawdown > 0
      ? t('dashboard.attention.rules.fromPeak', { value: formatPercent(-drawdown, { signed: true }) })
      : t('dashboard.attention.rules.atPeak'),
  ];
  if (bank.week_change !== null) parts.push(t('dashboard.attention.rules.week', { value: formatPercent(Number(bank.week_change), { signed: true }) }));
  if (bank.growth !== null) parts.push(t('dashboard.attention.rules.growth', { value: formatPercent(Number(bank.growth), { signed: true }) }));
  if (bank.winrate !== null) parts.push(t('dashboard.attention.rules.winrate', { value: formatPercent(Number(bank.winrate)) }));
  return parts.join(', ');
}

/**
 * «Сейчас ставка не больше 2,5% банка.» Действие, которое кончается сокращением («ставка
 * +0,5 п.п.»), закрывает предложение своей точкой — вторая не нужна.
 */
export function actingNowText(acting: readonly RuleRow[], t: TFunction): string {
  const effects = acting.map((row) => row.effect).join('; ');
  return t(effects.endsWith('.') ? 'dashboard.attention.rules.actingNowAbbr' : 'dashboard.attention.rules.actingNow', { effects });
}

// ---------- дела администратора ----------

/**
 * Дела администратора одной строкой на дело (adminTodo макета): просьбы вернуть ключ и участники
 * у порога или у 100% месячного лимита. Только расход на ИИ (Р14).
 */
export function adminTodo(admin: AdminAttention, t: TFunction): string[] {
  const out = admin.return_requests.map((item) => t('dashboard.attention.admin.returnKey', { name: item.name }));
  for (const item of admin.limits) {
    out.push(
      t('dashboard.attention.admin.limit', {
        name: item.name,
        pct: formatPercent(item.share, { digits: 0 }),
        spent: formatUsd(item.spent_usd),
        limit: formatUsd(item.limit_usd, Number.isInteger(item.limit_usd) ? 0 : 2),
      }),
    );
  }
  return out;
}

// ---------- расход на ИИ ----------

/**
 * Самая дорогая задача месяца («Дороже всего») и ее доля в расходе (share с сервера): задачи
 * сервер присылает по убыванию цены. Нет расхода или доли — null.
 */
export function topKind(usage: AiUsage): { kind: string; share: number } | null {
  const top = usage.kinds[0];
  if (!top || !(top.cost_usd > 0) || top.share === null || top.share === undefined) return null;
  return { kind: top.kind, share: top.share };
}

/** Лимиты и потолки: «$10», но «$1,50» — как на остальных экранах. */
export function usdLimit(value: number): string {
  return formatUsd(value, Number.isInteger(value) ? 0 : 2);
}
