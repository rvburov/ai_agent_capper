import { vi } from 'vitest';

// Подмена fetch для тестов клиента API: ответ выбирается по методу и пути запроса.
export type Handler = (request: Request) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function apiError(status: number, code: string, message: string, extra = {}): Response {
  return json({ error: { code, message, ...extra } }, status);
}

/** routes: { 'GET /api/me': handler }. Незнакомый запрос — 404 и ошибка теста. */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Request[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push(request);
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`Нет ответа для ${key}`);
    return handler(request);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export const ME_MEMBER = {
  id: 2,
  email: 'anna@example.com',
  display_name: 'Анна Петрова',
  role: 'member',
  status: 'active',
  ai_mode: 'shared',
  tz: 'Europe/Helsinki',
  totp_enabled: true,
  created_at: '2026-10-01T09:00:00Z',
  consent_training: false,
  deletion_requested_at: null,
  deletion_at: null,
} as const;

export const ME_ADMIN = { ...ME_MEMBER, id: 1, email: 'owner@example.com', display_name: 'Роман Буров', role: 'admin' } as const;
