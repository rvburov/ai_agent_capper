import { useSyncExternalStore } from 'react';

// Ширины из макета: до 960 px — телефонная раскладка (нижние вкладки),
// до 720 px — списки и окна выезжают шторкой снизу.
export const MOBILE_QUERY = '(max-width: 960px)';
export const SHEET_QUERY = '(max-width: 720px)';

function mediaList(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
}

export function matchesMedia(query: string): boolean {
  return mediaList(query)?.matches ?? false;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = mediaList(query);
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => matchesMedia(query),
    () => false,
  );
}
