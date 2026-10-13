import { cx } from '../../lib/cx';
import { sparkGeometry } from './geometry';
import './charts.css';

export interface SparklineProps {
  values: readonly number[];
  /** Размер рисунка; на странице он растягивается по ширине места (как в макете). */
  width?: number;
  height?: number;
  /** Цвет (токен), по умолчанию 'var(--accent)'. */
  color?: string;
  /**
   * Подпись для читалки экрана. Без нее график декоративный: рядом всегда есть число
   * (банк, расход), а ряд целиком — в таблице графика.
   */
  ariaLabel?: string;
  className?: string;
}

/** Мини-график (sparkline макета): линия, заливка 10% и точка последнего значения. */
export function Sparkline({ values, width = 96, height = 28, color = 'var(--accent)', ariaLabel, className }: SparklineProps) {
  const g = sparkGeometry(values, width, height);
  if (!g) return null;
  return (
    <svg
      className={cx('sparkline', className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : { 'aria-hidden': true })}
    >
      <path className="area" d={g.area} fill={color} />
      <path className="line spark" d={g.line} stroke={color} />
      <circle cx={g.end.x} cy={g.end.y} r={3} fill={color} />
    </svg>
  );
}
