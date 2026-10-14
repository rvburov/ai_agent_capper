import { createContext, useContext, useEffect } from 'react';

/*
 * Заголовок экрана из данных (UI.setHeader макета): карточка игрока показывает в шапке и во
 * вкладке браузера имя игрока, а не общее «Игрок». Без него — заголовок маршрута (handle).
 */
export const ScreenTitleContext = createContext<(title: string | null) => void>(() => undefined);

/** Экран задает заголовок шапки; пусто — заголовок маршрута. Уходя с экрана, заголовок снимается. */
export function useScreenTitle(title: string | null | undefined): void {
  const setTitle = useContext(ScreenTitleContext);
  useEffect(() => {
    setTitle(title || null);
    return () => setTitle(null);
  }, [setTitle, title]);
}
