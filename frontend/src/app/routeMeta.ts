import { useMatches } from 'react-router';

import type ru from '../i18n/locales/ru.json';
import type { NavId } from './layout/nav';

export type PageKey = keyof (typeof ru)['pages'];
export type CrumbKey = keyof (typeof ru)['crumbs'];

/** handle маршрута: заголовок в шапке и вкладке браузера, пункт меню, «хлебные крошки». */
export interface RouteMeta {
  title: PageKey;
  nav?: NavId;
  crumbs?: CrumbKey;
}

function isRouteMeta(value: unknown): value is RouteMeta {
  return typeof value === 'object' && value !== null && 'title' in value;
}

/** Самый глубокий handle среди совпавших маршрутов. */
export function useRouteMeta(): RouteMeta | undefined {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i]?.handle;
    if (isRouteMeta(handle)) return handle;
  }
  return undefined;
}
