import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ADMIN_TABS, LEARNING_TABS, PLAYER_TABS, PROFILE_TABS, paths } from '../../src/app/paths';

/*
 * Все адреса приложения — из списка маршрутов src/app/router.tsx, а не вручную: общая проверка
 * раскладки (all-routes.spec.ts) обходит каждый маршрут. Маршрут, для которого здесь не сказано,
 * какими адресами его открыть, роняет проверку: новый экран не останется без проверки на 360 и
 * 375 px.
 */

const ROUTER = fileURLToPath(new URL('../../src/app/router.tsx', import.meta.url));

/** Шаблоны маршрутов в порядке router.tsx: «/login», «/» (index), «analysis/:id», «*». */
export function routePatterns(source: string = readFileSync(ROUTER, 'utf8')): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\b(?:path:\s*'([^']+)'|index:\s*true)/g)) {
    out.push(match[1] ?? '/index');
  }
  return out.filter((pattern) => pattern !== '/');
}

/** Для каких данных строить адреса: номер своего анализа и игрока стека. */
export interface RouteContext {
  analysisId: number;
  playerId: number;
}

export type Audience = 'guest' | 'member' | 'admin';

export interface AppUrl {
  url: string;
  /** Кто открывает: без входа (вход, регистрация), участник или администратор. */
  who: Audience;
  pattern: string;
}

const ROUTE_URLS: Record<string, (ctx: RouteContext) => { who: Audience; urls: string[] }> = {
  '/login': () => ({ who: 'guest', urls: [paths.login] }),
  '/register': () => ({ who: 'guest', urls: [paths.register] }),
  '/reset': () => ({ who: 'guest', urls: [paths.reset] }),
  '/index': () => ({ who: 'member', urls: [paths.home] }),
  new: () => ({ who: 'member', urls: [paths.newAnalysis] }),
  'analysis/:id': (ctx) => ({ who: 'member', urls: [paths.analysis(ctx.analysisId)] }),
  bets: () => ({ who: 'member', urls: [paths.bets] }),
  players: () => ({ who: 'member', urls: [paths.players] }),
  // «Профиль из бота» у игроков стека нет — адрес вкладки уводит на обзор; его проверяет players.spec.ts
  'players/:id/:tab?': (ctx) => ({
    who: 'member',
    urls: PLAYER_TABS.filter((tab) => tab !== 'profile').map((tab) => paths.player(ctx.playerId, tab)),
  }),
  analytics: () => ({ who: 'member', urls: [paths.analytics] }),
  'learning/:tab?': () => ({ who: 'member', urls: LEARNING_TABS.map((tab) => paths.learning(tab)) }),
  costs: () => ({ who: 'member', urls: [paths.costs] }),
  'profile/:tab?': () => ({ who: 'member', urls: PROFILE_TABS.map((tab) => paths.profile(tab)) }),
  'admin/:tab?': () => ({ who: 'admin', urls: ADMIN_TABS.map((tab) => paths.admin(tab)) }),
  '*': () => ({ who: 'member', urls: ['/no-such-page'] }),
};

/** Адреса всех маршрутов router.tsx; неизвестный маршрут — ошибка. */
export function appUrls(ctx: RouteContext, patterns: readonly string[] = routePatterns()): AppUrl[] {
  const out: AppUrl[] = [];
  for (const pattern of patterns) {
    const build = ROUTE_URLS[pattern];
    if (!build) throw new Error(`Маршрут «${pattern}» из router.tsx не описан в e2e/support/routes.ts`);
    const { who, urls } = build(ctx);
    for (const url of urls) out.push({ url, who, pattern });
  }
  return out;
}
