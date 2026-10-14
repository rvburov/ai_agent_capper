import { useEffect } from 'react';
import { useLocation } from 'react-router';

/**
 * Прокрутка к якорю из адреса (#profile-rg, #profile-export) — ссылки «Часто нужно» сводки.
 * ready — данные над целью загружены и высота над ней больше не изменится.
 */
export function useHashTarget(ready: boolean): void {
  const { hash, key } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id || !ready) return;
    const frame = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [hash, key, ready]);
}
