import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

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

/** Бюджет JS начальной загрузки, КБ gzip (docs/PLAN.md, «Целевые показатели»). */
const INITIAL_JS_BUDGET_KB = 250;

/**
 * Отчет размеров сборки и бюджет начальной загрузки. Начальная загрузка — входной файл и все,
 * что он импортирует статически (то, что браузер грузит до первого экрана); экраны грузятся
 * по требованию (src/app/lazyPage.ts) и в нее не входят. Больше бюджета — сборка падает: в CI
 * (npm run build) и в Docker-образе.
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
      const chunks = new Map<string, { code: string; imports: string[]; isEntry: boolean }>();
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') chunks.set(file.fileName, file);
      }
      const initial = new Set<string>();
      const visit = (fileName: string) => {
        const chunk = chunks.get(fileName);
        if (!chunk || initial.has(fileName)) return;
        initial.add(fileName);
        chunk.imports.forEach(visit);
      };
      for (const [fileName, chunk] of chunks) if (chunk.isEntry) visit(fileName);

      const rows = [...chunks].map(([fileName, chunk]) => ({
        fileName,
        kb: gzipSync(chunk.code).length / 1024,
        initial: initial.has(fileName),
      }));
      rows.sort((a, b) => Number(b.initial) - Number(a.initial) || b.kb - a.kb);
      const total = rows.filter((row) => row.initial).reduce((sum, row) => sum + row.kb, 0);
      const lines = rows.map(
        (row) => `  ${row.initial ? 'сразу    ' : 'по запросу'}  ${row.kb.toFixed(1).padStart(6)} КБ  ${row.fileName}`,
      );
      log(['', 'JS по файлам (gzip):', ...lines].join('\n'));
      const summary = `JS начальной загрузки: ${total.toFixed(1)} КБ gzip (бюджет ${INITIAL_JS_BUDGET_KB} КБ)`;
      if (total > INITIAL_JS_BUDGET_KB) {
        this.error(`${summary}: больше бюджета. Вынесите экран или библиотеку в ленивую загрузку`);
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
  plugins: [react(), bundleBudget()],
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
