import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import ru from '../i18n/locales/ru.json';
import swSource from './sw.js?raw';
import {
  MANIFEST_ICONS,
  SHELL_STATIC,
  escapeHtml,
  offlinePage,
  serviceWorker,
  shellAssets,
  shellStyles,
  themeColors,
  webManifest,
} from './build';

// Файлы PWA, которые собирает npm run build: манифест, offline.html и sw.js (src/pwa/build.ts).

// CSS и HTML vitest не отдает как текст (?raw стилей пуст) — читаем файлы
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const tokens = read('../styles/tokens.css');
const indexHtml = read('../../index.html');
const colors = themeColors(tokens);

describe('PWA: цвета и манифест', () => {
  it('цвета — из tokens.css: фон шапки светлой и темной темы, зеленый значка (В9)', () => {
    expect(colors).toEqual({ light: '#f1f4f0', dark: '#0d110f', brand: '#14684a' });
  });

  it('theme-color в index.html — те же цвета тем, что в tokens.css', () => {
    expect(indexHtml).toContain(`<meta name="theme-color" content="${colors.light}" media="(prefers-color-scheme: light)" />`);
    expect(indexHtml).toContain(`<meta name="theme-color" content="${colors.dark}" media="(prefers-color-scheme: dark)" />`);
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  });

  it('манифест: имя и короткое имя из ru.json, standalone, значки 192, 512 и maskable', () => {
    const manifest = webManifest(ru, 'ru', colors);
    expect(manifest).toMatchObject({
      name: 'AI Capper — теннисная аналитика',
      short_name: 'AI Capper',
      lang: 'ru',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#14684a',
      theme_color: '#f1f4f0',
    });
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
  });

  it('значки манифеста и badge лежат в public/icons', () => {
    const files = Object.keys(import.meta.glob('../../public/icons/*.png'));
    const names = files.map((path) => path.replace('../../public', ''));
    for (const icon of MANIFEST_ICONS) expect(names).toContain(icon.src);
    expect(names).toEqual(expect.arrayContaining(['/icons/apple-touch-icon.png', '/icons/badge-96.png']));
  });
});

describe('PWA: offline.html', () => {
  const html = offlinePage({ texts: ru, lang: 'ru', colors, styles: ['/assets/index-abc.css'] });

  it('тексты — из ru.json (pwa.offline), стили приложения, скрипты только файлами (CSP)', () => {
    expect(html).toContain('<h1 id="off-title">Нет связи с интернетом</h1>');
    expect(html).toContain('Выключите режим «В самолете»');
    expect(html).toContain('<span>Повторить</span>');
    expect(html).toContain('data-still="Связи по-прежнему нет. Попробуйте еще раз через минуту"');
    expect(html).toContain('<link rel="stylesheet" href="/assets/index-abc.css" />');
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html).toContain('<script src="/offline.js" defer></script>');
    // встроенных скриптов нет: CSP script-src 'self'
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toBeNull();
    expect(html).toContain('<title>Нет связи · AI Capper</title>');
    expect(html).toMatch(/<html lang="ru">/);
  });

  it('текст экранируется', () => {
    expect(escapeHtml('<b>"A&B"</b>')).toBe('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
  });
});

describe('PWA: sw.js сборки', () => {
  const index =
    '<script type="module" crossorigin src="/assets/index-a1.js"></script>' +
    '<link rel="modulepreload" crossorigin href="/assets/vendor-b2.js">' +
    '<link rel="stylesheet" crossorigin href="/assets/index-c3.css">';

  it('файлы оболочки — из собранного index.html', () => {
    expect(shellAssets(index)).toEqual(['/assets/index-a1.js', '/assets/index-c3.css', '/assets/vendor-b2.js']);
    expect(shellStyles(index)).toEqual(['/assets/index-c3.css']);
  });

  it('версия и список файлов — в начале исходника; без метки — ошибка', () => {
    const shell = [...SHELL_STATIC, ...shellAssets(index)];
    const out = serviceWorker(swSource, { version: 'abc123', shell, name: 'AI Capper', lang: 'ru' });
    expect(out.startsWith('self.__CAPPER_SW__ = {"version":"abc123","shell":["/index.html","/offline.html"')).toBe(true);
    expect(out).toContain(swSource);
    expect(() => serviceWorker('console.log(1)', { version: 'x', shell: [], name: '', lang: '' })).toThrow(/__CAPPER_SW__/);
  });
});
