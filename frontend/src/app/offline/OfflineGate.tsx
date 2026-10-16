import { onlineManager } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { OfflineScreen } from './OfflineScreen';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

const isOffline = () => navigator.onLine === false;

/**
 * Связь пропала — поверх приложения экран «Нет связи» (В7): старые цифры не показываем. Само
 * приложение остается на месте (недописанный текст анализа не пропадет), но недоступно (inert).
 * Связь вернулась — экран уходит сам, TanStack Query перечитывает данные. «Повторить» убирает
 * экран, если сервер отвечает, даже когда браузер еще считает, что связи нет.
 */
export function OfflineGate({ children }: { children: ReactNode }) {
  const offline = useSyncExternalStore(subscribe, isOffline, () => false);
  // «Повторить» сработало раньше события online: экран убран до следующей потери связи
  const [dismissed, setDismissed] = useState(false);
  const shown = offline && !dismissed;

  useEffect(() => {
    if (!offline) setDismissed(false);
  }, [offline]);

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return undefined;
    root.inert = shown;
    return () => {
      root.inert = false;
    };
  }, [shown]);

  return (
    <>
      {children}
      {shown &&
        createPortal(
          <div className="off-overlay">
            <OfflineScreen
              onBack={() => {
                setDismissed(true);
                onlineManager.setOnline(true);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
