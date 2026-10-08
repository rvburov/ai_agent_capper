// Адреса экранов — как в макете, но путями вместо #хеша (mockup/js/app.js).

export const PROFILE_TABS = ['profile', 'security', 'bank', 'key', 'notifications', 'data'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

export const ADMIN_TABS = [
  'overview',
  'users',
  'invites',
  'access',
  'key',
  'usage',
  'settings',
  'audit',
  'message',
] as const;
export type AdminTab = (typeof ADMIN_TABS)[number];

export const paths = {
  login: '/login',
  register: '/register',
  reset: '/reset',
  home: '/',
  newAnalysis: '/new',
  analysis: (id: string | number) => `/analysis/${encodeURIComponent(String(id))}`,
  bets: '/bets',
  players: '/players',
  player: (id: string | number) => `/players/${encodeURIComponent(String(id))}`,
  analytics: '/analytics',
  learning: '/learning',
  costs: '/costs',
  profile: (tab?: ProfileTab) => (tab && tab !== 'profile' ? `/profile/${tab}` : '/profile'),
  admin: (tab?: AdminTab) => (tab && tab !== 'overview' ? `/admin/${tab}` : '/admin'),
} as const;

/**
 * Куда вернуться после входа: только путь этого же сайта. Внешний адрес («//evil.example»,
 * «https://...») и мусор дают главную — так ссылка входа не уводит на чужой сайт.
 * Адрес разбирается так же, как его разберет браузер: он вырезает табуляцию и перевод строки
 * и читает «\» как «/», поэтому «/<Tab>/evil.example» и «/\evil.example» — тоже чужой сайт.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/')) return paths.home;
  const origin = window.location.origin;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return paths.home;
  }
  if (url.origin !== origin || url.pathname.replace(/\/+$/, '') === paths.login) return paths.home;
  return url.pathname + url.search + url.hash;
}

/** Страница входа с возвратом туда, откуда пришли: /login?next=%2Fbets. */
export function loginPath(next?: string): string {
  if (!next || next === paths.home) return paths.login;
  return `${paths.login}?${new URLSearchParams({ next }).toString()}`;
}
