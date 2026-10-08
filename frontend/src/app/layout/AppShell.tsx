import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, ScrollRestoration, useNavigate } from 'react-router';

import { errorMessage } from '../../api/errors';
import { useLogout } from '../../api/hooks/useLogout';
import { useMe } from '../../api/hooks/useMe';
import { useToast } from '../../components';
import { paths } from '../paths';
import { useRouteMeta } from '../routeMeta';
import { useDocumentTitle } from '../useDocumentTitle';
import { MoreSheet } from './MoreSheet';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';
import { TopBar } from './TopBar';

/**
 * Оболочка приложения (mockup/js/app.js, shell): боковая панель на компьютере,
 * нижние вкладки и шторка «Еще» на телефоне, шапка с заголовком раздела.
 * Рендерится внутри RequireAuth, поэтому пользователь уже загружен.
 */
export function AppShell() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const meta = useRouteMeta();
  const toast = useToast();
  const logout = useLogout();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [moreOpen, setMoreOpen] = useState(false);

  const title = meta ? t(`pages.${meta.title}`) : t('app.name');
  const crumbs = meta?.crumbs ? t(`crumbs.${meta.crumbs}`) : undefined;
  useDocumentTitle(meta ? title : undefined);

  if (!me) return null;
  const isAdmin = me.role === 'admin';

  function onLogout() {
    logout.mutate(undefined, {
      onSuccess: async () => {
        await navigate(paths.login, { replace: true });
        // данные прежнего входа в памяти не остаются
        queryClient.removeQueries();
        toast.show(t('shell.loggedOut'), { icon: 'logout' });
      },
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }

  return (
    <div className="shell">
      <a
        className="skip-link"
        href="#view"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('view')?.focus();
        }}
      >
        {t('shell.skipToContent')}
      </a>
      <div className="sidebar-col">
        <Sidebar navId={meta?.nav} isAdmin={isAdmin} onLogout={onLogout} />
      </div>
      <div className="main">
        <TopBar title={title} crumbs={crumbs} me={me} onLogout={onLogout} />
        <main className="view" id="view" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <TabBar navId={meta?.nav} moreOpen={moreOpen} onMore={() => setMoreOpen(true)} />
      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        navId={meta?.nav}
        isAdmin={isAdmin}
        onLogout={onLogout}
      />
      <ScrollRestoration />
    </div>
  );
}
