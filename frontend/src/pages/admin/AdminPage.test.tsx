import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { ToastProvider } from '../../components';
import { adminUser, auditEntry } from '../../features/admin/testData';
import type { AuditEntry, Invite } from '../../features/admin/types';
import { apiError, json, ME_ADMIN, mockFetch, type Handler } from '../../test/fetchMock';
import { setViewportWidth } from '../../test/setup';
import { AdminPage } from './AdminPage';

const NOW = Date.now();
const later = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const ME = adminUser({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin', limit: null });
const OLGA = adminUser({ id: 2 });
const MARIA = adminUser({ id: 3, display_name: 'Мария Виртанен', email: 'maria@example.com', role: 'admin' });
const IGOR = adminUser({ id: 4, display_name: 'Игорь Нестеров', email: 'igor@example.com', status: 'blocked' });
const DMITRY = adminUser({ id: 5, display_name: 'Дмитрий Шульц', email: 'dmitry@example.com', ai_mode: 'own' });
const USERS = [ME, OLGA, MARIA, IGOR, DMITRY];

function invite(over: Partial<Invite>): Invite {
  return {
    id: 1,
    email: 'anna@example.com',
    role: 'member',
    ai_mode: 'shared',
    limit: { monthly_usd: 10, daily_analyses: 3, per_analysis_usd: 1 },
    created_at: ago(2),
    expires_at: later(24 * 6),
    used_at: null,
    used_by_name: null,
    revoked_at: null,
    created_by_name: 'Роман Буров',
    status: 'active',
    ...over,
  };
}
const INVITES = [
  invite({ id: 1 }),
  invite({ id: 2, email: 'olga@example.com', status: 'used', used_at: ago(100), used_by_name: 'Ольга Лехтинен' }),
  invite({ id: 3, email: 'pekka@example.com', status: 'revoked', revoked_at: ago(3), ai_mode: 'own', limit: null }),
];

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/me': () => json(ME_ADMIN),
    'GET /api/admin/users': () => json(USERS),
    'GET /api/admin/invites': () => json(INVITES),
    'GET /api/admin/reset-codes': () =>
      json([
        {
          id: 7,
          user_id: 2,
          user_name: 'Ольга Лехтинен',
          user_email: 'olga@example.com',
          created_at: ago(1),
          expires_at: later(23),
          used_at: null,
          revoked_at: null,
          created_by_name: 'Роман Буров',
          status: 'active',
        },
      ]),
    'GET /api/admin/audit': () => json([]),
    ...extra,
  };
}

async function bodyOf(request: Request): Promise<unknown> {
  return JSON.parse(await request.clone().text());
}

