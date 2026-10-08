import { useTranslation } from 'react-i18next';

import { cx } from '../lib/cx';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  /** Подпись для читалки экрана; decorative — когда рядом уже есть текст. */
  label?: string;
  decorative?: boolean;
  className?: string;
}

export function Spinner({ size = 'md', label, decorative = false, className }: SpinnerProps) {
  const { t } = useTranslation();
  const cls = cx('spinner', size !== 'md' && size, className);
  if (decorative) return <span className={cls} aria-hidden="true" />;
  return <span className={cls} role="status" aria-label={label ?? t('common.loading')} />;
}
