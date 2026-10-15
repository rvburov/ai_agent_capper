import { useCallback, useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ChartTooltip, tooltipText, useHideOnScroll, type TooltipRow } from './ChartTooltip';
import { defaultValueFormat } from './defaultFormat';
import {
  allIntegers,
  areaPath,
  clamp,
  linePath,
  lineYDomain,
  linearScale,
  markBand,
  nearestIndex,
  pickAxisLabels,
  placeMarkLabels,
  px,
  stepPath,
  textWidth,
  type Margins,
  type Point,
  type ValueFormat,
} from './geometry';
import { useChartWidth } from './useChartWidth';
import './charts.css';

export interface LineSeries {
  key: string;
  name: string;
  /** Цвет ряда — токен: 'var(--s1)'. */
  color: string;
  /** Значение на каждую подпись X; null — нет значения (разрыв линии). */
  values: readonly (number | null)[];
  dashed?: boolean;
  /** Ступенькой: значение меняется в день события (пунктир «вложено», В7 этапа 5). */
  step?: boolean;
  /** Тонкая линия (1,5 px) — вспомогательный ряд рядом с главным. */
  thin?: boolean;
  /** Без точки и конечной метки в конце: вспомогательный ряд не спорит с главным числом. */
  noEnd?: boolean;
}

/**
 * Отметка события на день index (пополнение или вывод банка): вертикальный пунктир, полая
 * точка на ряду series (по умолчанию — первом) и подпись у верхнего края; в подсказке этого
 * дня — строка tip (или подпись).
 */
export interface ChartMark {
  index: number;
  label: string;
  /** Строка подсказки этого дня: подпись и значение («Пополнение», «+20 000 ₽»). */
  tip?: { name: string; value: string };
  /** Ключ ряда, на котором точка; по умолчанию — первый ряд. */
  series?: string;
}

export interface RefLine {
  value: number;
  label?: string;
}

export interface LineChartProps {
  /** Значения оси X (обычно даты «2026-10-03»), по одному на точку. */
  labels: readonly string[];
  series: readonly LineSeries[];
  /** Что на графике — для читалки экрана: «Банк по дням за 30 дней: с 48 000 ₽ до 51 200 ₽». */
  ariaLabel: string;
  height?: number;
  /**
   * Подписи оси Y (со вторым аргументом { step } — шаг делений), конечная метка и значения
   * в подсказке. По умолчанию — число с точностью шага делений.
   */
  yFormat?: ValueFormat;
  /** Подписи оси X. */
  xFormat?: (label: string, index: number) => string;
  /** Заголовок подсказки; по умолчанию — как подпись X. */
  tipTitle?: (label: string, index: number) => string;
  /** Заливка под первым рядом (10%) до areaBase или низа оси. */
  area?: boolean;
  areaBase?: number;
  yMin?: number;
  yMax?: number;
  /** Опорные линии пунктиром: банк на начало периода, ноль. */
  refLines?: readonly RefLine[];
  /**
   * Значение последней точки справа от линии (выборочная подпись: конец ряда). Длинная
   * метка, которой справа не хватает места, встает над точкой, внутри рисунка.
   */
  endLabel?: boolean;
  /** Отметки событий (пополнения и выводы банка). */
  marks?: readonly ChartMark[];
  /** Деления оси Y целые (счетчики); по умолчанию — если все значения целые. */
  integer?: boolean;
  /** Ширина, px; по умолчанию — ширина контейнера. */
  width?: number;
}

interface Active {
  index: number;
  /** Точка привязки подсказки в координатах окна. */
  clientX: number;
  clientY: number;
  fromKeyboard: boolean;
}

/**
 * Линейный график (lineChart макета): несколько рядов, сетка, опорные линии, заливка,
 * конечная метка, перекрестие и подсказка по наведению и с клавиатуры (← → Home End).
 */
