import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';

import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';
import { useReadOnly } from './ReadOnly';
import { Spinner } from './Spinner';

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  kind?: ButtonKind;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
  /** Идет запрос: кнопка недоступна, вместо иконки — индикатор. */
  loading?: boolean;
  className?: string;
  children?: ReactNode;
  /**
   * Кнопка меняет данные (Р27): в режиме просмотра данных участника она неактивна, нажатие
   * показывает подсказку. Строка — своя подсказка вместо общей.
   */
  ro?: boolean | string;
}

type AsButton = CommonProps &
  Omit<ComponentPropsWithRef<'button'>, keyof CommonProps> & { to?: undefined; href?: undefined };
type AsRouterLink = CommonProps & Omit<LinkProps, keyof CommonProps> & { href?: undefined };
type AsAnchor = CommonProps &
  Omit<ComponentPropsWithRef<'a'>, keyof CommonProps> & { href: string; to?: undefined };

/** Кнопка макета (.btn). С to — ссылка внутри приложения, с href — внешняя ссылка. */
export type ButtonProps = AsButton | AsRouterLink | AsAnchor;

export function Button(props: ButtonProps) {
  const readOnly = useReadOnly();
  const {
    kind = 'secondary',
    size = 'md',
    icon,
    iconRight,
    block = false,
    loading = false,
    className,
    children,
    ro,
  } = props;
  const iconOnly = children === undefined || children === null || children === false;
  const cls = cx(
    'btn',
    kind,
    size !== 'md' && size,
    block && 'block',
    iconOnly && 'icon-only',
    className,
  );
  const content = (
    <>
      {loading ? <Spinner size="sm" decorative /> : icon && <Icon name={icon} />}
      {!iconOnly && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} />}
    </>
  );

  if (ro && readOnly) {
    // Только просмотр: вместо ссылки или действия — неактивная кнопка с подсказкой
    const hint = typeof ro === 'string' ? ro : readOnly.hint;
    const named = props['aria-label'] ?? (typeof children === 'string' ? children : props.title);
    return (
      <button
        type="button"
        id={props.id}
        className={cx(cls, 'is-ro')}
        title={hint}
        aria-disabled="true"
        aria-label={named ? `${named}. ${hint}` : hint}
        data-ro=""
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          readOnly.onBlocked(hint);
        }}
      >
        {content}
      </button>
    );
  }
  if (props.to !== undefined) {
    const { kind: _k, size: _s, icon: _i, iconRight: _r, block: _b, loading: _l, ro: _ro, ...link } = props;
    return (
      <Link {...link} className={cls}>
        {content}
      </Link>
    );
  }
  if (props.href !== undefined) {
    const { kind: _k, size: _s, icon: _i, iconRight: _r, block: _b, loading: _l, ro: _ro, ...anchor } = props;
    return (
      <a {...anchor} className={cls}>
        {content}
      </a>
    );
  }
  const {
    kind: _k,
    size: _s,
    icon: _i,
    iconRight: _r,
    block: _b,
    loading: _l,
    ro: _ro,
    type = 'button',
    disabled,
    ...button
  } = props;
  return (
    <button
      {...button}
      type={type}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {content}
    </button>
  );
}
