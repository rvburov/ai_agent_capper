import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NAV_ITEMS } from '../../app/layout/nav';
import { adminBudget, adminKey, adminUser, auditEntry, LIMIT_DEFAULTS, memberLimit } from '../../features/admin/testData';
import { activityOut, adminAiUsageOut, personUsage } from '../../features/costs/testData';
import type { MemberLimit } from '../../features/admin/types';
import { decisionsOf } from '../../features/admin/useAdminAttention';
import { adminAttention, aiUsageOut } from '../../features/dashboard/testData';
import type { AdminAttention } from '../../features/dashboard/types';
import { apiError, json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { AdminPage } from './AdminPage';
import { keyPeople, ownPeople } from './UsageTab';

const NOW = Date.now();
const later = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const USERS = [
  adminUser({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin', limit: null }),
  adminUser({ id: 2 }),
  adminUser({ id: 3, display_name: 'Игорь Нестеров', email: 'igor@example.com', status: 'blocked' }),
  adminUser({ id: 4, display_name: 'Мария Виртанен', email: 'maria@example.com' }),
  adminUser({ id: 5, display_name: 'Дмитрий Шульц', email: 'dmitry@example.com', ai_mode: 'own' }),
];

// Ольга просит вернуть ключ администратора, Мария израсходовала 85% лимита при пороге 80%
const MEMBERS: MemberLimit[] = [
  memberLimit({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin', limit: null, spent_month_usd: 27.5 }),
  memberLimit({ id: 2, ai_mode: 'own', own_key_last4: 'k3Yz', return_requested_at: ago(2), spent_month_usd: 0 }),
  memberLimit({ id: 4, display_name: 'Мария Виртанен', email: 'maria@example.com', spent_month_usd: 8.5, analyses_today: 2 }),
  memberLimit({ id: 5, display_name: 'Дмитрий Шульц', email: 'dmitry@example.com', ai_mode: 'own', own_key_last4: '7Qx2', own_spent_month_usd: 3.4 }),
];

// Дела решает сервер (GET /api/admin/attention): Ольга просит ключ, Мария — у порога
const ATTENTION = adminAttention({
  return_requests: [{ user_id: 2, name: 'Ольга Лехтинен', at: ago(2) }],
  limits: [{ user_id: 4, name: 'Мария Виртанен', spent_usd: 8.5, limit_usd: 10, share: 0.85, level: '80', runs_out_on: '2026-10-16' }],
});

function attentionRoute(attention: AdminAttention): Handler {
  return () => json(attention);
}

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/admin/attention': attentionRoute(ATTENTION),
    'GET /api/admin/users': () => json(USERS),
    'GET /api/admin/invites': () =>
      json([
        {
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
        },
      ]),
    'GET /api/admin/reset-codes': () =>
      json([
        {
          id: 7,
          user_id: 3,
          user_name: 'Игорь Нестеров',
          user_email: 'igor@example.com',
          created_at: ago(1),
          expires_at: later(23),
          used_at: null,
          revoked_at: null,
          created_by_name: 'Роман Буров',
          status: 'active',
        },
      ]),
    'GET /api/admin/audit': () =>
      json([
        auditEntry({ id: 3, at: ago(1), action: 'limit_change', target_name: 'Мария Виртанен' }),
        auditEntry({ id: 2, at: ago(3), action: 'invite', target_user_id: null, target_name: '', details: { email: 'anna@example.com' } }),
        auditEntry({ id: 1, at: ago(5), actor_id: null, actor_name: '', action: 'import', target_user_id: null, target_name: '', details: { source: 'terminal' } }),
      ]),
    'GET /api/admin/ai/limits': () => json({ defaults: LIMIT_DEFAULTS, members: MEMBERS }),
    'GET /api/admin/ai/budget': () => json(adminBudget()),
    'GET /api/admin/ai/key': () => json(adminKey()),
    'GET /api/admin/ai/usage': () => json(adminAiUsageOut()),
    'GET /api/ai/usage': () => json(aiUsageOut()),
    'GET /api/admin/activity': (request) => json(activityOut({ period: (new URL(request.url).searchParams.get('period') ?? '30d') as '30d' })),
    ...extra,
  };
}

function renderAdmin(path: string, extra: Record<string, Handler> = {}, width?: number) {
  return renderPage(<AdminPage />, {
    path: '/admin/:tab?',
    url: path,
    me: ME_ADMIN,
    api: routes(extra),
    ...(width ? { width } : {}),
    stubs: { '/profile/:tab?': 'Личный кабинет' },
  });
}

const card = (title: string) => screen.getByRole('heading', { name: title }).closest('section')!;

// Даты фикстур — 12–13 октября 2026. «Сегодня», месяц и год в подписях считаются от часов
// браузера: фиксируем их, иначе завтра (1 ноября, 1 января) тесты станут красными
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Администрирование: «Обзор»', () => {
  it('пункт меню «Администрирование» ведет к «Обзору»', () => {
    expect(NAV_ITEMS.admin.to).toBe('/admin');
  });

  it('дела — из ответа сервера: сначала просьба вернуть ключ, затем участники у лимита по доле', () => {
    const items = decisionsOf(ATTENTION, MEMBERS);
    expect(items.map((item) => [item.kind, item.member.id])).toEqual([
      ['return', 2],
      ['limit', 4],
    ]);
    // 88% при пороге 90%, но остатка не хватает на вызов Claude: сервер ставит уровень 100
    const stopped = adminAttention({
      return_requests: [],
      alert_pct: 90,
      limits: [
        { user_id: 4, name: 'Мария Виртанен', spent_usd: 8.5, limit_usd: 10, share: 0.85, level: '80', runs_out_on: '2026-10-16' },
        { user_id: 2, name: 'Ольга Лехтинен', spent_usd: 0.88, limit_usd: 1, share: 0.88, level: '100', runs_out_on: null },
      ],
    });
    expect(decisionsOf(stopped, MEMBERS).map((item) => (item.kind === 'limit' ? [item.member.id, item.level] : null))).toEqual([
      [2, '100'],
      [4, '80'],
    ]);
    // в браузере ничего не досчитывается: дел нет у сервера — нет и здесь
    expect(decisionsOf(adminAttention({ return_requests: [], limits: [] }), [memberLimit({ spent_month_usd: 9.9 })])).toEqual([]);
  });

  it('«Нужно решение»: просьба ключа с «Разрешить», участник у лимита с «Поднять лимит»', async () => {
    const { user } = renderAdmin('/admin');
    const tab = await screen.findByRole('tab', { name: /Обзор/ });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(tab).toHaveTextContent('(нужно решение: 2)'));
    const decisions = card('Нужно решение');
    expect(within(decisions).getByText('Ольга Лехтинен просит вернуть ключ администратора')).toBeInTheDocument();
    expect(within(decisions).getByText(/Сейчас работает на своем ключе sk-ant-…k3Yz/)).toBeInTheDocument();
    expect(within(decisions).getByText('Мария Виртанен — 85% лимита')).toBeInTheDocument();
    expect(within(decisions).getByText(/\$8,50 из \$10 за .+, сегодня 2 из 3 анализов\. При таком темпе лимит закончится 16 окт, и анализы на вашем ключе остановятся\./)).toBeInTheDocument();
    expect(within(decisions).getByRole('button', { name: 'Поднять лимит: Мария Виртанен' })).toBeInTheDocument();
    await user.click(within(decisions).getByRole('button', { name: 'Разрешить: Ольга Лехтинен возвращается на ключ администратора' }));
    expect(await screen.findByRole('dialog', { name: 'Вернуть на ключ администратора' })).toBeInTheDocument();
  });

  it('остатка не хватает на вызов Claude (уровень 100 с сервера) — «анализы остановлены», красным', async () => {
    const stopped = adminAttention({
      return_requests: [],
      alert_pct: 90,
      limits: [{ user_id: 4, name: 'Мария Виртанен', spent_usd: 8.8, limit_usd: 10, share: 0.88, level: '100', runs_out_on: null }],
    });
    const members = MEMBERS.map((m) => (m.id === 4 ? { ...m, spent_month_usd: 8.8 } : m));
    renderAdmin('/admin', { 'GET /api/admin/attention': attentionRoute(stopped), 'GET /api/admin/ai/limits': () => json({ defaults: LIMIT_DEFAULTS, members }) });
    const tab = await screen.findByRole('tab', { name: /Обзор/ });
    await waitFor(() => expect(tab).toHaveTextContent('(нужно решение: 1)'));
    const decisions = card('Нужно решение');
    const row = (await within(decisions).findByText('Мария Виртанен — 88% лимита')).closest('li')!;
    expect(row).toHaveTextContent('Анализы на вашем ключе остановлены.');
    expect(row).not.toHaveTextContent('остановятся');
    expect(row.querySelector('.adm-att-ic')).toHaveClass('bad');
  });

  it('просьб и предупреждений нет — «Все спокойно», без точки у вкладки', async () => {
    renderAdmin('/admin', { 'GET /api/admin/attention': attentionRoute(adminAttention({ return_requests: [], limits: [] })) });
    const decisions = await waitFor(() => card('Нужно решение'));
    expect(await within(decisions).findByText('Все спокойно')).toBeInTheDocument();
    expect(within(decisions).getByText(/подойдет к 80% лимита/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Обзор' })).not.toHaveTextContent('нужно решение');
  });

  it('«Действует сейчас»: код сброса и приглашение, отзыв приглашения — с подтверждением', async () => {
    const { user, calls } = renderAdmin('/admin', { 'DELETE /api/admin/invites/1': () => json({}) });
    const pending = await waitFor(() => card('Действует сейчас'));
    expect(await within(pending).findByText('Код сброса пароля: Игорь Нестеров')).toBeInTheDocument();
    expect(within(pending).getByText('Приглашение ждет регистрации: anna@example.com')).toBeInTheDocument();
    expect(within(pending).getByRole('link', { name: 'Приглашения' })).toHaveAttribute('href', '/admin/invites');
    await user.click(within(pending).getByRole('button', { name: 'Отозвать приглашение для anna@example.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Отозвать приглашение' });
    await user.click(within(dialog).getByRole('button', { name: 'Отозвать' }));
    await waitFor(() => expect(calls.some((request) => request.method === 'DELETE' && new URL(request.url).pathname === '/api/admin/invites/1')).toBe(true));
  });

  it('бюджет ключа: доля с сервера, «Кто тратит» — только расход на ИИ, итог как «Потрачено»', async () => {
    renderAdmin('/admin');
    const budget = await waitFor(() => card('Бюджет ключа администратора'));
    // доля бюджета — один формат в плашке и в итоге «Кто тратит» (formatShare): 68,7% → «69%»
    expect(await within(budget).findAllByText('69% бюджета')).toHaveLength(2);
    const list = await within(budget).findByRole('list', { name: 'Кто тратит ключ администратора' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Роман Буроввы');
    expect(rows[0]).toHaveTextContent('$27,50');
    expect(rows[1]).toHaveTextContent('лимит $10 · израсходовано 86%');
    expect(within(list).getByText('Общие фоновые задачи')).toBeInTheDocument();
    const total = rows[rows.length - 1]!;
    expect(total).toHaveTextContent('Итого с вашего ключа');
    expect(total).toHaveTextContent('$41,20');
    expect(total).toHaveTextContent('69% бюджета');
    expect(total).toHaveTextContent('за 1–13 октября');
    // участник на своем ключе без расхода на ключе администратора в «Кто тратит» не попадает
    expect(within(list).queryByText(/Дмитрий/)).toBeNull();
    expect(list).not.toHaveTextContent('₽');
  });

  it('бюджет и «Кто тратит» — числа сервера: доля прогноза (forecast_share) и «остальные» (others_*)', async () => {
    // пятеро тратили ключ: первые трое строками, двое — «остальными»; сумма остальных — с сервера
    // (нарочно не равна сумме их строк: экран не складывает сам)
    const usage = adminAiUsageOut({
      people: [
        personUsage({ user_id: 1, display_name: 'Роман Буров', role: 'admin', key_spent_usd: 20, limit_usd: null, limit_share: null }),
        personUsage({ user_id: 2, display_name: 'Ольга Лехтинен', key_spent_usd: 8 }),
        personUsage({ user_id: 4, display_name: 'Мария Виртанен', key_spent_usd: 6 }),
        personUsage({ user_id: 6, display_name: 'Анна Корхонен', key_spent_usd: 2 }),
        personUsage({ user_id: 7, display_name: 'Павел Ким', key_spent_usd: 1 }),
      ],
      others_ids: [6, 7],
      others_count: 2,
      others_usd: 3.05,
    });
    renderAdmin('/admin', { 'GET /api/admin/ai/usage': () => json(usage), 'GET /api/admin/ai/budget': () => json(adminBudget({ forecast_share: 1.5 })) });
    const budget = await waitFor(() => card('Бюджет ключа администратора'));
    expect(await within(budget).findByText('150% бюджета')).toBeInTheDocument();
    const list = await within(budget).findByRole('list', { name: 'Кто тратит ключ администратора' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.adm-urow-name')?.textContent)).toEqual([
      'Роман Буроввы',
      'Ольга Лехтинен',
      'Мария Виртанен',
      'Остальные: 2',
      'Общие фоновые задачи',
      'Итого с вашего ключа',
    ]);
    expect(rows[3]).toHaveTextContent('$3,05');
    expect(rows[3]).toHaveTextContent('Анна, Павел');
  });

  it('плитки аккаунтов, ключа и валюты; последние действия со ссылкой на журнал', async () => {
    renderAdmin('/admin');
    const people = await screen.findByRole('region', { name: 'Активных аккаунтов' });
    await waitFor(() => expect(people).toHaveTextContent('4из 5'));
    expect(people).toHaveTextContent('3 на ключе администратора · 1 на своем ключе · 1 заблокирован');
    await waitFor(() => expect(people).toHaveTextContent('Сегодня заходили: 2'));
    const key = screen.getByRole('region', { name: 'Ключ администратора' });
    expect(await within(key).findByText('Работает')).toBeInTheDocument();
    const currency = screen.getByRole('region', { name: 'Валюта программы' });
    expect(await within(currency).findByText('Рубли')).toBeInTheDocument();
    const recent = card('Последние действия');
    expect(await within(recent).findByText('терминал на сервере', { exact: false })).toBeInTheDocument();
    expect(within(recent).getByRole('link', { name: 'Весь журнал' })).toHaveAttribute('href', '/admin/audit');
  });

  it('375 px: обзор без таблиц, кнопки дел на месте', async () => {
    renderAdmin('/admin', {}, 375);
    const decisions = await waitFor(() => card('Нужно решение'));
    expect(await within(decisions).findByRole('button', { name: 'Поднять лимит: Мария Виртанен' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Администрирование: «Расход ИИ»', () => {
  it('люди на ключе и на своем ключе: порядок по расходу', () => {
    const usage = adminAiUsageOut();
    expect(keyPeople(usage.people).map((p) => p.user_id)).toEqual([1, 2, 3]);
    expect(ownPeople(usage.people).map((p) => p.user_id)).toEqual([5]);
  });

  it('плитки, по людям с общими задачами и итогом, по задачам, проверки отдельно', async () => {
    renderAdmin('/admin/usage');
    expect(await screen.findByText('1–13 октября (дни по UTC) · все суммы в долларах, как считает Anthropic')).toBeInTheDocument();
    const spent = screen.getByText('С вашего ключа', { selector: '.stat-label' }).closest('section')!;
    expect(spent).toHaveTextContent('$41,20');
    expect(spent).toHaveTextContent('69% бюджета $60');
    expect(screen.getByText('Анализов на вашем ключе', { selector: '.stat-label' }).closest('section')).toHaveTextContent('≈ $0,31 за анализ');

    const people = card('По людям');
    expect(within(people).getByRole('img', { name: /^Состав расхода: Роман \$27,50, Ольга \$8,60, Игорь \$2,00, Общие задачи \$3,10$/ })).toBeInTheDocument();
    const list = within(people).getByRole('list', { name: 'Расход по людям' });
    expect(within(list).getByText('31 анализ за 1–13 октября · лимит $10', { exact: false })).toBeInTheDocument();
    expect(within(list).getByText(/лимит \$5, пауза/)).toBeInTheDocument();
    expect(within(list).getByText(/Вызовы на вашем ключе без участника — приемка этапа: Оценка матча, Новости/)).toBeInTheDocument();
    expect(within(list).getByText('Итого с вашего ключа')).toBeInTheDocument();

    const tasks = card('По задачам');
    expect(within(tasks).getByRole('list', { name: 'Расход по задачам' })).toHaveTextContent('Оценка матча');
    const table = within(tasks).getByRole('table', { name: 'Задачи и доля кэша' });
    expect(within(table).getByText('Общие фоновые задачи')).toBeInTheDocument();
    expect(within(table).getByText('нет')).toBeInTheDocument();
    // под задачей — понятная подпись модели, effort и «на матч» (WHAT макета), а не ID модели
    expect(await within(table).findByText(/^Opus 5\.5 · effort medium · один вызов на матч · /)).toBeInTheDocument();
    expect(within(table).getByText(/^Sonnet 5\.5 · effort low · 2 поиска на матч · /)).toBeInTheDocument();
    expect(table).not.toHaveTextContent('claude-');
    expect(within(tasks).getByText('Проверки (eval)')).toBeInTheDocument();
    expect(within(tasks).getByText('из $25 бюджета проверок')).toBeInTheDocument();
    expect(within(tasks).getByText(/Прогон на истории сентября — \$4,50\. В общий бюджет \$60 не входит\./)).toBeInTheDocument();

    const own = card('На своем ключе');
    expect(await within(own).findByText('12 анализов · ключ sk-ant-…7Qx2')).toBeInTheDocument();
    expect(within(own).getByText('$3,40')).toBeInTheDocument();
  });

  it('«По людям»: доли в легенде — с сервера (spent_share), а не из сумм в браузере', async () => {
    const base = adminAiUsageOut();
    const usage = adminAiUsageOut({ people: base.people.map((p) => (p.user_id === 1 ? { ...p, spent_share: 0.5 } : p)) });
    renderAdmin('/admin/usage', { 'GET /api/admin/ai/usage': () => json(usage) });
    const people = await waitFor(() => card('По людям'));
    expect(within(people).getByText('Роман 50%')).toBeInTheDocument();
  });

  it('активность: период — в адресе (?period=7d), после перезагрузки тот же', async () => {
    const view = renderAdmin('/admin/usage?period=7d');
    const activity = await waitFor(() => card('Активность'));
    expect(within(activity).getByRole('button', { name: '7 дней' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(view.calls.some((request) => new URL(request.url).searchParams.get('period') === '7d')).toBe(true));
    await view.user.click(within(activity).getByRole('button', { name: '30 дней' }));
    await waitFor(() => expect(view.router.state.location.search).toBe(''));
  });

  it('активность: входы и анализы по людям, период уходит на сервер', async () => {
    const { user, calls, router } = renderAdmin('/admin/usage');
    const activity = await waitFor(() => card('Активность'));
    const list = await within(activity).findByRole('list', { name: 'Активность по людям' });
    expect(within(list).getByText('Игорь Нестеров').closest('li')).toHaveTextContent('2 неудачные попытки');
    expect(activity).toHaveTextContent('Входили: 3');
    await user.click(within(activity).getByRole('button', { name: '7 дней' }));
    await waitFor(() => expect(calls.some((request) => new URL(request.url).pathname === '/api/admin/activity' && new URL(request.url).searchParams.get('period') === '7d')).toBe(true));
    expect(router.state.location.search).toBe('?period=7d');
    // Р14: ни ставок, ни банка участников
    expect(activity).not.toHaveTextContent('₽');
  });

  it('расход не загрузился — ошибка с «Повторить», активность отдельно', { timeout: 15_000 }, async () => {
    renderAdmin('/admin/usage', { 'GET /api/admin/ai/usage': () => apiError(500, 'internal', 'Сервер недоступен') });
    expect(await screen.findByText(/Сервер недоступен/, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Активность' })).toBeInTheDocument();
  });
});
