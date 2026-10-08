import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link, type To } from 'react-router';

import { cx } from '../lib/cx';
import { Icon, type IconName } from './Icon';

export interface TabItem<Id extends string = string> {
  id: Id;
  label: ReactNode;
  icon?: IconName;
  /** Вкладка-адрес (/profile/security): переход по ссылке, работает «назад» и прямая ссылка. */
  to?: To;
}

export interface TabsProps<Id extends string = string> {
  items: readonly TabItem<Id>[];
  active: Id;
  /** Для вкладок без адреса: выбрана вкладка. */
  onChange?: (id: Id) => void;
  /** Подпись группы для читалки экрана. */
  label: string;
  /** id панели с содержимым вкладки (role="tabpanel"). */
  panelId?: string;
  className?: string;
}

/** Вкладки (.tabs): стрелки влево/вправо, Home и End переключают вкладку. */
export function Tabs<Id extends string>({
  items,
  active,
  onChange,
  label,
  panelId,
  className,
}: TabsProps<Id>) {
  const refs = useRef<Array<HTMLAnchorElement | HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const count = items.length;
    const current = refs.current.findIndex((el) => el === document.activeElement);
    if (current < 0 || count === 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (current + 1) % count;
    else if (event.key === 'ArrowLeft') next = (current - 1 + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    if (next === null) return;
    event.preventDefault();
    const el = refs.current[next];
    el?.focus();
    // ссылку активируем ее же кликом: переход делает роутер
    el?.click();
  }

  return (
    <div className={cx('tabs', className)} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, i) => {
        const selected = item.id === active;
        const content = (
          <>
            {item.icon && <Icon name={item.icon} />}
            {item.label}
          </>
        );
        const common = {
          role: 'tab',
          'aria-selected': selected,
          'aria-controls': panelId,
          tabIndex: selected ? 0 : -1,
        } as const;
        if (item.to !== undefined) {
          return (
            <Link
              key={item.id}
              to={item.to}
              {...common}
              ref={(el) => {
                refs.current[i] = el;
              }}
            >
              {content}
            </Link>
          );
        }
        return (
          <button
            key={item.id}
            type="button"
            {...common}
            ref={(el) => {
              refs.current[i] = el;
            }}
            onClick={() => onChange?.(item.id)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
