import { useCallback, useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../../lib/cx';
import { ChartTooltip, tooltipText, useHideOnScroll, type TooltipRow } from './ChartTooltip';
import { defaultValueFormat } from './defaultFormat';
import {
  allIntegers,
  bandIndex,
  clamp,
  columnPath,
  columnWidth,
  columnYDomain,
  linearScale,
  pickAxisLabels,
  px,
  textWidth,
  type Margins,
  type ValueFormat,
} from './geometry';
import { useChartWidth } from './useChartWidth';
import './charts.css';

export interface ColumnItem {
  key: string;
  /** Полная подпись (в подсказке): «от +1 до +2%», «3 окт». */
  label: string;
  /** Короткая подпись под столбцом; по умолчанию — label. */
  short?: string;
  value: number;
  /** Свой цвет столбца (токен); по умолчанию — цвет графика. */
  color?: string;
  /** Свои строки подсказки вместо «‹seriesName›: значение». */
  tip?: readonly TooltipRow[];
}

export interface ColumnChartProps {
  items: readonly ColumnItem[];
  ariaLabel: string;
  height?: number;
  /** Цвет столбцов (токен), по умолчанию 'var(--s1)'. */
  color?: string;
  /**
   * Подписи оси Y (со вторым аргументом { step } — шаг делений) и значение в подсказке.
   * По умолчанию — число с точностью шага делений.
   */
  valueFormat?: ValueFormat;
  /** Деления оси целые (счетчики ставок, событий); по умолчанию — если все значения целые. */
  integer?: boolean;
  /** Подпись значения в подсказке: «Расход за день», «Ставок». */
  seriesName?: string;
  /** Последний столбец ярче (сегодня), остальные приглушены. */
  highlightLast?: boolean;
  width?: number;
}

/**
 * Столбцы (columnChart макета): от нуля вверх и вниз, не толще 24 px, скругление 4 px только
 * на конце, подсказка по наведению на полосу и с клавиатуры (← → Home End).
 */
export function ColumnChart({
  items,
  ariaLabel,
  height = 200,
  color = 'var(--s1)',
  valueFormat = defaultValueFormat,
  seriesName,
  highlightLast = false,
  integer,
  width: fixedWidth,
}: ColumnChartProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const { ref, width: W } = useChartWidth(fixedWidth);
  const [active, setActive] = useState<{ index: number; clientX: number; clientY: number; fromKeyboard: boolean } | null>(null);
  const hide = useCallback(() => setActive(null), []);
  useHideOnScroll(active !== null, hide);
  const H = height;
  const n = items.length;

  const values = items.map((item) => item.value);
  const { lo, hi, ticks, step } = columnYDomain(values, 3, { integer: integer ?? allIntegers(values) });
  const tickText = (tick: number) => valueFormat(tick, { step });
  const yLabelW = Math.max(0, ...ticks.map((tick) => textWidth(tickText(tick)))) + 10;
  const m: Margins = { t: 10, r: 6, b: 24, l: yLabelW };
  const iw = Math.max(1, W - m.l - m.r);
  const ih = Math.max(1, H - m.t - m.b);
  const band = n ? iw / n : iw;
  const bw = columnWidth(band);
  const Y = linearScale([lo, hi], [m.t + ih, m.t]);
  const centers = items.map((_, i) => m.l + band * i + band / 2);
  const labels = pickAxisLabels(
    centers,
    items.map((item) => textWidth(item.short ?? item.label)),
    { min: 0, max: W },
  );

  const rowsOf = (item: ColumnItem): readonly TooltipRow[] =>
    item.tip ?? [
      { key: 'value', name: seriesName ?? t('charts.value'), color: item.color ?? color, value: valueFormat(item.value) },
    ];

  function pointAt(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setActive({
      index: bandIndex(event.clientX - rect.left, n, m.l, band),
      clientX: event.clientX,
      clientY: event.clientY,
      fromKeyboard: false,
    });
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (!n) return;
    const current = active?.index;
    let next: number | null;
    if (event.key === 'ArrowRight') next = current === undefined ? 0 : current + 1;
    else if (event.key === 'ArrowLeft') next = current === undefined ? n - 1 : current - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else if (event.key === 'Escape') next = null;
    else return;
    event.preventDefault();
    if (next === null) {
      setActive(null);
      return;
    }
    const index = clamp(next, 0, n - 1);
    const item = items[index];
    const rect = event.currentTarget.getBoundingClientRect();
    const top = item ? Math.min(Y(0), Y(item.value)) : m.t;
    setActive({ index, clientX: rect.left + (centers[index] ?? 0), clientY: rect.top + top, fromKeyboard: true });
  }

  const activeItem = active ? items[active.index] : undefined;
  const tip = active && activeItem ? { x: active.clientX, y: active.clientY, title: activeItem.label, rows: rowsOf(activeItem) } : null;

  return (
    <div ref={ref} className="chart" style={{ height: H }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={hintId}
        tabIndex={n ? 0 : undefined}
        onPointerMove={n ? pointAt : undefined}
        onPointerDown={n ? pointAt : undefined}
        onPointerLeave={(event) => {
          // после касания пальцем подсказка остается до прокрутки или касания в другом месте
          if (event.pointerType !== 'touch') hide();
        }}
        onBlur={hide}
        onKeyDown={onKeyDown}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className={tick === 0 ? 'axis-line' : 'grid-line'} x1={m.l} x2={W - m.r} y1={px(Y(tick))} y2={px(Y(tick))} />
            <text x={m.l - 8} y={px(Y(tick)) + 4} textAnchor="end">
              {tickText(tick)}
            </text>
          </g>
        ))}
        {items.map((item, i) => {
          const x = (centers[i] ?? 0) - bw / 2;
          // столбец под указателем чуть светлеет; «сегодня» (highlightLast) ярче остальных
          return (
            <path
              key={item.key}
              className={cx('column', highlightLast && i !== n - 1 && 'dim', active?.index === i && 'on')}
              d={columnPath(x, bw, Y(0), Y(item.value))}
              fill={item.color ?? color}
            />
          );
        })}
        {labels.map((label) => {
          const item = items[label.index];
          return (
            <text key={label.index} className="x-label" x={px(label.x)} y={H - 6} textAnchor={label.anchor}>
              {item ? (item.short ?? item.label) : ''}
            </text>
          );
        })}
      </svg>
      <span id={hintId} className="sr-only">
        {t('charts.keyboardHint')}
      </span>
      <span className="sr-only" aria-live="polite">
        {tip && active?.fromKeyboard ? tooltipText(tip.title, tip.rows) : ''}
      </span>
      {tip && <ChartTooltip x={tip.x} y={tip.y} title={tip.title} rows={tip.rows} />}
    </div>
  );
}
