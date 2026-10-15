import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { aiBudget } from '../../features/ai/testData';
import { playLimitsOut } from '../../features/bank/testData';
import { apiError, json, ME_ADMIN, ME_MEMBER, mockFetch, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { setViewportWidth } from '../../test/setup';
import { ProfilePage } from './ProfilePage';

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const SESSIONS = [
  { id: 11, device_label: 'Chrome · Windows', ip: '88.193.12.4', created_at: ago(600), last_seen_at: ago(1), current: true },
  { id: 12, device_label: '', ip: '62.78.1.2', created_at: ago(3000), last_seen_at: ago(2000), current: false },
];
const EVENTS = [
  { at: ago(5), ip: '88.193.12.4', device_label: 'Chrome · Windows', result: 'ok', method: 'totp' },
  { at: ago(60), ip: '185.220.1.2', device_label: 'Firefox · Linux', result: 'bad_totp', method: 'totp' },
  { at: ago(120), ip: '62.78.1.2', device_label: '', result: 'bad_password', method: 'password' },
];
const DEVICES = [
  {
    id: 5,
    device_label: 'Safari · iOS',
    ip: '91.155.1.1',
    created_at: ago(5000),
    last_used_at: ago(100),
    expires_at: new Date(NOW + 20 * 86_400_000).toISOString(),
    current: false,
  },
];
const CODES = Array.from({ length: 8 }, (_, i) => `abcd-ef${String(i).padStart(2, '0')}`);

type Me = typeof ME_MEMBER | typeof ME_ADMIN;

function routes(me: Me, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/me': () => json(me),
    'GET /api/me/sessions': () => json(SESSIONS),
    'GET /api/me/login-events': () => json(EVENTS),
    'GET /api/me/recovery-codes': () => json({ left: 3, total: 8, created_at: '2026-06-30T10:00:00Z' }),
    'GET /api/me/trusted-devices': () => json(DEVICES),
    'GET /api/settings': () => json({ currency: 'EUR' }),
    'GET /api/admin/users': () => json([{ id: 1, status: 'active' }, { id: 2, status: 'active' }, { id: 3, status: 'deleted' }]),
    'GET /api/admin/invites': () => json([{ id: 1 }]),
    // точка у вкладки «Ключ Claude» берется из лимита
    'GET /api/ai/budget': () => json(aiBudget()),
    // метка «Пауза до …» в сводке
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    ...extra,
  };
}

function renderProfile(path: string, me: Me = ME_MEMBER) {
  const { router, client } = renderPage(<ProfilePage />, {
    path: '/profile/:tab?',
    url: path,
    me,
    stubs: { '/login': 'Страница входа', '/admin/:tab?': 'Администрирование' },
  });
  return { router, client };
}

async function bodyOf(request: Request): Promise<unknown> {
  return JSON.parse(await request.clone().text());
}

