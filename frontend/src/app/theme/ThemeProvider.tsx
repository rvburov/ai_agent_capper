import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useMediaQuery } from '../../lib/useMediaQuery';
import {
  applyThemeChoice,
  DARK_QUERY,
  readThemeChoice,
  resolveTheme,
  storeThemeChoice,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from './theme';
import { ThemeContext, type ThemeApi } from './themeContext';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(readThemeChoice);
  const systemDark = useMediaQuery(DARK_QUERY);
  const resolved = resolveTheme(choice, systemDark);

  useEffect(() => {
    applyThemeChoice(choice);
  }, [choice]);

  // Тема, выбранная в другой вкладке, применяется и здесь
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === null || event.key === THEME_STORAGE_KEY) setChoiceState(readThemeChoice());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setChoice = useCallback((next: ThemeChoice) => {
    storeThemeChoice(next);
    setChoiceState(next);
  }, []);

  const toggle = useCallback(() => {
    setChoice(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setChoice]);

  const api = useMemo<ThemeApi>(
    () => ({ choice, resolved, setChoice, toggle }),
    [choice, resolved, setChoice, toggle],
  );
  return <ThemeContext.Provider value={api}>{children}</ThemeContext.Provider>;
}
