import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { aiBudget } from '../../features/ai/testData';
import { bankOut, strategyV3 } from '../../features/analysis/testData';
import { seriesOut } from '../../features/analytics/testData';
import type { Dashboard } from '../../features/dashboard/types';
import { adminAttention, aiUsageOut, dashboardOut, myMatch, openBetOut } from '../../features/dashboard/testData';
import { json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import type { Me } from '../../test/factories';
import { renderPage } from '../../test/renderPage';
import { DashboardPage } from './DashboardPage';

const STUBS = {
  '/bets': 'Экран ставок',
  '/analysis/:id': 'Экран анализа',
  '/players/:id': 'Карточка игрока',
  '/new': 'Новый анализ',
  '/profile/:tab?': 'Личный кабинет',
  '/admin/:tab?': 'Администрирование',
  '/costs': 'ИИ и расходы',
  '/analytics': 'Аналитика',
};

function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

function api(data: Dashboard = dashboardOut(), over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/dashboard': () => json(data),
    'GET /api/me/bank': () => json(data.bank),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/ai/usage': () => json(aiUsageOut()),
    ...over,
  };
}

function renderDashboard(options: { data?: Dashboard; over?: Record<string, Handler>; me?: Me; width?: number } = {}) {
  return renderPage(<DashboardPage />, {
    path: '/',
    api: api(options.data, options.over),
    stubs: STUBS,
    ...(options.me ? { me: options.me } : {}),
    ...(options.width ? { width: options.width } : {}),
  });
}

afterEach(() => window.sessionStorage.clear());

