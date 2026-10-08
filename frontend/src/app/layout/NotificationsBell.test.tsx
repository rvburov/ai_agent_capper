import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../api/queryClient';
import { ToastProvider } from '../../components';
import { setViewportWidth } from '../../test/setup';
import { json, mockFetch } from '../../test/fetchMock';
import { NotificationsBell } from './NotificationsBell';

const ITEMS = [
  {
    id: 7,
    kind: 'new_device',
    title: 'Вход с нового устройства',
    body: 'Выполнен вход: Firefox · Linux, IP-адрес 10.0.0.5.',
    link: '/profile/security',
    created_at: '2026-10-08T09:00:00Z',
    read_at: null,
  },
  {
    id: 6,
    kind: 'admin_message',
    title: 'Сообщение администратора',
    body: 'Сервер обновляется в субботу.',
    link: null,
    created_at: '2026-10-07T09:00:00Z',
    read_at: null,
  },
  {
    id: 5,
    kind: 'login_failures',
    title: 'Неудачные попытки входа',
    body: '',
    link: '/profile/security',
    created_at: '2026-10-06T09:00:00Z',
    read_at: '2026-10-06T10:00:00Z',
  },
];

function setup() {
  document.cookie = 'capper_csrf=tok; path=/';
  const read = new Set(ITEMS.filter((n) => n.read_at).map((n) => n.id));
  const markRead = (id: number) => {
    read.add(id);
    return new Response(null, { status: 204 });
  };
  const { calls } = mockFetch({
    'GET /api/me/notifications': () =>
      json({
        items: ITEMS.map((n) => (read.has(n.id) ? { ...n, read_at: n.read_at ?? '2026-10-08T12:00:00Z' } : n)),
        unread: ITEMS.filter((n) => !read.has(n.id)).length,
      }),
    'POST /api/me/notifications/7/read': () => markRead(7),
    'POST /api/me/notifications/6/read': () => markRead(6),
    'POST /api/me/notifications/read-all': () => {
      ITEMS.forEach((n) => read.add(n.id));
      return new Response(null, { status: 204 });
    },
  });
  const router = createMemoryRouter(
    [
      { path: '/', element: <NotificationsBell /> },
      { path: '/profile/:tab', element: <p>Безопасность</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { calls, router };
}

describe('колокольчик', () => {
  it('счетчик непрочитанных в подписи кнопки', async () => {
    setup();
    expect(await screen.findByRole('button', { name: 'Уведомления: непрочитанных 2' })).toBeInTheDocument();
  });

  it('список, клик по уведомлению: прочитано и переход по ссылке', async () => {
    const { calls, router } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Уведомления: непрочитанных 2' }));
    const dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    expect(within(dialog).getAllByText('Не прочитано')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: /Вход с нового устройства/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/profile/security'));
    expect(calls.some((r) => r.method === 'POST' && r.url.endsWith('/api/me/notifications/7/read'))).toBe(true);
  });

  it('уведомление без ссылки отмечается прочитанным, список остается открытым', async () => {
    const { calls } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Уведомления: непрочитанных/ }));
    const dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    await user.click(within(dialog).getByRole('button', { name: /Сообщение администратора/ }));
    await waitFor(() =>
      expect(calls.some((r) => r.method === 'POST' && r.url.endsWith('/api/me/notifications/6/read'))).toBe(true),
    );
    expect(screen.getByRole('dialog', { name: 'Уведомления' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Уведомления: непрочитанных 1' })).toBeInTheDocument();
  });

  it('«Прочитать все» обнуляет счетчик; Esc закрывает и возвращает фокус', async () => {
    setup();
    const user = userEvent.setup();
    const bell = await screen.findByRole('button', { name: /Уведомления: непрочитанных/ });
    await user.click(bell);
    await user.click(screen.getByRole('button', { name: 'Прочитать все' }));
    expect(await screen.findByRole('button', { name: 'Уведомления' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Уведомления' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Уведомления' })).toHaveFocus();
  });

  it('на компьютере фокус переходит в окно, когда оно уже видно; Tab идет по окну', async () => {
    // jsdom ставит фокус и на скрытый (visibility: hidden) элемент, браузер — нет. Поэтому
    // проверяем, что в момент вызова focus() окно уже расставлено и не скрыто
    const seen: string[] = [];
    const real = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
      this: HTMLElement,
      options?: FocusOptions,
    ) {
      if (this.getAttribute('role') === 'dialog') seen.push(this.style.visibility || 'visible');
      real.call(this, options);
    });
    try {
      setup();
      const user = userEvent.setup();
      const bell = await screen.findByRole('button', { name: /Уведомления: непрочитанных/ });
      bell.focus();
      await user.keyboard('{Enter}');
      const dialog = screen.getByRole('dialog', { name: 'Уведомления' });
      expect(dialog).toHaveFocus();
      expect(seen).toEqual(['visible']);
      await user.tab();
      expect(within(dialog).getByRole('button', { name: 'Прочитать все' })).toHaveFocus();
      expect(screen.getByRole('dialog', { name: 'Уведомления' })).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('на телефоне нажатие на фон закрывает шторку и возвращает фокус на колокольчик', async () => {
    setViewportWidth(375);
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Уведомления/ }));
    expect(screen.getByRole('dialog', { name: 'Уведомления' })).toHaveFocus();
    await user.click(document.querySelector('.notif-back')!);
    expect(screen.queryByRole('dialog', { name: 'Уведомления' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Уведомления/ })).toHaveFocus();
  });

  it('на телефоне — шторка снизу, «Что присылать» ведет в настройки', async () => {
    setViewportWidth(375);
    const { router } = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Уведомления/ }));
    const dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    expect(dialog).toHaveClass('sheet');
    await user.click(within(dialog).getByRole('link', { name: 'Что присылать' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/profile/notifications'));
    expect(screen.queryByRole('dialog', { name: 'Уведомления' })).not.toBeInTheDocument();
  });
});
