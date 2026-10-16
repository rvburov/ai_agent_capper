import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/errors';
import { useLogout as useLogoutRequest } from '../../api/hooks/useLogout';
import { paths } from '../../app/paths';
import { useToast } from '../../components';
import { clearDraft } from '../analysis/draftStore';
import { revokePushBeforeLogout } from '../pwa/revoke';

/**
 * Выход из меню пользователя: push этого устройства отзывается (В4: POST
 * /api/me/push-subscriptions/revoke и отписка браузера, не дольше 3 с) → POST /api/auth/logout →
 * страница входа, кэш TanStack очищен, черновик «Нового анализа» стерт из вкладки, тост «Вы
 * вышли из аккаунта». Не вышло — тост «Не удалось выйти: …». Хук живет в оболочке приложения
 * и в кабинете; pending — на весь выход, общий для всех кнопок «Выйти».
 *
 * Кэш чистим, когда оболочка уже убрана со страницы, а не сразу после navigate(): маршрутизатор
 * меняет экран в переходе (startTransition), и до его завершения экраны приложения еще на месте.
 * Очищенный кэш при любой их перерисовке (тост) заставил бы useMe снова спросить /api/me — лишний
 * запрос с ответом 401.
 */
// Выход идет один на всю вкладку: меню пользователя, боковая панель, «Еще» и кабинет видят одно
// ожидание, повторное нажатие во время выхода ничего не повторяет
let running = false;
const listeners = new Set<() => void>();

function setRunning(value: boolean): void {
  running = value;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isRunning = () => running;

export function useLogout(): { logout: () => void; pending: boolean } {
  const { t } = useTranslation();
  const request = useLogoutRequest();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { mutateAsync } = request;
  const loggedOut = useRef(false);
  // Ожидание — на весь выход: отзыв push (до 3 с) и POST /api/auth/logout
  const pending = useSyncExternalStore(subscribe, isRunning, () => false);

  useEffect(
    () => () => {
      if (loggedOut.current) queryClient.clear();
    },
    [queryClient],
  );

  const logout = useCallback(() => {
    if (running) return;
    setRunning(true);
    void (async () => {
      try {
        // Сначала отзыв: после выхода сервер не примет запрос без сеанса
        await revokePushBeforeLogout();
        await mutateAsync();
        loggedOut.current = true;
        // Банк и букмекер из черновика не должны дождаться следующего входа в этой вкладке
        clearDraft();
        toast.show(t('shell.loggedOut'), { icon: 'logout' });
        void navigate(paths.login, { replace: true });
      } catch (error) {
        // Выход не удался: человек остается в аккаунте и должен это видеть (push этого
        // устройства к этому времени уже отозван — его включают заново в «Уведомлениях»)
        toast.show(t('shell.logoutFailed', { message: errorMessage(error) }), { icon: 'alert' });
      } finally {
        setRunning(false);
      }
    })();
  }, [mutateAsync, navigate, toast, t]);

  return { logout, pending };
}
