import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminBudget } from '../../features/admin/testData';
import { aiBudget } from '../../features/ai/testData';
import { adminAiUsageOut, aiRunOut, aiRunsOut, aiUsageFull, NEWS_RUN, personUsage } from '../../features/costs/testData';
import { adminAttention, aiUsageOut } from '../../features/dashboard/testData';
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
      'GET /api/admin/attention': () => json(adminAttention({ return_requests: [], limits: [] })),
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

  it('плитки, расходы по дням с прогнозом, задачи с долей с сервера, версии и «Где экономим»', async () => {
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
    // заглушки этапа 4 сняты
    expect(screen.queryByRole('heading', { name: 'Появится на этапе 5' })).toBeNull();
    const savings = screen.getByRole('heading', { name: 'Где экономим' }).closest('section')!;
    expect(within(savings).getByText('Оценка матча на Sonnet 5.5')).toBeInTheDocument();
    // пары версий с прогонами нет — «До и после» не показывается
    expect(screen.queryByRole('heading', { name: 'До и после' })).toBeNull();
    // разбор ставки — строка настроек агента
    const settings = screen.getByRole('heading', { name: 'Как настроено' }).closest('section')!;
    expect(within(settings).getByText('Разбор ставки')).toBeInTheDocument();
    expect(within(settings).getByText(/Sonnet 5\.5 · effort low · Batch −50%/)).toBeInTheDocument();
  });

  it('этап 5: качество версии — лог-лосс на наборе; «Где экономим» и «До и после» — числа сервера', async () => {
    const versionEvalOut = (over: Record<string, unknown> = {}) => ({
      eval_set_code: 'S-2026-08', runs: 1, run_ids: [11], n: 250, log_loss: 0.612, brier: 0.211, ece: 0.031, format_errors: 0,
      max_tokens: 0, refusals: 0, to_market: null, noise: null, tokens_per_event: 9400, cost_per_event_usd: 0.031, ...over,
    });
    const usage = aiUsageFull({
      versions: [
        {
          kind: 'analysis', prompt_version: 'analysis.v1+lessons_block.v1:abc', runs: 5, cost_usd: 1.43, avg_cost_usd: 0.286, version_code: 'v3',
          quality: { version_id: 1, version_code: 'v3', status: 'active', eval_set_code: 'S-2026-08', n: 250, log_loss: 0.612, brier: 0.211, to_market: null, format_errors: 0 },
        },
        { kind: 'news', prompt_version: 'news-v2', runs: 4, cost_usd: 0.38, avg_cost_usd: 0.095, version_code: null, quality: null },
      ],
      savings: [
        {
          kind: 'version', status: 'waiting', version_id: 2, version_code: 'v4', version_name: 'v4 · сжатое досье', eval_set_code: 'S-2026-08', model: null, cost_change: -0.29, tokens_change: -0.31,
          log_loss: { a: 0.612, b: 0.615, diff: 0.003, low: -0.004, high: 0.008, margin: 0.01, ok: true }, passed: true,
          per_run_usd: null, per_run_without_usd: null, month_usd: null, month_forecast_usd: 1.2,
        },
        {
          kind: 'postmortem_batch', status: 'on', version_id: null, version_code: null, version_name: null, eval_set_code: null, model: 'claude-sonnet-5-5', cost_change: null, tokens_change: null,
          log_loss: null, passed: null, per_run_usd: 0.011, per_run_without_usd: 0.022, month_usd: null, month_forecast_usd: null,
        },
      ],
      before_after: {
        // цена обеих — на одной основе (прогоны на наборе), хотя у v3 есть и живые вызовы
        before: { version_id: 1, code: 'v3', name: 'v3 · основная', status: 'active', prompt_version: 'analysis.v1', eval: versionEvalOut(), live_avg_usd: 0.286, live_runs: 5, price_usd: 0.031 },
        after: {
          version_id: 2, code: 'v4', name: 'v4 · сжатое досье', status: 'candidate', prompt_version: 'analysis.v2',
          eval: versionEvalOut({ log_loss: 0.615, brier: 0.212, tokens_per_event: 6500, cost_per_event_usd: 0.022 }), live_avg_usd: null, live_runs: 0, price_usd: 0.022,
        },
        comparison: null,
        price_source: 'eval',
      },
    });
    renderCosts({ api: { 'GET /api/ai/usage': () => json(usage) } });
    expect(await screen.findByText('лог-лосс 0,612 · v3')).toBeInTheDocument();
    expect(screen.getByText(/замороженном наборе S-2026-08; экономию/)).toBeInTheDocument();
    const savings = screen.getByRole('heading', { name: 'Где экономим' }).closest('section')!;
    expect(within(savings).getByText('Инструкции v4 · сжатое досье')).toBeInTheDocument();
    expect(within(savings).getByText('Ждет решения')).toBeInTheDocument();
    expect(within(savings).getByText(/Токенов на анализ −31%, цена −29%, качество не хуже на наборе S-2026-08 \(ДИ лог-лосса −0,004…\+0,008\)/)).toBeInTheDocument();
    expect(within(savings).getByText('Экономия: ≈ $1,20 в месяц на ваших оценках матча')).toBeInTheDocument();
    expect(within(savings).getByRole('link', { name: 'Сравнение версий' })).toHaveAttribute('href', '/learning/versions');
    expect(within(savings).getByText('Экономия: ≈ $0,01 вместо $0,02 за матч')).toBeInTheDocument();
    const before = screen.getByRole('heading', { name: 'До и после' }).closest('section')!;
    expect(within(before).getByText('v3 (сейчас) против v4 (кандидат) на одних и тех же 250 матчах набора')).toBeInTheDocument();
    const row = within(before).getByText('Токенов на анализ').closest('tr')!;
    expect(row).toHaveTextContent('≈ 9,4 тыс.≈ 6,5 тыс.');
    // цена «до» и «после» — на одной основе сервера (price_source): прогоны на наборе
    expect(within(before).getByText('Цена оценки матча на наборе').closest('tr')).toHaveTextContent('$0,031$0,022');
    expect(within(before).getByText(/цена и токены — по логам прогонов на наборе \(Batch со скидкой, без новостей\)/)).toBeInTheDocument();
  });

  it('«Оценка матча на Sonnet 5.5»: цена проверки и худший случай — model_check сервера; нет — словами', async () => {
    const check = (over: Record<string, unknown> = {}) => ({
      model: 'claude-sonnet-5-5', events: 250, set_frozen: true, estimate_usd: 6.75, estimate_source: 'settings' as const, worst_usd: 13.5, budget_left_usd: 18.16, ...over,
    });
    const first = renderCosts({ api: { 'GET /api/ai/usage': () => json(aiUsageFull({ model_check: check() })) } });
    const savings = (await screen.findByRole('heading', { name: 'Где экономим' })).closest('section')!;
    expect(
      within(savings).getByText(
        'Экономия: проверка ≈ $6,75 из бюджета проверок по ценам модели (250 событий набора, Batch), худший случай $13,50 · остаток бюджета $18,16',
      ),
    ).toBeInTheDocument();
    first.unmount();
    const second = renderCosts({ api: { 'GET /api/ai/usage': () => json(aiUsageFull({ model_check: check({ estimate_source: 'live', estimate_usd: 3.1, set_frozen: false, events: 251 }) })) } });
    const live = (await screen.findByRole('heading', { name: 'Где экономим' })).closest('section')!;
    expect(within(live).getByText(/^Экономия: проверка ≈ \$3,10 из бюджета проверок по прошлым прогонам \(251 событие, набор еще не заморожен, Batch\)/)).toBeInTheDocument();
    second.unmount();
    renderCosts({ api: { 'GET /api/ai/usage': () => json(aiUsageFull({ model_check: null })) } });
    const none = (await screen.findByRole('heading', { name: 'Где экономим' })).closest('section')!;
    expect(within(none).getByText('Экономия: проверка — из бюджета проверок')).toBeInTheDocument();
  });

  it('«До и после»: цена по вашим вызовам (live) — своя подпись; основы нет — строки цены нет', async () => {
    const side = (code: string, price: number | null) => ({
      version_id: code === 'v3' ? 1 : 2, code, name: null, status: code === 'v3' ? ('archived' as const) : ('active' as const), prompt_version: `analysis.${code}`,
      eval: { eval_set_code: 'S-2026-08', runs: 1, run_ids: [11], n: 250, log_loss: 0.61, brier: 0.21, ece: 0.03, format_errors: 0, max_tokens: 0, refusals: 0, to_market: null, noise: null, tokens_per_event: 9400, cost_per_event_usd: 0.03 },
      live_avg_usd: price, live_runs: price === null ? 0 : 4, price_usd: price,
    });
    const pair = (source: 'live' | null) => aiUsageFull({ before_after: { before: side('v3', source ? 0.3 : null), after: side('v4', source ? 0.25 : null), comparison: null, price_source: source } });
    const first = renderCosts({ api: { 'GET /api/ai/usage': () => json(pair('live')) } });
    const card = (await screen.findByRole('heading', { name: 'До и после' })).closest('section')!;
    expect(within(card).getByText('Цена оценки матча, ваши вызовы').closest('tr')).toHaveTextContent('$0,300$0,250');
    expect(within(card).getByText(/цена — ваши вызовы оценки матча за месяц/)).toBeInTheDocument();
    first.unmount();
    renderCosts({ api: { 'GET /api/ai/usage': () => json(pair(null)) } });
    const none = (await screen.findByRole('heading', { name: 'До и после' })).closest('section')!;
    expect(within(none).queryByText(/^Цена оценки матча/)).toBeNull();
    expect(within(none).getByText('Токенов на анализ')).toBeInTheDocument();
  });

  it('администратор: бюджет проверок $30 в первый месяц, дальше $25 — с сервера', async () => {
    const admin = adminAiUsageOut();
    renderCosts({ admin: true, api: { 'GET /api/admin/ai/usage': () => json({ ...admin, eval: { ...admin.eval, budget_usd: 30, first_month: true, next_usd: 25 } }) } });
    expect(await screen.findByText('отдельный бюджет $30 в первый месяц, дальше $25, на вашем ключе, в итог не входят')).toBeInTheDocument();
    expect(screen.getByText('$4,50 из $30')).toBeInTheDocument();
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

  it('администратор: «в день», «можно в день», сумма порога, темп и «остальные» — числа сервера', async () => {
    // нарочно не равны тому, что дало бы деление в браузере (41,20 / 13 дней, 18,80 / 24 дня)
    const budget = aiBudget({ monthly_usd: null, left_usd: null, daily_analyses: null, limit_share: null, per_day_usd: 3.33, budget: adminBudget({ per_day_usd: 4.44, can_per_day_usd: 0.55, alert_usd: 47 }) });
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
    renderCosts({
      admin: true,
      api: {
        'GET /api/ai/budget': () => json(budget),
        'GET /api/ai/usage': () => json(aiUsageFull({ pace_usd: 1.94 })),
        'GET /api/admin/ai/usage': () => json(usage),
      },
    });
    const hero = await screen.findByRole('region', { name: 'Бюджет ключа администратора' });
    expect(within(hero).getByText('$4,44')).toBeInTheDocument();
    expect(within(hero).getByText('$0,55')).toBeInTheDocument();
    expect(within(hero).getByText(/На 80% бюджета \(\$47\) придет уведомление/)).toBeInTheDocument();
    const daily = screen.getByRole('heading', { name: 'Расходы по дням' }).closest('section')!;
    expect(within(daily).getByText('Темп бюджета ключа — $1,94 в день')).toBeInTheDocument();
    expect(within(daily).getByText(/в среднем \$4,44 в день при темпе бюджета \$1,94; из них ваши вызовы и общие задачи — \$3,33\./)).toBeInTheDocument();
    const who = (await screen.findByRole('heading', { name: 'Кто тратит бюджет' })).closest('section')!;
    const rest = await within(who).findByText('Еще 2 человека');
    expect(rest.closest('li')).toHaveTextContent('$3,05');
    expect(within(who).queryByText('Анна Корхонен')).toBeNull();
  });

  it('участник: сумма порога уведомления в правилах — с сервера (alert_usd)', async () => {
    renderCosts({ api: { 'GET /api/ai/budget': () => json(aiBudget({ alert_usd: 7.5 })) } });
    expect(await screen.findByText('80% — $7,50')).toBeInTheDocument();
  });

  it('администратор: уровень лимита «Кто тратит» — с сервера; 100 — «анализы остановлены» красным', async () => {
    const usage = adminAiUsageOut();
    const member = usage.people.find((p) => p.ai_mode === 'shared' && p.limit_usd !== null && p.key_spent_usd > 0)!;
    const attention = adminAttention({ return_requests: [], limits: [{ user_id: member.user_id, name: member.display_name, spent_usd: member.key_spent_usd, limit_usd: member.limit_usd!, share: 0.5, level: '100', runs_out_on: null }] });
    renderCosts({ admin: true, api: { 'GET /api/admin/attention': () => json(attention) } });
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