export function LineChart({
  labels,
  series,
  ariaLabel,
  height = 240,
  yFormat = defaultValueFormat,
  xFormat = (label) => label,
  tipTitle,
  area = false,
  areaBase,
  yMin,
  yMax,
  refLines = [],
  endLabel = false,
  marks = [],
  integer,
  width: fixedWidth,
}: LineChartProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const { ref, width: W } = useChartWidth(fixedWidth);
  const [active, setActive] = useState<Active | null>(null);
  const hide = useCallback(() => setActive(null), []);
  useHideOnScroll(active !== null, hide);
  const H = height;
  const n = labels.length;

  const values = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const all = [...values, ...refLines.map((r) => r.value)];
  const { lo, hi, ticks, step } = lineYDomain(all, {
    min: yMin,
    max: yMax,
    tickCount: H < 200 ? 3 : 4,
    integer: integer ?? allIntegers(all),
  });
  const tickText = (tick: number) => yFormat(tick, { step });
  const lastValues = series
    .filter((s) => !s.noEnd)
    .map((s) => s.values[s.values.length - 1])
    .filter((v): v is number => v !== null && v !== undefined);
  const yLabelW = Math.max(0, ...ticks.map((tick) => textWidth(tickText(tick)))) + 10;
  // место справа под конечную метку — по ее ширине; если она шире 35% рисунка (банк больше
  // миллиона в долларах на телефоне), метка встает над точкой, а линия идет до края
  const endText = endLabel && lastValues.length ? Math.max(...lastValues.map((v) => textWidth(yFormat(v)))) + 14 : 0;
  const endInside = endText > W * 0.35;
  const m: Margins = { t: 10, r: endText && !endInside ? endText : 10, b: 26, l: yLabelW };
  const iw = Math.max(1, W - m.l - m.r);
  const X = (i: number) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  // отметки вне ряда (день за пределами подписей) не рисуются
  const shownMarks = marks.filter((mark) => mark.index >= 0 && mark.index < n);
  // подписи отметок — в полосе над областью построения (X от верхнего отступа не зависит):
  // линия, деления и конечная метка в нее не заходят, поэтому полоса во всю ширину рисунка;
  // сторона подписи — по 55% области построения, как в макете
  const markLabels = placeMarkLabels(
    shownMarks.map((mark) => ({ x: X(mark.index), width: textWidth(mark.label) })),
    { min: 0, max: W, split: m.l + iw * 0.55 },
  );
  const markRows = Math.max(0, ...markLabels.map((place) => (place ? place.row + 1 : 0)));
  m.t = markBand.plotTop(markRows);
  // пунктир дня — один на все отметки дня (вывод и корректировка в один день) и доходит до
  // верхней из их подписей; неподписанный — только до области построения
  const dashTop = new Map<number, number>();
  shownMarks.forEach((mark, i) => {
    const place = markLabels[i];
    const top = place ? markBand.top(place.row) : m.t;
    dashTop.set(mark.index, Math.min(top, dashTop.get(mark.index) ?? top));
  });
  const ih = Math.max(1, H - m.t - m.b);
  const Y = linearScale([lo, hi], [m.t + ih, m.t]);
  const xLabels = pickAxisLabels(
    labels.map((_, i) => X(i)),
    labels.map((label, i) => textWidth(xFormat(label, i))),
    { min: 0, max: W },
  );
  const title = tipTitle ?? xFormat;

  const rowsAt = (index: number): TooltipRow[] => [
    ...series.map((s) => {
      const v = s.values[index];
      return { key: s.key, name: s.name, color: s.color, value: v === null || v === undefined ? '—' : yFormat(v) };
    }),
    ...shownMarks
      .filter((mark) => mark.index === index)
      .map((mark, i) => ({ key: `mark-${i}`, name: mark.tip?.name ?? mark.label, value: mark.tip?.value ?? '' })),
  ];

  function pointAt(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setActive({
      index: nearestIndex(event.clientX - rect.left, n, m.l, iw),
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
    // с клавиатуры подсказка — у верха перекрестия
    const index = clamp(next, 0, n - 1);
    const rect = event.currentTarget.getBoundingClientRect();
    setActive({ index, clientX: rect.left + X(index), clientY: rect.top + m.t, fromKeyboard: true });
  }

  const tip = active
    ? {
        x: active.clientX,
        y: active.clientY,
        title: title(labels[active.index] ?? '', active.index),
        rows: rowsAt(active.index),
      }
    : null;

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
        {ticks
          .filter((tick) => tick >= lo - 1e-9 && tick <= hi + 1e-9)
          .map((tick) => (
            <g key={tick}>
              <line className="grid-line" x1={m.l} x2={W - m.r} y1={px(Y(tick))} y2={px(Y(tick))} />
              <text x={m.l - 8} y={px(Y(tick)) + 4} textAnchor="end">
                {tickText(tick)}
              </text>
            </g>
          ))}
        {xLabels.map((label) => (
          <text key={label.index} className="x-label" x={px(label.x)} y={H - 6} textAnchor={label.anchor}>
            {xFormat(labels[label.index] ?? '', label.index)}
          </text>
        ))}
        {refLines.map((line, i) => (
          <g key={i} className="ref-line">
            <line x1={m.l} x2={W - m.r} y1={px(Y(line.value))} y2={px(Y(line.value))} />
            {line.label && (
              <text x={W - m.r} y={px(Y(line.value)) - 6} textAnchor="end">
                {line.label}
              </text>
            )}
          </g>
        ))}
        {series.map((s, si) => {
          const points: (Point | null)[] = s.values.map((v, i) => (v === null ? null : [X(i), Y(v)]));
          const last = points[points.length - 1];
          const lastValue = s.values[s.values.length - 1];
          const base = Y(clamp(areaBase ?? lo, lo, hi));
          return (
            <g key={s.key} className="series">
              {area && si === 0 && <path className="area" d={areaPath(points, base)} fill={s.color} />}
              <path
                className={s.thin ? 'line thin' : 'line'}
                d={s.step ? stepPath(points) : linePath(points)}
                stroke={s.color}
                strokeDasharray={s.dashed ? '5 4' : undefined}
              />
              {last && !s.noEnd && (
                <circle className="dot" cx={px(last[0])} cy={px(last[1])} r={4} fill={s.color} />
              )}
              {last && !s.noEnd && endLabel && lastValue !== null && lastValue !== undefined && (
                <text
                  className="end-label"
                  x={px(last[0]) + (endInside ? 0 : 8)}
                  // внутри рисунка — над точкой, а у верхнего края — под ней
                  y={endInside ? px(last[1] < m.t + 18 ? last[1] + 20 : last[1] - 10) : px(last[1]) + 4}
                  textAnchor={endInside ? 'end' : undefined}
                >
                  {yFormat(lastValue)}
                </text>
              )}
            </g>
          );
        })}
        {shownMarks.map((mark, i) => {
          const x = px(X(mark.index));
          const on = series.find((s) => s.key === mark.series) ?? series[0];
          const v = on?.values[mark.index];
          const place = markLabels[i];
          return (
            <g key={i} className="mark">
              {shownMarks.findIndex((other) => other.index === mark.index) === i && (
                <line className="mark-line" x1={x} x2={x} y1={dashTop.get(mark.index) ?? m.t} y2={m.t + ih} />
              )}
              {on && v !== null && v !== undefined && <circle className="mark-dot" cx={x} cy={px(Y(v))} r={4.5} stroke={on.color} />}
              {place && (
                <text className="mark-label" x={px(place.x)} y={markBand.baseline(place.row)} textAnchor={place.anchor}>
                  {mark.label}
                </text>
              )}
            </g>
          );
        })}
        {active && (
          <g className="cursor">
            <line className="crosshair" x1={px(X(active.index))} x2={px(X(active.index))} y1={m.t} y2={m.t + ih} />
            {series.map((s) => {
              const v = s.values[active.index];
              return v === null || v === undefined ? null : (
                <circle key={s.key} className="dot" cx={px(X(active.index))} cy={px(Y(v))} r={4} fill={s.color} />
              );
            })}
          </g>
        )}
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
