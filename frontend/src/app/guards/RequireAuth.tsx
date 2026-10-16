import { Suspense, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { errorMessage, isApiError, isUnauthorized, NETWORK_ERROR } from '../../api/errors';
import { useMe } from '../../api/hooks/useMe';
import { FullPageError, FullPageLoading } from '../layout/FullPageState';
import { lazyPage } from '../lazyPage';
import { OfflineScreen } from '../offline/OfflineScreen';
import { loginPath } from '../paths';

// Экран отмены удаления нужен редко — отдельным файлом сборки
const DeletionPendingScreen = lazyPage(
  () => import('../../pages/profile/deletion/DeletionPendingScreen').then((m) => m.DeletionPendingScreen),
  () => import('virtual:capper-texts/screen/profile/deletion/DeletionPendingScreen'),
);

/**
 * Пускает дальше только с действующим сеансом (GET /api/me). Нет сеанса (401) —
 * на /login?next=<откуда пришли>. Нет связи (запрос не дошел до сервера), а данных еще нет — экран
 * «Нет связи» (В7: приложение открыто из кэша service worker без сети); другая ошибка сервера —
 * экран ошибки с «Повторить».
 * Если пользователь уже загружен, а фоновая перепроверка упала по сети, приложение не прячем.
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const me = useMe();
  const location = useLocation();

  if (me.isError && isUnauthorized(me.error)) {
    // Пользователь уже был загружен — сеанс закончился при открытом приложении (выход на другом
    // устройстве, блокировка): экран входа скажет об этом
    return (
      <Navigate
        to={loginPath(location.pathname + location.search + location.hash)}
        replace
        state={me.data ? { sessionEnded: true } : undefined}
      />
    );
  }
  if (!me.data) {
    if (me.isError && isApiError(me.error) && me.error.code === NETWORK_ERROR) {
      return <OfflineScreen onBack={() => void me.refetch()} />;
    }
    if (me.isError) {
      return <FullPageError message={errorMessage(me.error)} onRetry={() => void me.refetch()} />;
    }
    return <FullPageLoading />;
  }
  // Аккаунт ждет удаления (В10): сервер открыт только для профиля, отмены и выхода — вместо
  // оболочки один экран отмены, а не ошибки на каждом экране
  if (me.data.deletion_requested_at) {
    return (
      <Suspense fallback={<FullPageLoading />}>
        <DeletionPendingScreen me={me.data} />
      </Suspense>
    );
  }
  return children ?? <Outlet />;
}
