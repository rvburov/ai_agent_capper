import { useEffect, useState, type ReactNode, type RefObject } from 'react';

import { cx } from '../lib/cx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import './StickyActionBar.css';

export interface StickyActionBarProps {
  /** Подпись области для читалки экрана: «Запуск анализа». */
  label: string;
  /** Основная кнопка на странице: пока она видна, панель спрятана. */
  watch?: RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
}

/**
 * Панель действия над нижними вкладками на телефоне (до 960 px), как .new-bar в макете:
 * прячется, когда на экране видна основная кнопка (IntersectionObserver). На компьютере
 * ее нет. Под ней — пустое место той же высоты, чтобы конец страницы не прятался.
 */
export function StickyActionBar({ label, watch, children, className }: StickyActionBarProps) {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const target = watch?.current;
    if (!mobile || !target || typeof IntersectionObserver === 'undefined') {
      setHidden(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => setHidden(entry.isIntersecting)),
      { rootMargin: '0px 0px -150px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [mobile, watch]);

  if (!mobile) return null;
  return (
    <>
      <div
        className={cx('sticky-bar', hidden && 'off', className)}
        role="region"
        aria-label={label}
        aria-hidden={hidden || undefined}
        inert={hidden || undefined}
      >
        {children}
      </div>
      <div className="sticky-bar-spacer" aria-hidden="true" />
    </>
  );
}
