import { cx } from '../lib/cx';

export interface MeterProps {
  value: number;
  max: number;
  /** Подпись для читалки экрана: «Лимит на месяц». */
  label: string;
  /** Текст значения для читалки: «$7,20 из $10». */
  valueText?: string;
  kind?: 'warn' | 'bad';
  className?: string;
}

/** Полоса заполнения (.meter): расход лимита, доля. */
export function Meter({ value, max, label, valueText, kind, className }: MeterProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div
      className={cx('meter', kind, className)}
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuetext={valueText}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}
