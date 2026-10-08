import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// В разработке запросы /api уходят на FastAPI (uvicorn на порту 8000).
// Тесты (vitest) — в jsdom, файлы *.test.ts(x) рядом с кодом.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8000',
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
