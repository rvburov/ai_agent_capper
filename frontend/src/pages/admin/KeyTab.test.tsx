import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminBudget,
  adminKey,
  adminUser,
  LIMIT_DEFAULTS,
  memberLimit,
} from '../../features/admin/testData';
import type { MemberLimit } from '../../features/admin/types';
import { apiError, json, ME_ADMIN, mockFetch, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { setViewportWidth } from '../../test/setup';
import { AdminPage } from './AdminPage';

const ME = memberLimit({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin', limit: null, spent_month_usd: 2.4 });
const OLGA = memberLimit({ id: 2 });
const ALEX = memberLimit({
  id: 3,
  display_name: 'Алексей Ковалев',
  email: 'alexey@example.com',
  limit: { monthly_usd: 8, daily_analyses: 5, per_analysis_usd: 1, paused: false },
  spent_month_usd: 7.28,
  analyses_today: 4,
  analyses_month: 33,
});
const DMITRY = memberLimit({
  id: 5,
  display_name: 'Дмитрий Шульц',
  email: 'dmitry@example.com',
  ai_mode: 'own',
  own_key_last4: '7Qx2',
  own_spent_month_usd: 3.4,
  return_requested_at: '2026-10-06T21:15:00Z',
});
const MEMBERS = [ME, OLGA, ALEX, DMITRY];

function routes(extra: Record<string, Handler> = {}, members: MemberLimit[] = MEMBERS): Record<string, Handler> {
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/me': () => json(ME_ADMIN),
    'GET /api/admin/users': () =>
      json([
        adminUser({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin', limit: null }),
        adminUser({ id: 2 }),
        adminUser({
          id: 3,
          display_name: 'Алексей Ковалев',
          email: 'alexey@example.com',
          ai_spent_month_usd: 7.28,
          limit: { monthly_usd: 10, daily_analyses: 5, per_analysis_usd: 1, paused: false },
        }),
        adminUser({ id: 5, display_name: 'Дмитрий Шульц', email: 'dmitry@example.com', ai_mode: 'own', limit: null }),
      ]),
    'GET /api/admin/invites': () => json([]),
    'GET /api/admin/ai/limits': () => json({ defaults: LIMIT_DEFAULTS, members }),
    'GET /api/admin/ai/budget': () => json(adminBudget()),
    'GET /api/admin/ai/key': () => json(adminKey()),
    ...extra,
  };
}

async function bodyOf(request: Request): Promise<unknown> {
  return JSON.parse(await request.clone().text());
}

function renderAdmin(path: string) {
  const { router } = renderPage(<AdminPage />, { path: '/admin/:tab?', url: path, me: ME_ADMIN });
  return { router };
}

const toast = (text: string | RegExp) => screen.findByText(text, { selector: '.toast span' });

// Даты фикстур — 12–13 октября 2026. «Сегодня», месяц и год в подписях считаются от часов
// браузера: фиксируем их, иначе завтра (1 ноября, 1 января) тесты станут красными
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Администрирование: ключ и бюджет', () => {
  it('ключ, бюджет с полосой и прогнозом, лимиты участников и правила порогов', async () => {
    mockFetch(routes());
    renderAdmin('/admin/key');
    const key = (await screen.findByText('sk-ant-…m9Tq')).closest('section')!;
    expect(within(key).getByRole('heading', { name: 'Ключ администратора' })).toBeInTheDocument();
    expect(within(key).getByText('Работает')).toBeInTheDocument();
    expect(within(key).getByText('3 человека и общие задачи')).toBeInTheDocument();
    expect(within(key).getByText(/например, \$70 в месяц/)).toBeInTheDocument();

    const budget = (await screen.findByText('$41,20')).closest('section')!;
    expect(within(budget).getByText('$41,20')).toBeInTheDocument();
    expect(within(budget).getByText('из $60')).toBeInTheDocument();
    expect(within(budget).getByText('69% бюджета')).toBeInTheDocument();
    expect(within(budget).getByRole('meter', { name: 'Потрачено $41,20 из $60, прогноз $66,00' })).toBeInTheDocument();
    expect(within(budget).getByText('Потрачено за 1–7 окт')).toBeInTheDocument();
    expect(within(budget).getAllByText('Прогноз на 31 окт')).toHaveLength(1);
    expect(within(budget).getByText('24 дня')).toBeInTheDocument();
    expect(within(budget).getByText(/Сумма личных лимитов — \$18 \(Ольга \$10, Алексей \$8\)/)).toBeInTheDocument();
    expect(within(budget).getByText(/Проверки модели на истории: \$4,50 из \$25/)).toBeInTheDocument();
    expect(within(budget).getByRole('button', { name: 'Сохранить' })).toBeDisabled();

    const limits = (await screen.findByRole('table')).closest('section')!;
    expect(within(limits).getByText('$10 в месяц · 3 анализа в день · $1 на анализ')).toBeInTheDocument();
    const table = within(limits).getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    // сначала вы, участник на своем ключе — в конце
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
      'Роман Буроввыключ администратора',
      'Ольга Лехтиненключ администратора',
      'Алексей Ковалевключ администратора',
      'Дмитрий Шульцсвой ключ …7Qx2',
    ]);
    expect(within(rows[0]!).getByText('Без личного лимита — только общий бюджет')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('Лимит трат — в его консоли Anthropic')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('задает участник')).toBeInTheDocument();
    // 91% лимита — выше порога уведомления 80%: процент желтый
    expect(within(rows[2]!).getByText('91%')).toHaveClass('warn-text');
    expect(within(rows[1]!).getByRole('button', { name: 'Изменить лимит: Ольга Лехтинен' })).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole('button', { name: /Изменить лимит/ })).not.toBeInTheDocument();

    expect(screen.getByRole('heading', { name: 'Что происходит на 80% и 100%' })).toBeInTheDocument();
    expect(screen.getByText('80% лимита участника')).toBeInTheDocument();
  });

  it('порог уведомления — из настроек бюджета: при 90% те же 91% уже не желтые до 100%', async () => {
    mockFetch(routes({ 'GET /api/admin/ai/budget': () => json(adminBudget({ alert_pct: 95 })) }));
    renderAdmin('/admin/key');
    const row = (await screen.findByText('Алексей Ковалев', { selector: '.adm-limits-table *' })).closest('tr')!;
    await waitFor(() => expect(within(row).getByText('91%')).not.toHaveClass('warn-text'));
    expect(screen.getByRole('heading', { name: 'Что происходит на 95% и 100%' })).toBeInTheDocument();
  });

  it('бюджет не загрузился: правил с порогом нет (а не «Что происходит на —»), у бюджета — ошибка и повтор', async () => {
    mockFetch(routes({ 'GET /api/admin/ai/budget': () => apiError(500, 'common.internal', 'Внутренняя ошибка') }));
    renderAdmin('/admin/key');
    await screen.findByRole('heading', { name: 'Лимиты участников' });
    expect(await screen.findByText(/Внутренняя ошибка/)).toBeInTheDocument();
    expect(screen.queryByText(/Что происходит на/)).not.toBeInTheDocument();
    expect(screen.queryByText(/—/, { selector: '.adm-rule-k' })).not.toBeInTheDocument();
  });

  it('замена ключа: формат на месте, код 2FA в окне, ключ не принят — ошибка под полем', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { calls } = mockFetch(
      routes({
        'PUT /api/admin/ai/key': () =>
          ++attempt === 1
            ? apiError(400, 'ai.key_rejected', 'Anthropic не принял ключ Claude: он отозван, неверный или не дает доступа к нужной модели')
            : json(adminKey({ last4: 'WXYZ', verified_at: '2026-10-07T09:00:00Z' })),
      }),
    );
    renderAdmin('/admin/key');
    await user.click(await screen.findByRole('button', { name: 'Заменить ключ' }));
    const field = screen.getByLabelText('Новый ключ');
    expect(field).toHaveFocus();
    await user.type(field, 'sk-ant-short');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    expect(screen.getByText('Ключ начинается с sk-ant- и длиннее 20 символов — скопируйте его целиком')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.clear(field);
    await user.type(field, 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    let dialog = screen.getByRole('dialog', { name: 'Заменить ключ администратора' });
    expect(within(dialog).getByText(/Старый sk-ant-…m9Tq перестанет использоваться сразу/)).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Проверить и сохранить' });
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '123456');
    await user.click(go);
    // ключ не принят: окно закрылось, ошибка — под полем ключа
    expect(await screen.findByText(/Anthropic не принял ключ Claude/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PUT')!)).toEqual({
      key: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      totp_code: '123456',
    });

    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    dialog = screen.getByRole('dialog', { name: 'Заменить ключ администратора' });
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '654321');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await toast('Ключ проверен и сохранен: sk-ant-…WXYZ')).toBeInTheDocument();
    expect(screen.queryByLabelText('Новый ключ')).not.toBeInTheDocument();
  });

  it('нет связи с Anthropic: код 2FA уже принят — окно закрывается, ошибка плашкой, новый код в новом окне', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const { calls } = mockFetch(
      routes({
        'PUT /api/admin/ai/key': () => {
          attempt += 1;
          if (attempt === 1) return apiError(503, 'ai.key_unavailable', 'Не удалось проверить ключ: нет связи с Anthropic. Попробуйте еще раз чуть позже');
          if (attempt === 2) return apiError(502, 'ai.key_check_failed', 'Anthropic ответил ошибкой 500 при проверке ключа. Попробуйте еще раз чуть позже');
          return json(adminKey({ last4: 'WXYZ', verified_at: '2026-10-07T09:00:00Z' }));
        },
      }),
    );
    renderAdmin('/admin/key');
    await user.click(await screen.findByRole('button', { name: 'Заменить ключ' }));
    const field = screen.getByLabelText('Новый ключ');
    await user.type(field, 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    for (const [code, message] of [
      ['111111', /нет связи с Anthropic/],
      ['222222', /Anthropic ответил ошибкой 500/],
    ] as const) {
      await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
      const dialog = screen.getByRole('dialog', { name: 'Заменить ключ администратора' });
      // новое окно — с пустым полем кода: прежний код сервер уже принял и второй раз не примет
      expect(within(dialog).getByLabelText('Код 2FA из вашего приложения')).toHaveValue('');
      await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), code);
      await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
      const alert = await screen.findByText(message);
      expect(alert.closest('[role="alert"]')).not.toBeNull();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // ключ в поле остается: повторить можно, не вставляя его заново
      expect(field).toHaveValue('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    }
    expect(screen.queryByText(/нет связи с Anthropic/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Проверить и сохранить' }));
    const dialog = screen.getByRole('dialog', { name: 'Заменить ключ администратора' });
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '333333');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await toast('Ключ проверен и сохранен: sk-ant-…WXYZ')).toBeInTheDocument();
    const codes = await Promise.all(
      calls.filter((r) => r.method === 'PUT').map(async (r) => ((await bodyOf(r)) as { totp_code: string }).totp_code),
    );
    expect(codes).toEqual(['111111', '222222', '333333']);
  });

  it('неверный код 2FA остается в окне под полем кода', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        'PUT /api/admin/ai/key': () =>
          apiError(403, 'admin.totp_invalid', 'Код 2FA не подходит: проверьте приложение и введите новый код'),
      }),
    );
    renderAdmin('/admin/key');
    await user.click(await screen.findByRole('button', { name: 'Заменить ключ' }));
    await user.type(screen.getByLabelText('Новый ключ'), 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Заменить ключ администратора' });
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Проверить и сохранить' }));
    expect(await within(dialog).findByText(/Код 2FA не подходит/)).toBeInTheDocument();
  });

  it('бюджет: границы $1–5000, не меньше потраченного; порог через единый выпадающий список', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        'PUT /api/admin/ai/budget': async (request) => {
          const body = (await bodyOf(request)) as { monthly_usd: string; alert_pct: number };
          return json(adminBudget({ budget_usd: Number(body.monthly_usd), alert_pct: body.alert_pct }));
        },
      }),
    );
    renderAdmin('/admin/key');
    const field = await screen.findByLabelText('Бюджет в месяц, $');
    const save = screen.getByRole('button', { name: 'Сохранить' });
    await user.clear(field);
    await user.type(field, '0,5');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(screen.getByText('От $1 до $5 000')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '40');
    await user.click(save);
    expect(screen.getByText('Меньше уже потраченного ($41,20): анализы на вашем ключе остановятся сразу')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'PUT')).toBe(false);

    await user.clear(field);
    await user.type(field, '70');
    await user.click(screen.getByRole('button', { name: /^Уведомить при: 80%/ }));
    await user.click(screen.getByRole('option', { name: '90%' }));
    await user.click(save);
    expect(await toast('Бюджет: $70 в месяц, уведомление при 90%')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PUT')!)).toEqual({ monthly_usd: '70.00', alert_pct: 90 });
  });

  it('бюджет изменили в другой вкладке: нетронутые поля берут новые значения, правленые — с предупреждением', async () => {
    const user = userEvent.setup();
    const versions = [adminBudget(), adminBudget({ budget_usd: 132, alert_pct: 70 }), adminBudget({ budget_usd: 140, alert_pct: 90 })];
    let version = 0;
    mockFetch(
      routes({
        'GET /api/admin/ai/budget': () => json(versions[Math.min(version, versions.length - 1)]),
        'PUT /api/admin/ai/limits/2': () => {
          version += 1;
          return json(memberLimit({ id: 2, limit: { monthly_usd: 10, daily_analyses: 3, per_analysis_usd: 1, paused: version % 2 === 1 } }));
        },
      }),
    );
    renderAdmin('/admin/key');
    const field = await screen.findByLabelText('Бюджет в месяц, $');
    const save = screen.getByRole('button', { name: 'Сохранить' });
    expect(field).toHaveValue('60');
    // любое действие в разделе перечитывает бюджет: в нем уже $132 и 70% из другой вкладки
    await user.click(screen.getByRole('switch', { name: 'Пауза: Ольга Лехтинен' }));
    await waitFor(() => expect(field).toHaveValue('132'));
    expect(screen.getByRole('button', { name: /^Уведомить при: 70%/ })).toBeInTheDocument();
    expect(save).toBeDisabled();

    // поле правят здесь, а на сервере снова новое: значения не затираются молча
    await user.clear(field);
    await user.type(field, '150');
    await user.click(screen.getByRole('switch', { name: 'Пауза: Ольга Лехтинен' }));
    expect(await screen.findByText('Бюджет уже изменили:')).toBeInTheDocument();
    expect(screen.getByText(/сейчас \$140 в месяц, уведомление при 90%/)).toBeInTheDocument();
    expect(field).toHaveValue('150');
    expect(save).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Взять новые значения' }));
    expect(field).toHaveValue('140');
    expect(screen.getByRole('button', { name: /^Уведомить при: 90%/ })).toBeInTheDocument();
    expect(screen.queryByText('Бюджет уже изменили:')).not.toBeInTheDocument();
    expect(save).toBeDisabled();
  });

  it('окно лимита: быстрые суммы, пояснение, пауза; уходят только измененные поля', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        'PUT /api/admin/ai/limits/2': async (request) => {
          const patch = (await bodyOf(request)) as { monthly_usd?: string; paused?: boolean };
          return json(
            memberLimit({
              limit: { monthly_usd: Number(patch.monthly_usd ?? 10), daily_analyses: 3, per_analysis_usd: 1, paused: Boolean(patch.paused) },
            }),
          );
        },
      }),
    );
    renderAdmin('/admin/key');
    await user.click(await screen.findByRole('button', { name: 'Изменить лимит: Ольга Лехтинен' }));
    let dialog = screen.getByRole('dialog', { name: 'Лимит на ключе администратора' });
    expect(within(dialog).getByText('Сегодня 1 анализ, за октябрь — 11. Лимит обнуляется 1-го числа.')).toBeInTheDocument();
    expect(within(dialog).getByText(/Израсходовано за октябрь/)).toHaveTextContent('$1,93 — это 19% нового лимита.');
    expect(within(dialog).getByText(/Сумма личных лимитов станет/)).toHaveTextContent('$18 при общем бюджете $60');
    // без изменений — ничего не отправляется
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await toast('Лимит не изменился')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'PUT')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Изменить лимит: Ольга Лехтинен' }));
    dialog = screen.getByRole('dialog', { name: 'Лимит на ключе администратора' });
    await user.click(within(dialog).getByRole('button', { name: '$15' }));
    expect(within(dialog).getByRole('button', { name: '$15' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByText(/Сумма личных лимитов станет/)).toHaveTextContent('$23 при общем бюджете $60');
    await user.click(within(dialog).getByRole('switch', { name: /Пауза/ }));
    await user.clear(within(dialog).getByLabelText('На один анализ, $'));
    await user.type(within(dialog).getByLabelText('На один анализ, $'), '20');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(within(dialog).getByText('От $0,10 до месячного лимита')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('На один анализ, $'));
    await user.type(within(dialog).getByLabelText('На один анализ, $'), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await toast('Ольга Лехтинен: $15 в месяц · 3 анализа в день · $1 на анализ')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PUT')!)).toEqual({ monthly_usd: '15.00', paused: true });
  });

  it('пауза переключателем в таблице и лимиты по умолчанию в окне', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        'PUT /api/admin/ai/limits/3': () =>
          json(memberLimit({ ...ALEX, limit: { monthly_usd: 8, daily_analyses: 5, per_analysis_usd: 1, paused: true } })),
        'PUT /api/admin/ai/defaults': async (request) => json({ ...(await bodyOf(request) as object), soft_cap_usd: 0.5 }),
      }),
    );
    renderAdmin('/admin/key');
    await user.click(await screen.findByRole('switch', { name: 'Пауза: Алексей Ковалев' }));
    expect(await toast('Алексей Ковалев: анализы на паузе')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.url.endsWith('/limits/3'))!)).toEqual({ paused: true });

    await user.click(screen.getByRole('button', { name: 'Изменить лимиты по умолчанию' }));
    const dialog = screen.getByRole('dialog', { name: 'Лимиты по умолчанию' });
    expect(within(dialog).getByText('Как решено: $10 в месяц · 3 анализа в день · $1 на анализ')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Анализов в день'));
    await user.type(within(dialog).getByLabelText('Анализов в день'), '4');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await toast('Лимиты по умолчанию: $10 в месяц · 4 анализа в день · $1 на анализ')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.url.endsWith('/defaults'))!)).toEqual({
      monthly_usd: '10.00',
      daily_analyses: 4,
      per_analysis_usd: '1.00',
    });
  });

  it('ссылка уведомления #adm-limits прокручивает к лимитам, когда они загрузились', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    mockFetch(routes());
    renderAdmin('/admin/key#adm-limits');
    await screen.findByRole('heading', { name: 'Лимиты участников' });
    await waitFor(() => expect(scroll.mock.contexts.some((el) => (el as Element).id === 'adm-limits')).toBe(true));
    // и подсвечивает тех, кто у порога уведомления (Алексей — 91% при пороге 80%), как в макете
    const alex = screen.getByText('Алексей Ковалев', { selector: '.adm-limits-table *' }).closest('tr')!;
    const olga = screen.getByText('Ольга Лехтинен', { selector: '.adm-limits-table *' }).closest('tr')!;
    await waitFor(() => expect(alex).toHaveClass('adm-flash'));
    expect(olga).not.toHaveClass('adm-flash');
  });

  it('без #adm-limits строки у порога не подсвечиваются', async () => {
    mockFetch(routes());
    renderAdmin('/admin/key');
    const alex = (await screen.findByText('Алексей Ковалев', { selector: '.adm-limits-table *' })).closest('tr')!;
    expect(alex).not.toHaveClass('adm-flash');
  });

  it('на телефоне — карточки лимитов с паузой, без таблицы', async () => {
    setViewportWidth(375);
    mockFetch(routes());
    renderAdmin('/admin/key');
    const card = await screen.findByRole('region', { name: 'Ольга Лехтинен' });
    expect(within(card).getByText('3 анализа')).toBeInTheDocument();
    expect(within(card).getByRole('switch', { name: 'Пауза: Ольга Лехтинен' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Дмитрий Шульц' })).toHaveTextContent(
      'Лимит трат — в его консоли Anthropic. Потолок на анализ — $1, его задает участник',
    );
  });
});

