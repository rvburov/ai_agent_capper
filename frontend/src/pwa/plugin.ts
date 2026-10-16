import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Plugin } from 'vite';

import { SHELL_STATIC, offlinePage, serviceWorker, shellAssets, shellStyles, themeColors, webManifest } from './build.ts';

/*
 * Плагин сборки PWA (этап 6, подключен в vite.config.ts): manifest.webmanifest, offline.html и
 * sw.js в dist. Код для Node (fs, crypto) — отдельно от build.ts, который берет и приложение.
 */

/** Язык файлов PWA (манифест, offline.html, подпись push без заголовка) — запасной язык приложения. */
export const PWA_LANG = 'ru';

type Texts = Record<string, unknown>;

export interface PwaSources {
  texts: Texts;
  tokensCss: string;
  /** Исходник service worker (src/pwa/sw.js). */
  swSource: string;
}

function readSources(): PwaSources {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  return {
    texts: JSON.parse(read(`../i18n/locales/${PWA_LANG}.json`)) as Texts,
    tokensCss: read('../styles/tokens.css'),
    swSource: read('./sw.js'),
  };
}

function manifestText(sources: PwaSources): string {
  return `${JSON.stringify(webManifest(sources.texts, PWA_LANG, themeColors(sources.tokensCss)), null, 2)}\n`;
}

/**
 * Записать в собранный dist манифест, offline.html и sw.js. Версия sw.js — хэш содержимого
 * всех файлов оболочки (index.html, /assets/*, offline.html, theme-init.js, offline.js, значки,
 * манифест) и исходника service worker: поменялся хоть один байт любого из них — sw.js другой,
 * браузер ставит новую версию, и она заново кэширует оболочку. Возвращает версию.
 */
export function writePwaFiles(outDir: string, sources: PwaSources = readSources()): string {
  const colors = themeColors(sources.tokensCss);
  const index = readFileSync(resolve(outDir, 'index.html'), 'utf8');
  writeFileSync(resolve(outDir, 'manifest.webmanifest'), manifestText(sources));
  writeFileSync(resolve(outDir, 'offline.html'), offlinePage({ texts: sources.texts, lang: PWA_LANG, colors, styles: shellStyles(index) }));
  const shell = [...SHELL_STATIC, ...shellAssets(index)];
  const hash = createHash('sha256').update(sources.swSource);
  for (const path of shell) {
    hash.update(`\n${path}\n`);
    hash.update(readFileSync(resolve(outDir, `.${path}`)));
  }
  const version = hash.digest('hex').slice(0, 12);
  const app = sources.texts.app;
  const name = typeof app === 'object' && app !== null ? String((app as Texts).name) : '';
  writeFileSync(resolve(outDir, 'sw.js'), serviceWorker(sources.swSource, { version, shell, name, lang: PWA_LANG }));
  return version;
}

/**
 * PWA в сборке Vite. Тексты — из locales/ru.json, цвета — из styles/tokens.css (build.ts). В
 * разработке отдается только манифест: service worker регистрируется лишь в production-сборке
 * (src/pwa/register.ts).
 */
export function capperPwa(): Plugin {
  let outDir = '';
  return {
    name: 'capper-pwa',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/manifest.webmanifest', (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json');
        res.end(manifestText(readSources()));
      });
    },
    writeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        writePwaFiles(outDir);
      },
    },
  };
}
