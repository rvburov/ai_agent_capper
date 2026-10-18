import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { aiBudget } from '../../features/ai/testData';
import { clearDraft } from '../../features/analysis/draftStore';
import { analysisDraft, analysisRunning, bankOut, listItem, previewOut, strategyV3 } from '../../features/analysis/testData';
import type { Analysis, ConfirmIn } from '../../features/analysis/types';
import { playLimitsOut } from '../../features/bank/testData';
import { marketsOut } from '../../features/markets/testData';
import { json, ME_MEMBER, mockFetch, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { NewAnalysisPage } from './NewAnalysisPage';

// «Новый анализ»: другие рынки и спорная фора (Р28)

function routes(analysis: Analysis, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/settings': () => json({ currency: 'RUB' }),
    'GET /api/me/bank': () => json(bankOut()),
    'GET /api/me/bookmakers': () => json(['Fonbet']),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    'GET /api/markets': () => json(marketsOut()),
    'GET /api/analyses': () => json([listItem({ id: 3 })]),
    'POST /api/analyses': () => json(analysis, 201),
    'POST /api/analyses/6/preview': () => json(previewOut()),
    ...extra,
  };
}

/** Черновик: у первого события тотал геймов 22.5 и спорная «Ф1(-1.5) = 2.05, Ф2(+1.5) = 1.72». */
function draftWithMarkets(): Analysis {
  const analysis = analysisDraft();
  const [first, ...rest] = analysis.draft!.events;
  analysis.draft!.events = [
    {
      ...first!,
      extra: [{ market: 'gtot', line: 22.5, o1: '1.90', o2: '1.90' }],
      disputed: [
        {
          line: -1.5,
          o1: '2.05',
          o2: '1.72',
          hint: { key: 'analysis.draft.hcp_hint.sets', params: { odds: '2.05', ml: '1.30' } },
          sets_ok: true,
        },
      ],
    },
    ...rest,
  ];
  return analysis;
}

afterEach(() => {
  clearDraft();
});

describe('Новый анализ: другие рынки (Р28)', () => {
  it('спорная фора блокирует запуск; «По геймам» — строка форы по геймам; в запуск уходят extra', async () => {
    const user = userEvent.setup();
    const sent: { run: ConfirmIn | null } = { run: null };
    mockFetch(
      routes(draftWithMarkets(), {
        'POST /api/analyses/6/run': async (request) => {
          sent.run = (await request.json()) as ConfirmIn;
          return json(analysisRunning({ id: 6 }), 202);
        },
      }),
    );
    renderPage(<NewAnalysisPage />, { path: '/new', url: '/new', me: ME_MEMBER, stubs: { '/analysis/:id': 'Экран анализа' } });
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Руне');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));

    const question = await screen.findByText(/фора по сетам или по геймам\?/);
    expect(question).toHaveTextContent('«Ф1(−1.5) = 2.05, Ф2(+1.5) = 1.72»');
    expect(screen.getByText(/так бывает у форы по сетам/)).toBeInTheDocument();
    // «Другие рынки» в карточке: тотал геймов со статусом «для сравнения»
    const total = screen.getByRole('group', { name: 'Тотал геймов 22.5' });
    expect(within(total).getByText('для сравнения · 160 из 150')).toBeInTheDocument();
    expect(within(total).getByLabelText(/Кэф Тотал геймов Больше 22.5/)).toHaveValue('1.90');
    await waitFor(() => expect(document.querySelector('.new-reason')).toHaveTextContent('Событие 1: уточните «Ф1(−1.5)»: фора по сетам или по геймам'));
    expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'По геймам' }));
    expect(screen.queryByText(/фора по сетам или по геймам\?/)).toBeNull();
    // у тотала геймов модель не прошла проверку, у форы по геймам модели пока нет (marketsOut)
    expect(within(total).getByText(/Модель не прошла проверку на истории: вероятность не покажем/)).toBeInTheDocument();
    const hcp = screen.getByRole('group', { name: 'Фора по геймам: Синнер −1.5' });
    expect(within(hcp).getByText(/Оценку модели по геймам покажем позже/)).toBeInTheDocument();

    const launch = screen.getByRole('button', { name: 'Запустить анализ' });
    await waitFor(() => expect(launch).toBeEnabled());
    await user.click(launch);
    await waitFor(() => expect(sent.run).not.toBeNull());
    const first = sent.run!.events![0]!;
    expect(first.extra).toEqual([
      { market: 'gtot', line: 22.5, o1: '1.9', o2: '1.9' },
      { market: 'ghcp', line: -1.5, o1: '2.05', o2: '1.72' },
    ]);
    expect(first.disputed).toEqual([]);
  });

  it('«По сетам» — кэфы в поля форы ±1.5', async () => {
    const user = userEvent.setup();
    mockFetch(routes(draftWithMarkets()));
    renderPage(<NewAnalysisPage />, { path: '/new', url: '/new', me: ME_MEMBER });
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Руне');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    await user.click(await screen.findByRole('button', { name: 'По сетам' }));
    await user.click(screen.getAllByRole('button', { name: /^Исправить событие 1/ })[0]!);
    expect(screen.getByLabelText('Кэф Ф1(−1.5), необязательно')).toHaveValue('2.05');
    expect(screen.getByLabelText('Кэф Ф2(+1.5), необязательно')).toHaveValue('1.72');
  });

  it('форма: «Добавить рынок», выбор рынка и линии, четвертная линия — ошибка', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({ ...analysisDraft({ id: 8, input_kind: 'form', input_text: '' }), draft: null }, {
        'POST /api/analyses/8/preview': () => json(previewOut({ events: [] })),
        'GET /api/players': () => json([]),
      }),
    );
    renderPage(<NewAnalysisPage />, { path: '/new', url: '/new', me: ME_MEMBER });
    await user.click(screen.getByRole('tab', { name: 'Заполнить форму' }));
    const panel = screen.getByRole('tabpanel');
    await user.click(within(panel).getByRole('button', { name: 'Добавить событие' }));
    await user.click(await screen.findByRole('button', { name: 'Добавить рынок' }));
    // матч без формата: первый — тотал сетов (фора ±2.5 только до 3 побед)
    const row = screen.getByRole('group', { name: 'Рынок Тотал сетов' });
    await user.click(within(row).getByRole('button', { name: 'Рынок: Тотал сетов' }));
    await user.click(screen.getByRole('option', { name: 'Тотал геймов' }));
    const games = screen.getByRole('group', { name: 'Рынок Тотал геймов' });
    const line = within(games).getByLabelText('Линия');
    expect(line).toHaveValue('22.5');
    await user.clear(line);
    await user.type(line, '22');
    expect(within(games).getByText(/целая линия: ровно 22 — возврат/)).toBeInTheDocument();
    expect(within(games).getByText('Больше 22')).toBeInTheDocument();
    await user.clear(line);
    await user.type(line, '22.25');
    expect(await screen.findByText(/Тотал геймов: линия половинная \(22.5\) или целая \(22\), четвертных нет/)).toBeInTheDocument();
    await user.click(within(games).getByRole('button', { name: 'Убрать рынок' }));
    expect(screen.queryByRole('group', { name: 'Рынок Тотал геймов' })).toBeNull();
  });
});
