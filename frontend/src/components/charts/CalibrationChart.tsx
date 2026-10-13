import { useCallback, useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../../lib/cx';
import { formatInterval, formatNumber, formatProb, formatProbRange } from '../../lib/format';
import { ChartTooltip, tooltipText, useHideOnScroll, type TooltipRow } from './ChartTooltip';
import {
  bubbleRadius,
  calibrationDomain,
  calibrationTicks,
  clamp,
  linePath,
  linearScale,
  outsideDomain,
  pickAxisLabels,
  px,
  textWidth,
  type Margins,
  type Point,
} from './geometry';
import { useChartWidth } from './useChartWidth';
import './charts.css';

export interface CalibrationBin {
  key: string;
  /** Границы корзины прогноза: 0.70 и 0.75. */
  lo: number;
  hi: number;
  /** Средний прогноз модели в корзине. */
  p: number;
  /** Доля сыгравших событий. */
  actual: number;
  /** Событий в корзине; размер точки растет с ним. */
  n: number;
  /** 95% ДИ доли сыгравших (Уилсон) — вертикальный отрезок с засечками. */
  ci?: readonly [number, number] | null;
}

export interface CalibrationChartProps {
  bins: readonly CalibrationBin[];
  ariaLabel: string;
  height?: number;
  /**
   * Шкала обеих осей; по умолчанию — по данным (calibrationDomain: точки и ДИ целиком внутри).
   * Значения за пределами заданной шкалы прижимаются к краю и помечаются: полая точка,
   * стрелка на конце ДИ, «за пределами шкалы» в подсказке и в тексте для читалки.
   */
  domain?: readonly [number, number];
  /** Цвет точек и линии (токен), по умолчанию 'var(--s1)'. */
  color?: string;
  /** Подпись диагонали «идеальная калибровка». */
  diagonalLabel?: boolean;
  width?: number;
}

/**
 * Калибровка (calibrationChart макета): средний прогноз против доли сыгравших по корзинам,
 * диагональ — идеальная калибровка, размер точки — число событий, у точки — 95% ДИ.
 * Подсказка по наведению на точку (зона не меньше 24 px) и с клавиатуры (← →).
 */
export function CalibrationChart({
  bins,
  ariaLabel,
  height = 260,
  domain,
  color = 'var(--s1)',
  diagonalLabel = false,
  width: fixedWidth,
}: CalibrationChartProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const { ref, width: W } = useChartWidth(fixedWidth);
  const [active, setActive] = useState<{ index: number; clientX: number; clientY: number; fromKeyboard: boolean } | null>(null);
  const hide = useCallback(() => setActive(null), []);
  useHideOnScroll(active !== null, hide);
  const H = height;
  const points = bins.filter((b) => b.n > 0).sort((a, b) => a.p - b.p);
  const scale = domain ?? calibrationDomain(points);
  const [d0, d1] = scale;

  const m: Margins = { t: 12, r: 12, b: 34, l: 44 };
  const iw = Math.max(1, W - m.l - m.r);
  const ih = Math.max(1, H - m.t - m.b);
  const X = linearScale([d0, d1], [m.l, m.l + iw]);
  const Y = linearScale([d0, d1], [m.t + ih, m.t]);
  const ticks = calibrationTicks(d0, d1);
  // подписи оси X не налезают друг на друга, на подписи оси Y в углу и на край (шкала
  // от 0% на телефоне — через одну)
  const xLabels = pickAxisLabels(
    ticks.map((tick) => X(tick)),
    ticks.map((tick) => textWidth(formatProb(tick))),
    { min: m.l - 4, max: W },
  );

  const maxN = Math.max(0, ...points.map((b) => b.n));
  const at = (b: CalibrationBin): Point => [X(clamp(b.p, d0, d1)), Y(clamp(b.actual, d0, d1))];
  const off = (v: number) => outsideDomain(v, scale);
  const offText = (text: string, outside: boolean) =>
    outside ? t('charts.calibration.offScaleValue', { value: text }) : text;

  const rowsOf = (b: CalibrationBin): TooltipRow[] => [
    { key: 'p', name: t('charts.calibration.mean'), value: offText(formatProb(b.p), off(b.p)) },
    { key: 'actual', name: t('charts.calibration.actual'), color, value: offText(formatProb(b.actual), off(b.actual)) },
    ...(b.ci
      ? [
          {
            key: 'ci',
            name: t('charts.ci'),
            value: offText(formatInterval(b.ci[0], b.ci[1], formatProb), off(b.ci[0]) || off(b.ci[1])),
          },
        ]
      : []),
    { key: 'n', name: t('charts.calibration.events'), value: formatNumber(b.n) },
  ];
  const titleOf = (b: CalibrationBin) => t('charts.calibration.tipTitle', { range: formatProbRange(b.lo, b.hi) });

  function show(index: number, clientX: number, clientY: number, fromKeyboard: boolean) {
    setActive({ index, clientX, clientY, fromKeyboard });
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    const n = points.length;
    if (!n) return;
    const current = active?.index;
    let next: number | null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current === undefined ? 0 : current + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current === undefined ? n - 1 : current - 1;
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
    const bin = points[index];
    if (!bin) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const [cx0, cy0] = at(bin);
    show(index, rect.left + cx0, rect.top + cy0, true);
  }

  const activeBin = active ? points[active.index] : undefined;
  const tip = active && activeBin ? { x: active.clientX, y: active.clientY, title: titleOf(activeBin), rows: rowsOf(activeBin) } : null;

  return (
    <div ref={ref} className="chart" style={{ height: H }}>
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={hintId}
        tabIndex={points.length ? 0 : undefined}
        onPointerLeave={(event) => {
          // после касания пальцем подсказка остается до прокрутки или касания в другом месте
          if (event.pointerType !== 'touch') hide();
        }}
        onBlur={hide}
        onKeyDown={onKeyDown}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="grid-line" x1={m.l} x2={m.l + iw} y1={px(Y(tick))} y2={px(Y(tick))} />
            <text x={m.l - 8} y={px(Y(tick)) + 4} textAnchor="end">
              {formatProb(tick)}
            </text>
          </g>
        ))}
        {xLabels.map((label) => (
          <text key={label.index} className="x-label" x={px(label.x)} y={m.t + ih + 16} textAnchor={label.anchor}>
            {formatProb(ticks[label.index])}
          </text>
        ))}
        <text className="x-label" x={m.l + iw} y={H - 2} textAnchor="end">
          {t('charts.calibration.axisX')}
        </text>
        <line className="ref-line diagonal" x1={px(X(d0))} y1={px(Y(d0))} x2={px(X(d1))} y2={px(Y(d1))} />
        {diagonalLabel && (
          <text x={px(X(d1)) - 6} y={px(Y(d0 + (d1 - d0) * 0.88)) + 18} textAnchor="end">
            {t('charts.calibration.diagonal')}
          </text>
        )}
        {points.length > 1 && <path className="line" d={linePath(points.map(at))} stroke={color} />}
        {points.map((b) => {
          if (!b.ci) return null;
          const x = px(X(clamp(b.p, d0, d1)));
          const lo = Math.min(b.ci[0], b.ci[1]);
          const hi = Math.max(b.ci[0], b.ci[1]);
          const y1 = px(Y(clamp(lo, d0, d1)));
          const y2 = px(Y(clamp(hi, d0, d1)));
          // конец ДИ внутри шкалы — засечка, за шкалой — стрелка наружу у края
          const end = (y: number, outside: boolean, dir: 1 | -1) =>
            outside ? (
              <path className="ci-arrow" d={`M${x - 4} ${y - 5 * dir}L${x} ${y}L${x + 4} ${y - 5 * dir}`} />
            ) : (
              <line x1={x - 4} x2={x + 4} y1={y} y2={y} />
            );
          return (
            <g key={`ci-${b.key}`} className="ci">
              <line x1={x} x2={x} y1={y1} y2={y2} />
              {end(y1, off(lo), 1)}
              {end(y2, off(hi), -1)}
            </g>
          );
        })}
        {points.map((b, i) => {
          const [cx0, cy0] = at(b);
          const r = bubbleRadius(b.n, maxN);
          const onPointer = (event: PointerEvent<SVGCircleElement>) => show(i, event.clientX, event.clientY, false);
          // точка за шкалой прижата к краю — полая, чтобы не читалась как настоящее значение
          const outside = off(b.p) || off(b.actual);
          return (
            <g key={b.key}>
              <circle
                className={cx('dot', outside && 'off', active?.index === i && 'on')}
                cx={px(cx0)}
                cy={px(cy0)}
                r={px(r)}
                fill={outside ? 'var(--surface)' : color}
                style={outside && active?.index !== i ? { stroke: color } : undefined}
              />
              {/* зона наведения больше точки: не меньше 24 px в поперечнике */}
              <circle
                className="hit"
                cx={px(cx0)}
                cy={px(cy0)}
                r={px(Math.max(12, r + 6))}
                onPointerMove={onPointer}
                onPointerDown={onPointer}
                onPointerLeave={(event) => {
                  if (event.pointerType !== 'touch') hide();
                }}
              />
            </g>
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
