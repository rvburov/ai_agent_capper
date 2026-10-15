import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { bankOut } from '../../features/analysis/testData';
import { analyticsOut, brierOut } from '../../features/analytics/testData';
import type { Analytics, Brier } from '../../features/analytics/types';
import { fixClock } from '../../test/clock';
import { json } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { AnalyticsPage } from './AnalyticsPage';

// «Аналитика» этапа 5: «Все мои прогнозы» в калибровке (по умолчанию, блок calibration_all) и
// «Только ноги ставок» (calibration); Brier — переключатель «При прогнозе / Закрытие», главный ряд — по ответу
// сервера.

fixClock('2026-10-15T09:00:00Z');
afterEach(() => window.sessionStorage.clear());

function stage5(brier: Partial<Brier> = {}): Analytics {
  const base = analyticsOut();
  const closing: Brier = {
    ...brierOut(),
    main: 'closing',
    closing_n: 80,
    closing_model: 0.205,
    closing_market: 0.211,
    closing_diff: -0.006,
    closing_diff_ci: { low: -0.014, high: 0.002 },
    closing_noise: true,
    closing_points: [
      { day: '2026-09-25', model: 0.21, market: 0.215 },
      { day: '2026-10-12', model: 0.205, market: 0.211 },
    ],
    closing_windows: 17,
    closing_better: 11,
    ...brier,
  };
  return { ...base, calibration_all: { ...base.calibration, kind: 'all', events: 82 }, brier: closing };
}

function card(title: string): HTMLElement {
  return screen.getByRole('heading', { level: 3, name: title }).closest('section')!;
}

function renderAnalytics(data: Analytics = stage5()) {
  return renderPage(<AnalyticsPage />, {
    path: '/analytics',
    url: '/analytics',
    api: {
      'GET /api/analytics': () => json(data),
      'GET /api/me/bank': () => json(bankOut()),
    },
  });
}

describe('«Аналитика»: точность прогнозов этапа 5', () => {
  it('калибровка: «Все мои прогнозы» по умолчанию, «Только ноги ставок» — второй блок ответа, выбор помнится', async () => {
    const { user, calls } = renderAnalytics();
    const calib = await waitFor(() => card('Калибровка прогнозов'));
    const sample = within(calib).getByRole('group', { name: 'Выборка калибровки' });
    expect(within(sample).getByRole('button', { name: 'Все мои прогнозы · 82' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(calib).getByText('82 события')).toBeInTheDocument();
    expect(within(calib).getByText(/^Все ваши прогнозы с исходом: ноги ставок и матчи из анализов без ставки/)).toBeInTheDocument();
    // события вне корзин 50–95% (outside): чип считает все — пояснение, почему на графике меньше
    expect(within(calib).getByText('Вне графика — 6 событий с прогнозом 95% и выше: диапазоны калибровки — от 50 до 95%.')).toBeInTheDocument();

    await user.click(within(sample).getByRole('button', { name: 'Только ноги ставок' }));
    expect(within(calib).getByText('Итоговая вероятность модели против доли сыгравших событий')).toBeInTheDocument();
    expect(within(calib).getByText('58 событий')).toBeInTheDocument();
    // у ног ставок вероятность бывает и ниже 50% (ставка на аутсайдера)
    expect(within(calib).getByText('Вне графика — 6 событий с прогнозом ниже 50% или от 95%: диапазоны калибровки — от 50 до 95%.')).toBeInTheDocument();
    expect(within(calib).getByRole('button', { name: 'Только ноги ставок' })).toHaveAttribute('aria-pressed', 'true');
    // оба блока — в одном ответе: нового запроса нет
    expect(calls.filter((request) => request.url.includes('/api/analytics'))).toHaveLength(1);
    expect(window.sessionStorage.getItem('capper.analytics.sample')).toBe('legs');
  });

  it('калибровка: все события вне диапазонов — надпись сходится с чипом', async () => {
    const base = stage5();
    const legs = { ...base.calibration, events: 4, outside: 4, bins: [], status: 'empty' as const, worst: null, opposite: null };
    const { user } = renderAnalytics({ ...base, calibration: legs });
    const calib = await waitFor(() => card('Калибровка прогнозов'));
    await user.click(within(calib).getByRole('button', { name: 'Только ноги ставок' }));
    expect(within(calib).getByText('4 события')).toBeInTheDocument();
    expect(within(calib).getByText('Все 4 события — с прогнозом ниже 50% или от 95%, а диапазоны калибровки — от 50 до 95%: на графике показать нечего.')).toBeInTheDocument();
    expect(within(calib).queryByText('Нет событий за период')).toBeNull();
  });

  it('Brier: главный ряд — закрытие по ответу сервера; переключение на рынок при прогнозе', async () => {
    const { user } = renderAnalytics();
    const brier = await waitFor(() => card('Brier: модель против рынка'));
    const refs = within(brier).getByRole('group', { name: 'С каким рынком сравнивать' });
    expect(within(refs).getByRole('button', { name: 'Закрытие · 80' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(brier).getByText(/^Рынок закрытия без маржи: ваши две стороны или кэфы П1\/П2 архива tennis-data \(момент снятия не проверен\)/)).toBeInTheDocument();
    expect(within(brier).getByText('Точнее рынка: 11 из 17')).toBeInTheDocument();
    expect(within(brier).getByText('Рынок закрытия · главный ряд')).toBeInTheDocument();
    expect(within(brier).getByText('модель 0,214 · 64 события')).toBeInTheDocument();

    await user.click(within(refs).getByRole('button', { name: 'При прогнозе · 64' }));
    expect(within(brier).getByText('Точнее рынка: 8 из 12')).toBeInTheDocument();
    // главный ряд — по ответу сервера (закрытие), а не по выбору переключателя
    expect(within(brier).getByText('Рынок закрытия · главный ряд')).toBeInTheDocument();
    expect(within(brier).getByText('Рынок при прогнозе')).toBeInTheDocument();
    expect(within(brier).queryByText('Рынок при прогнозе · главный ряд')).not.toBeInTheDocument();
    expect(within(brier).getByText('модель 0,205 · 80 событий')).toBeInTheDocument();
    expect(within(brier).queryByText(/станет главным/)).not.toBeInTheDocument();
    expect(within(brier).getByText(/^Рынок при прогнозе, без маржи/)).toBeInTheDocument();
  });
});
