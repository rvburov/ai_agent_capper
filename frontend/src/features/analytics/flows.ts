import type { TFunction } from 'i18next';

import type { ChartMark } from '../../components/charts';
import { formatDate, formatMoney, type Currency } from '../../lib/format';
import type { PeriodStart } from './display';
import type { Series } from './types';

/*
 * «Банк по дням» по В7 этапа 5 (главная и «Аналитика», Р25): пунктир «вложено» ступенькой и
 * отметки пополнений и выводов. Числа — с сервера (ряд банка SeriesOut): «вложено» на каждый
 * день (points[].invested — старт периода плюс пополнения минус выводы внутри периода),
 * движения банка внутри периода (flows) и их сумма (flows_total). Экран только рисует.
 * Если «вложено» за день не пришло (null), берется старт периода — ровная линия.
 */

/** Движение банка внутри периода: день (по поясу участника), вид, сумма со знаком. */
export type BankFlow = Series['flows'][number];
export type FlowKind = BankFlow['kind'];

export interface BankSteps {
  /** «Вложено» на каждый день ряда (points начала периода) — ступенька. */
  invested: number[];
  /** Пополнения, выводы и корректировки внутри периода. */
  flows: readonly BankFlow[];
  /** Сумма движений за период; null — их не было. */
  flowSum: string | null;
}

/** Ступенька «вложено» и движения банка периода; у ряда результата — пусто. */
export function bankSteps(series: Series, start: PeriodStart): BankSteps {
  if (series.kind !== 'bank') return { invested: [], flows: [], flowSum: null };
  const base = Number(start.amount);
  const sum = series.flows_total;
  return {
    invested: start.points.map((point) => (point.invested === null ? base : Number(point.invested))),
    flows: series.flows,
    flowSum: Number(sum) !== 0 ? sum : null,
  };
}

/** Подпись движения: «+20 000 ₽ · пополнение, 14 сен»; short — без даты (телефон). */
export function flowLabel(t: TFunction, flow: BankFlow, currency: Currency, short = false): string {
  const money = formatMoney(flow.amount, currency, { signed: true });
  const kind = t(`analytics.flows.kind.${flow.kind}`);
  return short ? t('analytics.flows.short', { money, kind }) : t('analytics.flows.label', { money, kind, date: formatDate(flow.day) });
}

/** Отметки движений на графике по дням ряда (labels — дни points); день вне ряда пропускается. */
export function flowMarks(
  t: TFunction,
  flows: readonly BankFlow[],
  labels: readonly string[],
  currency: Currency,
  short: boolean,
): ChartMark[] {
  return flows.flatMap((flow) => {
    const index = labels.indexOf(flow.day);
    if (index < 0) return [];
    return [
      {
        index,
        label: flowLabel(t, flow, currency, short),
        tip: { name: t(`analytics.flows.tip.${flow.kind}`), value: formatMoney(flow.amount, currency, { signed: true }) },
      },
    ];
  });
}

/** Все движения периода одной строкой — для читалки и подсказки «Старт периода». */
export function flowsText(t: TFunction, flows: readonly BankFlow[], currency: Currency): string {
  return flows.map((flow) => flowLabel(t, flow, currency)).join('; ');
}