describe('Главная', () => {
  it('приветствие, банк, плитки с изменением к прошлому периоду и пояснение', async () => {
    const { calls } = renderDashboard();
    expect(await screen.findByRole('heading', { level: 2, name: 'Доброе утро, Анна' })).toBeInTheDocument();
    expect(screen.getByText('13 октября, вторник · 1 ставка в игре, 1 мой матч сегодня')).toBeInTheDocument();
    expect(query(calls.find((r) => r.url.includes('/api/dashboard'))!).get('period')).toBe('30d');

    const hero = screen.getByRole('region', { name: 'Банк' });
    expect(within(hero).getByText('50 860 ₽')).toBeInTheDocument();
    expect(within(hero).getByText('+2 860 ₽ · +6,0%')).toBeInTheDocument();
    expect(within(hero).getByText('48 000 ₽')).toBeInTheDocument();
    expect(within(hero).getByText('1 ставка')).toBeInTheDocument();
    expect(within(hero).getByText('−0,7%')).toBeInTheDocument();
    expect(within(hero).getByText('пик 51 200 ₽')).toBeInTheDocument();

    expect(screen.getByText('+5,5%')).toBeInTheDocument();
    expect(screen.getByText('+2,1 п.п.')).toBeInTheDocument();
    expect(screen.getAllByText('к пред. 30 дням').length).toBeGreaterThan(0);
    expect(screen.getByText('62,5%')).toBeInTheDocument();
    expect(screen.getByText('25 В · 15 П · 2 возвр.')).toBeInTheDocument();
    expect(screen.getByText('лучше закрытия в 24 из 34')).toBeInTheDocument();
    expect(screen.getByText('0,214')).toBeInTheDocument();
    expect(screen.getByText('−0,006 к рынку')).toBeInTheDocument();
    expect(screen.getByText(/^CLV — ваш кэф ÷ закрывающий − 1/)).toBeInTheDocument();
    // малой выборки нет — предупреждения нет
    expect(screen.queryByText(/всего .* ставк/)).toBeNull();
  });

  it('без прошлого периода — без стрелки, малая выборка — предупреждение', async () => {
    renderDashboard({ data: dashboardOut({ change: null, prev: null, small_sample: true, kpi: { ...dashboardOut().kpi, settled: 6 } }) });
    expect(await screen.findByText('оборот 52 000 ₽')).toBeInTheDocument();
    expect(screen.queryByText('+2,1 п.п.')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('За 30 дней — всего 6 ставок. На такой выборке ROI, винрейт и Brier сильно скачут');
  });

  it('период: 7 дней — новый запрос, выбор помнится до конца сеанса; «Все» — с первого дня', async () => {
    const all = dashboardOut({ period: 'all', date_from: null, change: null, prev: null });
    const { user, calls } = renderDashboard({
      over: { 'GET /api/dashboard': (r) => json(query(r).get('period') === 'all' ? all : dashboardOut({ period: (query(r).get('period') ?? '30d') as Dashboard['period'] })) },
    });
    await screen.findByRole('heading', { level: 2, name: 'Доброе утро, Анна' });
    await user.click(screen.getByRole('button', { name: '7 дней' }));
    await waitFor(() => expect(calls.some((r) => r.url.includes('/api/dashboard') && query(r).get('period') === '7d')).toBe(true));
    expect(window.sessionStorage.getItem('capper.dash.period')).toBe('7d');
    await user.click(screen.getByRole('button', { name: 'Все' }));
    expect(await screen.findByText('С 13 сен, в рублях')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Банк по дням с 13 сен: с 48\s000\s₽ до 50\s860\s₽$/ })).toBeInTheDocument();
    // у «всего времени» прошлого периода нет — у ROI оборот вместо изменения
    expect(screen.getByText('оборот 52 000 ₽')).toBeInTheDocument();
  });

  it('банк появился внутри периода: без нулевых дней, старт — стартовый банк, процент — рост с сервера', async () => {
    // Пополнение 20 000 ₽ 23 сентября, за период +300 ₽: на конец 23 сен банк 20 350 ₽
    const base = dashboardOut();
    const data = dashboardOut({
      kpi: { ...base.kpi, settled: 3, won: 2, lost: 1, void: 0, profit: '300.00', turnover: '3000.00' },
      small_sample: true,
      series: seriesOut({
        group: 'week',
        start: '2026-09-13',
        base: '0.00',
        last: '20300.00',
        peak: '20350.00',
        best: '20350.00',
        worst: '0.00',
        max_drawdown: -0.0025,
        // старт периода и ряд без дней до банка — с сервера (SeriesOut.start_*)
        start_day: '2026-09-23',
        start_amount: '20000.00',
        change_share: 0.015,
        points: [
          { day: '2026-09-23', value: '20350.00' },
          { day: '2026-10-13', value: '20300.00' },
        ],
      }),
      bank: bankOut({ equity: '20300.00', balance: '20300.00', peak: '20350.00', drawdown: '0.0025', invested: '20000.00', growth: '0.0150' }),
    });
    renderDashboard({ data });
    const hero = await screen.findByRole('region', { name: 'Банк' });
    expect(within(hero).getByText('+300 ₽ · +1,5%')).toBeInTheDocument();
    const start = within(hero).getByText('Старт периода').nextSibling as HTMLElement;
    expect(start).toHaveTextContent(/^20\s000\s₽23 сен$/);
    expect(within(hero).queryByText('0 ₽')).toBeNull();

    expect(screen.getByText('Банк на начало периода · 20 000 ₽')).toBeInTheDocument();
    const chart = screen.getByRole('img', { name: /^Банк по дням за 30 дней: с 20\s000\s₽ до 20\s300\s₽$/ });
    // дней без банка на графике нет: первая подпись — день пополнения, ось не уходит ниже нуля
    expect(chart.querySelector('text.x-label')).toHaveTextContent('23 сен');
    const ticks = [...chart.querySelectorAll('g:not(.ref-line) > text')].map((node) => node.textContent ?? '');
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.some((tick) => tick.startsWith('−') || tick === '0')).toBe(false);
  });

  it('«Все время»: старт — стартовый банк, а не банк на конец первого дня', async () => {
    const base = dashboardOut();
    const data = dashboardOut({
      period: 'all',
      date_from: null,
      change: null,
      prev: null,
      kpi: { ...base.kpi, settled: 1, won: 1, lost: 0, void: 0, profit: '1168.20', turnover: '1320.00' },
      series: seriesOut({ group: 'week', start: '2026-10-13', base: '49168.20', start_day: '2026-10-13', start_amount: '48000.00', change_share: 0.0243, last: '49168.20', points: [{ day: '2026-10-13', value: '49168.20' }] }),
      bank: bankOut({ equity: '49168.20', balance: '49168.20', peak: '49168.20', invested: '48000.00', growth: '0.0243' }),
    });
    window.sessionStorage.setItem('capper.dash.period', 'all');
    renderDashboard({ data });
    const hero = await screen.findByRole('region', { name: 'Банк' });
    expect(within(hero).getByText('+1 168 ₽ · +2,4%')).toBeInTheDocument();
    expect(within(hero).getByText('Старт периода').nextSibling).toHaveTextContent(/^48\s000\s₽13 окт$/);
    // один день банка — точка с подписью, а не пустая полоса
    const one = within(hero).getByText('Ряд по дням появится со второго дня').parentElement!;
    expect(one.querySelector('svg circle')).not.toBeNull();
    expect(screen.getByText('Банк на начало периода · 48 000 ₽')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Банк по дням с 13 окт: с 48\s000\s₽ до 49\s168\s₽$/ })).toBeInTheDocument();
  });

  it('открытые ставки: вероятность модели и по кэфу, «Внести результат» — окно на «Ставках»', async () => {
    const { user, router } = renderDashboard();
    const card = await screen.findByRole('article', { name: 'Ставка №7' });
    expect(within(card).getByText('Экспресс из 2 событий')).toBeInTheDocument();
    expect(within(card).getByText('№7 · Fonbet · Shanghai Masters')).toBeInTheDocument();
    expect(within(card).getByText('модель 81% · по кэфу 77%')).toBeInTheDocument();
    expect(within(card).getByText('2 488 ₽')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Синнер' })).toHaveAttribute('href', '/players/1');
    const settle = within(card).getByRole('link', { name: 'Внести результат ставки №7' });
    expect(settle).toHaveAttribute('href', '/bets?bet=7');
    await user.click(settle);
    expect(await screen.findByText('Экран ставок')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?bet=7');
  });

  it('мои матчи сегодня: время по поясу, место по Эло, ставка и анализ', async () => {
    const data = dashboardOut({
      my_matches: [myMatch(), myMatch({ match_id: 102, scheduled_at: null, bets: [], analyses: [140, 143], rank1: null, round: 'QF', tournament: null })],
    });
    renderDashboard({ data });
    const card = (await screen.findByText('Мои матчи сегодня')).closest('section')!;
    expect(within(card).getByText('1 в ставках · 1 в анализах · время по Хельсинки')).toBeInTheDocument();
    const first = within(card).getByRole('article', { name: 'Синнер — Руне, 14:30' });
    expect(within(first).getByText('Shanghai Masters, 1/8 финала')).toBeInTheDocument();
    expect(within(first).getByText('№2')).toBeInTheDocument();
    expect(within(first).getByText('В ставке №7 · П1 1.30')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Открыть ставку №7' })).toHaveAttribute('href', '/bets?bet=7');
    const second = within(card).getByRole('article', { name: 'Синнер — Руне' });
    // без времени начала — «сегодня», как у ноги в «Открытых ставках», а не прочерк
    expect(within(second).getByText('сегодня')).toBeInTheDocument();
    expect(within(second).queryByText('—', { selector: '.dashboard-match-time *' })).toBeNull();
    expect(within(second).getByText('Анализ #A-0140')).toBeInTheDocument();
    expect(within(second).getByText('Анализ #A-0143')).toBeInTheDocument();
    // «Анализ» — последний анализ матча, с самой свежей оценкой
    expect(within(second).getByRole('link', { name: 'Открыть анализ #A-0143' })).toHaveAttribute('href', '/analysis/143');
    expect(within(card).getByRole('link', { name: 'Новый анализ' })).toHaveAttribute('href', '/new');
  });

  it('возврат на главную перечитывает ее: новый анализ сегодняшнего матча виден без перезагрузки', async () => {
    let analyzed = false;
    const { user, router, calls } = renderDashboard({
      data: dashboardOut({ my_matches: [] }),
      over: { 'GET /api/dashboard': () => json(dashboardOut({ my_matches: analyzed ? [myMatch({ bets: [], analyses: [91] })] : [] })) },
    });
    expect(await screen.findByText('Сегодня в ваших ставках и анализах матчей нет.')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Новый анализ' }));
    expect(await screen.findByText('Новый анализ', { selector: 'p' })).toBeInTheDocument();
    // анализ создан и прошел на другом экране; кэш главной свежий (меньше 30 с), но устарел
    analyzed = true;
    await router.navigate('/');
    expect(await screen.findByRole('link', { name: 'Открыть анализ #A-0091' })).toBeInTheDocument();
    expect(calls.filter((r) => r.url.includes('/api/dashboard'))).toHaveLength(2);
  });

  it('пустые состояния: нет открытых ставок и матчей сегодня', async () => {
    renderDashboard({ data: dashboardOut({ open_bets: [], open_count: 0, open_stake: '0.00', my_matches: [] }) });
    expect(await screen.findByText('Открытых ставок нет. Запустите анализ матчей дня — ИИ предложит экспресс.')).toBeInTheDocument();
    expect(screen.getByText('Сегодня в ваших ставках и анализах матчей нет.')).toBeInTheDocument();
    expect(screen.getByText('Из ваших ставок и анализов')).toBeInTheDocument();
    expect(screen.getByText('13 октября, вторник · 0 ставок в игре')).toBeInTheDocument();
  });

  it('«Требует внимания» участника: размер ставки по правилам, выключенный рост — пояснение', async () => {
    renderDashboard();
    const list = await screen.findByRole('list', { name: 'Правила адаптации' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('Просадка от пика −10%ставка не больше 2,5% банкаЖдет условия');
    expect(items[3]).toHaveTextContent('Выключено');
    expect(screen.getByText('Размер ставки: адаптации не действуют')).toBeInTheDocument();
    expect(screen.getByText(/^Банк −0,7% от пика, за 7 дней \+1,0%, к вложенному \+6,0%, винрейт 62,5%\. Сегодня суммы — по таблице стратегии\.$/)).toBeInTheDocument();
    expect(screen.getByText(/«банк \+15% к вложенному и винрейт от 60%» и «итог 7 дней \+10% и лучше»/)).toBeInTheDocument();
    expect(screen.getByText('1 пункт · стратегия')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Правила ставок' })).toHaveAttribute('href', '/profile/bank');
    // дел администратора у участника нет
    expect(screen.queryByText(/Архив матчей/)).toBeNull();
  });

  it('действует правило просадки — предупреждение и «Сейчас …»', async () => {
    const base = dashboardOut();
    const bank = {
      ...base.bank,
      drawdown: '0.1200',
      adaptations: base.bank.adaptations.map((r) => (r.key === 'dd10' ? { ...r, active: true } : r)),
    };
    renderDashboard({ data: dashboardOut({ bank }) });
    expect(await screen.findByText('Размер ставки изменен правилом адаптации')).toBeInTheDocument();
    expect(screen.getByText(/Сейчас ставка не больше 2,5% банка\.$/)).toBeInTheDocument();
    expect(screen.getAllByText('Действует')).toHaveLength(1);
  });

  it('у администратора — архив с окном «Что делать» и дела: просьба ключа, участник у лимита', async () => {
    const { user, calls } = renderDashboard({
      me: ME_ADMIN,
      data: dashboardOut({ admin: adminAttention() }),
      over: {
        'GET /api/ai/budget': () =>
          json(
            aiBudget({
              monthly_usd: null,
              left_usd: null,
              daily_analyses: null,
              spent_usd: 3.1,
              budget: {
                month_start: '2026-10-01T00:00:00Z',
                days_in_month: 31,
                days_left: 18,
                budget_usd: 50,
                spent_usd: 31.2,
                background_usd: 1.4,
                reserved_usd: 0,
                left_usd: 18.8,
                forecast_usd: 72.5,
                members_limits_usd: 30,
                members_usd: 26.7,
                budget_share: 0.624,
                alert_pct: 80,
                eval_budget_usd: 25,
                eval_spent_usd: 4.6,
                forecast_share: 1.45,
                per_day_usd: 2.23,
                can_per_day_usd: 1.04,
                alert_usd: 40,
              },
            }),
          ),
      },
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Доброе утро, Роман' })).toBeInTheDocument();
    expect(screen.getByText('Архив матчей не обновлялся 4 дня')).toBeInTheDocument();
    expect(screen.getByText('Последняя загрузка — 9 окт. Эло и форма игроков — без матчей после этой даты, анализы идут.')).toBeInTheDocument();
    expect(screen.getByText('Администрирование: 2 дела')).toBeInTheDocument();
    expect(screen.getByText('Олег просит вернуть ключ администратора. Анна — уже 85% месячного лимита ($8,50 из $10).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть Администрирование' })).toHaveAttribute('href', '/admin/users');
    expect(screen.getByText('3 пункта · стратегия, архив и администрирование')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Что делать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Архив матчей не обновляется' });
    expect(within(dialog).getByText(/Ночное обновление в 03:30 UTC/)).toHaveTextContent('Последняя успешная загрузка — 9 октября 2026, 03:30 UTC.');
    expect(within(dialog).getByText('bash deploy/local.sh data')).toBeInTheDocument();
    expect(within(dialog).getByText('Архив tennis-data')).toBeInTheDocument();
    expect(within(dialog).getByText(/больше 3 дней/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Понятно' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // расход: бюджет ключа администратора, участники = все − вы − фоновые, проверки отдельно
    const costs = screen.getByText('Расходы ИИ в октябре').closest('section')!;
    expect(within(costs).getByText('$31,20')).toBeInTheDocument();
    expect(within(costs).getByText('62% бюджета')).toBeInTheDocument();
    expect(within(costs).getByText('$3,10')).toBeInTheDocument();
    expect(within(costs).getByText('$26,70')).toBeInTheDocument();
    expect(within(costs).getByText('$1,40')).toBeInTheDocument();
    expect(within(costs).getByText('≈ $72,50')).toBeInTheDocument();
    expect(within(costs).getByText('$4,60 из $25')).toBeInTheDocument();
    expect(within(costs).getByText('62% бюджета')).toHaveClass('chip', 'good');
    // свой расход по задачам администратору на главной не нужен
    expect(calls.some((r) => r.url.includes('/api/ai/usage'))).toBe(false);
  });

  it('окно «Что делать»: архив не загружался ни разу — без «после этой даты»', async () => {
    const archive = { ...adminAttention().archive!, days: null, last_load: null, sources: [{ source: 'sackmann' as const, last_load: null }, { source: 'tennis_data' as const, last_load: '2026-10-10T03:30:00Z' }] };
    const { user } = renderDashboard({ me: ME_ADMIN, data: dashboardOut({ admin: adminAttention({ archive }) }) });
    expect(await screen.findByText('Архив матчей еще не загружался')).toBeInTheDocument();
    expect(screen.getByText(/^Один из архивов не загружался ни разу\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Что делать' }));
    const dialog = await screen.findByRole('dialog', { name: 'Архив матчей не обновляется' });
    expect(within(dialog).getByText('Успешной загрузки всех архивов еще не было.', { exact: false })).toBeInTheDocument();
    expect(within(dialog).getByText('Что устарело').nextElementSibling).toHaveTextContent('Эло, форма и подача игроков — без матчей архивов, которые еще не загружались');
    expect(within(dialog).queryByText(/после этой даты/)).toBeNull();
  });

  it('новая установка: не загружался ни один архив — «Архивы матчей еще не загружались», а не «Один из архивов»', async () => {
    const archive = { ...adminAttention().archive!, days: null, last_load: null, sources: [{ source: 'sackmann' as const, last_load: null }, { source: 'tennis_data' as const, last_load: null }] };
    renderDashboard({ me: ME_ADMIN, data: dashboardOut({ admin: adminAttention({ archive }) }) });
    expect(await screen.findByText(/^Архивы матчей еще не загружались\. Эло и форма игроков могут быть неполными/)).toBeInTheDocument();
    expect(screen.queryByText(/Один из архивов/)).toBeNull();
  });

  it('расходы ИИ участника — строки макета: анализы сегодня, прогноз, из кэша, дороже всего; пауза', async () => {
    renderDashboard({ over: { 'GET /api/ai/budget': () => json(aiBudget({ paused: true })) } });
    const costs = (await screen.findByText('Расходы ИИ в октябре')).closest('section')!;
    await within(costs).findByText('$1,93');
    expect(within(costs).getByText(/из \$10 · осталось \$8,07/)).toBeInTheDocument();
    expect(within(costs).getByText('19% лимита')).toBeInTheDocument();
    expect(within(costs).getByText('Анализы на паузе — решение администратора')).toBeInTheDocument();
    const value = (label: string) => within(costs).getByText(label).nextElementSibling;
    expect(value('Анализов сегодня')).toHaveTextContent('1 из 3');
    expect(await within(costs).findByText('≈ $4,50')).toBe(value('Прогноз на месяц'));
    expect(value('Из кэша')).toHaveTextContent('68% входных токенов');
    expect(value('Дороже всего')).toHaveTextContent('Оценка матча · 74%');
    // строк не из макета нет
    expect(within(costs).queryByText('Анализов за месяц')).toBeNull();
    expect(within(costs).queryByText('Средняя цена анализа')).toBeNull();
  });

  it('расходы ИИ: цвет доли — по порогу уведомления из настроек администратора', async () => {
    const chip = async (spent: number, alert: number) => {
      const view = renderDashboard({ over: { 'GET /api/ai/budget': () => json(aiBudget({ spent_usd: spent, limit_share: spent / 10, left_usd: 10 - spent, alert_pct: alert })) } });
      const costs = (await screen.findByText('Расходы ИИ в октябре')).closest('section')!;
      const pct = `${Math.round(spent * 10)}% лимита`;
      const kind = (await within(costs).findByText(pct)).className;
      const meter = within(costs).getByRole('meter').className;
      view.unmount();
      return { kind, meter };
    };
    // 75% при пороге 80% — еще зеленый (раньше был желтым с 70%)
    expect(await chip(7.5, 80)).toEqual({ kind: 'chip good', meter: 'meter' });
    expect(await chip(8.5, 80)).toEqual({ kind: 'chip warn', meter: 'meter warn' });
    // 95% — желтый, а не красный: красный только с 100%
    expect(await chip(9.5, 80)).toEqual({ kind: 'chip warn', meter: 'meter warn' });
    expect(await chip(10, 80)).toEqual({ kind: 'chip bad', meter: 'meter bad' });
    expect(await chip(6, 50)).toEqual({ kind: 'chip warn', meter: 'meter warn' });
  });

  it('расходы ИИ на своем ключе: расход со своего счета, прогноз, потолок, из кэша', async () => {
    const own = aiBudget({ mode: 'own', key_source: 'own', monthly_usd: null, left_usd: null, spent_usd: 4.2, own_cap_usd: 1.5 });
    renderDashboard({
      over: {
        'GET /api/ai/budget': () => json(own),
        'GET /api/ai/usage': () => json(aiUsageOut({ admin_key_usd: 0, own_key_usd: 4.2, forecast_usd: 10.02 })),
      },
    });
    const costs = (await screen.findByText('Расходы ИИ в октябре')).closest('section')!;
    expect(await within(costs).findByText('Свой ключ · расход с вашего счета Anthropic')).toBeInTheDocument();
    expect(within(costs).getByText('$4,20')).toBeInTheDocument();
    expect(within(costs).getByText('с вашего счета за октябрь')).toBeInTheDocument();
    const value = (label: string) => within(costs).getByText(label).nextElementSibling;
    expect(await within(costs).findByText('≈ $10,02')).toBe(value('Прогноз на месяц'));
    expect(value('Потолок на анализ')).toHaveTextContent('до $1,50');
    expect(value('Из кэша')).toHaveTextContent('68% входных токенов');
    expect(within(costs).queryByText('До перехода')).toBeNull();
    expect(within(costs).getByRole('link', { name: 'Ключ Claude' })).toHaveAttribute('href', '/profile/key');
  });

  it('свой ключ после перехода в этом месяце: «До перехода» вместо прогноза и пояснение', async () => {
    const own = aiBudget({ mode: 'own', key_source: 'own', monthly_usd: null, left_usd: null, spent_usd: 2.1 });
    renderDashboard({
      over: {
        'GET /api/ai/budget': () => json(own),
        'GET /api/ai/usage': () => json(aiUsageOut({ admin_key_usd: 0.84, own_key_usd: 2.1 })),
      },
    });
    const costs = (await screen.findByText('Расходы ИИ в октябре')).closest('section')!;
    expect((await within(costs).findByText('До перехода')).nextElementSibling).toHaveTextContent('$0,84');
    expect(within(costs).queryByText('Прогноз на месяц')).toBeNull();
    expect(within(costs).getByText(/^До перехода на свой ключ анализы шли на ключе администратора — эти \$0,84 в его бюджете\./)).toBeInTheDocument();
  });

  it('«Динамика банка»: таблица последних ставок, строка ведет на ставку, «Все N ставок за период»', async () => {
    const { user, router } = renderDashboard();
    expect(await screen.findByText('За 30 дней, в рублях')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Банк по дням за 30 дней: с 48\s000\s₽ до 50\s860\s₽$/ })).toBeInTheDocument();
    expect(screen.getByText('Макс. просадка').nextSibling).toHaveTextContent('−4,6%');
    await user.click(screen.getByRole('button', { name: 'Показать таблицей' }));
    const table = await screen.findByRole('table', { name: 'Последние рассчитанные ставки' });
    expect(within(table).getByText('+1 168 ₽')).toBeInTheDocument();
    expect(within(table).getByText('50 860 ₽')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Все 42 ставки за период' })).toHaveAttribute('href', '/bets?period=30d&status=settled');
    await user.click(within(table).getByText('+1 168 ₽'));
    expect(await screen.findByText('Экран ставок')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?bet=5');
  });

  it('банка еще нет (новый участник, администратор без ставок): ни нулевого графика, ни «банк на пике»', async () => {
    const base = dashboardOut();
    const zero = { settled: 0, won: 0, lost: 0, void: 0, turnover: '0.00', profit: '0.00', roi: null, winrate: null, clv: null, clv_positive: 0, clv_n: 0, legacy_settled: 0 };
    const data = dashboardOut({
      bank: { ...base.bank, empty: true, equity: '0.00', balance: '0.00', in_play: '0.00', peak: '0.00', drawdown: '0', invested: '0.00', growth: null, week_change: null, winrate: null, settled_bets: 0 },
      kpi: { ...base.kpi, ...zero },
      series: { ...base.series, base: '0.00', last: '0.00', peak: '0.00', best: '0.00', worst: '0.00', max_drawdown: 0, points: [{ day: '2026-10-13', value: '0.00' }], rows: [] },
      recent: [],
      small_sample: true,
      open_bets: [],
      open_count: 0,
      open_stake: '0.00',
      my_matches: [],
      change: null,
      prev: null,
    });
    renderDashboard({ data });
    const hero = await screen.findByRole('region', { name: 'Банк' });
    expect(within(hero).getByText('—')).toBeInTheDocument();
    expect(within(hero).getByText('Банк появится после первой ставки или пополнения.')).toBeInTheDocument();
    expect(within(hero).getByRole('link', { name: 'Банк и стратегия' })).toHaveAttribute('href', '/profile/bank');

    // «Динамика банка» — пустое состояние со ссылкой, без графика, легенды и полосы итогов
    const chart = screen.getByRole('heading', { level: 3, name: 'Динамика банка' }).closest('section')!;
    expect(within(chart).getByText('Банка еще нет: график появится после первой ставки или пополнения.')).toBeInTheDocument();
    expect(within(chart).getByRole('link', { name: 'Банк и стратегия' })).toHaveAttribute('href', '/profile/bank');
    expect(within(chart).queryByRole('img')).toBeNull();
    expect(within(chart).queryByText(/Банк на начало периода/)).toBeNull();
    expect(within(chart).queryByText('Макс. просадка')).toBeNull();

    // «Размер ставки» — не «Банк на пике»
    const rules = screen.getByText('Размер ставки: адаптации не действуют').closest('li')!;
    expect(within(rules).getByText(/^Банка еще нет: суммы ставок посчитаются от банка/)).toBeInTheDocument();
    expect(within(rules).queryByText(/Банк на пике/)).toBeNull();
    expect(within(rules).queryByText(/по таблице стратегии/)).toBeNull();

    // нет рассчитанных ставок — не «всего 0 ставок»
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('За 30 дней рассчитанных ставок нет. ROI, винрейт, CLV и Brier появятся после первых результатов.');
    expect(screen.queryByText(/всего 0 ставок/)).toBeNull();
  });

  it('изменение банка за период — прибыль периода с сервера: пополнения и стартовый банк в него не входят', async () => {
    // Банк 48 000 записан пополнением в этом периоде, две ставки рассчитаны с итогом −152 ₽
    const base = dashboardOut();
    const data = dashboardOut({
      bank: { ...base.bank, equity: '47848.00', peak: '48000.00', drawdown: '0.0032', invested: '48000.00', growth: '-0.0032' },
      kpi: { ...base.kpi, settled: 2, won: 1, lost: 1, void: 0, profit: '-152.00' },
      series: { ...base.series, base: '0.00', start_day: '2026-10-12', start_amount: '48000.00', change_share: -0.0032, last: '47848.00', points: [{ day: '2026-10-12', value: '48000.00' }, { day: '2026-10-13', value: '47848.00' }] },
      small_sample: true,
    });
    renderDashboard({ data });
    const hero = await screen.findByRole('region', { name: 'Банк' });
    expect(within(hero).getByText('47 848 ₽')).toBeInTheDocument();
    // банка на начало периода не было — процент от стартового банка (рост с сервера), а не от нуля
    expect(within(hero).getByText('−152 ₽ · −0,3%')).toBeInTheDocument();
    expect(within(hero).queryByText(/47 848 ₽ ·|\+47 848/)).toBeNull();
    expect(screen.getByText('Прибыль').nextSibling).toHaveTextContent('−152 ₽');
  });

  it('открытые ставки: у сегодняшнего матча — время начала, у остальных — день', async () => {
    // «Сегодня» — день сервера (today = 13 окт), а не часы браузера: у них уже 14 октября
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T09:00:00Z'));
    try {
      const bet = openBetOut();
      const legs = bet.legs.map((leg, i) => ({ ...leg, match: { ...leg.match, id: 101 + i * 50, day: i === 0 ? '2026-10-13' : '2026-10-14' } }));
      const third = { ...legs[1]!, id: 99, match: { ...legs[1]!.match, id: 300, day: '2026-10-13' } };
      renderDashboard({ data: dashboardOut({ open_bets: [{ ...bet, legs: [...legs, third] }], my_matches: [myMatch({ match_id: 101 })] }) });
      const card = await screen.findByRole('article', { name: 'Ставка №7' });
      const times = card.querySelectorAll('.dashboard-leg-time');
      expect([...times].map((el) => el.textContent)).toEqual(['14:30', '14 окт', 'сегодня']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('«Модель учится» — пустое состояние этапа 5 со ссылкой на «Аналитику»', async () => {
    renderDashboard();
    expect(await screen.findByText('Появится на этапе 5')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Аналитика' })).toHaveAttribute('href', '/analytics');
  });

  it('телефон: одна колонка, подпись показателей, последние ставки списком', async () => {
    const { user } = renderDashboard({ width: 375 });
    expect(await screen.findByText('Показатели за 30 дней')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать таблицей' }));
    const list = await screen.findByRole('list', { name: 'Последние рассчитанные ставки' });
    expect(within(list).getAllByRole('link')[0]).toHaveAttribute('href', '/bets?bet=5');
    expect(within(list).getByText('банк 50 860 ₽')).toBeInTheDocument();
  });

  it('ошибка загрузки — текст и «Повторить»', async () => {
    let fail = true;
    const { user } = renderDashboard({
      over: {
        'GET /api/dashboard': () =>
          fail ? json({ error: { code: 'common.internal', message: 'Сервер недоступен' } }, 500) : json(dashboardOut()),
      },
    });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // загрузка закончилась ошибкой — не «Показатели загружаются»
    expect(screen.getByRole('heading', { level: 2, name: 'Главная не загрузилась' })).toBeInTheDocument();
    expect(screen.queryByText('Показатели загружаются')).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Доброе утро, Анна' })).toBeInTheDocument();
  });
});
