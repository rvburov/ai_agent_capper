import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

import { addTexts, type TextsModule } from '../i18n';

/*
 * Экраны грузятся отдельными файлами сборки, когда их открывают: начальный JS меньше
 * (PLAN.md: < 250 КБ gzip). После выкладки новой версии старых файлов на сервере нет, и
 * открытая со вчера вкладка не сможет загрузить экран — это ChunkLoadError. RouteError
 * показывает понятный текст и один раз сам перезагружает страницу (claimChunkReload).
 */

/** Файл экрана не загрузился: вышла новая версия программы или пропала связь. */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ChunkLoadError';
  }
}

export function isChunkLoadError(error: unknown): error is ChunkLoadError {
  return error instanceof ChunkLoadError;
}

/**
 * Ленивый экран вместе с его текстами (src/i18n/sections.ts, SCREEN_TEXTS):
 *   lazyPage(() => import('../pages/x/XPage').then((m) => m.XPage), () => import('virtual:capper-texts/screen/x/XPage'))
 * Экран рисуется уже со своими текстами, а не с ключами. Любой отказ загрузки (нет файла, нет
 * связи, не загрузились стили или тексты) — ChunkLoadError.
 */
export function lazyPage<P extends object>(
  load: () => Promise<ComponentType<P>>,
  // Без текстов — только ядро (тесты оболочки); экраны приложения передают свои, это проверяет
  // i18n.test.ts
  texts?: () => Promise<TextsModule>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() =>
    Promise.all([load(), texts?.().then(addTexts)]).then(
      ([Component]) => ({ default: Component }),
      (error: unknown) => {
        throw new ChunkLoadError(error);
      },
    ),
  );
}

// Когда страница последний раз перезагружалась сама из-за ChunkLoadError (sessionStorage)
export const CHUNK_RELOAD_KEY = 'capper.chunkReloadAt';
/** Повторная ошибка в этом окне после автоперезагрузки — не новая версия, а сбой: без цикла. */
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

function lastChunkReload(): number {
  return Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY));
}

/**
 * Страница уже перезагружалась сама из-за ChunkLoadError меньше минуты назад: ошибка
 * повторилась после перезагрузки — это не новая версия, а сбой (сервер, сеть, ошибка в коде
 * экрана). Только читает отметку, ничего не пишет.
 */
export function chunkReloadedRecently(now: number = Date.now()): boolean {
  try {
    const last = lastChunkReload();
    return last > 0 && now - last >= 0 && now - last < CHUNK_RELOAD_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Можно ли перезагрузить страницу самой: только если связь есть и за последнюю минуту
 * автоперезагрузки не было. Разрешение сразу записывается — вторая ошибка подряд покажет
 * текст и кнопку, а не перезагрузит страницу снова. Без sessionStorage (запрет хранилища)
 * автоперезагрузки нет: не на чем удержаться от цикла.
 */
export function claimChunkReload(now: number = Date.now()): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const last = lastChunkReload();
    if (last > 0 && now - last >= 0 && now - last < CHUNK_RELOAD_WINDOW_MS) return false;
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}
