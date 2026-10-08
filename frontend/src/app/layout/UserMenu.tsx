import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { Me } from '../../api/hooks/useMe';
import { Chip, Icon, Segmented } from '../../components';
import { paths } from '../paths';
import { useTheme } from '../theme/themeContext';
import type { ThemeChoice } from '../theme/theme';
import { initials } from './initials';

interface UserMenuProps {
  me: Me;
  onLogout: () => void;
}

const THEMES: readonly ThemeChoice[] = ['light', 'dark', 'system'];

/** Кружок с инициалами в шапке: меню «Личный кабинет», тема, «Выйти». */
export function UserMenu({ me, onLogout }: UserMenuProps) {
  const { t } = useTranslation();
  const { choice, setChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  function close(returnFocus: boolean) {
    setOpen(false);
    setStyle(null);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }

  // Под кнопкой, по правому краю
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      setStyle({ top: Math.round(r.bottom + 8), right: Math.max(12, Math.round(window.innerWidth - r.right)) });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    popRef.current?.focus({ preventScroll: true });
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(popRef.current?.contains(target) || buttonRef.current?.contains(target));
    function onPointerDown(event: PointerEvent) {
      if (inside(event.target)) return;
      setOpen(false);
      setStyle(null);
    }
    // Tab увел фокус на другой элемент страницы — меню закрывается, а не висит поверх нее.
    // Ловим focusin, а не blur: blur без адресата бывает и при клике по кнопке в Safari
    // (кнопка там фокус не берет), и когда окно браузера теряет фокус.
    function onFocusIn(event: FocusEvent) {
      if (inside(event.target)) return;
      setOpen(false);
      setStyle(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      setStyle(null);
      buttonRef.current?.focus({ preventScroll: true });
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const letters = initials(me.display_name, me.email);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="avatar"
        aria-label={t('shell.userMenu')}
        title={me.display_name || me.email}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        {letters}
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          className="menu-pop"
          role="dialog"
          aria-label={t('shell.userMenu')}
          tabIndex={-1}
          style={{ ...style, visibility: style ? undefined : 'hidden' }}
        >
          <div className="menu-head">
            <span className="avatar" aria-hidden="true">
              {letters}
            </span>
            <div className="menu-head-text">
              <span className="menu-head-name">{me.display_name || me.email}</span>
              <span className="menu-head-email">{me.email}</span>
              <Chip kind={me.role === 'admin' ? 'accent' : 'outline'}>{t(`shell.role.${me.role}`)}</Chip>
            </div>
          </div>
          <Link className="menu-item" to={paths.profile()} onClick={() => close(false)}>
            <Icon name="user" />
            {t('nav.profile')}
          </Link>
          <div className="menu-section">
            <span className="eyebrow">{t('shell.theme')}</span>
            <Segmented
              label={t('shell.theme')}
              items={THEMES.map((value) => ({ value, label: t(`shell.themeOption.${value}`) }))}
              value={choice}
              onChange={setChoice}
            />
          </div>
          <button
            type="button"
            className="menu-item danger"
            onClick={() => {
              close(false);
              onLogout();
            }}
          >
            <Icon name="logout" />
            {t('nav.logout')}
          </button>
        </div>
      )}
    </>
  );
}
