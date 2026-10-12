import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import './BudgetBar.css';
import { spendTone } from './LimitBar';

/** Ширина «потрачено» и «прогноз» в процентах полосы и цвет расхода. */
export function budgetBarParts(spent: number, forecast: number, budget: number, alertPct: number) {
  const pct = (value: number) => (budget > 0 ? Math.max(0, Math.min(100, (value / budget) * 100)) : 0);
  return {
    spent: pct(spent),
    forecast: pct(forecast),
    mark: Math.max(0, Math.min(100, alertPct)),
    tone: spendTone(spent, budget, alertPct),
  };
}

export interface BudgetBarProps {
  spent: number;
  forecast: number;
  budget: number;
  alertPct: number;
  /** Подпись для читалки: «Потрачено $41,20 из $60, прогноз $66». */
  label: string;
  /** Подсказка у отметки порога: «Уведомление при 80%». */
  markTitle: string;
  /** Легенда: потрачено, прогноз, порог. */
  legend: readonly [ReactNode, ReactNode, ReactNode];
  className?: string;
}

/**
 * Полоса общего бюджета (budgetBar макета, mockup/js/screens/admin.js): потрачено, прогноз на
 * конец месяца штриховкой и отметка порога уведомления; под ней — легенда.
 */
export function BudgetBar({ spent, forecast, budget, alertPct, label, markTitle, legend, className }: BudgetBarProps) {
  const parts = budgetBarParts(spent, forecast, budget, alertPct);
  return (
    <div className={cx('budget-bar-wrap', className)}>
      <div
        className="budget-bar"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(spent * 100) / 100}
        aria-valuemin={0}
        aria-valuemax={budget}
      >
        <i className="proj" style={{ width: `${parts.forecast}%` }} />
        <i className={cx('spent', parts.tone)} style={{ width: `${parts.spent}%` }} />
        <span className="mark" style={{ left: `${parts.mark}%` }} title={markTitle} />
      </div>
      <div className="budget-legend">
        <span>
          <i className="spent" aria-hidden="true" />
          {legend[0]}
        </span>
        <span>
          <i className="proj" aria-hidden="true" />
          {legend[1]}
        </span>
        <span>
          <i className="mark" aria-hidden="true" />
          {legend[2]}
        </span>
      </div>
    </div>
  );
}
