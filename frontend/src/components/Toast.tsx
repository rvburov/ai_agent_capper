import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Icon, type IconName } from './Icon';

const DEFAULT_DURATION_MS = 2600;

export interface ToastOptions {
  icon?: IconName;
  /** Сколько показывать, мс. */
  duration?: number;
}

export interface ToastApi {
  show: (message: string, options?: ToastOptions) => void;
}

interface ToastItem {
  id: number;
  message: string;
  icon: IconName;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Короткие сообщения внизу экрана (.toast): «Сохранено», «Вы вышли из аккаунта». */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const show = useCallback((message: string, options: ToastOptions = {}) => {
    const id = nextId.current++;
    setItems((list) => [...list, { id, message, icon: options.icon ?? 'check' }]);
    window.setTimeout(() => {
      setItems((list) => list.filter((item) => item.id !== id));
    }, options.duration ?? DEFAULT_DURATION_MS);
  }, []);

  const api = useMemo<ToastApi>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-host" aria-live="polite">
          {items.map((item) => (
            <div key={item.id} className="toast" role="status">
              <Icon name={item.icon} />
              <span>{item.message}</span>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast: нет ToastProvider выше по дереву');
  return api;
}
