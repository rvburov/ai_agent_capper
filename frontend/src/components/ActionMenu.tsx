import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { cx } from '../lib/cx';
import { matchesMedia, SHEET_QUERY } from '../lib/useMediaQuery';
import './ActionMenu.css';
import { Icon, type IconName } from './Icon';
import { IconButton } from './IconButton';
import { Modal } from './Modal';

/*
 * Меню действий строки (кнопка «⋯»), как menuButton/openMenu в макете (mockup/js/screens/admin.js):
 * на компьютере — всплывающий список под кнопкой, на телефоне (до 720 px) — шторка снизу.
 * Пункт может быть недоступен с пояснением мелким текстом («себя удалить нельзя»).
 * Клавиатура: стрелки, Home/End, Esc закрывает и возвращает фокус на кнопку, Tab закрывает.
 * При прокрутке меню едет за кнопкой; ушла кнопка из вида — меню закрывается.
 */

export interface ActionMenuItem {
  id: string;
  label: string;
  icon: IconName;
  /** Пояснение под названием: «нужен ваш код 2FA», «код на 24 часа». */
  hint?: string | null;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type ActionMenuEntry = ActionMenuItem | 'separator';

interface ActionMenuListProps {
  items: readonly ActionMenuEntry[];
  onPick: (item: ActionMenuItem) => void;
  /** Подпись меню для читалки экрана. */
  label: string;
  className?: string;
}

/** Список пунктов меню (role="menu"): во всплывающем меню, в шторке и внутри окна. */
export function ActionMenuList({ items, onPick, label, className }: ActionMenuListProps) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('.action-menu-item:not([disabled])'),
    );
    if (!list.length) return;
    const i = list.findIndex((el) => el === document.activeElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowDown') next = list[i + 1] ?? list[0];
    else if (event.key === 'ArrowUp') next = list[i - 1] ?? list[list.length - 1];
    else if (event.key === 'Home') next = list[0];
    else if (event.key === 'End') next = list[list.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  return (
    <div className={cx('action-menu-list', className)} role="menu" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((item, index) =>
        item === 'separator' ? (
          <div key={`sep-${index}`} className="action-menu-sep" role="separator" />
        ) : (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={cx('action-menu-item', item.danger && 'danger')}
            disabled={item.disabled}
            onClick={() => onPick(item)}
          >
            <Icon name={item.icon} />
            <span>
              {item.label}
              {item.hint && <small>{item.hint}</small>}
            </span>
          </button>
        ),
      )}
    </div>
  );
}

// Пока положение не посчитано, меню стоит за краем экрана (а не скрыто): так первый пункт
// сразу может получить фокус
const OFFSCREEN: CSSProperties = { left: -9999, top: 0 };

export interface ActionMenuProps {
  /** Заголовок меню и шторки: имя человека. */
  title: string;
  /** Подпись кнопки «⋯» для читалки экрана: «Действия: Ольга Лехтинен». */
  label: string;
  items: readonly ActionMenuEntry[];
  className?: string;
}

export function ActionMenu({ title, label, items, className }: ActionMenuProps) {
  const [open, setOpen] = useState<'pop' | 'sheet' | null>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  function close(returnFocus: boolean) {
    setOpen(null);
    setStyle(null);
    if (returnFocus) anchorRef.current?.focus({ preventScroll: true });
  }

  function toggle() {
    if (open) {
      close(true);
      return;
    }
    setOpen(matchesMedia(SHEET_QUERY) ? 'sheet' : 'pop');
  }

  // Выбор пункта: меню закрывается, фокус — на кнопке «⋯». Окно действия (Modal) запомнит ее
  // и вернет фокус туда же, когда закроется
  function pick(item: ActionMenuItem) {
    close(open === 'pop');
    item.onSelect();
  }

  // Положение как в макете: под кнопкой по правому краю, а если снизу мало места — над ней
  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = anchor.bottom + 6;
    if (top + h > vh - 12) top = anchor.top - h - 6 >= 12 ? anchor.top - h - 6 : Math.max(12, vh - h - 12);
    setStyle({ left: Math.max(12, Math.min(vw - w - 12, anchor.right - w)), top });
  }, []);

  useLayoutEffect(() => {
    if (open === 'pop') place();
  }, [open, place]);

  // Фокус — на первый доступный пункт, когда меню уже стоит на месте
  useEffect(() => {
    if (open !== 'pop' || !style) return;
    popRef.current?.querySelector<HTMLButtonElement>('.action-menu-item:not([disabled])')?.focus({
      preventScroll: true,
    });
  }, [open, style]);

  useEffect(() => {
    if (open !== 'pop') return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && (popRef.current?.contains(target) || anchorRef.current?.contains(target))) return;
      setOpen(null);
      setStyle(null);
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (event.key === 'Tab') {
        // фокус возвращается на кнопку, и Tab ведет к следующему элементу страницы
        close(true);
      }
    }
    function onAway() {
      setOpen(null);
      setStyle(null);
    }
    // Прокрутка: меню едет за кнопкой, а если кнопка ушла под шапку или за край экрана — закрывается
    function onScroll() {
      const r = anchorRef.current?.getBoundingClientRect();
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
      if (!r || r.bottom < topbar || r.top > window.innerHeight) onAway();
      else place();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onAway);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onAway);
    };
  }, [open, place]);

  return (
    <>
      <IconButton
        ref={anchorRef}
        icon="more"
        label={label}
        size="sm"
        className={cx('action-menu-btn', className)}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onClick={toggle}
      />
      {open === 'pop' &&
        createPortal(
          <div
            ref={popRef}
            className="action-menu"
            style={style ?? OFFSCREEN}
          >
            <div className="action-menu-head" aria-hidden="true">
              {title}
            </div>
            <ActionMenuList items={items} onPick={pick} label={title} />
          </div>,
          document.body,
        )}
      <Modal open={open === 'sheet'} onClose={() => close(false)} title={title}>
        <ActionMenuList items={items} onPick={pick} label={title} className="action-sheet" />
      </Modal>
    </>
  );
}
