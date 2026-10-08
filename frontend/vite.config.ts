import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

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
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
