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
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}
