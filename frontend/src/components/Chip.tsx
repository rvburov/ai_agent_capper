import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export type ChipKind = 'good' | 'warn' | 'serious' | 'bad' | 'info' | 'accent' | 'outline';

export interface ChipProps {
  kind?: ChipKind;
  icon?: IconName;
  /** Цветная точка слева (покрытие корта, серия графика): значение — токен, например var(--clay). */
  dot?: string;
  className?: string;
  children: ReactNode;
}

/** Метка-статус (.chip). */
export function Chip({ kind, icon, dot, className, children }: ChipProps) {
  return (
    <span className={cx('chip', kind, className)}>
      {dot !== undefined && <i className="dot" style={{ background: dot }} aria-hidden="true" />}
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}
