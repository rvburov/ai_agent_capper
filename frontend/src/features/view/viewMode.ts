// Режим просмотра данных участника (Р27): администратор видит «Главную», «Ставки», «Аналитику»,
// «Банк и стратегию» и анализы участника так, как их видит он сам, только просмотр. Режим живет
// в адресе (?as=<id>): ссылка и обновление страницы его сохраняют. Запросы этих экранов идут с
// as_user, а их ключи кэша — под префиксом ['view', id]: чужие данные не смешиваются со своими.

/** Параметр адреса: /bets?as=7. */
export const VIEW_PARAM = 'as';
/** Префикс ключей кэша чужих данных: ['view', id, ...ключ экрана]. */
export const VIEW_PREFIX = 'view';

/** Экраны режима просмотра: главная, ставки, аналитика, анализы, анализ и «Банк и стратегия». */
export function isViewablePath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return (
    path === '/' ||
    path === '/bets' ||
    path === '/analytics' ||
    path === '/new' ||
    path === '/profile/bank' ||
    /^\/analysis\/[^/]+$/.test(path)
  );
}

/** Чьи данные в адресе: целое положительное число или null. */
export function parseViewParam(search: string): number | null {
  const raw = new URLSearchParams(search).get(VIEW_PARAM);
  if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/** Строка поиска с ?as=<id> (null — без него); остальные параметры сохраняются. */
export function withViewSearch(search: string, id: number | null): string {
  const params = new URLSearchParams(search);
  if (id === null) params.delete(VIEW_PARAM);
  else params.set(VIEW_PARAM, String(id));
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Адрес экрана в режиме просмотра: viewTo('/bets', 7) — '/bets?as=7'. */
export function viewTo(path: string, id: number): string {
  const at = path.indexOf('?');
  const base = at < 0 ? path : path.slice(0, at);
  return base + withViewSearch(at < 0 ? '' : path.slice(at), id);
}

/**
 * Куда вести при смене участника: тот же экран без его параметров (ставка, фильтры принадлежат
 * прежнему участнику), анализ — к списку анализов.
 */
export function switchTarget(pathname: string): string {
  if (/^\/analysis\//.test(pathname)) return '/new';
  return isViewablePath(pathname) ? pathname : '/';
}

/** Ключ кэша: свой — как был, чужой — под ['view', id]. */
export function viewKey(asUser: number | null, key: readonly unknown[]): readonly unknown[] {
  return asUser === null ? key : [VIEW_PREFIX, asUser, ...key];
}

/** Параметр запроса: {} для своих данных, { as_user: id } для чужих. */
export function asUserQuery(asUser: number | null): { as_user?: number } {
  return asUser === null ? {} : { as_user: asUser };
}
