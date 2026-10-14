import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';

import { paths } from '../../app/paths';
import { useToast } from '../../components';
import { clearDraft } from '../analysis/draftStore';

/**
 * Удаление запрошено: сервер уже завершил все сеансы и стер cookie. Как выход из меню
 * (features/auth/useLogout): страница входа, черновик «Нового анализа» стерт, сообщение с датой
 * удаления. Кэш чистится, когда экраны приложения уже убраны, — иначе они перечитали бы
 * данные и получили 401.
 */
export function useLeaveAccount(): (message: string) => void {
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const left = useRef(false);

  useEffect(
    () => () => {
      if (left.current) client.clear();
    },
    [client],
  );

  return useCallback(
    (message: string) => {
      left.current = true;
      clearDraft();
      toast.show(message, { icon: 'trash', duration: 10_000 });
      void navigate(paths.login, { replace: true });
    },
    [navigate, toast],
  );
}
