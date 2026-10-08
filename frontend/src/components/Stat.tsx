import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  /** Изменение, уже отформатированное: «+2,1%». */
  delta?: ReactNode;
  trend?: 'up' | 'down' | 'flat';
  /** false — рост плохой (например, расход): стрелка вверх красная. */
  good?: boolean;
  hint?: ReactNode;
  icon?: IconName;
  hero?: boolean;
  /** Место справа внизу: спарклайн или метка. */
  aside?: ReactNode;
  className?: string;
}

/** Показатель в карточке: подпись, крупное число, изменение и подсказка. */
export function Stat({
  label,
  value,
  delta,
  trend = 'flat',
  good = true,
  hint,
  icon,
  hero = false,
  aside,
  className,
}: StatProps) {
  const goodDir = good ? 'up' : 'down';
  const deltaClass = trend === 'flat' ? 'flat' : `${trend}-${trend === goodDir ? 'good' : 'bad'}`;
  return (
    <section className={cx('card', className)}>
      <div className="stat">
        <div className="stat-label">
          {icon && <Icon name={icon} />}
          {label}
        </div>
        <div className={cx('stat-value', hero && 'hero')}>{value}</div>
        <div className="stat-foot">
          <div className="row">
            {delta !== undefined && (
              <span className={cx('delta', deltaClass)}>
                {trend !== 'flat' && <Icon name={trend === 'up' ? 'arrowUp' : 'arrowDown'} />}
                {delta}
              </span>
            )}
            {hint !== undefined && <span className="stat-hint">{hint}</span>}
          </div>
          {aside}
        </div>
      </div>
    </section>
  );
}
