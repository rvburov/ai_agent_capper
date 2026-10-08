import { describe, expect, it } from 'vitest';

import { apiError, json, mockFetch } from '../test/fetchMock';
import { api, CSRF_HEADER, readCsrfCookie, unwrap } from './client';
import { ApiError } from './errors';

describe('CSRF', () => {
  it('читает cookie и в prod (__Host-csrf), и в разработке (capper_csrf)', () => {
    expect(readCsrfCookie('a=1; __Host-csrf=prod%2Btoken; b=2')).toBe('prod+token');
    expect(readCsrfCookie('capper_csrf=dev')).toBe('dev');
    expect(readCsrfCookie('capper_session=x')).toBeNull();
  });

  it('первый изменяющий запрос без cookie сначала получает ее, параллельные ждут один вызов', async () => {
    const { calls } = mockFetch({
      'GET /api/auth/csrf': () => {
        document.cookie = 'capper_csrf=tok123; path=/';
        return json({ csrf_token: 'tok123' });
      },
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
      'POST /api/me/notifications/read-all': () => new Response(null, { status: 204 }),
    });
    await Promise.all([
      unwrap(api.POST('/api/auth/logout')),
      unwrap(api.POST('/api/me/notifications/read-all')),
    ]);
    const paths = calls.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths.filter((p) => p === 'GET /api/auth/csrf')).toHaveLength(1);
    const posts = calls.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      expect(post.headers.get(CSRF_HEADER)).toBe('tok123');
      expect(post.credentials).toBe('same-origin');
    }
  });

  it('с cookie заголовок ставится сразу, GET идет без заголовка', async () => {
    document.cookie = 'capper_csrf=have; path=/';
    const { calls } = mockFetch({
      'POST /api/auth/logout': () => new Response(null, { status: 204 }),
      'GET /api/settings': () => json({ currency: 'RUB' }),
    });
    await unwrap(api.POST('/api/auth/logout'));
    const settings = await unwrap(api.GET('/api/settings'));
    expect(settings.currency).toBe('RUB');
    expect(calls.map((r) => r.method)).toEqual(['POST', 'GET']);
    expect(calls[0]?.headers.get(CSRF_HEADER)).toBe('have');
    expect(calls[1]?.headers.has(CSRF_HEADER)).toBe(false);
  });
});

describe('ошибки', () => {
  it('ответ {error: {code, message}} превращается в ApiError с текстом сервера', async () => {
    document.cookie = 'capper_csrf=t; path=/';
    mockFetch({
      'POST /api/auth/login': () =>
        apiError(429, 'auth.rate_limited', 'Вход временно закрыт', { retry_after: 840 }),
    });
    const error = await unwrap(
      api.POST('/api/auth/login', { body: { email: 'a@b.c', password: 'x' } }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiErr = error as ApiError;
    expect(apiErr.status).toBe(429);
    expect(apiErr.code).toBe('auth.rate_limited');
    expect(apiErr.message).toBe('Вход временно закрыт');
    expect(apiErr.retryAfter).toBe(840);
  });

  it('ошибка проверки отдает поля', async () => {
    document.cookie = 'capper_csrf=t; path=/';
    mockFetch({
      'POST /api/auth/login': () =>
        apiError(422, 'validation', 'Проверьте поля', {
          fields: [{ loc: ['body', 'email'], code: 'value_error' }],
        }),
    });
    const error = (await unwrap(
      api.POST('/api/auth/login', { body: { email: 'x', password: 'x' } }),
    ).catch((e: unknown) => e)) as ApiError;
    expect(error.fields).toEqual([{ loc: ['body', 'email'], code: 'value_error' }]);
  });

  it('страница ошибки прокси (502) — понятный текст', async () => {
    mockFetch({
      'GET /api/me': () => new Response('<html>Bad Gateway</html>', { status: 502 }),
    });
    const error = (await unwrap(api.GET('/api/me')).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(502);
    expect(error.code).toBe('unknown');
    expect(error.message).toBe('Сервер временно недоступен. Повторите через минуту.');
  });

  it('нет сети — ApiError network', async () => {
    mockFetch({
      'GET /api/me': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const error = (await unwrap(api.GET('/api/me')).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.code).toBe('network');
    expect(error.message).toBe('Нет связи с сервером. Проверьте интернет и повторите.');
  });
});
