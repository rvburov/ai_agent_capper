import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { tooltipPosition } from './geometry';

export interface TooltipRow {
  key: string;
  /** Подпись ряда — вторична; значение — главное в строке (как в макете). */
  name: string;
  value: string;
  /** Цвет ряда: короткая линия-ключ слева от подписи; текст цветом ряда не красится. */
  color?: string;
}

export interface ChartTooltipProps {
  /** Точка привязки в координатах окна (clientX/clientY). */
  x: number;
  y: number;
  title: string;
  rows: readonly TooltipRow[];
}

/**
 * Подсказка графика (.chart-tip): поверх страницы, рядом с указателем или с точкой, выбранной
 * с клавиатуры; у края окна переезжает на другую сторону. Только дополняет данные: те же
 * значения есть в таблице «Показать таблицей».
 */
export function ChartTooltip({ x, y, title, rows }: ChartTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => tooltipPosition(x, y, 0, 0, window.innerWidth));

  useLayoutEffect(() => {
    const el = ref.current;
    const next = tooltipPosition(x, y, el?.offsetWidth ?? 0, el?.offsetHeight ?? 0, window.innerWidth);
    setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [x, y, title, rows]);

  return createPortal(
    <div ref={ref} className="chart-tip" role="tooltip" style={{ left: pos.left, top: pos.top }}>
      <div className="tip-title">{title}</div>
      {rows.map((row) => (
        <div key={row.key} className="tip-row">
          <span className="tip-key">
            {row.color && <i style={{ background: row.color }} aria-hidden="true" />}
            {row.name}
          </span>
          <b>{row.value}</b>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** Текст подсказки одной строкой — для читалки экрана при выборе точки с клавиатуры. */
export function tooltipText(title: string, rows: readonly TooltipRow[]): string {
  return [title, ...rows.map((row) => `${row.name}: ${row.value}`)].join('. ');
}

/**
 * Подсказка стоит на месте окна (position: fixed): при прокрутке страницы она отстала бы
 * от графика — прячем ее. На телефоне подсказка после касания остается до прокрутки или
 * касания в другом месте (тогда график теряет фокус).
 */
export function useHideOnScroll(open: boolean, hide: () => void): void {
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', hide, { capture: true });
  }, [open, hide]);
}