function renderAdmin(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/admin/:tab?', element: <AdminPage /> },
      { path: '/profile/:tab?', element: <p>Личный кабинет</p> },
    ],
    { initialEntries: [path] },
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  client.setQueryData(meQueryKey, ME_ADMIN);
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { router };
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Действия: ${name}` }));
  return screen.getByRole('menu');
}

describe('Администрирование: участники', () => {
  it('шапка и таблица: роль, статус, ключ, расход и лимит; ставок и банка нет (Р14)', async () => {
    mockFetch(routes());
    renderAdmin('/admin/users');
    expect(
      await screen.findByText(
        // неразрывные пробелы после чисел testing-library сводит к обычным
        'В программе 5 человек: 4 активны, 1 заблокирован, 2 администратора. 1 приглашение ждет регистрации.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Вы — администратор · Роман Буров')).toBeInTheDocument();
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers.slice(0, 5)).toEqual([
      'Участник · роль и статус',
      'Ключ Claude',
      expect.stringMatching(/^Расход ИИ за /),
      'Анализы',
      'Вход и 2FA',
    ]);
    const olga = within(table).getByText('Ольга Лехтинен').closest('tr')!;
    expect(within(olga).getByText('$10 · 3 в день · $1')).toBeInTheDocument();
    expect(within(olga).getByText('$1,93')).toBeInTheDocument();
    expect(within(olga).getByRole('meter')).toHaveAccessibleName('Израсходовано $1,93 из $10');
    const dmitry = within(table).getByText('Дмитрий Шульц').closest('tr')!;
    expect(within(dmitry).getByText('Свой ключ')).toBeInTheDocument();
    expect(within(dmitry).getByText('вне бюджета')).toBeInTheDocument();
    expect(within(table).getByText('Заблокирован')).toBeInTheDocument();
    // о ставках, банке и стратегии в таблице ничего нет
    expect(table.textContent).not.toMatch(/ставк|банк|стратег/i);
  });

  it('фильтр по статусу', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderAdmin('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Заблокированные · 1' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Игорь Нестеров');
  });

  it('меню: свои действия и сброс администратора недоступны, с пояснением', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderAdmin('/admin/users');
    let menu = await openMenu(user, 'Роман Буров');
    expect(within(menu).getByRole('menuitem', { name: /Заблокировать/ })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: /себя удалить нельзя/ })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: /Личный кабинет/ })).toBeEnabled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Действия: Роман Буров' })).toHaveFocus();

    menu = await openMenu(user, 'Мария Виртанен');
    expect(
      within(menu).getByRole('menuitem', { name: /Сбросить 2FA\s*2FA администратора — только командой в терминале/ }),
    ).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: /Выдать код сброса пароля/ })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: /Сделать участником/ })).toBeEnabled();
    // первый доступный пункт в фокусе, стрелки двигают фокус
    expect(within(menu).getByRole('menuitem', { name: /Активность и входы/ })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: /Завершить все сеансы/ })).toHaveFocus();
  });

  it('блокировка: подтверждение, POST /block и сообщение', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({ 'POST /api/admin/users/2/block': () => json({ ...OLGA, status: 'blocked' }) }),
    );
    renderAdmin('/admin/users');
    const menu = await openMenu(user, 'Ольга Лехтинен');
    await user.click(within(menu).getByRole('menuitem', { name: 'Заблокировать' }));
    const dialog = screen.getByRole('dialog', { name: 'Заблокировать' });
    expect(within(dialog).getByText(/Данные сохранятся/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Заблокировать' }));
    expect(await screen.findByText('Ольга Лехтинен заблокирован')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'POST' && r.url.endsWith('/api/admin/users/2/block'))).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('смена роли: нужен код 2FA, ошибка сервера — под полем кода', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { calls } = mockFetch(
      routes({
        'POST /api/admin/users/2/role': () =>
          ++attempt === 1
            ? apiError(403, 'admin.totp_required', 'Введите текущий код 2FA, чтобы подтвердить действие')
            : json({ ...OLGA, role: 'admin' }),
      }),
    );
    renderAdmin('/admin/users');
    const menu = await openMenu(user, 'Ольга Лехтинен');
    await user.click(within(menu).getByRole('menuitem', { name: /Сделать администратором/ }));
    const dialog = screen.getByRole('dialog', { name: 'Сделать администратором' });
    const go = within(dialog).getByRole('button', { name: 'Сделать администратором' });
    const otp = within(dialog).getByLabelText('Код 2FA из вашего приложения');
    expect(otp).toHaveFocus();
    expect(go).toBeDisabled();
    await user.type(otp, '12a345');
    expect(otp).toHaveValue('12345');
    expect(go).toBeDisabled();
    await user.type(otp, '6');
    await user.click(go);
    expect(await within(dialog).findByText('Введите текущий код 2FA, чтобы подтвердить действие')).toBeInTheDocument();
    expect(otp).toHaveValue('');
    await user.type(otp, '654321');
    await user.click(go);
    expect(await screen.findByText('Ольга Лехтинен — администратор')).toBeInTheDocument();
    const posts = calls.filter((r) => r.method === 'POST' && r.url.endsWith('/role'));
    expect(await bodyOf(posts[1]!)).toEqual({ role: 'admin', totp_code: '654321' });
  });

  it('удаление: кнопка доступна, когда email совпал и введен код 2FA', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({ 'DELETE /api/admin/users/2': () => new Response(null, { status: 204 }) }),
    );
    renderAdmin('/admin/users');
    const menu = await openMenu(user, 'Ольга Лехтинен');
    await user.click(within(menu).getByRole('menuitem', { name: /Удалить/ }));
    const dialog = screen.getByRole('dialog', { name: 'Удалить участника' });
    expect(within(dialog).getByText('Удалится навсегда')).toBeInTheDocument();
    expect(within(dialog).getByText(/Запись в журнале: кто, когда и кого удалил/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Удалить навсегда' });
    await user.type(within(dialog).getByLabelText(/Введите email участника/), 'olga@example.co');
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '123456');
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Введите email участника/), 'm');
    expect(go).toBeEnabled();
    await user.click(go);
    expect(await screen.findByText('Ольга Лехтинен удален. Запись — в журнале')).toBeInTheDocument();
    const del = calls.find((r) => r.method === 'DELETE')!;
    expect(await bodyOf(del)).toEqual({ confirm_email: 'olga@example.com', totp_code: '123456' });
  });

  it('карточка участника: входы и сеансы', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        'GET /api/admin/users/2': () =>
          json({
            ...OLGA,
            active_sessions: 2,
            recent_logins: [
              { at: ago(1), ip: '88.193.12.4', device_label: 'Chrome · Windows', result: 'ok', method: 'totp' },
              { at: ago(2), ip: '62.78.1.2', device_label: '', result: 'bad_password', method: 'password' },
            ],
          }),
      }),
    );
    renderAdmin('/admin/users');
    const menu = await openMenu(user, 'Ольга Лехтинен');
    await user.click(within(menu).getByRole('menuitem', { name: /Активность и входы/ }));
    const dialog = screen.getByRole('dialog', { name: 'Карточка участника' });
    const logins = await within(dialog).findByRole('list', { name: 'Последние входы' });
    expect(within(logins).getAllByRole('listitem')).toHaveLength(2);
    expect(within(logins).getByText('Неверный пароль')).toBeInTheDocument();
    expect(within(logins).getByText('88.193.•.•')).toBeInTheDocument();
    expect(within(logins).getByText(/Неизвестное устройство/)).toBeInTheDocument();
    expect(within(dialog).getByText('Сеансов сейчас').nextSibling).toHaveTextContent('2');
    expect(within(dialog).getByRole('menuitem', { name: /Заблокировать/ })).toBeEnabled();
  });

  it('на телефоне — карточки участников вместо таблицы', async () => {
    setViewportWidth(375);
    mockFetch(routes());
    renderAdmin('/admin/users');
    expect(await screen.findByRole('region', { name: 'Ольга Лехтинен' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Администрирование: сброс доступа', () => {
  it('«Выдать код сброса» из меню: вкладка с выбранным участником, код показывается один раз', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        'POST /api/admin/reset-codes': () =>
          json(
            {
              code: 'RST-ABCD-EFGH',
              reset_code: {
                id: 8,
                user_id: 2,
                user_name: 'Ольга Лехтинен',
                user_email: 'olga@example.com',
                created_at: new Date(NOW).toISOString(),
                expires_at: later(24),
                used_at: null,
                revoked_at: null,
                created_by_name: 'Роман Буров',
                status: 'active',
              },
            },
            201,
          ),
      }),
    );
    const { router } = renderAdmin('/admin/users');
    const menu = await openMenu(user, 'Ольга Лехтинен');
    await user.click(within(menu).getByRole('menuitem', { name: /Выдать код сброса пароля/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/access'));
    expect(screen.getByRole('button', { name: /^Участник: Ольга Лехтинен/ })).toBeInTheDocument();
    expect(screen.getByText('У участника уже есть действующий код: новый заменит его')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Выдать код' }));
    expect(await screen.findByText('RST-ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByText(/Прежний код перестал действовать/)).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'POST')!)).toEqual({ user_id: 2 });
    await user.click(screen.getByRole('button', { name: 'Готово, скрыть код' }));
    expect(screen.queryByText('RST-ABCD-EFGH')).not.toBeInTheDocument();
  });

  it('администраторов нет в списке кода сброса; сброс 2FA — с кодом администратора', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({ 'POST /api/admin/users/2/2fa-reset': () => new Response(null, { status: 204 }) }),
    );
    renderAdmin('/admin/access');
    await user.click(await screen.findByRole('button', { name: /^Участник: не выбрано/, description: /забыл пароль/ }));
    const list = screen.getByRole('listbox');
    expect(within(list).queryByText(/Мария Виртанен/)).not.toBeInTheDocument();
    expect(within(list).queryByText(/Роман Буров/)).not.toBeInTheDocument();
    expect(within(list).getByText(/Игорь Нестеров/)).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: /^Участник: не выбрано/, description: /2FA включена/ }));
    await user.click(screen.getByRole('option', { name: /Ольга Лехтинен/ }));
    await user.click(screen.getByRole('button', { name: 'Сбросить 2FA' }));
    const dialog = screen.getByRole('dialog', { name: 'Сбросить 2FA' });
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '111222');
    await user.click(within(dialog).getByRole('button', { name: 'Сбросить 2FA' }));
    expect(await screen.findByText('2FA сброшена: Ольга Лехтинен настроит ее при следующем входе')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.url.endsWith('/2fa-reset'))!)).toEqual({ totp_code: '111222' });
  });

  it('действующие коды сброса и отзыв', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({ 'DELETE /api/admin/reset-codes/7': () => new Response(null, { status: 204 }) }),
    );
    renderAdmin('/admin/access');
    await user.click(await screen.findByRole('button', { name: 'Отозвать код сброса для Ольга Лехтинен' }));
    const dialog = screen.getByRole('dialog', { name: 'Отозвать код сброса' });
    await user.click(within(dialog).getByRole('button', { name: 'Отозвать' }));
    expect(await screen.findByText('Код сброса отозван')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'DELETE' && r.url.endsWith('/reset-codes/7'))).toBe(true);
    expect(screen.getByText(/python -m app.admin.cli reset-code --email owner@example.com/)).toBeInTheDocument();
  });
});

describe('Администрирование: приглашения', () => {
  it('список по статусам', async () => {
    mockFetch(routes());
    renderAdmin('/admin/invites');
    expect(await screen.findByText('anna@example.com')).toBeInTheDocument();
    expect(screen.getByText('Ждет')).toBeInTheDocument();
    expect(screen.getByText(/Зарегистрировался .* — Ольга Лехтинен/)).toBeInTheDocument();
    expect(screen.getByText('Отозвано')).toBeInTheDocument();
    expect(screen.getByText('Участник · свой ключ')).toBeInTheDocument();
  });

  it('приглашение участника: проверка формы, затем код один раз', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        'POST /api/admin/invites': async (request) => {
          const body = (await bodyOf(request)) as { email: string };
          return json({ code: 'CAP-ABCD-EFGH', invite: invite({ id: 9, email: body.email }) }, 201);
        },
      }),
    );
    renderAdmin('/admin/invites');
    await user.click((await screen.findAllByRole('button', { name: 'Пригласить' }))[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Пригласить в AI Capper' });
    expect(within(dialog).queryByLabelText('Код 2FA из вашего приложения')).not.toBeInTheDocument();
    const email = within(dialog).getByLabelText('Email');
    expect(email).toHaveFocus();
    await user.type(email, 'olga@example.com');
    await user.clear(within(dialog).getByLabelText('В месяц, $'));
    await user.type(within(dialog).getByLabelText('В месяц, $'), '900');
    await user.click(within(dialog).getByRole('button', { name: 'Создать код' }));
    expect(within(dialog).getByText('Этот email уже есть среди участников')).toBeInTheDocument();
    expect(within(dialog).getByText('От $1 до $500')).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, 'Anna@example.com');
    expect(within(dialog).queryByText('Этот email уже есть среди участников')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Создать код' }));
    expect(
      within(dialog).getByText('Для этого email уже есть активное приглашение — отзовите его или дождитесь регистрации'),
    ).toBeInTheDocument();
    await user.clear(email);
    await user.type(email, 'New@Example.com');
    await user.clear(within(dialog).getByLabelText('В месяц, $'));
    await user.type(within(dialog).getByLabelText('В месяц, $'), '12,5');
    await user.click(within(dialog).getByRole('button', { name: 'Создать код' }));
    // после создания — то же окно с кодом (новый элемент окна)
    expect(await screen.findByText('CAP-ABCD-EFGH')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'POST' && r.url.endsWith('/invites'))!)).toEqual({
      email: 'new@example.com',
      role: 'member',
      ai_mode: 'shared',
      limit: { monthly_usd: '12.50', daily_analyses: 3, per_analysis_usd: '1.00' },
      totp_code: null,
    });
    expect(screen.getByRole('dialog', { name: 'Пригласить в AI Capper' })).toHaveTextContent(/Код действует 7 дней/);
  });

  it('приглашение администратора: поле кода 2FA; занятый email — ошибка сервера под полем', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { calls } = mockFetch(
      routes({
        'POST /api/admin/invites': () =>
          ++attempt === 1
            ? apiError(409, 'admin.email_taken', 'Этот email уже зарегистрирован')
            : json({ code: 'CAP-ADMN-2FA2', invite: invite({ id: 10, role: 'admin', ai_mode: 'own', limit: null }) }, 201),
      }),
    );
    renderAdmin('/admin/invites');
    await user.click((await screen.findAllByRole('button', { name: 'Пригласить' }))[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Пригласить в AI Capper' });
    await user.type(within(dialog).getByLabelText('Email'), 'boss@example.com');
    await user.click(within(dialog).getByRole('button', { name: /^Роль: Участник/ }));
    await user.click(screen.getByRole('option', { name: 'Администратор' }));
    expect(within(dialog).getByText('Увидит раздел «Администрирование» и сможет управлять участниками')).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/Свой ключ/));
    expect(within(dialog).queryByLabelText('В месяц, $')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Создать код' }));
    expect(within(dialog).getByText('Введите 6 цифр из приложения-аутентификатора')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '246810');
    await user.click(within(dialog).getByRole('button', { name: 'Создать код' }));
    expect(await within(dialog).findByText('Этот email уже зарегистрирован')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Создать код' }));
    expect(await screen.findByText('CAP-ADMN-2FA2')).toBeInTheDocument();
    const posts = calls.filter((r) => r.method === 'POST' && r.url.endsWith('/invites'));
    expect(await bodyOf(posts[1]!)).toEqual({
      email: 'boss@example.com',
      role: 'admin',
      ai_mode: 'own',
      limit: null,
      totp_code: '246810',
    });
  });
});

describe('Администрирование: журнал и заглушки', () => {
  it('журнал: названия действий, терминал и «Показать еще»', async () => {
    const user = userEvent.setup();
    const page1: AuditEntry[] = Array.from({ length: 50 }, (_, i) =>
      auditEntry({ id: 100 - i, action: 'unblock', target_name: `Участник ${i}` }),
    );
    page1[0] = auditEntry({
      id: 100,
      action: 'create_admin',
      actor_id: null,
      actor_name: '',
      target_name: 'Роман Буров',
      details: { email: 'owner@example.com', source: 'terminal' },
      ip: null,
    });
    const { calls } = mockFetch(
      routes({
        'GET /api/admin/audit': (request) => {
          const before = new URL(request.url).searchParams.get('before_id');
          return json(before ? [auditEntry({ id: 40, action: 'block', target_name: 'Последний' })] : page1);
        },
      }),
    );
    renderAdmin('/admin/audit');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('терминал')).toBeInTheDocument();
    expect(within(table).getByText('сервер')).toBeInTheDocument();
    expect(within(table).getByText('Создан администратор')).toBeInTheDocument();
    expect(within(table).getByText('python -m app.admin.cli create-admin')).toBeInTheDocument();
    expect(screen.getByText(/Показано 50 записей/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать еще' }));
    expect(await within(table).findByText('Последний')).toBeInTheDocument();
    const urls = calls.filter((r) => r.url.includes('/api/admin/audit')).map((r) => new URL(r.url));
    expect(urls.at(-1)!.searchParams.get('before_id')).toBe('51');
    expect(screen.queryByRole('button', { name: 'Показать еще' })).not.toBeInTheDocument();
  });

  it('фильтр журнала по типу действия уходит на сервер', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes());
    renderAdmin('/admin/audit');
    await user.click(await screen.findByRole('button', { name: /^Тип действия: Все действия/ }));
    await user.click(screen.getByRole('option', { name: 'Приглашения' }));
    await waitFor(() =>
      expect(
        calls.some((r) => new URL(r.url).searchParams.getAll('action').join(',') === 'invite,invite_revoke'),
      ).toBe(true),
    );
    expect(await screen.findByText('Таких действий в журнале нет')).toBeInTheDocument();
  });

  it('вкладки следующих этапов — заглушка с номером этапа', async () => {
    mockFetch(routes());
    renderAdmin('/admin/key');
    expect(await screen.findByText('Раздел появится на этапе 3')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Ключ и бюджет' })).toHaveAttribute('aria-selected', 'true');
  });
});
