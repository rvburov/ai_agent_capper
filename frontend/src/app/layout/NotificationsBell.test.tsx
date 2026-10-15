import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../api/queryClient';
import { ToastProvider } from '../../components';
import { setViewportWidth } from '../../test/setup';
import { memberPrefsOut } from '../../features/notifications/testData';
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

type Item = (typeof ITEMS)[number] | { id: number; kind: string; title: string; body: string; link: string | null; created_at: string; read_at: string | null; outcome?: string | null };

function setup({ items = ITEMS as readonly Item[], prefs = memberPrefsOut() }: { items?: readonly Item[]; prefs?: ReturnType<typeof memberPrefsOut> } = {}) {
  document.cookie = 'capper_csrf=tok; path=/';
  const ITEMS_ = items;
  const read = new Set(ITEMS_.filter((n) => n.read_at).map((n) => n.id));
  const markRead = (id: number) => {
    read.add(id);
    return new Response(null, { status: 204 });
  };
  const { calls } = mockFetch({
    'GET /api/me/notifications': () =>
      json({
        items: ITEMS_.map((n) => (read.has(n.id) ? { ...n, read_at: n.read_at ?? '2026-10-08T12:00:00Z' } : n)),
        unread: ITEMS_.filter((n) => !read.has(n.id)).length,
      }),
    'GET /api/me/notification-prefs': () => json(prefs),
    ...Object.fromEntries(ITEMS_.map((n) => [`POST /api/me/notifications/${n.id}/read`, () => markRead(n.id)])),
    'POST /api/me/notifications/read-all': () => {
      ITEMS_.forEach((n) => read.add(n.id));
      return new Response(null, { status: 204 });
    },
  });
  const router = createMemoryRouter(
    [
      { path: '/', element: <NotificationsBell /> },
      { path: '/profile/:tab', element: <p>Безопасность</p> },
      { path: '/bets', element: <p>Ставки</p> },
      { path: '/learning/:tab?', element: <p>Обучение модели</p> },
      { path: '/admin/:tab?', element: <p>Администрирование</p> },
      { path: '/analysis/:id', element: <p>Анализ</p> },
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

  it('выключенные в кабинете виды не показываются и не считаются; внизу — пометка', async () => {
    const items: Item[] = [
      ...ITEMS,
      { id: 8, kind: 'bet_settled', title: 'Ставка №12 рассчитана', body: 'Итог: выигрыш', link: '/bets?bet=12', created_at: '2026-10-08T10:00:00Z', read_at: null },
    ];
    setup({ items, prefs: memberPrefsOut(['bet_settled']) });
    const user = userEvent.setup();
    // непрочитанных с сервера 3, одно из них — выключенного вида
    await user.click(await screen.findByRole('button', { name: 'Уведомления: непрочитанных 2' }));
    const dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    expect(within(dialog).queryByText('Ставка №12 рассчитана')).toBeNull();
    expect(within(dialog).getByText('Часть видов выключена в настройках')).toBeInTheDocument();
  });

  it('ссылки на ставку и на анализ; сигнал расхода ИИ — с текстом правила с сервера', async () => {
    const items: Item[] = [
      { id: 9, kind: 'ai_alert', title: 'Доля кэша упала до 31%', body: 'Анализов в проверке: 10. Из кэша прочитано 31%', link: '/analysis/42', created_at: '2026-10-08T11:00:00Z', read_at: null },
      { id: 8, kind: 'bet_settled', title: 'Ставка №12 рассчитана', body: 'Итог: выигрыш', link: '/bets?bet=12', created_at: '2026-10-08T10:00:00Z', read_at: null },
    ];
    const { router } = setup({ items });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Уведомления: непрочитанных 2' }));
    let dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    expect(within(dialog).getByText('Анализов в проверке: 10. Из кэша прочитано 31%')).toBeInTheDocument();
    expect(within(dialog).getByText('На сайте · push появится на этапе 6')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Ставка №12 рассчитана/ }));
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/bets?bet=12'));
    await router.navigate('/');
    await user.click(await screen.findByRole('button', { name: /Уведомления: непрочитанных/ }));
    dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    await user.click(within(dialog).getByRole('button', { name: /Доля кэша упала до 31%/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/analysis/42'));
  });

  it('этап 5: авторасчет со ссылкой на ставку, «ждет результата», расхождение с архивом, отчет недели', async () => {
    const { router } = setup({
      items: [
        { id: 24, kind: 'weekly_report', title: 'Отчет за неделю 5 – 11 окт', body: '3 ставки (2 по архиву).', link: null, created_at: '2026-10-12T04:00:00Z', read_at: null },
        { id: 23, kind: 'settle_conflict', title: 'Архив показывает другой исход ставки №70', body: 'Банк не меняли.', link: '/bets?bet=70', created_at: '2026-10-11T08:00:00Z', read_at: null },
        { id: 22, kind: 'bet_needs_result', title: 'Ставка №66 ждет результата', body: 'Исхода в архиве нет 3 дня.', link: '/bets?bet=66', created_at: '2026-10-10T08:00:00Z', read_at: null },
        { id: 21, kind: 'bet_settled', title: 'Ставка №73 рассчитана автоматически', body: 'По архиву tennis-data.', link: '/bets?bet=73', created_at: '2026-10-09T08:00:00Z', read_at: null },
      ],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Уведомления: непрочитанных 4' }));
    const dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    // сначала новые; у каждого вида свой значок и цвет
    const rows = within(dialog).getAllByRole('button', { name: /Отчет|Архив|ждет|рассчитана/ });
    expect(rows.map((row) => row.querySelector('.notif-ic')?.className)).toEqual([
      'notif-ic info',
      'notif-ic warn',
      'notif-ic warn',
      'notif-ic',
    ]);
    // ставка рассчитана сама — ссылка на саму ставку
    await user.click(within(dialog).getByRole('button', { name: /Ставка №73 рассчитана автоматически/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?bet=73'));
    expect(router.state.location.pathname).toBe('/bets');
    // отчет недели без ссылки с сервера — вкладка «Отчеты» (колокольчик — на главной)
    await act(() => router.navigate('/'));
    await user.click(await screen.findByRole('button', { name: /Уведомления: непрочитанных 3/ }));
    await user.click(within(screen.getByRole('dialog', { name: 'Уведомления' })).getByRole('button', { name: /Отчет за неделю/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/learning/reports'));
  });

  it('этап 5: цвет «Ставка рассчитана» — по исходу; «Пора загрузить файл» ведет на «Данные»', async () => {
    const { router } = setup({
      items: [
        { id: 34, kind: 'data_stale', title: 'Пора загрузить файл tennis-data', body: 'Последняя загрузка файла — 5 окт.', link: null, created_at: '2026-10-12T04:00:00Z', read_at: null },
        { id: 33, kind: 'bet_settled', title: 'Ставка №75 рассчитана автоматически', body: 'Возврат.', link: '/bets?bet=75', created_at: '2026-10-11T08:00:00Z', read_at: null, outcome: 'void' },
        { id: 32, kind: 'bet_settled', title: 'Ставка №74 рассчитана автоматически', body: 'Проигрыш.', link: '/bets?bet=74', created_at: '2026-10-10T08:00:00Z', read_at: null, outcome: 'lost' },
        { id: 31, kind: 'bet_settled', title: 'Ставка №73 рассчитана автоматически', body: 'Выигрыш.', link: '/bets?bet=73', created_at: '2026-10-09T08:00:00Z', read_at: null, outcome: 'won' },
      ],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Уведомления: непрочитанных 4' }));
    const dialog = screen.getByRole('dialog', { name: 'Уведомления' });
    const rows = within(dialog).getAllByRole('button', { name: /рассчитана|Пора загрузить/ });
    expect(rows.map((row) => row.querySelector('.notif-ic')?.className)).toEqual(['notif-ic warn', 'notif-ic', 'notif-ic bad', 'notif-ic good']);
    await user.click(within(dialog).getByRole('button', { name: /Пора загрузить файл tennis-data/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/data'));
  });
});
