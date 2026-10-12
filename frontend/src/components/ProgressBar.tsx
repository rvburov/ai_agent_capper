import { cx } from '../lib/cx';
import './Indicators.css';

export interface ProgressBarProps {
  value: number;
  max: number;
  /** Подпись для читалки экрана: «Ход анализа». */
  label: string;
  /** Текст значения: «Шаг 3 из 9». */
  valueText?: string;
  className?: string;
}

/** Полоса хода процесса (role=progressbar; Meter — для доли и расхода). */
export function ProgressBar({ value, max, label, valueText, className }: ProgressBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className={cx('progress', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}
