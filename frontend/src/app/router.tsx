import { Suspense, type ReactNode } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';

import { NotFoundPage } from '../pages/not-found/NotFoundPage';
import { StubPage } from '../pages/stub/StubPage';
import { RequireAdmin } from './guards/RequireAdmin';
import { RequireAuth } from './guards/RequireAuth';
import { AppShell } from './layout/AppShell';
import { PageLoading } from './layout/FullPageState';
import { lazyPage } from './lazyPage';
import type { RouteMeta } from './routeMeta';
import { RouteError } from './RouteError';

// Адреса — как в макете, путями вместо #хеша. Один экран — одна папка в src/pages.
// Этапы заглушек — по дорожной карте (docs/PLAN.md, раздел 10).
function meta(value: RouteMeta): RouteMeta {
  return value;
}

// Каждый экран — свой файл сборки: грузится, когда его открывают (src/app/lazyPage.ts),
// вместе со своими текстами (SCREEN_TEXTS, src/i18n/sections.ts).
// Экраны в оболочке ждут загрузки внутри AppShell (Suspense вокруг Outlet), вход и
// регистрация — на весь экран. Заглушки и «Такой страницы нет» — маленькие, в общем файле.
const LoginPage = lazyPage(
  () => import('../pages/auth/LoginPage').then((m) => m.LoginPage),
  () => import('virtual:capper-texts/screen/auth/LoginPage'),
);
const RegisterPage = lazyPage(
  () => import('../pages/auth/RegisterPage').then((m) => m.RegisterPage),
  () => import('virtual:capper-texts/screen/auth/RegisterPage'),
);
const ResetPage = lazyPage(
  () => import('../pages/auth/ResetPage').then((m) => m.ResetPage),
  () => import('virtual:capper-texts/screen/auth/ResetPage'),
);
const NewAnalysisPage = lazyPage(
  () => import('../pages/new/NewAnalysisPage').then((m) => m.NewAnalysisPage),
  () => import('virtual:capper-texts/screen/new/NewAnalysisPage'),
);
const AnalysisPage = lazyPage(
  () => import('../pages/analysis/AnalysisPage').then((m) => m.AnalysisPage),
  () => import('virtual:capper-texts/screen/analysis/AnalysisPage'),
);
const ProfilePage = lazyPage(
  () => import('../pages/profile/ProfilePage').then((m) => m.ProfilePage),
  () => import('virtual:capper-texts/screen/profile/ProfilePage'),
);
const AdminPage = lazyPage(
  () => import('../pages/admin/AdminPage').then((m) => m.AdminPage),
  () => import('virtual:capper-texts/screen/admin/AdminPage'),
);
const BetsPage = lazyPage(
  () => import('../pages/bets/BetsPage').then((m) => m.BetsPage),
  () => import('virtual:capper-texts/screen/bets/BetsPage'),
);
const DashboardPage = lazyPage(
  () => import('../pages/dashboard/DashboardPage').then((m) => m.DashboardPage),
  () => import('virtual:capper-texts/screen/dashboard/DashboardPage'),
);
const AnalyticsPage = lazyPage(
  () => import('../pages/analytics/AnalyticsPage').then((m) => m.AnalyticsPage),
  () => import('virtual:capper-texts/screen/analytics/AnalyticsPage'),
);
const PlayersPage = lazyPage(
  () => import('../pages/players/PlayersPage').then((m) => m.PlayersPage),
  () => import('virtual:capper-texts/screen/players/PlayersPage'),
);
const PlayerPage = lazyPage(
  () => import('../pages/players/PlayerPage').then((m) => m.PlayerPage),
  () => import('virtual:capper-texts/screen/players/PlayerPage'),
);
const CostsPage = lazyPage(
  () => import('../pages/costs/CostsPage').then((m) => m.CostsPage),
  () => import('virtual:capper-texts/screen/costs/CostsPage'),
);

/** Экран без оболочки (вход, регистрация, сброс): пока грузится — индикатор на весь экран. */
function bare(page: ReactNode): ReactNode {
  return <Suspense fallback={<PageLoading full />}>{page}</Suspense>;
}

export const routes: RouteObject[] = [
  { path: '/login', element: bare(<LoginPage />), errorElement: <RouteError /> },
  { path: '/register', element: bare(<RegisterPage />), errorElement: <RouteError /> },
  { path: '/reset', element: bare(<ResetPage />), errorElement: <RouteError /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        element: <DashboardPage />,
        handle: meta({ title: 'dashboard', nav: 'dashboard' }),
      },
      {
        path: 'new',
        element: <NewAnalysisPage />,
        handle: meta({ title: 'new', nav: 'new' }),
      },
      {
        path: 'analysis/:id',
        element: <AnalysisPage />,
        handle: meta({ title: 'analysis', nav: 'new', crumbs: 'analysis' }),
      },
      {
        path: 'bets',
        element: <BetsPage />,
        handle: meta({ title: 'bets', nav: 'bets' }),
      },
      {
        path: 'players',
        element: <PlayersPage />,
        handle: meta({ title: 'players', nav: 'players' }),
      },
      {
        path: 'players/:id/:tab?',
        element: <PlayerPage />,
        handle: meta({ title: 'player', nav: 'players', crumbs: 'player' }),
      },
      {
        path: 'analytics',
        element: <AnalyticsPage />,
        handle: meta({ title: 'analytics', nav: 'analytics' }),
      },
      {
        path: 'learning',
        element: <StubPage screen="learning" stage={5} />,
        handle: meta({ title: 'learning', nav: 'learning' }),
      },
      {
        path: 'costs',
        element: <CostsPage />,
        handle: meta({ title: 'costs', nav: 'costs', crumbs: 'costs' }),
      },
      {
        path: 'profile/:tab?',
        element: <ProfilePage />,
        handle: meta({ title: 'profile', nav: 'profile' }),
      },
      {
        path: 'admin/:tab?',
        element: (
          <RequireAdmin>
            <AdminPage />
          </RequireAdmin>
        ),
        handle: meta({ title: 'admin', nav: 'admin', crumbs: 'manage' }),
      },
      { path: '*', element: <NotFoundPage />, handle: meta({ title: 'notFound' }) },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
