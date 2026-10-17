import { createContext, useContext, type ReactNode } from 'react';

import { Icon } from './Icon';

/**
 * Только просмотр (Р27): пока администратор смотрит данные участника, кнопки изменения с
 * пропом ro неактивны, а нажатие только объясняет почему (onBlocked показывает подсказку).
 * Без провайдера (свои данные) — null, и кнопки работают как обычно.
 */
export interface ReadOnlyState {
  /** Подсказка по умолчанию: «Только просмотр: менять данные участника может только он сам». */
  hint: string;
  onBlocked: (hint: string) => void;
}

export const ReadOnlyContext = createContext<ReadOnlyState | null>(null);

export function useReadOnly(): ReadOnlyState | null {
  return useContext(ReadOnlyContext);
}

/** Пояснение с замком вместо формы, которой в режиме просмотра нет (vw-note макета). */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <div className="vw-note">
      <Icon name="lock" />
      <span>{children}</span>
    </div>
  );
}
