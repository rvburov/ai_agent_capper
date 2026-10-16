import { listenInstallEvents } from '../features/pwa/install';

/*
 * Старт PWA (main.tsx): слушать события установки (beforeinstallprompt приходит рано) и
 * зарегистрировать service worker. Регистрация — только в production-сборке (в том числе на
 * стеке сквозных тестов, он собирает production): в разработке sw.js нет. Новая версия sw.js
 * ставится в фоне и включается при следующем открытии приложения (src/pwa/sw.js).
 */
export function startPwa(): void {
  listenInstallEvents();
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const register = () => {
    // Не вышло (запрещено настройками браузера, нет HTTPS) — приложение работает и без него
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
