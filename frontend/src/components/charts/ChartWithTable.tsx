import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../../lib/cx';
import { Button } from '../Button';
import { EmptyState } from '../EmptyState';
import { ChartLegend, type LegendItem } from './ChartLegend';

export interface ChartWithTableProps {
  /** График. */
  children: ReactNode;
  /**
   * Таблица тех же данных — доступный двойник графика («Показать таблицей», withTable в
   * макете). Строится при первом открытии.
   */
  table: () => ReactNode;
  /** Легенда над графиком (при двух и больше рядах). */
  legend?: readonly LegendItem[];
  /** Данных нет: вместо графика и кнопки — этот текст. */
  empty?: ReactNode;
  /**
   * Данные перезапрашиваются (смена фильтра): прежний график остается на месте,
   * приглушенный, без скелетона и скачка раскладки.
   */
  pending?: boolean;
  className?: string;
}

/** Обертка графика: легенда, график, «Показать таблицей» / «Скрыть таблицу» и таблица. */
export function ChartWithTable({ children, table, legend, empty, pending = false, className }: ChartWithTableProps) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [built, setBuilt] = useState(false);

  if (empty) {
    return <EmptyState className={className}>{empty}</EmptyState>;
  }
  return (
    <div className={cx('chart-block', pending && 'pending', className)} aria-busy={pending || undefined}>
      {legend && legend.length > 0 && <ChartLegend items={legend} />}
      {children}
      <Button
        kind="ghost"
        size="sm"
        icon="list"
        className="chart-table-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setBuilt(true);
          setOpen((value) => !value);
        }}
      >
        {open ? t('charts.hideTable') : t('charts.showTable')}
      </Button>
      <div id={id} className="chart-table" hidden={!open}>
        {built && table()}
      </div>
    </div>
  );
}
