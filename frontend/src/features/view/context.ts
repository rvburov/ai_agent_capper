import { createContext, useContext } from 'react';

/** Режим просмотра данных участника (Р27) для экранов и шапки. */
export interface ViewMode {
  /** Чьи данные на экране: id участника или null — свои. */
  asUser: number | null;
  /**
   * В адресе ?as= чужого, а смотреть чужие данные нельзя (участник): экран вместо данных
   * показывает понятную ошибку.
   */
  denied: boolean;
  /** Администратор на экране, где можно выбрать, чьи данные смотреть. */
  canPick: boolean;
  /** Открыть данные участника: to — экран (по умолчанию тот же, анализ — список анализов). */
  open: (id: number, to?: string) => void;
  /** Вернуться к своим данным на том же экране. */
  exit: () => void;
}

const INACTIVE: ViewMode = {
  asUser: null,
  denied: false,
  canPick: false,
  open: () => undefined,
  exit: () => undefined,
};

export const ViewModeContext = createContext<ViewMode>(INACTIVE);

export function useViewMode(): ViewMode {
  return useContext(ViewModeContext);
}

/** Чьи данные запрашивать: null — свои, id — участника (запросы с as_user). */
export function useViewAs(): number | null {
  return useContext(ViewModeContext).asUser;
}