describe('Администрирование: меню участника — лимит и возврат ключа', () => {
  async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(await screen.findByRole('button', { name: `Действия: ${name}` }));
    return screen.getByRole('menu');
  }

  it('просьба вернуть ключ: метка в таблице, «Разрешить» с лимитом', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes({
        'POST /api/admin/users/5/ai-mode': () => json(memberLimit({ ...DMITRY, ai_mode: 'shared', return_requested_at: null })),
      }),
    );
    renderAdmin('/admin/users');
    const row = (await screen.findByText('Дмитрий Шульц', { selector: '.adm-users-table *' })).closest('tr')!;
    expect(await within(row).findByText('просит вернуть')).toBeInTheDocument();
    const menu = await openMenu(user, 'Дмитрий Шульц');
    expect(within(menu).getByRole('menuitem', { name: /Потолок \$1 на анализ/ })).toBeDisabled();
    await user.click(within(menu).getByRole('menuitem', { name: /Разрешить вернуть ключ администратора/ }));
    const dialog = screen.getByRole('dialog', { name: 'Вернуть на ключ администратора' });
    expect(within(dialog).getByText(/Его ключ sk-ant-…7Qx2 отключится и удалится с сервера/)).toBeInTheDocument();
    expect(within(dialog).getByText('По умолчанию для новых участников: $10 в месяц · 3 анализа в день · $1 на анализ.')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('В месяц, $'));
    await user.type(within(dialog).getByLabelText('В месяц, $'), '12');
    await user.click(within(dialog).getByRole('button', { name: 'Разрешить' }));
    expect(await toast('Дмитрий Шульц снова на ключе администратора. Он увидит уведомление')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'POST' && r.url.endsWith('/ai-mode'))!)).toEqual({
      decision: 'approve',
      limit: { monthly_usd: '12.00', daily_analyses: 3, per_analysis_usd: '1.00' },
    });
  });

  it('«Отклонить просьбу» и «Изменить лимит» из меню', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes({ 'POST /api/admin/users/5/ai-mode': () => json(DMITRY) }));
    renderAdmin('/admin/users');
    let menu = await openMenu(user, 'Дмитрий Шульц');
    await user.click(within(menu).getByRole('menuitem', { name: /Отклонить просьбу/ }));
    const dialog = screen.getByRole('dialog', { name: 'Отклонить просьбу' });
    await user.click(within(dialog).getByRole('button', { name: 'Отклонить' }));
    expect(await toast('Просьба отклонена. Дмитрий Шульц остается на своем ключе')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'POST')!)).toEqual({ decision: 'reject', limit: null });

    menu = await openMenu(user, 'Ольга Лехтинен');
    expect(within(menu).queryByRole('menuitem', { name: /Разрешить вернуть/ })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: /Изменить лимит/ }));
    expect(screen.getByRole('dialog', { name: 'Лимит на ключе администратора' })).toBeInTheDocument();
  });

  it('у себя (администратора) пунктов лимита нет; порог полосы участников — из настроек', async () => {
    const user = userEvent.setup();
    mockFetch(routes({ 'GET /api/admin/ai/budget': () => json(adminBudget({ alert_pct: 70 })) }));
    renderAdmin('/admin/users');
    const row = (await screen.findByText('Алексей Ковалев', { selector: '.adm-users-table *' })).closest('tr')!;
    // $7,28 из $10 = 73%: при пороге 70% — желтый
    await waitFor(() => expect(within(row).getByText('73%')).toHaveClass('warn-text'));
    const menu = await openMenu(user, 'Роман Буров');
    expect(within(menu).queryByRole('menuitem', { name: /Изменить лимит/ })).not.toBeInTheDocument();
  });

  it('приглашение: лимит по умолчанию — из настроек администратора', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        'GET /api/admin/ai/limits': () =>
          json({ defaults: { ...LIMIT_DEFAULTS, monthly_usd: 12, per_analysis_usd: 0.5 }, members: MEMBERS }),
      }),
    );
    renderAdmin('/admin/users');
    await screen.findByText('Ольга Лехтинен', { selector: '.adm-users-table *' });
    await user.click(screen.getByRole('button', { name: 'Пригласить' }));
    const dialog = screen.getByRole('dialog', { name: 'Пригласить в AI Capper' });
    expect(within(dialog).getByLabelText('В месяц, $')).toHaveValue('12');
    expect(within(dialog).getByLabelText('На один анализ, $')).toHaveValue('0,50');
    expect(within(dialog).getByText(/По умолчанию для новых участников: \$12 в месяц/)).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/Свой ключ/));
    expect(within(dialog).getByText(/по умолчанию \$0,50/)).toBeInTheDocument();
  });
});
