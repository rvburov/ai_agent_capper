import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { meQueryKey, notificationsQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { ToastProvider } from '../../components';
import { apiError, ME_MEMBER, mockFetch, type Handler } from '../../test/fetchMock';
import { stubPushBrowser } from '../../test/pushBrowser';
import { emptyDraft, loadDraft, saveDraft } from '../analysis/draftStore';
import { useLogout } from './useLogout';

// Выход из меню пользователя: запрос, страница входа, пустой кэш, тост.

function LogoutButton() {
  const { logout, pending } = useLogout();
  return (
    <button type="button" disabled={pending} onClick={logout}>
      logout
    </button>
  );
}

function setup(
  answer: Handler,
  extra: Record<string, Handler> = {},
): { client: QueryClient; calls: Request[]; router: ReturnType<typeof createMemoryRouter> } {
  document.cookie = 'capper_csrf=tok; path=/';
  const { calls } = mockFetch({ 'POST /api/auth/logout': answer, ...extra });
  const client = createQueryClient();
  client.setQueryData(meQueryKey, ME_MEMBER);
  client.setQueryData(notificationsQueryKey, { items: [], unread: 3 });
  const router = createMemoryRouter(
    [
      { path: '/bets', element: <LogoutButton /> },
      { path: '/login', element: <p>login page</p> },
    ],
    { initialEntries: ['/bets'] },
  );
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { client, calls, router };
}

describe('выход', () => {
  it('POST /api/auth/logout → /login, кэш очищен, тост', async () => {
    const { client, calls, router } = setup(() => new Response(null, { status: 204 }));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('login page');
    expect(router.state.location.pathname).toBe('/login');
    expect(calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /api/auth/logout']);
    expect(calls[0]?.headers.get('X-CSRF-Token')).toBe('tok');
    await waitFor(() => expect(client.getQueryData(meQueryKey)).toBeUndefined());
    expect(client.getQueryData(notificationsQueryKey)).toBeUndefined();
    expect(await screen.findByText('Вы вышли из аккаунта')).toBeInTheDocument();
  });

  it('черновик «Нового анализа» стирается из вкладки при выходе', async () => {
    saveDraft(emptyDraft(), ME_MEMBER.id);
    expect(loadDraft(ME_MEMBER.id)).not.toBeNull();
    setup(() => new Response(null, { status: 204 }));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('login page');
    expect(window.sessionStorage.getItem('capper.new-analysis.draft')).toBeNull();
    expect(loadDraft(ME_MEMBER.id)).toBeNull();
  });

  it('сеанс уже закончился (401) — тоже выход', async () => {
    const { router } = setup(() => apiError(401, 'auth.not_authenticated', 'Войдите в аккаунт'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('login page');
    expect(router.state.location.pathname).toBe('/login');
  });

  it('сбой сервера — остаемся, текст ошибки в тосте, данные на месте', async () => {
    const { client, router } = setup(() => apiError(500, 'common.internal', 'Ошибка сервера'));
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    expect(await screen.findByText('Не удалось выйти: Ошибка сервера')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/bets');
    // ожидание снято: можно попробовать еще раз
    expect(screen.getByRole('button', { name: 'logout' })).toBeEnabled();
    expect(client.getQueryData(meQueryKey)).toEqual(ME_MEMBER);
  });

  it('push на этом устройстве: сначала отзыв по endpoint и отписка браузера, потом выход (В4)', async () => {
    const browser = stubPushBrowser({ permission: 'granted', endpoint: 'https://push.example/sub/this' });
    const { calls } = setup(() => new Response(null, { status: 204 }), {
      'POST /api/me/push-subscriptions/revoke': () => new Response(null, { status: 204 }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('login page');
    expect(calls.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'POST /api/me/push-subscriptions/revoke',
      'POST /api/auth/logout',
    ]);
    expect(await calls[0]?.clone().json()).toEqual({ endpoint: 'https://push.example/sub/this' });
    expect(browser.subscription()).toBeNull();
  });

  it('отзыв push не удался (нет связи с сервером) — браузер все равно отписан, выход идет', async () => {
    const browser = stubPushBrowser({ permission: 'granted', endpoint: 'https://push.example/sub/this' });
    setup(() => new Response(null, { status: 204 }), {
      'POST /api/me/push-subscriptions/revoke': () => apiError(500, 'common.internal', 'Ошибка сервера'),
    });
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    await screen.findByText('login page');
    expect(browser.subscription()).toBeNull();
  });

  it('ожидание — на весь выход (отзыв push и /auth/logout): кнопка неактивна, повторное нажатие ничего не повторяет', async () => {
    stubPushBrowser({ permission: 'granted', endpoint: 'https://push.example/sub/this' });
    let releaseRevoke!: () => void;
    const revokeDone = new Promise<void>((resolve) => (releaseRevoke = resolve));
    const { calls } = setup(() => new Response(null, { status: 204 }), {
      'POST /api/me/push-subscriptions/revoke': async () => {
        await revokeDone;
        return new Response(null, { status: 204 });
      },
    });
    const button = screen.getByRole('button', { name: 'logout' });
    await userEvent.click(button);
    // отзыв push еще идет: кнопка уже неактивна
    await waitFor(() => expect(button).toBeDisabled());
    button.removeAttribute('disabled');
    await userEvent.click(button);
    releaseRevoke();
    await screen.findByText('login page');
    const sent = calls.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(sent).toEqual(['POST /api/me/push-subscriptions/revoke', 'POST /api/auth/logout']);
  });

  it('push отозван, а /auth/logout упал — человек видит, что выход не удался', async () => {
    const browser = stubPushBrowser({ permission: 'granted', endpoint: 'https://push.example/sub/this' });
    const { router } = setup(() => apiError(503, 'common.unavailable', 'Сервер временно недоступен'), {
      'POST /api/me/push-subscriptions/revoke': () => new Response(null, { status: 204 }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'logout' }));
    expect(await screen.findByText('Не удалось выйти: Сервер временно недоступен')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/bets');
    expect(browser.subscription()).toBeNull();
  });
});
