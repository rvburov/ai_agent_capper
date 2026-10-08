import type { CSSProperties, ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  /** Кнопки и метки справа от заголовка. */
  actions?: ReactNode;
  foot?: ReactNode;
  /** Тело без отступов (таблица во всю ширину карточки). */
  flush?: boolean;
  id?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Card({
  title,
  subtitle,
  eyebrow,
  actions,
  foot,
  flush = false,
  id,
  className,
  style,
  children,
}: CardProps) {
  const head = title !== undefined || actions !== undefined || eyebrow !== undefined;
  return (
    <section className={cx('card', className)} id={id} style={style}>
      {head && (
        <div className="card-head">
          <div className="card-head-text">
            {eyebrow !== undefined && <div className="eyebrow">{eyebrow}</div>}
            {title !== undefined && <h3>{title}</h3>}
            {subtitle !== undefined && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions !== undefined && <div className="row">{actions}</div>}
        </div>
      )}
      {children !== undefined && children !== null && (
        <div className={cx('card-body', flush && 'flush')}>{children}</div>
      )}
      {foot !== undefined && <div className="card-foot">{foot}</div>}
    </section>
  );
}
