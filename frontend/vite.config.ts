import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

import { SCREEN_TEXTS, screenTexts, splitTexts } from './src/i18n/sections.ts';

/**
 * CSP сайта берется из deploy/Caddyfile — одного источника для Caddy и vite preview. На
 * preview идут сквозные тесты: встроенный скрипт, стиль или ресурс data:, который CSP не
 * пустит, ломает их, а не prod. В Docker-сборке Caddyfile рядом нет, preview там не нужен.
 */
function siteCsp(): Record<string, string> {
  try {
    const caddyfile = readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
    const policy = /Content-Security-Policy\s+"([^"]+)"/.exec(caddyfile)?.[1];
    return policy ? { 'Content-Security-Policy': policy } : {};
  } catch {
    return {};
  }
}

const TEXTS_PREFIX = 'virtual:capper-texts/';
const SCREEN_PREFIX = `${TEXTS_PREFIX}screen/`;
const SCREENS: Readonly<Record<string, readonly string[]>> = SCREEN_TEXTS;

/**
 * Тексты интерфейса частями: virtual:capper-texts/core — ядро для начальной загрузки
 * (оболочка, меню, ошибки, форматы, общие компоненты); virtual:capper-texts/screen/<экран> —
 * тексты экрана, он грузит их вместе со своим кодом (src/app/lazyPage.ts);
 * virtual:capper-texts/rest — все вне ядра (тесты и запасной путь, src/i18n/index.ts).
 * Источник один — locales/<язык>.json; состав — src/i18n/sections.ts. Модуль: { <язык>: тексты }.
 */
function capperTexts(): Plugin {
  const dir = fileURLToPath(new URL('./src/i18n/locales/', import.meta.url));
  return {
    name: 'capper-texts',
    resolveId(id) {
      if (id === `${TEXTS_PREFIX}core` || id === `${TEXTS_PREFIX}rest`) return `\0${id}`;
      if (id.startsWith(SCREEN_PREFIX) && id.slice(SCREEN_PREFIX.length) in SCREENS) return `\0${id}`;
      return undefined;
    },
    load(id) {
      if (!id.startsWith(`\0${TEXTS_PREFIX}`)) return undefined;
      const name = id.slice(TEXTS_PREFIX.length + 1);
      const out: Record<string, unknown> = {};
      for (const file of readdirSync(dir).filter((entry) => entry.endsWith('.json')).sort()) {
        const path = `${dir}${file}`;
        this.addWatchFile(path);
        const texts = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        out[file.replace(/\.json$/, '')] =
          name === 'core'
            ? splitTexts(texts).core
            : name === 'rest'
              ? splitTexts(texts).rest
              : screenTexts(texts, SCREENS[name.slice('screen/'.length)] ?? []);
      }
      return `export default ${JSON.stringify(out)};`;
    },
  };
}

/** Бюджет JS начальной загрузки, КБ gzip (docs/PLAN.md, «Целевые показатели»). */
const INITIAL_JS_BUDGET_KB = 250;

/**
 * Отчет размеров сборки и бюджет первого экрана. Начальная загрузка — входной файл и все, что он
 * импортирует статически (то, что браузер грузит до первого экрана). Первый экран добавляет
 * к ней свой файл (с его статическими импортами) и файл своих текстов (SCREEN_TEXTS,
 * src/i18n/sections.ts): так браузер и качает, открыв по ссылке любой экран. Бюджет — для
 * самого тяжелого экрана; больше — сборка падает: в CI (npm run build) и в Docker-образе.
 */
