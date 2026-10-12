import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/errors';
import { useLogout as useLogoutRequest } from '../../api/hooks/useLogout';
import { paths } from '../../app/paths';
import { useToast } from '../../components';
import { clearDraft } from '../analysis/draftStore';

/**
 * Выход из меню пользователя: POST /api/auth/logout → страница входа, кэш TanStack очищен,
 * черновик «Нового анализа» стерт из вкладки, тост «Вы вышли из аккаунта». Хук живет в оболочке
 * приложения.
 *
 * Кэш чистим, когда оболочка уже убрана со страницы, а не сразу после navigate(): маршрутизатор
 * меняет экран в переходе (startTransition), и до его завершения экраны приложения еще на месте.
 * Очищенный кэш при любой их перерисовке (тост) заставил бы useMe снова спросить /api/me — лишний
 * запрос с ответом 401.
 */
export function useLogout(): { logout: () => void; pending: boolean } {
  const { t } = useTranslation();
  const request = useLogoutRequest();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { mutate } = request;
  const loggedOut = useRef(false);

  useEffect(
    () => () => {
      if (loggedOut.current) queryClient.clear();
    },
    [queryClient],
  );

  const logout = useCallback(() => {
    mutate(undefined, {
      onSuccess: () => {
        loggedOut.current = true;
        // Банк и букмекер из черновика не должны дождаться следующего входа в этой вкладке
        clearDraft();
        toast.show(t('shell.loggedOut'), { icon: 'logout' });
        void navigate(paths.login, { replace: true });
      },
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }, [mutate, navigate, toast, t]);

  return { logout, pending: request.isPending };
}
