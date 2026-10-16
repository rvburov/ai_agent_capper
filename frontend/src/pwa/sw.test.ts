import { describe, expect, it, vi } from 'vitest';

import swSource from './sw.js?raw';

// Service worker (src/pwa/sw.js) в подмененном окружении: кэш, сеть, окна и уведомления.

const ORIGIN = 'https://capper.test';
const BUILD = { version: 'v1', shell: ['/index.html', '/offline.html', '/theme-init.js', '/assets/index-a1.js'], name: 'AI Capper', lang: 'ru' };

type Listener = (event: Record<string, unknown>) => void;

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

function keyOf(request: string | FakeRequest): string {
  return typeof request === 'string' ? new URL(request, ORIGIN).href : request.url;
}

function loadWorker({ oldCaches = [] as string[], windows = [] as { url: string; focus: ReturnType<typeof vi.fn>; navigate?: ReturnType<typeof vi.fn> }[] } = {}) {
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, Map<string, Response>>();
  for (const name of oldCaches) stores.set(name, new Map());
  const store = (name: string) => {
    let found = stores.get(name);
    if (!found) {
      found = new Map();
      stores.set(name, found);
    }
    return found;
  };
  const network = vi.fn(async (request: string | FakeRequest): Promise<Response> => {
    const url = keyOf(request);
    return new Response(`body of ${url}`, { status: 200, headers: { 'Content-Type': url.endsWith('.js') ? 'text/javascript' : 'text/html' } });
  });
  const caches = {
    open: async (name: string) => {
      const map = store(name);
      return {
        addAll: async (urls: string[]) => {
          for (const url of urls) map.set(keyOf(url), await network(url));
        },
        match: async (request: string | FakeRequest) => map.get(keyOf(request))?.clone(),
        put: async (request: string | FakeRequest, response: Response) => {
          map.set(keyOf(request), response);
        },
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const claim = vi.fn(async () => undefined);
  const self = {
    __CAPPER_SW__: BUILD,
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    registration: { showNotification },
    clients: { claim, openWindow, matchAll: async () => windows },
  };
  new Function('self', 'caches', 'fetch', swSource)(self, caches, network);

  /** Запрос страницы: undefined — service worker его не трогает. */
  async function request(path: string, { method = 'GET', mode = 'cors' } = {}): Promise<Response | undefined> {
    let answer: Promise<Response> | undefined;
    listeners.fetch?.({
      request: { url: new URL(path, ORIGIN).href, method, mode },
      respondWith: (value: Promise<Response>) => {
        answer = value;
      },
    });
    return answer;
  }

  async function lifecycle(type: 'install' | 'activate') {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[type]?.({ waitUntil: (value: Promise<unknown>) => (wait = value) });
    await wait;
  }

  async function dispatch(type: 'push' | 'notificationclick', event: Record<string, unknown>) {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[type]?.({ ...event, waitUntil: (value: Promise<unknown>) => (wait = value) });
    await wait;
  }

  return { request, lifecycle, dispatch, network, stores, showNotification, openWindow, claim };
}

describe('service worker: кэш', () => {
  it('ставится с файлами оболочки, старые версии кэша удаляет', async () => {
    const sw = loadWorker({ oldCaches: ['capper-shell-old', 'other-cache'] });
    await sw.lifecycle('install');
    expect([...(sw.stores.get('capper-shell-v1')?.keys() ?? [])]).toEqual(BUILD.shell.map((path) => `${ORIGIN}${path}`));
    await sw.lifecycle('activate');
    expect([...sw.stores.keys()].sort()).toEqual(['capper-shell-v1', 'other-cache']);
    expect(sw.claim).toHaveBeenCalled();
  });

  it('ответы /api не кэширует никогда (В7), чужие сайты и POST — не трогает', async () => {
    const sw = loadWorker();
    await sw.lifecycle('install');
    expect(await sw.request('/api/me')).toBeUndefined();
    expect(await sw.request('/api/bets?status=open')).toBeUndefined();
    expect(await sw.request('/api/me/notifications', { mode: 'navigate' })).toBeUndefined();
    expect(await sw.request('/assets/index-a1.js', { method: 'POST' })).toBeUndefined();
    expect(await sw.request('https://other.test/assets/x.js')).toBeUndefined();
    expect(await sw.request('/sw.js')).toBeUndefined();
    const cached = [...(sw.stores.get('capper-shell-v1')?.keys() ?? [])];
    expect(cached.some((url) => url.includes('/api'))).toBe(false);
  });

  it('файлы /assets — из кэша; новый файл — из сети и в кэш', async () => {
    const sw = loadWorker();
    await sw.lifecycle('install');
    sw.network.mockClear();
    expect(await (await sw.request('/assets/index-a1.js'))?.text()).toBe(`body of ${ORIGIN}/assets/index-a1.js`);
    expect(sw.network).not.toHaveBeenCalled();
    await sw.request('/assets/BetsPage-x9.js');
    expect(sw.network).toHaveBeenCalledTimes(1);
    expect(sw.stores.get('capper-shell-v1')?.has(`${ORIGIN}/assets/BetsPage-x9.js`)).toBe(true);
    // прочее (картинки вне оболочки) — не трогает
    expect(await sw.request('/icons/icon-512.png')).toBeUndefined();
  });

  it('файлы оболочки без хэша в имени (theme-init.js) — из сети, свежая копия в кэш; без сети — из кэша', async () => {
    const sw = loadWorker();
    await sw.lifecycle('install');
    sw.network.mockResolvedValueOnce(new Response('новая тема', { status: 200 }));
    expect(await (await sw.request('/theme-init.js'))?.text()).toBe('новая тема');
    expect(await sw.stores.get('capper-shell-v1')?.get(`${ORIGIN}/theme-init.js`)?.clone().text()).toBe('новая тема');
    sw.network.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await (await sw.request('/theme-init.js'))?.text()).toBe('новая тема');
  });

  it('переход по адресу: сеть; без сети — оболочка из кэша; без оболочки — «Нет связи»', async () => {
    const sw = loadWorker();
    await sw.lifecycle('install');
    expect(await (await sw.request('/bets', { mode: 'navigate' }))?.text()).toBe(`body of ${ORIGIN}/bets`);
    sw.network.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await (await sw.request('/bets', { mode: 'navigate' }))?.text()).toBe(`body of ${ORIGIN}/bets`);
    sw.stores.get('capper-shell-v1')?.delete(`${ORIGIN}/index.html`);
    expect(await (await sw.request('/analytics', { mode: 'navigate' }))?.text()).toBe(`body of ${ORIGIN}/offline.html`);
  });
});

describe('service worker: push', () => {
  it('показывает уведомление: заголовок, текст, значок, badge, tag и адрес этого сайта', async () => {
    const sw = loadWorker();
    const data = { title: 'Ставка №75 рассчитана', body: 'Откройте, чтобы посмотреть результат', url: '/bets?bet=75', tag: 'bet_settled:75' };
    await sw.dispatch('push', { data: { json: () => data, text: () => JSON.stringify(data) } });
    expect(sw.showNotification).toHaveBeenCalledWith('Ставка №75 рассчитана', {
      body: 'Откройте, чтобы посмотреть результат',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      lang: 'ru',
      tag: 'bet_settled:75',
      renotify: true,
      data: { url: `${ORIGIN}/bets?bet=75` },
    });
  });

  it('без заголовка — название приложения; адрес чужого сайта — главная', async () => {
    const sw = loadWorker();
    await sw.dispatch('push', { data: { json: () => ({ body: 'Текст', url: 'https://evil.test/x' }), text: () => '' } });
    expect(sw.showNotification).toHaveBeenCalledWith('AI Capper', expect.objectContaining({ body: 'Текст', data: { url: `${ORIGIN}/` } }));
  });

  it('нажатие: вкладка с этим адресом — фокус; другая вкладка приложения — переход и фокус; нет вкладок — новое окно', async () => {
    const same = { url: `${ORIGIN}/bets?bet=75`, focus: vi.fn(async () => undefined) };
    let sw = loadWorker({ windows: [same] });
    const close = vi.fn();
    await sw.dispatch('notificationclick', { notification: { close, data: { url: `${ORIGIN}/bets?bet=75` } } });
    expect(close).toHaveBeenCalled();
    expect(same.focus).toHaveBeenCalled();

    const other = { url: `${ORIGIN}/`, focus: vi.fn(async () => undefined), navigate: vi.fn(async () => other) };
    sw = loadWorker({ windows: [other] });
    await sw.dispatch('notificationclick', { notification: { close, data: { url: `${ORIGIN}/bets?bet=75` } } });
    expect(other.navigate).toHaveBeenCalledWith(`${ORIGIN}/bets?bet=75`);
    expect(other.focus).toHaveBeenCalled();

    sw = loadWorker();
    await sw.dispatch('notificationclick', { notification: { close, data: { url: `${ORIGIN}/profile` } } });
    expect(sw.openWindow).toHaveBeenCalledWith(`${ORIGIN}/profile`);
  });
});