describe('Личный кабинет: профиль', () => {
  it('сводка: имя, роль, 2FA, сеансы и мало резервных кодов', async () => {
    mockFetch(routes(ME_MEMBER));
    renderProfile('/profile');
    const hero = screen.getByRole('region', { name: 'Сводка аккаунта' });
    expect(within(hero).getByRole('heading', { name: 'Анна Петрова' })).toBeInTheDocument();
    expect(within(hero).getByText('Участник')).toBeInTheDocument();
    expect(within(hero).getByText('2FA включена')).toBeInTheDocument();
    expect(await within(hero).findByText('Chrome · Windows, Неизвестное устройство')).toBeInTheDocument();
    expect(within(hero).getByText('3 из 8 не использованы')).toBeInTheDocument();
    expect(within(hero).getByText('2 из 3')).toBeInTheDocument();
    // вход с верным паролем, но без 2FA — предупреждение и точка на вкладке
    expect(within(hero).getByText(/вход \(Firefox · Linux\) остановлен на 2FA/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Безопасность\s*\(есть что проверить\)/ })).toBeInTheDocument();
  });

  it('имя: сохраняется через PATCH /api/me, пустое не уходит', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(ME_MEMBER, {
        'PATCH /api/me': async (request) => {
          const body = (await bodyOf(request)) as { display_name: string };
          return json({ ...ME_MEMBER, display_name: body.display_name });
        },
      }),
    );
    renderProfile('/profile');
    const name = screen.getByLabelText('Имя и фамилия');
    const save = screen.getAllByRole('button', { name: 'Сохранить' })[0]!;
    expect(save).toBeDisabled();
    await user.clear(name);
    await user.type(name, 'А');
    await user.click(save);
    expect(await screen.findByText('Укажите имя — хотя бы 2 буквы')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'PATCH')).toBe(false);

    await user.clear(name);
    await user.type(name, '  Анна Иванова ');
    await user.click(save);
    expect(await screen.findByText('Имя сохранено: Анна Иванова')).toBeInTheDocument();
    const patch = calls.find((r) => r.method === 'PATCH');
    expect(await bodyOf(patch!)).toEqual({ display_name: 'Анна Иванова' });
    expect(patch!.headers.get('X-CSRF-Token')).toBe('csrf');
    expect(screen.getByRole('heading', { name: 'Анна Иванова' })).toBeInTheDocument();
    // email — только для чтения
    expect(screen.getByLabelText('Email для входа')).toHaveAttribute('readonly');
  });

  it('часовой пояс: выбор в едином списке и сохранение', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(ME_MEMBER, {
        'PATCH /api/me': async (request) => json({ ...ME_MEMBER, ...((await bodyOf(request)) as object) }),
      }),
    );
    const { client } = renderProfile('/profile');
    expect(await screen.findByText('Евро (€)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Часовой пояс/ }));
    await user.click(await screen.findByRole('option', { name: /Нью-Йорк/ }));
    const region = screen.getByRole('region', { name: 'Регион и язык' });
    await user.click(within(region).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText(/Время теперь показываем по Нью-Йорку/)).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PATCH')!)).toEqual({ tz: 'America/New_York' });
    expect(client.getQueryData<Me>(meQueryKey)?.tz).toBe('America/New_York');
  });

  it('администратору — число участников и ссылки в администрирование', async () => {
    mockFetch(routes(ME_ADMIN));
    renderProfile('/profile', ME_ADMIN);
    expect(await screen.findByRole('link', { name: '1 человек · 1 приглашение ждет' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
    expect(screen.getByRole('link', { name: 'Пригласить участника' })).toHaveAttribute('href', '/admin/invites');
  });

  it('сводка «Часто нужно»: лимиты и пауза, экспорт данных — работают с этапа 4', async () => {
    mockFetch(routes(ME_MEMBER));
    renderProfile('/profile');
    const hero = screen.getByRole('region', { name: 'Сводка аккаунта' });
    expect(within(hero).getByRole('link', { name: 'Лимиты и пауза' })).toHaveAttribute('href', '/profile/bank#profile-rg');
    expect(within(hero).getByRole('link', { name: 'Экспорт данных' })).toHaveAttribute('href', '/profile/data#profile-export');
    // заглушек во вкладках кабинета больше нет
    expect(screen.queryByText(/Раздел появится на этапе/)).toBeNull();
  });

  it('«Выйти» в сводке: выход на сервере, страница входа, кэш очищен', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(ME_MEMBER, { 'POST /api/auth/logout': () => new Response(null, { status: 204 }) }),
    );
    const { router, client } = renderProfile('/profile');
    const hero = screen.getByRole('region', { name: 'Сводка аккаунта' });
    await user.click(within(hero).getByRole('button', { name: 'Выйти' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(calls.some((r) => r.method === 'POST' && r.url.endsWith('/api/auth/logout'))).toBe(true);
    expect(client.getQueryData(meQueryKey)).toBeUndefined();
  });
});

describe('Личный кабинет: безопасность', () => {
  it('смена пароля: проверки формы, ошибка текущего пароля, успех', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { calls } = mockFetch(
      routes(ME_MEMBER, {
        'POST /api/me/password': () =>
          ++attempt === 1
            ? apiError(400, 'auth.current_password_invalid', 'Текущий пароль не подходит')
            : new Response(null, { status: 204 }),
      }),
    );
    renderProfile('/profile/security');
    await screen.findByText('Другие сеансы завершатся: Неизвестное устройство — там нужно будет войти заново');
    const submit = screen.getByRole('button', { name: 'Сменить пароль' });
    await user.click(submit);
    expect(screen.getByText('Введите текущий пароль')).toBeInTheDocument();
    expect(screen.getByText('Нужно не меньше 12 символов')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Текущий пароль'), 'old-password-1');
    await user.type(screen.getByLabelText('Новый пароль'), 'Fresh-password-2026');
    expect(screen.getByText('Надежный')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'Fresh-password-2026');
    await user.click(submit);
    expect(await screen.findByText('Текущий пароль не подходит')).toBeInTheDocument();

    await user.click(submit);
    expect(await screen.findByText('Пароль изменен. Другие сеансы завершены')).toBeInTheDocument();
    const posts = calls.filter((r) => r.method === 'POST' && r.url.endsWith('/api/me/password'));
    expect(await bodyOf(posts[1]!)).toEqual({
      current_password: 'old-password-1',
      new_password: 'Fresh-password-2026',
    });
    expect(screen.getByLabelText('Текущий пароль')).toHaveValue('');
  });

  it('сеансы: «Этот сеанс», завершение чужого и выход на остальных', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(ME_MEMBER, {
        'DELETE /api/me/sessions/12': () => new Response(null, { status: 204 }),
        'POST /api/me/sessions/revoke-others': () => new Response(null, { status: 204 }),
      }),
    );
    renderProfile('/profile/security');
    const card = (await screen.findByRole('heading', { name: 'Активные сеансы' })).closest('section')!;
    expect(await within(card).findByText('Этот сеанс')).toBeInTheDocument();
    expect(within(card).getByText('88.193.xx.xx')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Завершить сеанс: Неизвестное устройство' }));
    expect(await screen.findByText('Сеанс на Неизвестное устройство завершен')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/me/sessions/12'))).toBe(true);

    await user.click(within(card).getByRole('button', { name: 'Выйти на всех других устройствах' }));
    expect(within(card).getByText(/Завершим 1 сеанс: Неизвестное устройство/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Да, завершить' }));
    expect(await screen.findByText('Все другие сеансы завершены')).toBeInTheDocument();
  });

  it('резервные коды: перевыпуск по коду 2FA и показ новых', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    mockFetch(
      routes(ME_MEMBER, {
        'POST /api/me/recovery-codes': () =>
          ++attempt === 1
            ? apiError(400, 'auth.invalid_code', 'Код не подошел')
            : json({ recovery_codes: CODES }),
      }),
    );
    renderProfile('/profile/security');
    expect(await screen.findByText('Осталось мало')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Перевыпустить резервные коды' }));
    const dialog = screen.getByRole('dialog', { name: 'Резервные коды' });
    const field = within(dialog).getByLabelText('Код из приложения-аутентификатора');
    expect(field).toHaveFocus();
    await user.type(field, '12');
    await user.click(within(dialog).getByRole('button', { name: 'Создать новые коды' }));
    expect(within(dialog).getByText('Нужно 6 цифр из приложения')).toBeInTheDocument();
    await user.type(field, '3456');
    await user.click(within(dialog).getByRole('button', { name: 'Создать новые коды' }));
    expect(await within(dialog).findByText('Код не подошел')).toBeInTheDocument();
    await user.type(field, '654321');
    await user.click(within(dialog).getByRole('button', { name: 'Создать новые коды' }));
    const list = await screen.findByRole('list', { name: 'Резервные коды' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    await waitFor(() => expect(list).toHaveFocus());

    // Файл хранят долго: дата выпуска с годом
    const files: Blob[] = [];
    const urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = (blob: Blob) => {
      files.push(blob);
      return 'blob:codes';
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      await user.click(screen.getByRole('button', { name: 'Скачать .txt' }));
    } finally {
      Object.assign(URL, { createObjectURL: urls.create, revokeObjectURL: urls.revoke });
      click.mockRestore();
    }
    const text = await files[0]?.text();
    expect(text).toContain('Аккаунт: anna@example.com');
    // год — по поясу участника (в новогоднюю ночь по UTC он уже другой), поэтому любой
    expect(text).toMatch(/Созданы: \d+ \S+ \d{4}, \d\d:\d\d/);
    expect(text).toContain(CODES[7]);

    // Коды больше не покажут: ни Esc, ни «Готово» не закрывают окно без отметки «сохранил»
    const codesDialog = screen.getByRole('dialog', { name: 'Резервные коды' });
    await user.keyboard('{Escape}');
    await user.click(within(codesDialog).getByRole('button', { name: 'Закрыть' }));
    await user.click(within(codesDialog).getByRole('button', { name: 'Готово' }));
    expect(screen.getByRole('dialog', { name: 'Резервные коды' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Отметьте, что сохранили коды');
    const saved = screen.getByRole('checkbox', { name: 'Я сохранил(а) резервные коды в надежном месте' });
    expect(saved).toHaveFocus();
    await user.click(saved);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('резервные коды: пока сервер их выпускает, окно не закрывается', async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => undefined;
    mockFetch(
      routes(ME_MEMBER, {
        'POST /api/me/recovery-codes': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      }),
    );
    renderProfile('/profile/security');
    await user.click(await screen.findByRole('button', { name: 'Перевыпустить резервные коды' }));
    await user.type(screen.getByLabelText('Код из приложения-аутентификатора'), '654321{Enter}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled());
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Резервные коды' })).toBeInTheDocument();
    answer(json({ recovery_codes: CODES }));
    expect(await screen.findByRole('list', { name: 'Резервные коды' })).toBeInTheDocument();
  });

  it('якорь из сводки: прокрутка к журналу, когда карточки над ним загрузились', async () => {
    let answer: (response: Response) => void = () => undefined;
    mockFetch(
      routes(ME_MEMBER, {
        'GET /api/me/sessions': () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      }),
    );
    const scrolled: string[] = [];
    const scroll = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(function (this: Element) {
        scrolled.push(this.id);
      });
    try {
      renderProfile('/profile/security#profile-log');
      await screen.findByRole('heading', { name: 'Журнал входов' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(scrolled).toEqual([]);
      answer(json(SESSIONS));
      await waitFor(() => expect(scrolled).toEqual(['profile-log']));
    } finally {
      scroll.mockRestore();
    }
  });

  it('доверенные устройства: список и «Забыть»', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(ME_MEMBER, { 'DELETE /api/me/trusted-devices/5': () => new Response(null, { status: 204 }) }),
    );
    renderProfile('/profile/security');
    await user.click(await screen.findByRole('button', { name: 'Забыть устройство: Safari · iOS' }));
    expect(await screen.findByText('Устройство «Safari · iOS» забыто: там снова спросим код 2FA')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/me/trusted-devices/5'))).toBe(true);
  });

  it('журнал входов: результат чипом, фильтр неудачных, «Это был я»', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes(ME_MEMBER));
    renderProfile('/profile/security');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Успешно')).toBeInTheDocument();
    expect(within(table).getByText('2FA не пройдена')).toBeInTheDocument();
    expect(within(table).getByText('Неверный пароль')).toBeInTheDocument();
    expect(within(table).getByText('185.220.xx.xx')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Неудачные' }));
    expect(within(screen.getByRole('table')).queryByText('Успешно')).not.toBeInTheDocument();

    expect(screen.getByText(/кто-то ввел верный пароль, но не прошел 2FA/)).toBeInTheDocument();
    // Подозрительный вход ищется отдельным запросом без неверных паролей и отказов 429:
    // их поток не вытеснит из выборки след входа с верным паролем
    expect(
      calls.some((r) =>
        r.url.endsWith('/api/me/login-events?limit=200&result=ok&result=bad_totp&result=bad_recovery'),
      ),
    ).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Это был я' }));
    expect(screen.queryByText(/кто-то ввел верный пароль/)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Безопасность' })).toBeInTheDocument();
  });

  it('на телефоне журнал — список, вкладки — короткие подписи', async () => {
    setViewportWidth(375);
    mockFetch(routes(ME_MEMBER));
    renderProfile('/profile/security');
    expect(await screen.findByRole('list', { name: 'Журнал входов' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Банк' })).toBeInTheDocument();
  });
});
