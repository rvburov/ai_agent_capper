import { aiBudget } from '../../../features/ai/testData';
import { bankOut, strategyV3 } from '../../../features/analysis/testData';
import { playLimitsOut } from '../../../features/bank/testData';
import { betsSummary } from '../../../features/bets/testData';
import { bookmakersOut } from '../../../features/bookmakers/testData';
import { strategyVersions } from '../../../features/learning/testData';
import { json, ME_MEMBER, type Handler } from '../../../test/fetchMock';
import { renderPage } from '../../../test/renderPage';
import { ProfilePage } from '../ProfilePage';

/** Ответы для вкладки «Банк и стратегия»: банк, стратегия, журнал, лимиты, букмекеры. */
export function bankTabApi(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/me/bank': () => json(bankOut({ balance: '42000.00', equity: '43320.00', in_play: '1320.00' })),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/me/bank/entries': () => json({ items: [], next_before: null, last_id: null }),
    'GET /api/bets/summary': () => json(betsSummary()),
    'GET /api/me/bookmakers/list': () => json(bookmakersOut()),
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/me/login-events': () => json([]),
    'GET /api/strategy/versions': () => json(strategyVersions()),
    ...over,
  };
}

/** Кабинет на вкладке «Банк и стратегия» (или другой: url). */
export function renderBankTab(handlers: Record<string, Handler>, { me = ME_MEMBER, url = '/profile/bank', width }: { me?: typeof ME_MEMBER | { readonly [key: string]: unknown }; url?: string; width?: number } = {}) {
  return renderPage(<ProfilePage />, {
    path: '/profile/:tab?',
    url,
    me: me as typeof ME_MEMBER,
    api: handlers,
    width,
    stubs: { '/admin/:tab?': 'Администрирование', '/login': 'Страница входа' },
  });
}
