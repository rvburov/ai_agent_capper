import type { CSSProperties } from 'react';

import { cx } from '../lib/cx';

export interface SkeletonProps {
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  radius?: CSSProperties['borderRadius'];
  /** Несколько строк текста: последняя короче. */
  lines?: number;
  className?: string;
}

/** Заглушка на месте данных, пока они грузятся. Для читалки экрана скрыта. */
export function Skeleton({ width, height = 14, radius, lines, className }: SkeletonProps) {
  if (lines && lines > 1) {
    return (
      <span className={cx('skeleton-lines', className)} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span
            key={i}
            className="skeleton"
            style={{ width: i === lines - 1 ? '60%' : width ?? '100%', height, borderRadius: radius }}
          />
        ))}
      </span>
    );
  }
  return (
    <span
      className={cx('skeleton', className)}
      style={{ width: width ?? '100%', height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}
