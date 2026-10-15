import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { bankOut } from '../../features/analysis/testData';
import { analyticsOut, insightWith, seriesOut, seriesWithFlows } from '../../features/analytics/testData';
import type { Analytics, Series } from '../../features/analytics/types';
import type { Bank } from '../../features/bank/types';
import { fixClock } from '../../test/clock';
import { json, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { AnalyticsPage } from './AnalyticsPage';

const STUBS = { '/bets': 'Экран ставок' };

function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

function renderAnalytics(url = '/analytics', handler: Handler = () => json(analyticsOut()), width?: number, bank: Bank = bankOut()) {
  return renderPage(<AnalyticsPage />, {
    path: '/analytics',
    url,
    api: { 'GET /api/analytics': handler, 'GET /api/me/bank': () => json(bank) },
    stubs: STUBS,
    ...(width ? { width } : {}),
  });
}

function card(title: string): HTMLElement {
  return screen.getByRole('heading', { level: 3, name: title }).closest('section')!;
}

// даты образцов — октябрь 2026 (см. fixClock)
fixClock('2026-10-15T09:00:00Z');

describe('Аналитика', () => {
  it('показатели с ДИ, выборка и пояснения про старый бот и ставки в игре', async () => {
    renderAnalytics();
    const kpis = await screen.findByRole('region', { name: 'Ключевые показатели за все время' });
    expect(within(kpis).getByText('+2 860 ₽')).toBeInTheDocument();
    expect(within(kpis).getByText('оборот 52 000 ₽')).toBeInTheDocument();
    expect(within(kpis).getByText('+5,5%')).toBeInTheDocument();
    expect(within(kpis).getByText('ДИ −8…+16%')).toBeInTheDocument();
    expect(within(kpis).getByText('62,5%')).toBeInTheDocument();
    expect(within(kpis).getByText('ДИ +0,4%…+3,8% · лучше закрытия в 24 из 34')).toBeInTheDocument();
    expect(within(kpis).getByText('−0,006 к рынку')).toBeInTheDocument();
    expect(within(kpis).getByText('рынок при прогнозе 0,220 · в пределах шума')).toBeInTheDocument();
    expect(within(kpis).getByTitle('12 ординаров, 30 экспрессов')).toHaveTextContent('42 / 64');

    const filters = screen.getByRole('region', { name: 'Фильтры: применяются ко всем блокам ниже' });
    expect(within(filters).getByText('42 ставки')).toBeInTheDocument();
    expect(within(filters).getByText('64 события')).toBeInTheDocument();
    expect(within(filters).getByText('из них 3 ставки старого бота — в банке и ROI, но не в CLV, Brier и калибровке')).toBeInTheDocument();
    expect(within(filters).getByText(/^4 события из экспрессов старого бота не считаются/)).toBeInTheDocument();
    expect(within(filters).getByText('2 ставки в игре не учитываются')).toBeInTheDocument();
    // фильтров нет — «Сбросить фильтры» не нужен
    expect(within(filters).queryByRole('button', { name: 'Сбросить фильтры' })).toBeNull();
  });

  it('изменение к прошлому периоду — только когда сервер его дал', async () => {
    const data = analyticsOut({
      period: '30d',
      date_from: '2026-09-14',
      change: { profit: '1500.00', roi: 0.021, winrate: 0.02, clv: -0.004 },
    });
    renderAnalytics('/analytics?period=30d', () => json(data));
    const kpis = await screen.findByRole('region', { name: 'Ключевые показатели за 30 дней' });
    expect(within(kpis).getByText('+1 500 ₽')).toBeInTheDocument();
    expect(within(kpis).getByText('+2,1 п.п.')).toBeInTheDocument();
    expect(within(kpis).getByText('ДИ −8…+16% · к пред. 30 дням')).toBeInTheDocument();
    expect(within(kpis).getByText('−0,4 п.п.')).toBeInTheDocument();
  });

  it('нет интервала (одна ставка): вместо «ДИ —» оборот у ROI и доля у CLV', async () => {
    const base = analyticsOut();
    const data = analyticsOut({ kpi: { ...base.kpi, roi_ci: null, clv_ci: null, clv_positive: 1, clv_n: 1 } });
    renderAnalytics('/analytics', () => json(data));
    const kpis = await screen.findByRole('region', { name: 'Ключевые показатели за все время' });
    expect(within(kpis).getAllByText('оборот 52 000 ₽')).toHaveLength(2);
    expect(within(kpis).getByText('лучше закрытия в 1 из 1')).toBeInTheDocument();
    expect(within(kpis).queryByText(/ДИ —/)).toBeNull();
    const clv = card('Распределение CLV');
    expect(within(clv).queryByText(/в пределах шума/)).toBeNull();
  });

  it('выводы: тексты с числами, основание и действия — калибровка, фильтр среза, объяснение', async () => {
    const { user, router } = renderAnalytics();
    const insights = await screen.findByRole('list', { name: 'Выводы' });
    const items = within(insights).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Внимание: Переоценка фаворитов в диапазоне 70\u2060–\u206075%');
    expect(items[0]).toHaveTextContent('Модель давала в среднем 72%, а сыграло 62% — на 10 п.п. меньше.');
    expect(within(items[0]!).getByText('Основание: 14 событий')).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('Покрытие Грунт: ROI +18,2% — пока не закономерность');
    expect(screen.getByText('Обновлено 12 окт')).toBeInTheDocument();

    await user.click(within(items[1]!).getByRole('button', { name: 'Показать только Грунт' }));
    await waitFor(() => expect(router.state.location.search).toBe('?surface=clay'));
    expect(await screen.findByText('Фильтр: Грунт')).toBeInTheDocument();

    await user.click(within(items[2]!).getByRole('button', { name: 'Что это значит' }));
    const dialog = await screen.findByRole('dialog', { name: 'Brier и CLV простыми словами' });
    expect(within(dialog).getByText('Brier — точность вероятностей')).toBeInTheDocument();
    expect(within(dialog).getByText('Доверительный интервал')).toBeInTheDocument();
  });

  it('вывод «выборка мала»: «Показать за все время» снимает период, «Снять фильтры» — рынок и покрытие', async () => {
    const widen = insightWith('sample', { bets: 5, events: 9, min_events: 30 }, { tone: 'info', basis: 9, action: 'widen' });
    const clear = insightWith('sample', { bets: 5, events: 9, min_events: 30 }, { tone: 'info', basis: 9, action: 'clear' });
    const { user, router } = renderAnalytics('/analytics?period=30d&surface=hard', (r) =>
      json(analyticsOut({ insights: [query(r).has('period') ? widen : clear] })),
    );
    await user.click(await screen.findByRole('button', { name: 'Показать за все время' }));
    await waitFor(() => expect(router.state.location.search).toBe('?surface=hard'));
    await user.click(await screen.findByRole('button', { name: 'Снять фильтры' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('фильтры в адресе и в запросе: исход, покрытие, источник; метки снимают фильтр, сброс', async () => {
    const { user, router, calls } = renderAnalytics();
    await screen.findByRole('list', { name: 'Выводы' });
    await user.click(screen.getByRole('button', { name: 'Рынок: Все рынки' }));
    await user.click(within(screen.getByRole('listbox', { name: 'Рынок' })).getByRole('option', { name: 'Ф2(+1.5)' }));
    await waitFor(() => expect(router.state.location.search).toBe('?market=HCP_%2B1.5&selection=2'));
    await waitFor(() => expect(calls.some((r) => query(r).get('market') === 'HCP_+1.5' && query(r).get('selection') === '2')).toBe(true));

    await user.click(screen.getByRole('button', { name: 'Источник: Все источники' }));
    await user.click(within(screen.getByRole('listbox', { name: 'Источник' })).getByRole('option', { name: 'Старый бот' }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('source')).toBe('legacy'));

    await user.click(screen.getByRole('button', { name: '3 месяца' }));
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('period')).toBe('90d'));
    expect(calls.some((r) => query(r).get('period') === '90d' && query(r).get('source') === 'legacy')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Убрать фильтр: Рынок: Ф2(+1.5)' }));
    await waitFor(() => expect(router.state.location.search).toBe('?period=90d&source=legacy'));
    await user.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('сводка по рынкам: строка ставит фильтр исхода, повторно — снимает; «Все рынки» — тоже', async () => {
    const { user, router } = renderAnalytics();
    const table = await screen.findByRole('table', { name: 'Сводка по рынкам' });
    expect(within(table).getByText('победа игрока 1')).toBeInTheDocument();
    expect(within(table).getByText('игрок 2 — хотя бы сет (два)')).toBeInTheDocument();
    await user.click(within(table).getByRole('row', { name: 'П1. Нажмите, чтобы отфильтровать страницу' }));
    await waitFor(() => expect(router.state.location.search).toBe('?market=ML&selection=1'));
    expect(await screen.findByText('Фильтр: П1 — пересчитаны все блоки')).toBeInTheDocument();
    const row = await within(table).findByRole('row', { name: 'П1, выбран. Нажмите, чтобы снять фильтр' });
    expect(row).toHaveClass('is-active');
    expect(screen.getByText('Выбран П1')).toBeInTheDocument();
    await user.click(row);
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await user.click(within(table).getByRole('row', { name: 'Все рынки. Нажмите, чтобы показать все рынки' }));
    expect(await screen.findByText('Показаны все рынки')).toBeInTheDocument();
  });

  it('банк по дням без фильтров и результат отобранных ставок с фильтром — по series.kind', async () => {
    const result = analyticsOut({
      filtered: true,
      series: seriesOut({ kind: 'result', base: '0.00', last: '860.00', best: '1200.00', worst: '-300.00', points: [{ day: '2026-08-31', value: '0.00', invested: null }, { day: '2026-10-13', value: '860.00', invested: null }] }),
    });
    const { user } = renderAnalytics('/analytics?surface=hard', (r) => json(query(r).has('surface') ? result : analyticsOut()));
    expect(await screen.findByText('Результат отобранных ставок')).toBeInTheDocument();
    expect(screen.getByText('Нарастающим итогом, ₽ · банк целиком виден без фильтров рынка и покрытия')).toBeInTheDocument();
    expect(screen.getByText('Лучшая точка').nextSibling).toHaveTextContent('+1 200 ₽');
    expect(screen.getByText('Худшая точка').nextSibling).toHaveTextContent('−300 ₽');
    await user.click(screen.getByRole('button', { name: 'Убрать фильтр: Покрытие: Хард' }));
    expect(await screen.findByText('Банк по дням')).toBeInTheDocument();
    expect(screen.getByText('За все время, ₽ на конец дня')).toBeInTheDocument();
    expect(screen.getByText('Макс. просадка').nextSibling).toHaveTextContent('−4,6%');
    const series = card('Банк по дням');
    await user.click(within(series).getByRole('button', { name: 'Показать таблицей' }));
    const table = within(series).getByRole('table', { name: 'Банк по дням' });
    expect(within(table).getByText('Сентябрь')).toBeInTheDocument();
    expect(within(table).getByText('Октябрь (по 13 окт)')).toBeInTheDocument();
  });

  it('банк по дням: банк появился внутри периода — без нулевых дней, старт — стартовый банк', async () => {
    const data = analyticsOut({
      period: '30d',
      date_from: '2026-09-14',
      kpi: { ...analyticsOut().kpi, profit: '300.00' },
      series: seriesOut({
        group: 'week',
        start: '2026-09-13',
        base: '0.00',
        last: '20300.00',
        peak: '20350.00',
        best: '20350.00',
        worst: '0.00',
        // старт периода и ряд без дней до банка — с сервера (SeriesOut.start_*)
        start_day: '2026-09-23',
        start_amount: '20000.00',
        change_share: 0.015,
        points: [
          { day: '2026-09-23', value: '20350.00', invested: null },
          { day: '2026-10-13', value: '20300.00', invested: null },
        ],
      }),
    });
    renderAnalytics('/analytics?period=30d', () => json(data), undefined, bankOut({ equity: '20300.00', invested: '20000.00', growth: '0.0150' }));
    const series = await waitFor(() => card('Банк по дням'));
    expect(within(series).getByText('Старт периода').nextSibling).toHaveTextContent(/^20\s000\s₽23 сен$/);
    expect(within(series).getByText('Вложено: старт 20 000 ₽')).toBeInTheDocument();
    const chart = within(series).getByRole('img', { name: /^Банк по дням за 30 дней: с 20\s000\s₽ до 20\s300\s₽$/ });
    expect(chart.querySelector('text.x-label')).toHaveTextContent('23 сен');
    const ticks = [...chart.querySelectorAll('g:not(.ref-line) > text')].map((node) => node.textContent ?? '');
    expect(ticks.some((tick) => tick.startsWith('−') || tick === '0')).toBe(false);
  });

  it('банк по дням с пополнением (В7): ступенька «вложено», отметка, «Пополнения» и просадка без пополнений', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:00:00Z'));
    try {
      const data = analyticsOut({ period: '30d', date_from: '2026-09-14', kpi: { ...analyticsOut().kpi, profit: '10485.00' }, series: seriesWithFlows() });
      renderAnalytics('/analytics?period=30d', () => json(data), 375, bankOut({ equity: '70485.00', invested: '60000.00' }));
      const series = await waitFor(() => card('Банк по дням'));
      expect(within(series).getByText('Вложено: старт 40 000 ₽ и пополнения')).toBeInTheDocument();
      const chart = within(series).getByRole('img', { name: /; \+20\s000\s₽ · пополнение, 14 сен$/ });
      expect(chart.querySelector('.line.thin')?.getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+(H[\d.]+V[\d.]+)+$/);
      expect(chart.querySelector('.ref-line')).toBeNull();
      // на телефоне подпись отметки — без даты
      expect(chart.querySelector('.mark-label')).toHaveTextContent(/^\+20\s000\s₽ · пополнение$/);
      const flows = within(series).getByText('Пополнения').nextSibling as HTMLElement;
      expect(flows).toHaveTextContent(/^\+20\s000\s₽14 сен$/);
      expect(within(series).getByText('Макс. просадка').nextSibling).toHaveTextContent(/от пика, без пополнений$/);
      expect(within(series).queryByText('Пик')).toBeNull();
      expect(within(series).getByText(/ставки в плюсе на любом участке/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('«Пополнения»: вывод и корректировка одного дня — дата один раз', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T06:00:00Z'));
    try {
      const flows: Series['flows'] = [
        { day: '2026-09-14', kind: 'deposit', amount: '20000.00' },
        { day: '2026-10-01', kind: 'withdrawal', amount: '-3000.00' },
        { day: '2026-10-01', kind: 'correction', amount: '150.00' },
      ];
      const data = analyticsOut({ period: '30d', date_from: '2026-09-14', series: { ...seriesWithFlows(), flows, flows_total: '17150.00' } });
      renderAnalytics('/analytics?period=30d', () => json(data), undefined, bankOut({ equity: '70485.00', invested: '57150.00' }));
      const series = await waitFor(() => card('Банк по дням'));
      expect(within(series).getByText('Пополнения').nextSibling).toHaveTextContent(/^\+17\s150\s₽14 сен, 1 окт$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('результат отобранных ставок — без ступеньки и отметок, линия нуля', async () => {
    const data = analyticsOut({ series: seriesOut({ kind: 'result', base: '0.00', start_amount: '0.00', points: [{ day: '2026-10-12', value: '0.00', invested: null }, { day: '2026-10-13', value: '120.00', invested: null }] }) });
    renderAnalytics('/analytics?market=ML', () => json(data));
    const series = await waitFor(() => card('Результат отобранных ставок'));
    const chart = within(series).getByRole('img');
    expect(chart.querySelectorAll('.line')).toHaveLength(1);
    expect(chart.querySelector('.ref-line')).not.toBeNull();
    expect(chart.querySelector('.mark')).toBeNull();
  });

  it('банк по дням за все время: старт — стартовый банк, а не банк на конец первого дня', async () => {
    const data = analyticsOut({
      kpi: { ...analyticsOut().kpi, profit: '1168.20' },
      series: seriesOut({ group: 'week', start: '2026-10-13', base: '49168.20', start_day: '2026-10-13', start_amount: '48000.00', change_share: 0.0243, last: '49168.20', peak: '49168.20', points: [{ day: '2026-10-13', value: '49168.20', invested: null }] }),
    });
    renderAnalytics('/analytics', () => json(data), undefined, bankOut({ equity: '49168.20', invested: '48000.00', growth: '0.0243' }));
    const series = await waitFor(() => card('Банк по дням'));
    // за все время старт — первое пополнение (В7)
    expect(within(series).getByText('Старт периода').nextSibling).toHaveTextContent(/^48\s000\s₽13 окт · первое пополнение$/);
    expect(within(series).getByText('Вложено: старт 48 000 ₽')).toBeInTheDocument();
  });

  it('срезы: «мало данных» по порогу сервера, итоговый кэф с долей стратегии, нет покрытий — сноска', async () => {
    const { user } = renderAnalytics();
    const surfaces = await waitFor(() => card('ROI по покрытиям'));
    expect(within(surfaces).getByRole('list', { name: 'ROI по покрытиям' })).toHaveTextContent('Грунт');
    expect(within(surfaces).getAllByText('мало данных')).toHaveLength(1);
    expect(within(surfaces).getByText('меньше 20 событий — ROI может быть случайным')).toBeInTheDocument();
    expect(within(surfaces).getByText('Трава: событий за период нет')).toBeInTheDocument();
    const totals = card('ROI по итоговому кэфу');
    expect(within(totals).getByText('ставок нет')).toBeInTheDocument();
    expect(within(totals).getByText(/На экспрессы до 1\.70 по таблице стратегии идет самая крупная ставка \(2,75% банка\)/)).toBeInTheDocument();
    expect(within(totals).getByText(/Диапазон 3\.25–4\.10 — только экспресс из 3 событий/)).toBeInTheDocument();
    await user.click(within(totals).getByRole('button', { name: 'Показать таблицей' }));
    const table = within(totals).getByRole('table', { name: 'ROI по итоговому кэфу' });
    expect(within(table).getByText('−1 640 ₽')).toBeInTheDocument();
    expect(within(table).getByText('2,75%')).toBeInTheDocument();
    const odds = card('ROI по кэфу события');
    expect(within(odds).getByText('2.00+')).toBeInTheDocument();
  });

  it('итоговый кэф вне таблицы стратегии — подпись целиком, с переносом, а не «Вне табл…»; «Ср. кэф» не переносится', async () => {
    const base = analyticsOut();
    const outside = { low: null, high: null, stake_pct: null, triple: false, bets: 8, voids: 0, turnover: '8000.00', profit: '1200.00', roi: 0.15, roi_ci: { low: -0.2, high: 0.5 }, small: true };
    renderAnalytics('/analytics', () => json(analyticsOut({ slices: { ...base.slices, totals: [...base.slices.totals, outside] } })));
    const totals = await waitFor(() => card('ROI по итоговому кэфу'));
    const name = within(totals).getByText('Вне таблицы');
    expect(name).toHaveClass('hbar-name', 'analytics-hbar-wrap');
    // у подписей из диапазонов переноса нет
    expect(within(totals).getByText('1.28–1.70')).not.toHaveClass('analytics-hbar-wrap');
    const summary = card('Сводка по рынкам');
    expect(within(summary).getByRole('columnheader', { name: 'Ср.\u00a0кэф' })).toBeInTheDocument();
  });

  it('экспрессы против ординаров (Р21), калибровка с выводом, Brier «точнее рынка X из Y» по всем окнам', async () => {
    renderAnalytics();
    const r21 = await waitFor(() => card('Экспрессы и те же события ординарами'));
    expect(within(r21).getByText('30 экспрессов · 62 события')).toBeInTheDocument();
    expect(within(r21).getByText('+4,5%')).toBeInTheDocument();
    expect(within(r21).getByText('95% ДИ −8…+11 п.п.')).toBeInTheDocument();
    expect(within(r21).getByText('В пределах шума')).toBeInTheDocument();
    expect(within(r21).getByText(/^2 экспресса старого бота не входят в сравнение — ни в экспрессы/)).toBeInTheDocument();

    const calib = card('Калибровка прогнозов');
    // «п.п.» в конце предложения — одна точка (раньше выходило «10 п.п..»)
    expect(within(calib).getByText(/^прогноз 72%/).closest('.callout')).toHaveTextContent(
      /^Диапазон 70–75%: прогноз 72%, сбылось 62% \(14 событий\)\. Модель переоценивает фаворитов на 10 п\.п\.$/,
    );
    expect(within(calib).getByText('Меньше 60 событий: точки калибровки сильно скачут, выводы преждевременны.')).toBeInTheDocument();
    expect(within(calib).getByRole('button', { name: 'Все прогнозы · этап 5' })).toBeDisabled();

    const brier = card('Brier: модель против рынка');
    // окон 12, точек на графике 3 — считаются окна
    expect(within(brier).getByText('Точнее рынка: 8 из 12')).toBeInTheDocument();
    expect(within(brier).getByText(/в пределах шума на 64 событиях\.$/)).toBeInTheDocument();
    expect(within(brier).getByText('модель 0,205 · 12 событий с двумя сторонами')).toBeInTheDocument();
  });

  it('калибровка: с обратным диапазоном — одна точка перед «А в диапазоне»; в норме — «4 п.п.»', async () => {
    const base = analyticsOut();
    const opposite = { low: 0.65, high: 0.7, n: 20, p: 0.62, actual: 0.7, gap: 0.08, direction: 'under' as const };
    const view = renderAnalytics('/analytics', () => json(analyticsOut({ calibration: { ...base.calibration, worst: { ...base.calibration.worst!, gap: 0.26 }, opposite } })));
    const calib = await waitFor(() => card('Калибровка прогнозов'));
    const text = within(calib).getByText(/^прогноз 72%/).closest('.callout')!.textContent;
    expect(text).toContain('Модель переоценивает фаворитов на 26 п.п. А в диапазоне 65–70% — наоборот, недооценивает: 62% против 70%.');
    expect(text).not.toContain('..');
    view.unmount();

    renderAnalytics('/analytics', () => json(analyticsOut({ calibration: { ...base.calibration, status: 'ok', worst: null } })));
    const ok = await waitFor(() => card('Калибровка прогнозов'));
    expect(within(ok).getByText('Во всех диапазонах с 8+ событиями прогноз расходится с фактом меньше чем на 4 п.п. — и вверх, и вниз.')).toBeInTheDocument();
  });

  it('CLV: распределение, средний с ДИ и без маржи; у старого бота — пусто', async () => {
    const { user } = renderAnalytics();
    const clv = await waitFor(() => card('Распределение CLV'));
    expect(within(clv).getByText('Средний +2,1%')).toBeInTheDocument();
    expect(within(clv).getByText('Кэф не хуже закрытия · 26')).toBeInTheDocument();
    expect(within(clv).getByText('Линия ушла против вас · 8')).toBeInTheDocument();
    expect(within(clv).getByText('+0,4%…+3,8% · 34 ставки')).toBeInTheDocument();
    expect(within(clv).getByText('9 событий с двумя сторонами закрытия')).toBeInTheDocument();
    await user.click(within(clv).getByRole('button', { name: 'Показать таблицей' }));
    const table = within(clv).getByRole('table', { name: 'Распределение CLV' });
    expect(within(table).getByText('до −1%')).toBeInTheDocument();
    expect(within(table).getByText('от 0 до +1%')).toBeInTheDocument();
    expect(within(table).getByText('от +1%')).toBeInTheDocument();
  });

  it('старый бот: калибровка по оценке Claude, Brier и CLV не считаются', async () => {
    const legacy = analyticsOut({
      calibration: { kind: 'claude', events: 6, outside: 0, bins: [], status: 'few', worst: null, opposite: null },
      clv: { n: 0, positive: 0, negative: 0, bins: [], fair_mean: null, fair_n: 0 },
    });
    renderAnalytics('/analytics?source=legacy', () => json(legacy));
    expect(await screen.findByText(/^У старого бота по событиям считаются только ординары — за период их 6\./)).toBeInTheDocument();
    expect(screen.getByText(/^У ставок старого бота нет итоговой вероятности модели/)).toBeInTheDocument();
    expect(screen.getByText('У ставок старого бота CLV не считается.')).toBeInTheDocument();
  });

  it('пусто: нового участника ведем на «Ставки», под фильтром — шире период или сброс', async () => {
    const empty = (data: Partial<Analytics> = {}) => analyticsOut({ sample: { ...analyticsOut().sample, bets: 0, events: 0 }, ...data });
    const first = renderAnalytics('/analytics', () => json(empty()));
    expect(await screen.findByText('Рассчитанных ставок пока нет')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть ставки' })).toHaveAttribute('href', '/bets');
    first.unmount();

    const { user, router } = renderAnalytics('/analytics?period=30d&market=ML&selection=1', (r) =>
      json(query(r).has('period') ? empty({ period: '30d' }) : analyticsOut()),
    );
    expect(await screen.findByText('Под фильтр не попало ни одной ставки')).toBeInTheDocument();
    // за все время такие ставки есть — когда последняя и сколько, кнопка «Показать за все время»
    expect(await screen.findByText('За 30 дней таких ставок нет. Последняя была 12 окт, всего за все время — 42 ставки.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать за все время' }));
    await waitFor(() => expect(router.state.location.search).toBe('?market=ML&selection=1'));
    expect(await screen.findByRole('list', { name: 'Выводы' })).toBeInTheDocument();
  });

  it('пусто под фильтром и за все время — без «Показать за все время»: снять фильтры', async () => {
    const empty = (data: Partial<Analytics> = {}) => analyticsOut({ sample: { ...analyticsOut().sample, bets: 0, events: 0, last_day: null }, ...data });
    const { calls } = renderAnalytics('/analytics?period=30d&surface=carpet', (r) => json(empty(query(r).has('period') ? { period: '30d' } : {})));
    expect(await screen.findByText('Под фильтр не попало ни одной ставки')).toBeInTheDocument();
    expect(await screen.findByText('Нет рассчитанных ставок с таким рынком, покрытием и источником. Снимите один из фильтров.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Показать за все время' })).toBeNull();
    // «Сбросить фильтры» — и в фильтрах, и главной кнопкой пустого состояния
    expect(screen.getAllByRole('button', { name: 'Сбросить фильтры' })).toHaveLength(2);
    // проверка «за все время» — тем же запросом, что и экран за все время, с теми же фильтрами
    const ever = calls.find((r) => r.url.includes('/api/analytics') && !query(r).has('period'))!;
    expect(query(ever).getAll('surface')).toEqual(['carpet']);
  });

  it('выгрузка: по умолчанию ставки и события ZIP-архивом, одна часть — CSV, ничего — нельзя', async () => {
    const { user } = renderAnalytics('/analytics?period=30d', () => json(analyticsOut({ period: '30d', date_from: '2026-09-14' })));
    await screen.findByRole('list', { name: 'Выводы' });
    await user.click(screen.getByRole('button', { name: 'Выгрузить CSV' }));
    const dialog = await screen.findByRole('dialog', { name: 'Выгрузить аналитику в CSV' });
    expect(within(dialog).getByText('Будут выгружены данные под текущими фильтрами: за 30 дней, 42 ставки, 64 события.')).toBeInTheDocument();
    const download = () => within(dialog).getByRole('link', { name: 'Скачать CSV' });
    expect(download()).toHaveAttribute('href', '/api/analytics/export.zip?period=30d&part=bets&part=events');
    await user.click(within(dialog).getByRole('checkbox', { name: 'События экспрессов (кэф, закрытие, прогноз модели)' }));
    expect(download()).toHaveAttribute('href', '/api/analytics/export.csv?period=30d&part=bets');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Калибровку и Brier по окнам' }));
    expect(download()).toHaveAttribute('href', '/api/analytics/export.zip?period=30d&part=bets&part=calibration&part=brier');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Ставки с суммами и результатом' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Калибровку и Brier по окнам' }));
    expect(within(dialog).getByRole('button', { name: 'Скачать CSV' })).toBeDisabled();
    expect(within(dialog).getByText('Выберите хотя бы один набор.')).toBeInTheDocument();
  });

  it('телефон: сводка по рынкам — кнопками, таблицы без лишних колонок', async () => {
    const { user, router } = renderAnalytics('/analytics', () => json(analyticsOut()), 375);
    const list = await screen.findByRole('list', { name: 'Сводка по рынкам' });
    await user.click(within(list).getByRole('button', { name: 'Ф2(+1.5). Нажмите, чтобы отфильтровать страницу' }));
    await waitFor(() => expect(router.state.location.search).toBe('?market=HCP_%2B1.5&selection=2'));
    const surfaces = card('ROI по покрытиям');
    await user.click(within(surfaces).getByRole('button', { name: 'Показать таблицей' }));
    const table = within(surfaces).getByRole('table', { name: 'ROI по покрытиям' });
    // сжатый вид: без «Ср. кэф» и отдельных колонок числа событий и ДИ — они под покрытием и ROI
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Покрытие', 'Винрейт', 'ROI · 95% ДИ']);
    const hard = within(table).getAllByRole('row')[1]!;
    expect(within(hard).getByText('48 событий')).toBeInTheDocument();
    expect(within(hard).getByTitle('95% доверительный интервал')).toHaveTextContent('−6…+14%');
    expect(within(hard).getByText('+4,2%')).toBeInTheDocument();
  });

  it('таблица шире своей карточки (две колонки карточек на 1200 px) — сжатый вид, шире — полный', async () => {
    // В jsdom раскладки нет: рамка таблицы — width px, таблица — по 80 px на колонку
    let width = 388;
    const client = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('analytics-tablebox') || this.classList.contains('table-wrap') ? width : 0;
    });
    const scroll = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('table-wrap') ? this.querySelectorAll('th').length * 80 : 0;
    });
    try {
      const { user } = renderAnalytics();
      const totals = await waitFor(() => card('ROI по итоговому кэфу'));
      await user.click(within(totals).getByRole('button', { name: 'Показать таблицей' }));
      const table = within(totals).getByRole('table', { name: 'ROI по итоговому кэфу' });
      expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Кэф', 'Прибыль', 'ROI · 95% ДИ']);
      expect(within(table).getByText('10 ставок')).toBeInTheDocument();
      cleanup();
      // карточка широкая (одна колонка) — полный вид, как в макете
      width = 800;
      const wide = renderAnalytics();
      const totals2 = await waitFor(() => card('ROI по итоговому кэфу'));
      await wide.user.click(within(totals2).getByRole('button', { name: 'Показать таблицей' }));
      const full = within(totals2).getByRole('table', { name: 'ROI по итоговому кэфу' });
      expect(within(full).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Кэф', 'Ставок', 'Ставка', 'Прибыль', 'ROI', '95% ДИ']);
    } finally {
      client.mockRestore();
      scroll.mockRestore();
    }
  });
});
