import { useId, useState, type ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';
import './Disclosure.css';

export interface DisclosureProps {
  /** Подпись кнопки: строка или функция от состояния («Показать шаги» / «Скрыть шаги»). */
  summary: ReactNode | ((open: boolean) => ReactNode);
  children: ReactNode;
  /** Управляемое состояние; без него — свое, начиная с defaultOpen. */
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  /** button — небольшая кнопка со стрелкой; header — заголовок карточки во всю ширину. */
  variant?: 'button' | 'header';
  icon?: IconName;
  className?: string;
  bodyClassName?: string;
}

/** Раскрывающийся блок: «Показать шаги», «Как посчитана сумма», «Почему так». */
export function Disclosure({
  summary,
  children,
  open,
  defaultOpen = false,
  onToggle,
  variant = 'button',
  icon,
  className,
  bodyClassName,
}: DisclosureProps) {
  const bodyId = useId();
  const [own, setOwn] = useState(defaultOpen);
  const isOpen = open ?? own;
  const label = typeof summary === 'function' ? summary(isOpen) : summary;

  function toggle() {
    const next = !isOpen;
    if (open === undefined) setOwn(next);
    onToggle?.(next);
  }

  return (
    <div className={cx('disclosure', variant, className)}>
      <button
        type="button"
        className={cx(variant === 'button' ? 'btn ghost sm disclosure-btn' : 'disclosure-head')}
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={toggle}
      >
        {icon && <Icon name={icon} />}
        <span className="disclosure-label">{label}</span>
        <Icon name="chevronDown" className="disclosure-chev" />
      </button>
      <div id={bodyId} className={cx('disclosure-body', bodyClassName)} hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}
