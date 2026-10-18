import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { aiBudget } from '../../features/ai/testData';
import { analysisDone, bankOut, strategyV3 } from '../../features/analysis/testData';
import type { Analysis, MarketRow } from '../../features/analysis/types';
import { bookmakersOut } from '../../features/bookmakers/testData';
import { marketsOut } from '../../features/markets/testData';
import { json, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { setViewportWidth } from '../../test/setup';
import { AnalysisPage } from './AnalysisPage';

// Р28: рынки группами с линией и статусом, рынки по геймам без оценки модели, лучший валуй
// среди рынков «для сравнения», своя ставка на тотал геймов.

function row(over: Partial<MarketRow> & Pick<MarketRow, 'market' | 'selection' | 'family'>): MarketRow {
  return {
    prediction_id: null,
    p_base: null,
    p_claude: null,
    p_final: null,
    q_market: 0.5,
    odds: '1.90',
    value: null,
    tier: 'none',
    in_express: false,
    note_key: 'analysis.leg.market_compare',
    suspended: false,
    line: null,
    status: 'compare',
    p_push: 0,
    has_model: true,
    ...over,
  };
}

/** Синнер — Руне: тотал сетов 2.5 (валуй у «больше») и тотал геймов 22 (без модели, целая линия). */
function withMarkets(): Analysis {
  const base = analysisDone();
  const result = base.result!;
  const extra: MarketRow[] = [
    row({ market: 'STOT_2.5', selection: 1, family: 'stot', line: 2.5, prediction_id: 201, p_base: 0.4, p_claude: 0.47, p_final: 0.47, odds: '2.30', value: 0.081, tier: 'small' }),
    row({ market: 'STOT_2.5', selection: 2, family: 'stot', line: 2.5, prediction_id: 202, p_base: 0.6, p_claude: 0.53, p_final: 0.53, odds: '1.60', value: -0.152 }),
    row({ market: 'GTOT_22', selection: 1, family: 'gtot', line: 22, prediction_id: 203, has_model: false, odds: '1.75', note_key: 'analysis.leg.no_model' }),
    row({ market: 'GTOT_22', selection: 2, family: 'gtot', line: 22, prediction_id: 204, has_model: false, odds: '2.05', note_key: 'analysis.leg.no_model' }),
  ];
  return {
    ...base,
    result: { ...result, matches: result.matches.map((m) => (m.match_id === 91 ? { ...m, markets: [...m.markets, ...extra] } : m)) },
  };
}

function open(analysis: Analysis, extra: Record<string, Handler> = {}) {
  return renderPage(<AnalysisPage />, {
    path: '/analysis/:id',
    url: '/analysis/1',
    api: {
      'GET /api/me/bank': () => json(bankOut()),
      'GET /api/me/bookmakers': () => json(['Fonbet']),
      'GET /api/me/bookmakers/list': () => json(bookmakersOut()),
      'GET /api/strategy/active': () => json(strategyV3()),
      'GET /api/ai/budget': () => json(aiBudget()),
      'GET /api/markets': () => json(marketsOut()),
      [`GET /api/analyses/${analysis.id}`]: () => json(analysis),
      ...extra,
    },
    stubs: { '/new': 'Новый анализ', '/bets': 'Ставки' },
  });
}

describe('Анализ: рынки по группам (Р28)', () => {
  it('группы с линией и статусом с сервера; по геймам — «оценка модели — скоро»; целая линия — возврат', async () => {
    open(withMarkets());
    const table = await screen.findByRole('table', { name: /Вероятности и валуй по рынкам: Синнер — Руне/ });
    const groups = within(table).getAllByRole('rowgroup').slice(1);
    const heads = groups.map((g) => within(g).getAllByRole('row')[0]!.textContent);
    expect(heads).toEqual([
      'Победа в матчеидет в экспресс',
      'Тотал сетов 2.5для сравнения · 21 из 150',
      'Тотал геймов 22для сравнения · 160 из 150',
    ]);
    const games = groups[2]!;
    expect(within(games).getByText('Тотал геймов больше 22')).toBeInTheDocument();
    expect(within(games).getByText('больше 22 геймов, ровно 22 — возврат')).toBeInTheDocument();
    expect(within(games).getAllByText('оценка модели — скоро')).toHaveLength(2);
    expect(within(groups[1]!).getAllByText('2.5')).toHaveLength(2);
    expect(within(groups[1]!).getByText('три сета')).toBeInTheDocument();
  });

  it('лучший валуй среди рынков для сравнения — в колонке вариантов, с причиной', async () => {
    open(withMarkets());
    expect(await screen.findByText(/Лучший валуй среди рынков для сравнения — Тотал сетов больше 2.5 \(Синнер — Руне\) @2.30, валуй \+8,1%/)).toBeInTheDocument();
    expect(screen.getByText(/21 из 150 событий/)).toBeInTheDocument();
  });

  it('своя ставка на тотал геймов: оценки модели нет, предупреждение «для сравнения»', async () => {
    const { user } = open(withMarkets());
    await user.click(await screen.findByRole('button', { name: 'В свою ставку: Тотал геймов меньше 22, Синнер — Руне' }));
    const dialog = screen.getByRole('dialog', { name: 'Своя ставка' });
    expect(within(dialog).getByText(/оценки модели по геймам пока нет/)).toBeInTheDocument();
    expect(within(dialog).getByText('рынок для сравнения')).toBeInTheDocument();
    expect(within(dialog).getByText(/рынок на проверке или для сравнения/)).toBeInTheDocument();
  });

  it('на телефоне — карточки по группам с теми же метками', async () => {
    setViewportWidth(375);
    open(withMarkets());
    const group = await screen.findByRole('region', { name: 'Тотал геймов 22' });
    expect(within(group).getByText('для сравнения · 160 из 150')).toBeInTheDocument();
    expect(within(group).getAllByText('оценка модели — скоро')).toHaveLength(2);
  });
});
