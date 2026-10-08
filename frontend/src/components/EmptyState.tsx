import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  /** Короткая форма, как в макете: одна строка серым текстом. */
  children?: ReactNode;
  /** Полная форма: иконка, заголовок, текст и действие. */
  icon?: IconName;
  title?: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  /** Заголовок как заголовок страницы, если другого нет (экраны без шапки). */
  titleAs?: 'div' | 'h1' | 'h2';
  className?: string;
}

/** Пустое состояние (.empty): «Нет данных» или заглушка раздела. */
export function EmptyState({
  children,
  icon,
  title,
  text,
  action,
  titleAs: TitleTag = 'div',
  className,
}: EmptyStateProps) {
  const rich = icon !== undefined || title !== undefined || text !== undefined || action !== undefined;
  if (!rich) return <div className={cx('empty', className)}>{children}</div>;
  return (
    <div className={cx('empty', 'rich', className)}>
      {icon && (
        <span className="empty-icon">
          <Icon name={icon} />
        </span>
      )}
      {title !== undefined && <TitleTag className="empty-title">{title}</TitleTag>}
      {text !== undefined && <p className="empty-text">{text}</p>}
      {children}
      {action !== undefined && <div className="empty-action">{action}</div>}
    </div>
  );
}
