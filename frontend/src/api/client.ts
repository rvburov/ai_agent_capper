import createClient, { type Middleware } from 'openapi-fetch';

import { apiErrorFrom, networkError } from './errors';
import type { paths } from './schema';

/*
 * Клиент API. Пути и типы — из schema.d.ts (npm run gen:api), руками не дублируются.
 * Cookie сеанса ставит сервер (HttpOnly), браузер отправляет ее сам: credentials same-origin.
 * Изменяющие запросы несут заголовок X-CSRF-Token со значением CSRF-cookie (double submit).
 */

export const CSRF_HEADER = 'X-CSRF-Token';
// В prod cookie с префиксом __Host-, в разработке (http) — без него
const CSRF_COOKIES = ['__Host-csrf', 'capper_csrf'];
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readCsrfCookie(cookies: string = document.cookie): string | null {
  for (const part of cookies.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (CSRF_COOKIES.includes(name)) {
      const value = part.slice(eq + 1).trim();
      if (value) return decodeURIComponent(value);
    }
  }
  return null;
}

export const api = createClient<paths>({
  // Абсолютный адрес того же сайта: Request в тестах (Node) не принимает относительный
  baseUrl: window.location.origin,
  credentials: 'same-origin',
  headers: { Accept: 'application/json' },
  // Через globalThis на каждый вызов: тесты подменяют fetch
  fetch: (request) => globalThis.fetch(request),
});

let csrfPending: Promise<string> | null = null;

// Первый изменяющий запрос без CSRF-cookie сначала получает ее: GET /api/auth/csrf.
// Параллельные запросы ждут один и тот же вызов.
async function ensureCsrfToken(): Promise<string> {
  const existing = readCsrfCookie();
  if (existing) return existing;
  csrfPending ??= api
    .GET('/api/auth/csrf')
    .then(({ data, error, response }) => {
      if (!data) throw apiErrorFrom(response.status, error);
      return readCsrfCookie() ?? data.csrf_token;
    })
    .finally(() => {
      csrfPending = null;
    });
  return csrfPending;
}

const csrfMiddleware: Middleware = {
  async onRequest({ request }) {
    if (!UNSAFE_METHODS.has(request.method) || request.headers.has(CSRF_HEADER)) return undefined;
    request.headers.set(CSRF_HEADER, await ensureCsrfToken());
    return request;
  },
};

const networkMiddleware: Middleware = {
  onError({ error }) {
    // отмену запроса (AbortController) пропускаем как есть
    if (error instanceof DOMException && error.name === 'AbortError') return error;
    return networkError(error);
  },
};

api.use(csrfMiddleware, networkMiddleware);

interface ApiResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Данные ответа или ApiError: удобно для TanStack Query.
 *   const me = await unwrap(api.GET('/api/me'));
 * Для ответа 204 возвращает undefined.
 */
export async function unwrap<T>(request: Promise<ApiResult<T>>): Promise<T> {
  const { data, error, response } = await request;
  if (!response.ok) throw apiErrorFrom(response.status, error);
  return data as T;
}
