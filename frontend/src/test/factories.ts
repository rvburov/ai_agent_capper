import { aiBudget } from '../features/ai/testData';
import { bankOut, strategyV3 } from '../features/analysis/testData';
import { analyticsOut } from '../features/analytics/testData';
import { dashboardOut } from '../features/dashboard/testData';
import { memberPrefsOut } from '../features/notifications/testData';
import { json, ME_ADMIN, ME_MEMBER, type Handler } from './fetchMock';

/*
 * Фабрики ответов API для тестов экранов: каждый вызов — новый объект, поля меняются
 * аргументом over. Типы — из OpenAPI (src/api/schema.d.ts) через features/<раздел>/types.ts:
 * смена схемы бэкенда ломает фабрику при tsc, а не тест молча. Фабрики разделов лежат рядом
 * с разделом (features/<раздел>/testData.ts) и собираются здесь.
 */

export { aiBudget, analyticsOut, bankOut, dashboardOut, strategyV3 };
export { ME_ADMIN, ME_MEMBER };

export type Me = typeof ME_MEMBER | typeof ME_ADMIN;
export type Currency = 'RUB' | 'USD' | 'EUR';

/** Публичные настройки программы (GET /api/settings): валюта по Р17. */
export function settingsOut(currency: Currency = 'RUB') {
  return { currency };
}

/** Центр уведомлений без уведомлений (GET /api/me/notifications). */
export function notificationsEmpty() {
  return { items: [], unread: 0 };
}

/**
 * Ответы, которые нужны любому экрану: CSRF для изменяющих запросов, текущий пользователь,
 * валюта программы и колокольчик. me = null — сеанса нет (401).
 */
export function baseApi(me: Me | null = ME_MEMBER, currency: Currency = 'RUB'): Record<string, Handler> {
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/me': () =>
      me ? json(me) : json({ error: { code: 'auth.not_authenticated', message: 'Войдите в аккаунт' } }, 401),
    'GET /api/settings': () => json(settingsOut(currency)),
    'GET /api/me/notifications': () => json(notificationsEmpty()),
    // колокольчик прячет выключенные в кабинете виды: настройки — все включены
    'GET /api/me/notification-prefs': () => json(memberPrefsOut()),
  };
}

/**
 * Ответы главной: показатели периода (GET /api/dashboard — участник 13 октября 2026, 30 дней),
 * банк, стратегия и лимит ИИ.
 */
export function dashboardApi(): Record<string, Handler> {
  return {
    'GET /api/dashboard': () => json(dashboardOut()),
    'GET /api/me/bank': () => json(bankOut()),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/ai/budget': () => json(aiBudget()),
  };
}
