import { defineConfig, devices } from '@playwright/test';

import { BASE_URL } from './e2e/support/stack';

/*
 * Тесты в Chromium (браузер — из PLAYWRIGHT_BROWSERS_PATH, в песочнице /opt/pw-browsers).
 * - shell: смоук оболочки на 360, 375 и 1366 px, API подменяется в самих тестах (page.route).
 * - desktop (1366 px) и mobile (375 px): сквозные сценарии e2e/flows на настоящем API.
 * - mobile-360: самый узкий телефон из PLAN.md («Готово, когда»: 360 px) — сценарии с меткой
 *   @360 (раскладка экранов на телефоне), чтобы не гонять все сценарии третий раз.
 * - exclusive (1366 px): сценарии, которые меняют общее для всех состояние (валюта программы,
 *   инструкции анализа и замороженный набор),
 *   идут после остальных проектов; в других проектах они пропускаются.
 * - loop (1366 px): сквозной сценарий этапа 5 learning-loop.spec.ts — после exclusive.
 * Service worker приложения (этап 6) в сценариях выключен (serviceWorkers: 'block'): подмена
 * ответов page.route его не видит, а кэш оболочки между тестами не нужен. Сценарии PWA
 * (e2e/flows/pwa.spec.ts) включают его своим устройствам: device({ serviceWorkers: 'allow' }).
 * Стек поднимает scripts/e2e-stack.sh: временная база с миграциями, uvicorn, vite preview с
 * прокси /api. Нужны PostgreSQL и Redis, как для тестов backend. Уже запущенный стек
 * (bash scripts/e2e-stack.sh в другом терминале) переиспользуется, кроме CI.
 */
const MOBILE_UA = [
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)',
  'Chrome/141.0.0.0 Mobile Safari/537.36',
].join(' ');

/** Телефон с сенсорным экраном заданной ширины. */
function phone(width: number, height: number) {
  return {
    ...devices['Desktop Chrome'],
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
  };
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    locale: 'ru-RU',
    timezoneId: 'Europe/Helsinki',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'shell', testMatch: 'shell.spec.ts', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'desktop',
      testDir: './e2e/flows',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } },
    },
    { name: 'mobile', testDir: './e2e/flows', use: phone(375, 812) },
    { name: 'mobile-360', testDir: './e2e/flows', grep: /@360/, use: phone(360, 780) },
    // Сценарии, которые меняют общее состояние стека (валюта программы, Р17): после остальных
    {
      name: 'exclusive',
      testDir: './e2e/flows',
      testMatch: ['admin-settings-currency.spec.ts', 'learning-versions.spec.ts'],
      dependencies: ['desktop', 'mobile', 'mobile-360'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } },
    },
    // Сквозной сценарий этапа 5 (ставка → архив → разбор → урок → версия → откат): тоже меняет
    // инструкции анализа и уроки, поэтому идет после exclusive, а не вместе с его сценариями
    {
      name: 'loop',
      testDir: './e2e/flows',
      testMatch: 'learning-loop.spec.ts',
      dependencies: ['exclusive'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } },
    },
  ],
  webServer: {
    command: 'bash ../scripts/e2e-stack.sh up',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    // SIGTERM, а не SIGKILL: скрипт успевает удалить временную базу и ключи Redis
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
