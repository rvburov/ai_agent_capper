import { Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, ScrollRestoration } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { useLogout } from '../../features/auth/useLogout';
import { useRouteMeta } from '../routeMeta';
import { useDocumentTitle } from '../useDocumentTitle';
import { PageLoading } from './FullPageState';
import { InstallModal } from './InstallModal';
import { ScreenTitleContext } from './screenTitle';
import { MoreSheet } from './MoreSheet';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';
import { TopBar } from './TopBar';
import { usePendingNavigation } from './usePendingNavigation';

/**
 * Оболочка приложения (mockup/js/app.js, shell): боковая панель на компьютере,
 * нижние вкладки и шторка «Еще» на телефоне, шапка с заголовком раздела.
 * Рендерится внутри RequireAuth, поэтому пользователь уже загружен.
 */
export function AppShell() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  // Переход на экран, который грузится дольше 300 мс: шапка и меню — уже нового экрана, на
  // месте прежнего — индикатор (как при первой загрузке), а не застывший прежний экран
  const pending = usePendingNavigation();
  const shownMeta = useRouteMeta();
  const meta = pending ? (pending.meta ?? shownMeta) : shownMeta;
  // Выход: запрос, переход на /login, очистка кэша и тост — в одном хуке
  const { logout: onLogout, pending: loggingOut } = useLogout();
  const [moreOpen, setMoreOpen] = useState(false);
  // Окно установки: из боковой панели и шторки «Еще» (кабинет открывает свое)
  const [installOpen, setInstallOpen] = useState(false);
  // Заголовок из данных экрана (имя игрока) — только пока на экране он сам, а не переход
  const [screenTitle, setScreenTitle] = useState<string | null>(null);

  const title = screenTitle && !pending ? screenTitle : meta ? t(`pages.${meta.title}`) : t('app.name');
  const crumbs = meta?.crumbs ? t(`crumbs.${meta.crumbs}`) : undefined;
  useDocumentTitle(meta ? title : undefined);

  if (!me) return null;
  const isAdmin = me.role === 'admin';

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
        <Sidebar navId={meta?.nav} isAdmin={isAdmin} onLogout={onLogout} loggingOut={loggingOut} onInstall={() => setInstallOpen(true)} />
      </div>
      <div className="main">
        <TopBar title={title} crumbs={crumbs} me={me} onLogout={onLogout} loggingOut={loggingOut} />
        <main className="view" id="view" tabIndex={-1} aria-busy={pending ? true : undefined}>
          {/* экран грузится отдельным файлом (src/app/lazyPage.ts): шапка и меню уже на месте */}
          {pending && <PageLoading immediate />}
          {/* прежний экран при долгом переходе скрыт, но не размонтирован: переход могут отменить */}
          <div className="view-screen" hidden={pending !== null}>
            <Suspense fallback={<PageLoading />}>
              <ScreenTitleContext.Provider value={setScreenTitle}>
                <Outlet />
              </ScreenTitleContext.Provider>
            </Suspense>
          </div>
        </main>
      </div>
      <TabBar navId={meta?.nav} moreOpen={moreOpen} onMore={() => setMoreOpen(true)} />
      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        navId={meta?.nav}
        isAdmin={isAdmin}
        onLogout={onLogout}
        loggingOut={loggingOut}
        onInstall={() => setInstallOpen(true)}
      />
      <InstallModal open={installOpen} onClose={() => setInstallOpen(false)} />
      <ScrollRestoration />
    </div>
  );
}