function bundleBudget(): Plugin {
  let log: (message: string) => void = console.log;
  return {
    name: 'capper-bundle-budget',
    apply: 'build',
    configResolved(config) {
      log = (message) => config.logger.info(message);
    },
    writeBundle(_options, bundle) {
      const chunks = new Map<string, { code: string; imports: string[]; isEntry: boolean; facadeModuleId: string | null }>();
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') chunks.set(file.fileName, file);
      }
      const kb = new Map([...chunks].map(([fileName, chunk]) => [fileName, gzipSync(chunk.code).length / 1024]));
      // Файл и все, что он импортирует статически
      const closure = (roots: readonly string[], into = new Set<string>()) => {
        const visit = (fileName: string) => {
          const chunk = chunks.get(fileName);
          if (!chunk || into.has(fileName)) return;
          into.add(fileName);
          chunk.imports.forEach(visit);
        };
        roots.forEach(visit);
        return into;
      };
      const byModule = (test: (id: string) => boolean) =>
        [...chunks].find(([, chunk]) => chunk.facadeModuleId !== null && test(chunk.facadeModuleId))?.[0];
      const sum = (files: Iterable<string>) => [...files].reduce((total, fileName) => total + (kb.get(fileName) ?? 0), 0);

      const initial = closure([...chunks].filter(([, chunk]) => chunk.isEntry).map(([fileName]) => fileName));
      const screens = Object.keys(SCREEN_TEXTS).map((page) => {
        const pageFile = byModule((id) => id.endsWith(`/src/pages/${page}.tsx`));
        const textsFile = byModule((id) => id === `\0${SCREEN_PREFIX}${page}`);
        if (!pageFile || !textsFile) this.error(`Нет файла сборки экрана или его текстов: ${page} (src/i18n/sections.ts)`);
        return { page, kb: sum(closure([pageFile, textsFile], new Set(initial))) };
      });
      screens.sort((a, b) => b.kb - a.kb);

      const rows = [...chunks.keys()].map((fileName) => ({ fileName, kb: kb.get(fileName) ?? 0, initial: initial.has(fileName) }));
      rows.sort((a, b) => Number(b.initial) - Number(a.initial) || b.kb - a.kb);
      const lines = rows.map(
        (row) => `  ${row.initial ? 'сразу    ' : 'по запросу'}  ${row.kb.toFixed(1).padStart(6)} КБ  ${row.fileName}`,
      );
      const screenLines = screens.map((row) => `  ${row.kb.toFixed(1).padStart(6)} КБ  ${row.page}`);
      log(['', 'JS по файлам (gzip):', ...lines, '', 'Первый экран: начальная загрузка + экран + его тексты (gzip):', ...screenLines].join('\n'));
      const heaviest = screens[0];
      const summary =
        `JS начальной загрузки: ${sum(initial).toFixed(1)} КБ gzip; ` +
        `первый экран — до ${heaviest ? heaviest.kb.toFixed(1) : '0'} КБ (${heaviest?.page ?? '—'}), бюджет ${INITIAL_JS_BUDGET_KB} КБ`;
      if (heaviest && heaviest.kb > INITIAL_JS_BUDGET_KB) {
        this.error(`${summary}: больше бюджета. Вынесите библиотеку или часть экрана в ленивую загрузку`);
      }
      log(summary);
    },
  };
}

// Библиотеки основы — отдельным файлом: они меняются реже кода приложения, и после выкладки
// браузер берет их из кэша. Остальные пакеты попадают туда, где их импортируют (экраны —
// в свои файлы), а не в начальную загрузку.
const VENDOR = /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack|i18next|react-i18next|openapi-fetch)[\\/]/;

// В разработке запросы /api уходят на FastAPI: по умолчанию uvicorn на порту 8000,
// другой адрес — переменной CAPPER_API_URL (например, для сквозных тестов). vite preview берет тот же прокси.
const apiUrl = process.env.CAPPER_API_URL ?? 'http://localhost:8000';

// Тесты (vitest) — в jsdom, файлы *.test.ts(x) рядом с кодом.
export default defineConfig({
  plugins: [react(), capperTexts(), bundleBudget()],
  build: {
    // Шрифты всегда отдельными файлами: CSP сайта (font-src 'self') не пускает шрифты из data:
    assetsInlineLimit: (filePath) => (/\.woff2?$/.test(filePath) ? false : undefined),
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: 'vendor', test: VENDOR }] },
      },
    },
  },
  server: {
    proxy: {
      '/api': apiUrl,
    },
  },
  // В режиме разработки CSP нет: Vite вставляет свои встроенные скрипты (обновление на лету)
  preview: {
    headers: siteCsp(),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    // С запасом под ожидание findBy* (5 с) на медленной машине CI
    testTimeout: 20_000,
    unstubGlobals: true,
  },
});
