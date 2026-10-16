import { ICON_PATHS, type IconName } from '../components/icons';

/*
 * Файлы PWA, которые собирает `npm run build` (плагин capperPwa в vite.config.ts): манифест,
 * страница «Нет связи» для первого захода без сети (offline.html) и service worker с версией и
 * списком файлов оболочки. Тексты — из locales/<язык>.json (те же ключи, что у экрана «Нет
 * связи» в приложении: pwa.offline.*), цвета — из styles/tokens.css. Здесь только чистые
 * функции: их проверяет vitest (src/pwa/build.test.ts), файлы пишет плагин.
 */

type Texts = { [key: string]: unknown };

function text(texts: Texts, key: string): string {
  let node: unknown = texts;
  for (const part of key.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Texts)[part] : undefined;
  }
  if (typeof node !== 'string') throw new Error(`Нет текста ${key} для файлов PWA`);
  return node;
}

export interface ThemeColors {
  /** Фон шапки светлой и темной темы (theme-color). */
  light: string;
  dark: string;
  /** Зеленый фирменный: фон значка и заставки Android (background_color, В9). */
  brand: string;
}

/** Цвета из tokens.css: --bg светлой темы (первый :root) и темной (prefers-color-scheme: dark), --accent светлой. */
export function themeColors(tokensCss: string): ThemeColors {
  const values = (name: string) => [...tokensCss.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))].map((m) => m[1] ?? '');
  const bg = values('--bg');
  const accent = values('--accent');
  const [light, dark] = bg;
  const [brand] = accent;
  if (!light || !dark || !brand) throw new Error('В tokens.css нет --bg светлой и темной темы или --accent');
  return { light, dark, brand };
}

/** Значки манифеста (PNG — scripts/gen-icons.mjs из mockup/icons). */
export const MANIFEST_ICONS = [
  { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] as const;

/** manifest.webmanifest: название, короткое имя под значком, цвета заставки и строки состояния. */
export function webManifest(texts: Texts, lang: string, colors: ThemeColors) {
  const name = text(texts, 'app.name');
  return {
    id: '/',
    name: `${name} — ${text(texts, 'app.tagline')}`,
    short_name: name,
    lang,
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: colors.brand,
    theme_color: colors.light,
    icons: MANIFEST_ICONS,
  };
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

/** Иконка макета разметкой (как компонент Icon). */
export function iconSvg(name: IconName): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ' +
    `stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICON_PATHS[name]}"/></svg>`
  );
}

/** Знак AI Capper разметкой (как BrandMark). */
const BRAND_MARK =
  '<svg class="brand-mark" viewBox="0 0 36 36" aria-hidden="true" focusable="false">' +
  '<rect x="1" y="1" width="34" height="34" rx="9" fill="var(--accent)"/>' +
  '<path d="M9 7v22M27 7v22M9 13h18M9 23h18M18 13v10" stroke="var(--accent-fg)" stroke-width="1.6" fill="none" opacity="0.85"/>' +
  '<circle cx="23.5" cy="18" r="3.2" fill="var(--brand-ball)" stroke="var(--accent)" stroke-width="1"/></svg>';

/** Линии корта в шапке карточки «Нет связи» (off-court, как в OfflineScreen). */
export const COURT_PATH = 'M30 10h340v112H30zM70 10v112M330 10v112M70 44h260M70 88h260M200 44v44';

export interface OfflinePageOptions {
  texts: Texts;
  lang: string;
  colors: ThemeColors;
  /** Стили приложения (файл сборки с токенами и .off-*): тот же вид, что у экрана в приложении. */
  styles: readonly string[];
}

/**
 * offline.html — «Нет связи», когда service worker не нашел в кэше оболочку приложения. Та же
 * разметка и тексты, что у экрана OfflineScreen; скрипты — только файлами (CSP: script-src
 * 'self'): theme-init.js (тема) и offline.js («Повторить» и уход, когда связь вернется).
 */
export function offlinePage({ texts, lang, colors, styles }: OfflinePageOptions): string {
  const t = (key: string) => escapeHtml(text(texts, `pwa.offline.${key}`));
  const name = escapeHtml(text(texts, 'app.name'));
  const tips = ['tip1', 'tip2', 'tip3'].map((key) => `<li>${iconSvg('check')}<span>${t(key)}</span></li>`).join('');
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="${colors.light}" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="${colors.dark}" media="(prefers-color-scheme: dark)" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>${t('pageTitle')} · ${name}</title>
    <script src="/theme-init.js"></script>
${styles.map((href) => `    <link rel="stylesheet" href="${escapeHtml(href)}" />`).join('\n')}
    <script src="/offline.js" defer></script>
  </head>
  <body>
    <div class="off-page">
      <main class="off-card" aria-labelledby="off-title">
        <div class="off-court" aria-hidden="true"><svg viewBox="0 0 400 132" preserveAspectRatio="none"><path class="ln" d="${COURT_PATH}"/></svg></div>
        <div class="off-top"><div class="off-brand">${BRAND_MARK}<span class="brand-name">${name}</span></div></div>
        <div class="off-ic" aria-hidden="true">${iconSvg('wifiOff')}</div>
        <h1 id="off-title">${t('title')}</h1>
        <p class="off-lead">${t('lead')}</p>
        <ul class="off-list">${tips}</ul>
        <button type="button" class="btn primary lg block" id="off-retry" data-checking="${t('checking')}" data-still="${t('still')}">${iconSvg('refresh')}<span>${t('retry')}</span></button>
        <div class="off-status" id="off-status" role="status" aria-live="polite"></div>
        <p class="off-foot">${t('foot')}</p>
      </main>
    </div>
  </body>
</html>
`;
}

/** Служебное поле в sw.js, куда сборка кладет версию и файлы оболочки. */
export const SW_BUILD_MARK = 'self.__CAPPER_SW__';

/** Файлы оболочки из собранного index.html: скрипты, стили и предзагрузка из /assets/. */
export function shellAssets(indexHtml: string): string[] {
  const out = new Set<string>();
  for (const match of indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
    if (match[1]) out.add(match[1]);
  }
  return [...out].sort();
}

/** Стили приложения из собранного index.html (для offline.html). */
export function shellStyles(indexHtml: string): string[] {
  return [...indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[^"]+\.css)"/g)].map((m) => m[1] ?? '').filter(Boolean);
}

/** Файлы вне /assets/, которые нужны без сети: страница «Нет связи», ее скрипты, значки, манифест. */
export const SHELL_STATIC = [
  '/index.html',
  '/offline.html',
  '/offline.js',
  '/theme-init.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/badge-96.png',
] as const;

/**
 * sw.js сборки: исходник src/pwa/sw.js с версией (хэш списка файлов) и списком оболочки.
 * version меняется с каждой сборкой, где поменялся хоть один файл: браузер видит новый sw.js
 * и ставит новую версию, она включается при следующем открытии.
 */
export function serviceWorker(source: string, build: { version: string; shell: readonly string[]; name: string; lang: string }): string {
  if (!source.includes(SW_BUILD_MARK)) throw new Error('В src/pwa/sw.js нет self.__CAPPER_SW__');
  return `${SW_BUILD_MARK} = ${JSON.stringify(build)};\n${source}`;
}
