import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminBudget } from '../../features/admin/testData';
import { aiBudget } from '../../features/ai/testData';
import { adminAiUsageOut, aiRunOut, aiRunsOut, aiUsageFull, NEWS_RUN } from '../../features/costs/testData';
import { adminAttention, aiUsageOut, dashboardOut } from '../../features/dashboard/testData';
import { apiError, json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { CostsPage } from './CostsPage';

interface Options {
  admin?: boolean;
  width?: number;
  url?: string;
  api?: Record<string, Handler>;
}

function renderCosts({ admin = false, width, url = '/costs', api = {} }: Options = {}) {
  return renderPage(<CostsPage />, {
    path: '/costs',
    url,
    ...(admin ? { me: ME_ADMIN } : {}),
    ...(width ? { width } : {}),
    api: {
      'GET /api/ai/budget': () => json(admin ? aiBudget({ monthly_usd: null, left_usd: null, daily_analyses: null, limit_share: null, budget: adminBudget() }) : aiBudget()),
      'GET /api/ai/usage': () => json(aiUsageFull()),
      'GET /api/ai/runs': () => json(aiRunsOut()),
      'GET /api/admin/ai/usage': () => json(adminAiUsageOut()),
      'GET /api/dashboard': () => json(dashboardOut({ admin: adminAttention({ return_requests: [], limits: [] }) })),
      ...api,
    },
    stubs: { '/analysis/:id': 'Экран анализа', '/admin/:tab?': 'Администрирование', '/profile/:tab?': 'Личный кабинет' },
  });
}

const path = (request: Request) => new URL(request.url).pathname;
const query = (request: Request) => new URL(request.url).searchParams;

// Даты фикстур — 12–13 октября 2026. «Сегодня», месяц и год в подписях считаются от часов
// браузера: фиксируем их, иначе завтра (1 ноября, 1 января) тесты станут красными
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ИИ и расходы', () => {
  it('участник на ключе администратора: лимит, доля с сервера и «хватит на N анализов»', async () => {
    const { calls } = renderCosts();
    expect(await screen.findByRole('heading', { level: 2, name: 'Расходы на Claude в октябре' })).toBeInTheDocument();
    const hero = screen.getByRole('region', { name: 'Ваш лимит на ключе администратора' });
    expect(within(hero).getByText('$1,93')).toBeInTheDocument();
    // доля лимита — limit_share с сервера (0,193), а не деление в браузере
    expect(within(hero).getByText('19% лимита')).toBeInTheDocument();
    expect(within(hero).getByText(/Остатка хватит примерно на 62 анализа по средней цене \$0,13 \(с новостями\)\. Но не больше 3 в день\./)).toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: 'Перейти на свой ключ' })).toHaveAttribute('href', '/profile/key');
    // администраторские данные участнику не запрашиваются (Р14)
    expect(calls.some((request) => path(request).startsWith('/api/admin/'))).toBe(false);
  });

  it('остатка лимита не хватает на вызов Claude (reason_code с сервера) — «анализы остановлены», без «хватит на N»', async () => {
    const blocked = aiBudget({ monthly_usd: 1, spent_usd: 0.88, left_usd: 0.12, limit_share: 0.88, reason_code: 'ai.monthly_limit', reason_params: { limit: '1,00' } });
    renderCosts({ api: { 'GET /api/ai/budget': () => json(blocked) } });
    const hero = await screen.findByRole('region', { name: 'Ваш лимит на ключе администратора' });
    expect(within(hero).getByText('88% лимита').closest('.chip')).toHaveClass('bad');
    expect(within(hero).getByText(/Остатка лимита \(\$0,12\) не хватает на вызов Claude — анализы остановлены/)).toBeInTheDocument();
    expect(within(hero).queryByText(/Остатка хватит/)).toBeNull();
  });

  it('другая причина с сервера (дневной лимит) — текст причины, без «хватит на N»', async () => {
    const daily = aiBudget({ analyses_today: 3, reason_code: 'ai.daily_limit', reason_params: { daily: 3 } });
    renderCosts({ api: { 'GET /api/ai/budget': () => json(daily) } });
    const hero = await screen.findByRole('region', { name: 'Ваш лимит на ключе администратора' });
    expect(within(hero).getByText(/Новые — после полуночи по вашему времени\./)).toBeInTheDocument();
    expect(within(hero).getByText('19% лимита').closest('.chip')).not.toHaveClass('bad');
    expect(within(hero).queryByText(/Остатка хватит/)).toBeNull();
  });

  it('плитки, расходы по дням с прогнозом, задачи с долей с сервера, версии и «Появится на этапе 5»', async () => {
    renderCosts();
    const price = (await screen.findByText('Цена анализа', { selector: '.stat-label' })).closest('section')!;
    expect(price).toHaveTextContent('$0,13');
    const days = screen.getByRole('heading', { name: 'Расходы по дням' }).closest('section')!;
    expect(within(days).getByText(/Прогноз на 31 окт ≈ \$4,50\./)).toBeInTheDocument();
    const types = screen.getByRole('heading', { name: 'На что уходят деньги' }).closest('section')!;
    // доля задачи — UsageKindOut.share
    expect(within(types).getByRole('list', { name: 'Расход по задачам' })).toHaveTextContent('74%');
    expect(screen.getByRole('heading', { name: 'Версии инструкций: цена и качество' })).toBeInTheDocument();
    expect(screen.getByText('analysis-v3')).toBeInTheDocument();
    const later = screen.getByRole('heading', { name: 'Появится на этапе 5' }).closest('section')!;
    expect(within(later).getByText('«Где экономим».')).toBeInTheDocument();
  });

  it('журнал вызовов: строка — вызов с номером в анализе; окно — разбор цены и кто платит', async () => {
    const { user } = renderCosts();
    const table = await screen.findByRole('table', { name: 'Вызовы Claude, сначала новые' });
    const row = within(table).getByText('вызов 3 в анализе').closest('tr')!;
    expect(row).toHaveTextContent('Оценка матча');
    expect(row).toHaveTextContent('$0,100');
    // номер анализа — как на остальных экранах: #A-0042
    expect(within(row).getByRole('link', { name: '#A-0042' })).toHaveAttribute('href', '/analysis/42');
    expect(screen.getByText(/Всего: 2 вызова · \$0,17/)).toBeInTheDocument();

    await user.click(within(row).getByText('Оценка матча'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('$0,100')).toBeInTheDocument();
    expect(within(dialog).getByText('94% входа из кэша')).toBeInTheDocument();
    const parts = within(dialog).getByRole('table', { name: 'Части цены вызова' });
    expect(within(parts).getByText('Чтение из кэша')).toBeInTheDocument();
    expect(within(parts).getByText('$5 / 1M')).toBeInTheDocument();
    expect(within(dialog).getByText('Ключ администратора — входит в ваш лимит ($10 в месяц)')).toBeInTheDocument();
    expect(within(dialog).getByText('medium — средний уровень размышлений')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'К анализу #A-0042' })).toHaveAttribute('href', '/analysis/42');
  });

  it('фильтр журнала — в адресе (?runs=news): после перезагрузки тот же; неизвестное значение — все', async () => {
    const api = { 'GET /api/ai/runs': (request: Request) => json(aiRunsOut(query(request).get('kind') === 'news' ? [NEWS_RUN] : [aiRunOut(), NEWS_RUN])) };
    const view = renderCosts({ url: '/costs?runs=news', api });
    const filter = await screen.findByRole('group', { name: 'Задача' });
    expect(within(filter).getByRole('button', { name: 'Новости' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText(/Новости: 1 вызов · \$0,07/)).toBeInTheDocument();
    await view.user.click(within(filter).getByRole('button', { name: 'Все' }));
    await waitFor(() => expect(view.router.state.location.search).toBe(''));
    view.unmount();
    renderCosts({ url: '/costs?runs=zzz', api });
    expect(within(await screen.findByRole('group', { name: 'Задача' })).getByRole('button', { name: 'Все' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('фильтр журнала уходит на сервер: kind=news', async () => {
    const { user, calls, router } = renderCosts({
      api: { 'GET /api/ai/runs': (request) => json(aiRunsOut(query(request).get('kind') === 'news' ? [NEWS_RUN] : [aiRunOut(), NEWS_RUN])) },
    });
    const filter = await screen.findByRole('group', { name: 'Задача' });
    await user.click(within(filter).getByRole('button', { name: 'Новости' }));
    await waitFor(() => expect(calls.some((request) => path(request) === '/api/ai/runs' && query(request).get('kind') === 'news')).toBe(true));
    expect(await screen.findByText(/Новости: 1 вызов · \$0,07/)).toBeInTheDocument();
    expect(router.state.location.search).toBe('?runs=news');
    // у участника нет фильтра «Приемка»
    expect(within(filter).queryByRole('button', { name: 'Приемка' })).toBeNull();
  });

  it('«Цены моделей» — окно с таблицей цен с сервера', async () => {
    const { user } = renderCosts();
    await user.click(await screen.findByRole('button', { name: 'Цены моделей' }));
    const dialog = await screen.findByRole('dialog', { name: 'Цены моделей' });
    expect(within(dialog).getAllByText(/Opus 5\.5/).length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/Sonnet 5\.5/).length).toBeGreaterThan(0);
  });

  it('расхода еще нет: пустые расходы по дням, задачи и журнал', async () => {
    const empty = aiUsageOut({ totals: { ...aiUsageOut().totals, runs: 0, cost_usd: 0, cache_share: null }, kinds: [], avg_analysis_usd: null, admin_key_avg_usd: null, forecast_usd: 0, analyses_left: null });
    renderCosts({ api: { 'GET /api/ai/usage': () => json(empty), 'GET /api/ai/runs': () => json(aiRunsOut([])) } });
    expect(await screen.findAllByText('В этом месяце вызовов Claude еще не было.')).toHaveLength(2);
    expect(await screen.findByText('Вызовов в этом месяце нет.')).toBeInTheDocument();
    expect(screen.queryByText(/Остатка хватит/)).toBeNull();
    // графика нет — нет и «Как читать» под ним, темпа и прогноза
    const daily = screen.getByRole('heading', { name: 'Расходы по дням' }).closest('section')!;
    expect(within(daily).queryByText(/Как читать/)).toBeNull();
    expect(within(daily).queryByText(/Прогноз на/)).toBeNull();
  });

  it('свой ключ: расход с вашего счета, ключ по маске, без лимита администратора', async () => {
    const own = aiBudget({ mode: 'own', key_source: 'own', monthly_usd: null, left_usd: null, daily_analyses: null, limit_share: null, spent_usd: 4.2, own_cap_usd: 1.5, own_key: { last4: 'm9Tq', verified_at: '2026-10-05T10:00:00Z', last_error: null } });
    renderCosts({ api: { 'GET /api/ai/budget': () => json(own) } });
    const hero = await screen.findByRole('region', { name: 'Свой ключ Claude' });
    expect(within(hero).getByText('$4,20')).toBeInTheDocument();
    expect(within(hero).getByText('с вашего счета')).toBeInTheDocument();
    expect(within(hero).getByText('sk-ant-…m9Tq')).toBeInTheDocument();
    expect(within(hero).queryByText(/лимита/)).toBeNull();
  });

  it('администратор: бюджет ключа с долей с сервера, «Кто тратит» — только расход, фильтр «Приемка»', async () => {
    const { calls } = renderCosts({ admin: true, api: { 'GET /api/ai/usage': () => json(aiUsageFull({ shared_usd: 3.1 })) } });
    const hero = await screen.findByRole('region', { name: 'Бюджет ключа администратора' });
    expect(within(hero).getByText('$41,20')).toBeInTheDocument();
    expect(within(hero).getByText('69% бюджета')).toBeInTheDocument();
    const who = (await screen.findByRole('heading', { name: 'Кто тратит бюджет' })).closest('section')!;
    expect(within(who).getByText('Роман Буров')).toBeInTheDocument();
    expect(within(who).getByText('$27,50')).toBeInTheDocument();
    expect(within(who).getByText('Общие фоновые задачи')).toBeInTheDocument();
    expect(within(who).getByText('$4,50 из $25')).toBeInTheDocument();
    expect(within(who).getByText(/Дмитрий Шульц — на своем ключе/)).toBeInTheDocument();
    // Р14: только доллары расхода на ИИ — ни ставок, ни банков участников в рублях
    expect(who).not.toHaveTextContent('₽');
    expect(within(await screen.findByRole('group', { name: 'Задача' })).getByRole('button', { name: 'Приемка' })).toBeInTheDocument();
    expect(calls.some((request) => path(request) === '/api/admin/ai/usage')).toBe(true);
    // «Лимиты участников» — сразу к таблице лимитов во вкладке «Ключ и бюджет»
    expect(within(hero).getByRole('link', { name: 'Лимиты участников' })).toHaveAttribute('href', '/admin/key#adm-limits');
  });

  it('администратор: уровень лимита «Кто тратит» — с сервера; 100 — «анализы остановлены» красным', async () => {
    const usage = adminAiUsageOut();
    const member = usage.people.find((p) => p.ai_mode === 'shared' && p.limit_usd !== null && p.key_spent_usd > 0)!;
    const attention = adminAttention({ return_requests: [], limits: [{ user_id: member.user_id, name: member.display_name, spent_usd: member.key_spent_usd, limit_usd: member.limit_usd!, share: 0.5, level: '100', runs_out_on: null }] });
    renderCosts({ admin: true, api: { 'GET /api/dashboard': () => json(dashboardOut({ admin: attention })) } });
    const who = (await screen.findByRole('heading', { name: 'Кто тратит бюджет' })).closest('section')!;
    const sub = await within(who).findByText(/анализы остановлены/);
    expect(sub).toHaveClass('bad-text');
  });

  it('администратор: «Кто тратит» не загрузился — ошибка и «Повторить»', async () => {
    let fail = true;
    const { user } = renderCosts({ admin: true, api: { 'GET /api/admin/ai/usage': () => (fail ? apiError(500, 'internal', 'Сервер недоступен') : json(adminAiUsageOut())) } });
    const who = (await screen.findByRole('heading', { name: 'Кто тратит бюджет' })).closest('section')!;
    const alert = await within(who).findByRole('alert');
    expect(alert).toHaveTextContent('Расход по людям не загрузился.');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await within(who).findByText('Роман Буров')).toBeInTheDocument();
  });

  it('расход не загрузился — текст ошибки и «Повторить»', async () => {
    let fail = true;
    const { user } = renderCosts({ api: { 'GET /api/ai/usage': () => (fail ? apiError(500, 'internal', 'Сервер недоступен') : json(aiUsageFull())) } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Расход не загрузился.');
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Расходы на Claude в октябре' })).toBeInTheDocument();
  });

  it('375 px: журнал — список кнопок, нажатие открывает разбор цены', async () => {
    const { user } = renderCosts({ width: 375 });
    const list = await screen.findByRole('list', { name: 'Вызовы Claude, сначала новые' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent('вызов 3 в анализе');
    expect(buttons[0]).toHaveTextContent('#A-0042');
    await user.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Цена вызова');
    // части цены — списком (статья, объем × цена, сумма справа), а не таблицей шире окна
    expect(within(dialog).queryByRole('table')).toBeNull();
    const parts = within(dialog).getByRole('list', { name: 'Части цены вызова' });
    const read = within(parts).getByText('Чтение из кэша').closest('li')!;
    expect(read.querySelector('.s')).toHaveTextContent(/^[\d\s]+ ток\. × \$\S+ \/ 1M$/);
    expect(read.querySelector('.v')).toHaveTextContent(/^\$\d+,\d{4}$/);
  });
});
