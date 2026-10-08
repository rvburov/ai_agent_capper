import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export type CalloutKind = 'info' | 'warn' | 'bad' | 'good' | 'accent' | 'neutral';

const DEFAULT_ICON: Record<CalloutKind, IconName> = {
  info: 'info',
  warn: 'alert',
  bad: 'alert',
  good: 'check',
  accent: 'spark',
  neutral: 'info',
};

export interface CalloutProps {
  kind?: CalloutKind;
  icon?: IconName;
  /** Ошибки и предупреждения объявляются читалке экрана сразу. */
  role?: 'alert' | 'status' | 'note';
  className?: string;
  children: ReactNode;
}

/** Плашка с пояснением или предупреждением (.callout). */
export function Callout({ kind = 'neutral', icon, role, className, children }: CalloutProps) {
  return (
    <div className={cx('callout', kind !== 'neutral' && kind, className)} role={role}>
      <Icon name={icon ?? DEFAULT_ICON[kind]} />
      <div className="callout-body">{children}</div>
    </div>
  );
}
