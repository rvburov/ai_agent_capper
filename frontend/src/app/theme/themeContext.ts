import { createContext, useContext } from 'react';

import type { ResolvedTheme, ThemeChoice } from './theme';

export interface ThemeApi {
  /** Что выбрал пользователь. */
  choice: ThemeChoice;
  /** Что видно сейчас (для «системной» — тема ОС). */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  /** Переключатель в шапке: светлая ↔ темная. */
  toggle: () => void;
}

export const ThemeContext = createContext<ThemeApi | null>(null);

export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (!api) throw new Error('useTheme: нет ThemeProvider выше по дереву');
  return api;
}
