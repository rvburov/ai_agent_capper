import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { meQueryKey } from '../../../api/keys';
import { aiBudget } from '../../../features/ai/testData';
import { playLimitsOut } from '../../../features/bank/testData';
import { betsSummary } from '../../../features/bets/testData';
import { bookmakersOut } from '../../../features/bookmakers/testData';
import { apiError, json, ME_ADMIN, ME_MEMBER, type Handler } from '../../../test/fetchMock';
import { bodyOf, renderPage } from '../../../test/renderPage';
import { ProfilePage } from '../ProfilePage';

// Кабинет → «Данные»: экспорт сразу скачиванием, согласие (Р15), импорт бота — статус,
// удаление аккаунта с паролем и кодом 2FA (В10).

function summary(request: Request) {
  const legacy = new URL(request.url).searchParams.get('source') === 'legacy';
  return json(legacy ? betsSummary({ settled: 0, open: 0, legacy_settled: 0 }) : betsSummary());
}

function api(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/bets/summary': summary,
    'GET /api/me/bookmakers/list': () => json(bookmakersOut()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/me/login-events': () => json([]),
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    'GET /api/admin/users': () =>
      json([
        { id: 1, role: 'admin', status: 'active' },
        { id: 7, role: 'admin', status: 'active' },
      ]),
    ...over,
  };
}

function renderTab(handlers: Record<string, Handler>, me: typeof ME_MEMBER | typeof ME_ADMIN = ME_MEMBER) {
  return renderPage(<ProfilePage />, {
    path: '/profile/:tab?',
    url: '/profile/data',
    me,
    api: handlers,
    stubs: { '/login': 'Страница входа', '/admin/:tab?': 'Администрирование' },
  });
}

