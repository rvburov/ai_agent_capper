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

// Каждый экран — свой файл сборки: грузится, когда его открывают (src/app/lazyPage.ts).
// Экраны в оболочке ждут загрузки внутри AppShell (Suspense вокруг Outlet), вход и
// регистрация — на весь экран. Заглушки и «Такой страницы нет» — маленькие, в общем файле.
const LoginPage = lazyPage(() => import('../pages/auth/LoginPage').then((m) => m.LoginPage));
const RegisterPage = lazyPage(() => import('../pages/auth/RegisterPage').then((m) => m.RegisterPage));
const ResetPage = lazyPage(() => import('../pages/auth/ResetPage').then((m) => m.ResetPage));
const NewAnalysisPage = lazyPage(() => import('../pages/new/NewAnalysisPage').then((m) => m.NewAnalysisPage));
const AnalysisPage = lazyPage(() => import('../pages/analysis/AnalysisPage').then((m) => m.AnalysisPage));
const ProfilePage = lazyPage(() => import('../pages/profile/ProfilePage').then((m) => m.ProfilePage));
const AdminPage = lazyPage(() => import('../pages/admin/AdminPage').then((m) => m.AdminPage));

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
        element: <StubPage screen="dashboard" stage={4} />,
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
        element: <StubPage screen="bets" stage={4} />,
        handle: meta({ title: 'bets', nav: 'bets' }),
      },
      {
        path: 'players',
        element: <StubPage screen="players" stage={4} />,
        handle: meta({ title: 'players', nav: 'players' }),
      },
      {
        path: 'players/:id',
        element: <StubPage screen="player" stage={4} />,
        handle: meta({ title: 'player', nav: 'players', crumbs: 'players' }),
      },
      {
        path: 'analytics',
        element: <StubPage screen="analytics" stage={4} />,
        handle: meta({ title: 'analytics', nav: 'analytics' }),
      },
      {
        path: 'learning',
        element: <StubPage screen="learning" stage={5} />,
        handle: meta({ title: 'learning', nav: 'learning' }),
      },
      {
        path: 'costs',
        element: <StubPage screen="costs" stage={4} />,
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
