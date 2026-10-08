import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
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

// В разработке запросы /api уходят на FastAPI: по умолчанию uvicorn на порту 8000,
// другой адрес — переменной CAPPER_API_URL (например, для сквозных тестов). vite preview берет тот же прокси.
const apiUrl = process.env.CAPPER_API_URL ?? 'http://localhost:8000';

// Тесты (vitest) — в jsdom, файлы *.test.ts(x) рядом с кодом.
export default defineConfig({
  plugins: [react()],
  build: {
    // Шрифты всегда отдельными файлами: CSP сайта (font-src 'self') не пускает шрифты из data:
    assetsInlineLimit: (filePath) => (/\.woff2?$/.test(filePath) ? false : undefined),
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
