/*
 * Service worker AI Capper (этап 6, Р26). Собирается при `npm run build` (плагин capperPwa в
 * vite.config.ts): сюда подставляются версия сборки и список файлов оболочки (SHELL), в dist
 * он попадает как /sw.js. Новых зависимостей нет.
 *
 * Что делает:
 * - кэширует только оболочку приложения: index.html, файлы /assets/* с хэшем в имени, значки и
 *   страницу «Нет связи» (offline.html). Ответы /api не кэширует никогда (В7): ставки и банк на
 *   устройстве не хранятся. Файлы /assets/* — из кэша, остальные файлы оболочки — из сети, а кэш
 *   только без нее. Версия (хэш содержимого всех файлов оболочки) меняется с любым из них;
 * - переход по адресу без сети — кэшированная оболочка (приложение само покажет «Нет связи»),
 *   а если ее нет — offline.html;
 * - push: показывает уведомление (значок, badge, tag — повтор заменяет прежнее, url в data);
 *   нажатие — фокус на открытой вкладке приложения или новое окно с url.
 * Новая версия ждет, пока закрыты все вкладки прежней, и включается при следующем открытии.
 */
/* global self, caches, clients */
'use strict';

// Подставляет сборка: { version: '<хэш>', shell: ['/index.html', '/assets/…', …], name, lang }
const BUILD = self.__CAPPER_SW__ || { version: 'dev', shell: [], name: '', lang: '' };
const PREFIX = 'capper-shell-';
const CACHE = PREFIX + BUILD.version;
const SHELL_PAGE = '/index.html';
const OFFLINE_PAGE = '/offline.html';
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(BUILD.shell)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Запрос, который service worker не трогает: чужой сайт, не GET, API, сам sw.js. */
function passThrough(request, url) {
  return (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/') ||
    url.pathname === '/sw.js'
  );
}

/** Переход по адресу: сеть, без сети — оболочка из кэша, без нее — «Нет связи». */
async function navigate(request) {
  try {
    const response = await fetch(request);
    if (response.ok && (response.headers.get('Content-Type') || '').includes('text/html')) {
      // свежая оболочка — на случай следующего захода без сети
      const cache = await caches.open(CACHE);
      await cache.put(SHELL_PAGE, response.clone());
    }
    return response;
  } catch (error) {
    const cache = await caches.open(CACHE);
    const cached = (await cache.match(SHELL_PAGE)) || (await cache.match(OFFLINE_PAGE));
    if (cached) return cached;
    throw error;
  }
}

/**
 * Файл оболочки. /assets/* с хэшем в имени не меняются: сначала кэш, нет — сеть и в кэш.
 * Остальные (theme-init.js, offline.js, значки, манифест) меняются под тем же именем: сначала
 * сеть (свежая копия — в кэш), без сети — кэш.
 */
async function shellFile(request, url) {
  const cache = await caches.open(CACHE);
  if (url.pathname.startsWith('/assets/')) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  }
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (passThrough(request, url)) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request));
    return;
  }
  if (url.pathname.startsWith('/assets/') || BUILD.shell.includes(url.pathname)) {
    event.respondWith(shellFile(request, url));
  }
});

/** Текст push: { title, body, url, tag } от сервера; без заголовка — название приложения. */
function pushData(event) {
  try {
    const data = event.data ? event.data.json() : {};
    return data && typeof data === 'object' ? data : {};
  } catch {
    return { body: event.data ? event.data.text() : '' };
  }
}

/** Адрес из push: только этот сайт, иначе главная. */
function targetUrl(raw) {
  try {
    const url = new URL(typeof raw === 'string' && raw ? raw : '/', self.location.origin);
    return url.origin === self.location.origin ? url.href : self.location.origin + '/';
  } catch {
    return self.location.origin + '/';
  }
}

self.addEventListener('push', (event) => {
  const data = pushData(event);
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    icon: ICON,
    badge: BADGE,
    lang: BUILD.lang,
    data: { url: targetUrl(data.url) },
  };
  if (typeof data.tag === 'string' && data.tag) {
    options.tag = data.tag;
    // повтор с тем же tag заменяет прежнее уведомление и снова его показывает
    options.renotify = true;
  }
  const title = typeof data.title === 'string' && data.title ? data.title : BUILD.name;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const same = windows.find((client) => client.url === url);
      if (same) return same.focus();
      const any = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (any) {
        // вкладка приложения уже открыта: туда и ведем
        const moved = 'navigate' in any ? await any.navigate(url).catch(() => null) : null;
        return (moved || any).focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
