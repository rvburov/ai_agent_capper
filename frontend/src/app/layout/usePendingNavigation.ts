import { useContext, useEffect, useState } from 'react';
import { matchRoutes, UNSAFE_DataRouterContext, useLocation, type Location } from 'react-router';

import type { RouteMeta } from '../routeMeta';

/** Через сколько миллисекунд долгий переход становится заметен: быстрые переходы не мигают. */
export const PENDING_DELAY_MS = 300;

export interface PendingNavigation {
  location: Location;
  /** handle экрана, на который идет переход: заголовок и пункт меню. */
  meta: RouteMeta | undefined;
}

function isRouteMeta(value: unknown): value is RouteMeta {
  return typeof value === 'object' && value !== null && 'title' in value;
}

/**
 * Переход на экран, файл которого еще грузится. Роутер меняет состояние в startTransition, а
 * ленивый экран (React.lazy) приостанавливает отрисовку: React держит на месте прежний экран,
 * адрес уже новый, а useNavigation() об этом не знает (загрузка — на уровне компонента, не
 * маршрута). Здесь сравниваются адрес роутера (подписка вне перехода) и адрес, который
 * отрисован. Возвращает переход, если он длится дольше delayMs, иначе null.
 */
export function usePendingNavigation(delayMs = PENDING_DELAY_MS): PendingNavigation | null {
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const shown = useLocation();
  const [latest, setLatest] = useState<Location | null>(null);
  const [slowKey, setSlowKey] = useState<string | null>(null);

  useEffect(() => {
    if (!router) return;
    // обычное (не переходное) обновление: оболочка перерисуется сразу, пока экран грузится
    return router.subscribe((state) => setLatest(state.location));
  }, [router]);

  const target = latest && latest.key !== shown.key ? latest : null;
  const targetKey = target?.key ?? null;

  useEffect(() => {
    if (targetKey === null) return;
    const timer = window.setTimeout(() => setSlowKey(targetKey), delayMs);
    return () => window.clearTimeout(timer);
  }, [targetKey, delayMs]);

  if (!router || !target || slowKey !== target.key) return null;
  const matches = matchRoutes(router.routes, target) ?? [];
  let meta: RouteMeta | undefined;
  for (let i = matches.length - 1; i >= 0 && !meta; i--) {
    const handle: unknown = matches[i]?.route.handle;
    if (isRouteMeta(handle)) meta = handle;
  }
  return { location: target, meta };
}