const card = async (name: string) => (await screen.findByRole('heading', { name })).closest('section') as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Кабинет: данные', () => {
  it('экспорт: что в архиве, JSON и ZIP скачиваются сразу с именем файла с сервера', async () => {
    const created: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      created.push(blob as Blob);
      return 'blob:capper';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    });
    const { user, calls } = renderTab(
      api({
        'GET /api/me/export': (request) => {
          const format = new URL(request.url).searchParams.get('format');
          const name = format === 'json' ? 'capper-export-2026-10-14.json' : 'capper-export-2026-10-14.zip';
          return new Response(format === 'json' ? '{"profile":{}}' : 'PK', {
            headers: {
              'Content-Type': format === 'json' ? 'application/json' : 'application/zip',
              'Content-Disposition': `attachment; filename="${name}"`,
            },
          });
        },
      }),
    );
    const exportCard = await card('Экспорт всех данных');
    // 3 рассчитанные и 1 в игре, 1 — старого бота; букмекеров 3, скрыт 1
    expect(await within(exportCard).findByText('4 ставки, из них 1 в игре, 1 из старого бота')).toBeInTheDocument();
    expect(await within(exportCard).findByText('3 букмекера, из них скрыто 1')).toBeInTheDocument();
    expect(within(exportCard).getByText('без паролей, кодов 2FA и ключей Claude')).toBeInTheDocument();
    await user.click(within(exportCard).getByRole('button', { name: 'Скачать JSON' }));
    expect(await screen.findByText('Скачивание началось: capper-export-2026-10-14.json')).toBeInTheDocument();
    await user.click(within(exportCard).getByRole('button', { name: 'Скачать CSV (ZIP)' }));
    expect(await screen.findByText('Скачивание началось: capper-export-2026-10-14.zip')).toBeInTheDocument();
    expect(clicked).toEqual(['capper-export-2026-10-14.json', 'capper-export-2026-10-14.zip']);
    expect(await created[0]!.text()).toBe('{"profile":{}}');
    const formats = calls.filter((r) => r.url.includes('/api/me/export')).map((r) => new URL(r.url).searchParams.get('format'));
    expect(formats).toEqual(['json', 'csv']);
  });

  it('экспорт не удался — текст ошибки, файла нет', async () => {
    const created = vi.spyOn(URL, 'createObjectURL');
    const { user } = renderTab(api({ 'GET /api/me/export': () => apiError(429, 'common.rate_limited', 'Слишком много запросов') }));
    const exportCard = await card('Экспорт всех данных');
    await user.click(within(exportCard).getByRole('button', { name: 'Скачать JSON' }));
    expect(await screen.findByText('Слишком много запросов')).toBeInTheDocument();
    expect(created).not.toHaveBeenCalled();
  });

  it('согласие на обезличенные прогнозы — PATCH /api/me, профиль из ответа', async () => {
    const { user, calls, client } = renderTab(api({ 'PATCH /api/me': () => json({ ...ME_MEMBER, consent_training: true }) }));
    const consent = await card('Прогнозы для общей модели');
    expect(within(consent).getByText('Согласия нет: при удалении аккаунта прогнозы удалятся вместе с ним.')).toBeInTheDocument();
    await user.click(within(consent).getByRole('switch', { name: /Разрешаю обезличенно использовать мои прогнозы/ }));
    expect(await screen.findByText('Согласие дано: обезличенные прогнозы помогут общей модели')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PATCH') as Request)).toEqual({ consent_training: true });
    expect(within(consent).getByText('Если удалите аккаунт, обезличенные прогнозы останутся в общей модели — без связи с вами.')).toBeInTheDocument();
    expect(client.getQueryData<{ consent_training: boolean }>(meQueryKey)?.consent_training).toBe(true);
    // в «Останется» — прогнозы со ссылкой на согласие
    const danger = await card('Удалить аккаунт');
    expect(within(danger).getByRole('link', { name: 'изменить' })).toHaveAttribute('href', '#profile-consent');
  });

  it('импорт старого бота: участнику — только если ставки перенесены; администратору — всегда', async () => {
    const legacy = (request: Request) =>
      new URL(request.url).searchParams.get('source') === 'legacy' ? json(betsSummary({ settled: 40, open: 2, legacy_settled: 40 })) : json(betsSummary());
    renderTab(api({ 'GET /api/bets/summary': legacy }));
    const done = await card('Импорт истории из старого бота');
    expect(within(done).getByText('Выполнен')).toBeInTheDocument();
    expect(await within(done).findByText('42 ставки в ваш аккаунт, из них 2 в игре')).toBeInTheDocument();
    expect(within(done).getByText('bash deploy/local.sh import EMAIL История-ставок.json')).toBeInTheDocument();
  });

  it('участник без ставок бота — карточки импорта нет; у администратора — «Не выполнен»', async () => {
    const view = renderTab(api());
    await card('Экспорт всех данных');
    await waitFor(() => expect(view.calls.some((r) => r.url.includes('source=legacy'))).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Импорт истории из старого бота' })).toBeNull();
    view.unmount();
    renderTab(api(), ME_ADMIN);
    const none = await card('Импорт истории из старого бота');
    expect(await within(none).findByText('Не выполнен')).toBeInTheDocument();
    expect(within(none).getByText('ставок старого бота в вашем аккаунте нет')).toBeInTheDocument();
  });

  it('удаление: пустые поля и ошибки сервера — у своих полей', async () => {
    let attempt = 0;
    const { user, calls } = renderTab(
      api({
        'POST /api/me/deletion': () => {
          attempt += 1;
          if (attempt === 1) return apiError(400, 'auth.current_password_invalid', 'Пароль не подходит');
          if (attempt === 2) return apiError(400, 'auth.invalid_code', 'Код не подходит');
          return apiError(409, 'account.deletion_pending_already', 'Уже запланировано');
        },
      }),
    );
    const danger = await card('Удалить аккаунт');
    expect(await within(danger).findByText('Ставки и экспрессы (4), банк и его журнал')).toBeInTheDocument();
    await user.click(within(danger).getByRole('button', { name: 'Удалить аккаунт' }));
    expect(within(danger).getByText('Введите пароль')).toBeInTheDocument();
    expect(within(danger).getByText('Нужно 6 цифр из приложения')).toBeInTheDocument();
    await waitFor(() => expect(within(danger).getByLabelText('Пароль')).toHaveFocus());
    expect(calls.some((r) => r.method === 'POST')).toBe(false);
    await user.type(within(danger).getByLabelText('Пароль'), 'secret-pass');
    await user.type(within(danger).getByRole('textbox', { name: 'Код 2FA' }), '123 456');
    await user.click(within(danger).getByRole('button', { name: 'Удалить аккаунт' }));
    expect(await within(danger).findByText('Пароль не подходит')).toBeInTheDocument();
    // кнопка на время запроса неактивна — фокус не теряется, а встает в поле с ошибкой
    await waitFor(() => expect(within(danger).getByLabelText('Пароль')).toHaveFocus());
    expect(await bodyOf(calls.find((r) => r.method === 'POST') as Request)).toEqual({ password: 'secret-pass', code: '123456' });
    // код после ошибки стирается: старый уже не подойдет
    expect(within(danger).getByRole('textbox', { name: 'Код 2FA' })).toHaveValue('');
    await user.type(within(danger).getByRole('textbox', { name: 'Код 2FA' }), '654321');
    await user.click(within(danger).getByRole('button', { name: 'Удалить аккаунт' }));
    expect(await within(danger).findByText('Код не подходит')).toBeInTheDocument();
    expect(within(danger).queryByText('Пароль не подходит')).toBeNull();
    await waitFor(() => expect(within(danger).getByRole('textbox', { name: 'Код 2FA' })).toHaveFocus());
    // остальное — плашкой под полями
    await user.type(within(danger).getByRole('textbox', { name: 'Код 2FA' }), '111111');
    await user.click(within(danger).getByRole('button', { name: 'Удалить аккаунт' }));
    expect(await within(danger).findByRole('alert')).toHaveTextContent('Удаление аккаунта уже запланировано');
    await waitFor(() => expect(within(danger).getByRole('textbox', { name: 'Код 2FA' })).toHaveFocus());
    // участнику список пользователей не запрашивается: /admin/* — только администратор
    expect(calls.some((r) => r.url.includes('/api/admin/'))).toBe(false);
  });

  it('администратор: список пользователей нужен, чтобы не удалить единственного администратора', async () => {
    const { calls } = renderTab(api(), ME_ADMIN);
    const danger = await card('Удалить аккаунт');
    expect(await within(danger).findByLabelText('Пароль')).toBeInTheDocument();
    expect(calls.some((r) => r.url.endsWith('/api/admin/users'))).toBe(true);
  });

  it('удаление запрошено: выход на страницу входа с датой удаления, кэш очищен', async () => {
    const { user, router, client } = renderTab(
      api({ 'POST /api/me/deletion': () => json({ requested_at: '2026-12-14T10:00:00Z', delete_at: '2026-12-21T10:00:00Z' }) }),
    );
    const danger = await card('Удалить аккаунт');
    await user.type(within(danger).getByLabelText('Пароль'), 'secret-pass');
    await user.type(within(danger).getByRole('textbox', { name: 'Код 2FA' }), '123456');
    await user.click(within(danger).getByRole('button', { name: 'Удалить аккаунт' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(await screen.findByText(/^Удаление запланировано на 21 декабря\. Вы вышли из аккаунта на всех устройствах/)).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData(meQueryKey)).toBeUndefined());
  });

  it('единственный администратор удалить себя не может — сначала назначить другого', async () => {
    renderTab(api({ 'GET /api/admin/users': () => json([{ id: 1, role: 'admin', status: 'active' }, { id: 2, role: 'member', status: 'active' }]) }), ME_ADMIN);
    const danger = await card('Удалить аккаунт');
    expect(await within(danger).findByText(/^Вы единственный администратор\./)).toBeInTheDocument();
    expect(within(danger).getByRole('button', { name: 'Удалить аккаунт' })).toBeDisabled();
    expect(within(danger).getByRole('link', { name: 'Участники' })).toHaveAttribute('href', '/admin/users');
    expect(within(danger).queryByLabelText('Пароль')).toBeNull();
  });

  it('«Откуда берутся данные» — новый текст: архивы, новости по Р23, кэфы и закрытие', async () => {
    renderTab(api());
    const sources = await card('Откуда берутся данные о матчах');
    expect(within(sources).getByText(/только на atptour\.com, сайтах турниров Большого шлема/)).toBeInTheDocument();
    // как в макете: до какого месяца копия архива и какая модель ищет новости
    expect(within(sources).getByText(/\(копия архива, по май 2026; CC BY-NC-SA 4\.0\)/)).toBeInTheDocument();
    expect(within(sources).getByText(/^Ищет Claude \(Sonnet 5\.5\) перед анализом/)).toBeInTheDocument();
    expect(within(sources).getByText(/эталона \(Pinnacle → Betfair → средний по рынку\)/)).toBeInTheDocument();
  });
});
