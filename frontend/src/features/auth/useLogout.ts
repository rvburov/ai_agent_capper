import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/errors';
import { useLogout as useLogoutRequest } from '../../api/hooks/useLogout';
import { paths } from '../../app/paths';
import { useToast } from '../../components';

/**
 * Выход из меню пользователя: POST /api/auth/logout → страница входа, кэш TanStack очищен,
 * тост «Вы вышли из аккаунта». Кэш чистим после перехода: экраны приложения уже размонтированы
 * и не запросят данные заново.
 */
export function useLogout(): { logout: () => void; pending: boolean } {
  const { t } = useTranslation();
  const request = useLogoutRequest();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { mutate } = request;

  const logout = useCallback(() => {
    mutate(undefined, {
      onSuccess: async () => {
        await navigate(paths.login, { replace: true });
        queryClient.clear();
        toast.show(t('shell.loggedOut'), { icon: 'logout' });
      },
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }, [mutate, navigate, queryClient, toast, t]);

  return { logout, pending: request.isPending };
}
