import { createBrowserRouter, type RouteObject } from 'react-router';

import { AdminPage } from '../pages/admin/AdminPage';
import { LoginPage } from '../pages/auth/LoginPage';
import { RegisterPage } from '../pages/auth/RegisterPage';
import { ResetPage } from '../pages/auth/ResetPage';
import { NotFoundPage } from '../pages/not-found/NotFoundPage';
import { ProfilePage } from '../pages/profile/ProfilePage';
import { StubPage } from '../pages/stub/StubPage';
import { RequireAdmin } from './guards/RequireAdmin';
import { RequireAuth } from './guards/RequireAuth';
import { AppShell } from './layout/AppShell';
import type { RouteMeta } from './routeMeta';
import { RouteError } from './RouteError';

// Адреса — как в макете, путями вместо #хеша. Один экран — одна папка в src/pages.
// Этапы заглушек — по дорожной карте (docs/PLAN.md, раздел 10).
function meta(value: RouteMeta): RouteMeta {
  return value;
}

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  { path: '/register', element: <RegisterPage />, errorElement: <RouteError /> },
  { path: '/reset', element: <ResetPage />, errorElement: <RouteError /> },
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
        element: <StubPage screen="new" stage={3} />,
        handle: meta({ title: 'new', nav: 'new' }),
      },
      {
        path: 'analysis/:id',
        element: <StubPage screen="analysis" stage={3} />,
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
