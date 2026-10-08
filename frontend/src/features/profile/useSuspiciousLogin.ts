import { useCallback, useMemo, useState } from 'react';

import { dismissSuspicious, findSuspicious, isSuspiciousDismissed } from './loginLog';
import type { LoginEvent } from './types';

/**
 * Предупреждение «кто-то ввел верный пароль, но не прошел 2FA» (журнал за 30 дней).
 * «Это был я» скрывает его в этом браузере; без хранилища — до перезагрузки страницы.
 */
export function useSuspiciousLogin(userId: number, events: readonly LoginEvent[] | undefined) {
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const found = useMemo(() => (events ? findSuspicious(events) : null), [events]);
  const event =
    found && found.at !== dismissedAt && !isSuspiciousDismissed(userId, found) ? found : null;
  const dismiss = useCallback(() => {
    if (!found) return;
    dismissSuspicious(userId, found);
    setDismissedAt(found.at);
  }, [found, userId]);
  return { event, dismiss };
}
