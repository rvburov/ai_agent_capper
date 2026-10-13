import type { ReactNode } from 'react';

import { cx } from '../../lib/cx';

export interface LegendItem {
  key: string;
  name: ReactNode;
  /** Цвет метки; у 'dash' (опорная линия) не нужен. */
  color?: string;
  /** Как метка на графике: линия, прямоугольник (столбцы, полосы) или пунктир (опорная линия). */
  type?: 'line' | 'box' | 'dash';
}

/**
 * Легенда (.chart-legend) — при двух и больше рядах всегда, чтобы цвет не был единственным
 * способом различить ряды. Подписи — цветом текста, цвет ряда — только у метки.
 */
export function ChartLegend({ items, className }: { items: readonly LegendItem[]; className?: string }) {
  return (
    <ul className={cx('chart-legend', className)}>
      {items.map((item) => (
        <li key={item.key}>
          <i
            className={item.type === 'box' || item.type === 'dash' ? item.type : undefined}
            style={item.type === 'dash' || !item.color ? undefined : { background: item.color }}
            aria-hidden="true"
          />
          {item.name}
        </li>
      ))}
    </ul>
  );
}
