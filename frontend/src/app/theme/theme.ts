import { readStored, writeStored } from '../../lib/storage';

// Тема: светлая, темная или как в системе. Выбор хранится в localStorage этого браузера
// (тот же ключ читает public/theme-init.js до первой отрисовки, чтобы не мигала другая тема).
export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'capper.theme';
export const DARK_QUERY = '(prefers-color-scheme: dark)';

export function readThemeChoice(): ThemeChoice {
  const stored = readStored(THEME_STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function storeThemeChoice(choice: ThemeChoice): void {
  writeStored(THEME_STORAGE_KEY, choice === 'system' ? null : choice);
}

/** data-theme на <html>: без атрибута тему выбирает CSS по prefers-color-scheme. */
export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  syncThemeColor(choice);
}

/**
 * Цвет строки состояния телефона (meta theme-color в index.html: светлый и темный по
 * prefers-color-scheme). Тема выбрана вручную — оба тега берут цвет этой темы, «как в системе» —
 * каждый свой. Исходный цвет тега запоминается в data-color.
 */
export function syncThemeColor(choice: ThemeChoice): void {
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
  for (const meta of metas) {
    if (!meta.dataset.color) meta.dataset.color = meta.content;
  }
  const colorOf = (theme: ResolvedTheme) => metas.find((meta) => meta.media.includes(theme))?.dataset.color;
  for (const meta of metas) {
    const color = choice === 'system' ? meta.dataset.color : colorOf(choice);
    if (color) meta.content = color;
  }
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}
