import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meQueryKey } from '../../api/keys';
import { createQueryClient } from '../../api/queryClient';
import { ToastProvider } from '../../components';
import { aiBudget } from '../../features/ai/testData';
import {
  analysisDone,
  analysisDraft,
  analysisFailed,
  analysisRunning,
  bankOut,
  progressEvent,
  strategyV3,
} from '../../features/analysis/testData';
import type { Analysis } from '../../features/analysis/types';
import { setEventSourceFactory } from '../../features/analysis/useAnalysisEvents';
import { CLIENT_REF, type BetIn } from '../../features/bets/api';
import { apiError, json, ME_MEMBER, mockFetch, type Handler } from '../../test/fetchMock';
import { setViewportWidth } from '../../test/setup';
import { AnalysisPage } from './AnalysisPage';

// Поток событий в jsdom: тест сам шлет события
class FakeSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeSource | null = null;
  readyState = FakeSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSource.last = this;
  }

  send(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  fail() {
    this.readyState = FakeSource.CONNECTING;
    this.onerror?.();
  }

  close() {
    this.readyState = FakeSource.CLOSED;
  }
}

beforeEach(() => {
  FakeSource.last = null;
  vi.stubGlobal('EventSource', FakeSource);
  setEventSourceFactory((url) => new FakeSource(url) as unknown as EventSource);
});

afterEach(() => {
  setEventSourceFactory(null);
});

function routes(analysis: Analysis | (() => Analysis), extra: Record<string, Handler> = {}): Record<string, Handler> {
  const current = typeof analysis === 'function' ? analysis : () => analysis;
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/settings': () => json({ currency: 'RUB' }),
    'GET /api/me/bank': () => json(bankOut()),
    'GET /api/me/bookmakers': () => json(['Fonbet']),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/ai/budget': () => json(aiBudget()),
    [`GET /api/analyses/${current().id}`]: () => json(current()),
    ...extra,
  };
}

function renderAnalysis(id: number) {
  const router = createMemoryRouter(
    [
      { path: '/analysis/:id', element: <AnalysisPage /> },
      { path: '/new', element: <p>Новый анализ</p> },
    ],
    { initialEntries: [`/analysis/${id}`] },
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  client.setQueryData(meQueryKey, ME_MEMBER);
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return router;
}

const expressRegion = () => screen.getByRole('region', { name: 'Экспресс' });

/** Ставка, сохраненная по анализу 1 (сводка в AnalysisOut.bet). */
function savedBet(over: Partial<NonNullable<Analysis['bet']>> = {}): NonNullable<Analysis['bet']> {
  return {
    id: 11,
    stake: '1320.00',
    currency: 'RUB',
    total_odds: '1.914',
    bookmaker: 'Fonbet',
    legs: [
      { prediction_id: 7, odds_taken: '1.45' },
      { prediction_id: 1, odds_taken: '1.32' },
    ],
    ...over,
  };
}

describe('Анализ готов: итог и экспресс', () => {
  it('заголовок, карточки матчей, экспресс с суммой по стратегии', async () => {
    const user = userEvent.setup();
    mockFetch(routes(analysisDone()));
    renderAnalysis(1);

    expect(await screen.findByRole('heading', { level: 2, name: 'Экспресс из 2 событий · кэф 1.89' })).toBeInTheDocument();
    expect(screen.getByText('Анализ готов')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Вероятности и валуй по рынкам: Синнер — Руне' });
    expect(within(table).getByRole('row', { name: /Синнер П1/ })).toHaveTextContent('1.30');
    expect(screen.getByRole('table', { name: 'Вероятности и валуй по рынкам: Джокович — Рублев' })).toBeInTheDocument();

    const express = expressRegion();
    expect(within(express).getByText('Ждет решения')).toBeInTheDocument();
    expect(express.querySelector('.analysis-stake-value')).toHaveTextContent(/^1\s320\s₽$/);
    await user.click(within(express).getByRole('button', { name: 'Как посчитана сумма' }));
    expect(within(express).getByText('Банк из вашего ввода')).toBeVisible();
    // Расчет суммы — по шагам стратегии с сервера
    expect(within(express).getByText('Кэф 1.89 → диапазон 1.71–2.20')).toBeVisible();
    expect(within(express).getByText(/^\+0,5 п\.п\. → 2,75\s?%$/)).toBeVisible();
    expect(within(express).getByText('Потолок доли банка')).toBeVisible();
    expect(within(express).getByText(/^48\s000\s₽ × 2,75\s?% = 1\s320\s₽, округление до 10\s₽$/)).toBeVisible();

    // Шаги — по кнопке, все 9
    await user.click(screen.getByRole('button', { name: 'Показать шаги' }));
    const steps = screen.getByRole('list', { name: 'Шаги анализа' });
    expect(within(steps).getAllByRole('listitem')).toHaveLength(9);
    expect(within(steps).getByText('Claude: Синнер — Руне')).toBeInTheDocument();
  });

  it('«Сохранить ставку»: кэф при ставке, один client_ref на окно, повтор после сбоя', async () => {
    const user = userEvent.setup();
    const bodies: BetIn[] = [];
    let saved = false;
    mockFetch(
      routes(() => (saved ? analysisDone({ bet_id: 11, decision: 'bet', bet: savedBet() }) : analysisDone()), {
        'POST /api/bets': async (request) => {
          bodies.push((await request.json()) as BetIn);
          if (bodies.length === 1) return apiError(503, 'common.unavailable', 'Сервис недоступен');
          saved = true;
          return json(
            {
              id: 11,
              analysis_id: 1,
              placed_at: '2026-10-11T21:12:00Z',
              bookmaker: 'Fonbet',
              stake: '1320.00',
              currency: 'RUB',
              total_odds: '1.914',
              status: 'open',
              legs: [
                { id: 1, prediction_id: 7, match_id: 2, market: 'ML', selection: 1, odds_taken: '1.45' },
                { id: 2, prediction_id: 1, match_id: 1, market: 'ML', selection: 1, odds_taken: '1.32' },
              ],
              client_ref: bodies[0]!.client_ref,
            },
            201,
          );
        },
      }),
    );
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });

    await user.click(within(expressRegion()).getByRole('button', { name: 'Сохранить ставку' }));
    const dialog = screen.getByRole('dialog', { name: 'Сохранить ставку' });
    const sinner = within(dialog).getByRole('textbox', { name: /^Синнер П1/ });
    expect(sinner).toHaveValue('1.30');
    await user.clear(sinner);
    await user.type(sinner, '1.32');
    expect(within(dialog).getByText('1.91 (в анализе 1.89)')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Сохранить ставку' }));
    expect(await within(dialog).findByText('Сервис недоступен')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить ставку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.client_ref).toMatch(CLIENT_REF);
    expect(bodies[1]!.client_ref).toBe(bodies[0]!.client_ref);
    expect(bodies[0]).toMatchObject({ analysis_id: 1, stake: '1320.00', bookmaker: 'Fonbet' });
    expect(bodies[0]!.legs).toEqual([
      { prediction_id: 7, odds_taken: '1.45' },
      { prediction_id: 1, odds_taken: '1.32' },
    ]);
    expect(await within(expressRegion()).findByText('Ставка сохранена')).toBeInTheDocument();
    expect(within(expressRegion()).getByText(/^Ставка №11 в игре: 1\s320\s₽ на экспресс @1\.91\./)).toBeInTheDocument();
  });

  it('после перезагрузки — сохраненная ставка (сумма и кэфы), а не рекомендация анализа', async () => {
    mockFetch(routes(analysisDone({ bet_id: 11, decision: 'bet', bet: savedBet({ stake: '1500.00' }) })));
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    const express = expressRegion();
    expect(within(express).getByText(/^Ставка №11 в игре: 1\s500\s₽ на экспресс @1\.91\./)).toBeInTheDocument();
    expect(express.querySelector('.analysis-stake-value')).toHaveTextContent(/^1\s500\s₽$/);
    // Нога Синнера — кэф при ставке 1.32 (в анализе 1.30), итог — по ставке
    expect(within(express).getByText('при ставке')).toBeInTheDocument();
    expect(within(express).getByText('1.32')).toBeInTheDocument();
    expect(within(express).getByText('Кэф при ставке')).toBeInTheDocument();
    expect(within(express).getByText('1.91')).toBeInTheDocument();
    expect(within(express).queryByRole('button', { name: /Вернуть/ })).not.toBeInTheDocument();
  });

  it('ставка уже сохранена (ответ потерялся): окно закрыто, анализ и банк перечитаны', async () => {
    const user = userEvent.setup();
    let saved = false;
    const { calls } = mockFetch(
      routes(() => (saved ? analysisDone({ bet_id: 11, decision: 'bet', bet: savedBet() }) : analysisDone()), {
        'POST /api/bets': () => {
          saved = true;
          return apiError(409, 'bet.duplicate', 'Ставка по этому анализу уже сохранена');
        },
      }),
    );
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    const gets = () => calls.filter((r) => r.method === 'GET' && new URL(r.url).pathname === '/api/analyses/1').length;
    const banks = () => calls.filter((r) => new URL(r.url).pathname === '/api/me/bank').length;
    const before = { gets: gets(), banks: banks() };
    await user.click(within(expressRegion()).getByRole('button', { name: 'Сохранить ставку' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Сохранить ставку' })).getByRole('button', { name: 'Сохранить ставку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText(/Ставка по этому анализу уже сохранена/)).toBeInTheDocument();
    expect(await within(expressRegion()).findByText(/^Ставка №11 в игре/)).toBeInTheDocument();
    expect(gets()).toBeGreaterThan(before.gets);
    expect(banks()).toBeGreaterThan(before.banks);
  });

  it('сумма больше банка: банк в тексте ошибки — деньгами', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes(analysisDone(), {
        'POST /api/bets': () =>
          json({ error: { code: 'bet.stake_range', message: 'x', bank: '48000.00', currency: 'RUB' } }, 422),
      }),
    );
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    await user.click(within(expressRegion()).getByRole('button', { name: 'Сохранить ставку' }));
    const dialog = screen.getByRole('dialog', { name: 'Сохранить ставку' });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить ставку' }));
    expect(await within(dialog).findByText(/^Сумма должна быть больше нуля и не больше банка \(48\s000\s₽\)$/)).toBeInTheDocument();
  });

  it('букмекера нет: ошибка поля — после попытки сохранить, с текстом и связью', async () => {
    const user = userEvent.setup();
    const done = analysisDone({ bookmaker: null });
    done.events = done.events.map((e) => ({ ...e, bookmaker: null }));
    const { calls } = mockFetch({ ...routes(done), 'GET /api/me/bookmakers': () => json([]) });
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    await user.click(within(expressRegion()).getByRole('button', { name: 'Сохранить ставку' }));
    const dialog = screen.getByRole('dialog', { name: 'Сохранить ставку' });
    const field = within(dialog).getByRole('combobox', { name: 'Букмекер' });
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(within(dialog).queryByText('Укажите букмекера')).not.toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Сохранить ставку' });
    expect(save).toBeEnabled();
    await user.click(save);
    expect(within(dialog).getByText('Укажите букмекера')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Укажите букмекера');
    expect(calls.some((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/bets')).toBe(false);
  });

  it('предупреждения итога: банк — деньгами, вероятность проигрыша — по-русски', async () => {
    const done = analysisDone();
    done.result!.warnings = [{ key: 'analysis.warnings.bank_differs', params: { input: '20000.00', ledger: '19450.00' } }];
    mockFetch(routes(done));
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    expect(screen.getByText(/Банк из ввода \(20\s000\s₽\) не совпадает с учетом \(19\s450\s₽\)/)).toBeInTheDocument();
    // p ≈ 89%: «1 раз из 10», а не «1 раза»
    expect(within(expressRegion()).getByText(/проигрывает примерно 1 раз из 10\./)).toBeInTheDocument();
  });

  it('числа готового анализа сверху и в строке расходов — одни и те же (учет agent_runs)', async () => {
    const done = analysisDone({ cost_usd: 0.161977 });
    done.totals = { ...done.totals, cost_usd: 0.129159, tokens: 30638 };
    done.result!.costs = { ...done.result!.costs, cost_usd: 0.161977, tokens: 39865, duration_ms: 13082 };
    mockFetch(routes(done));
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    const nums = document.querySelector('.analysis-done-row .analysis-nums') as HTMLElement;
    expect(nums).toHaveTextContent(/Токены 39\s865/);
    expect(nums).toHaveTextContent(/Стоимость \$0,16/);
    expect(nums).toHaveTextContent(/Время 1 с/);
    const meta = document.querySelector('.analysis-meta') as HTMLElement;
    expect(meta).toHaveTextContent(/39\s865 токенов/);
    expect(meta).toHaveTextContent(/\$0,16 \(оценка была/);
    expect(meta).toHaveTextContent(/ · 1 с · /);
  });

  it('«Изменить сумму»: доля банка, проверки, применение', async () => {
    const user = userEvent.setup();
    mockFetch(routes(analysisDone()));
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });

    await user.click(within(expressRegion()).getByRole('button', { name: 'Изменить сумму' }));
    const dialog = screen.getByRole('dialog', { name: 'Изменить сумму' });
    const amount = within(dialog).getByLabelText('Сумма ставки');
    await user.clear(amount);
    await user.type(amount, '50000');
    expect(within(dialog).getByText(/Сумма больше банка/)).toBeInTheDocument();
    // с ошибкой сумма не применяется: окно остается открытым
    await user.click(within(dialog).getByRole('button', { name: 'Применить' }));
    expect(screen.getByRole('dialog', { name: 'Изменить сумму' })).toBeInTheDocument();
    await user.clear(amount);
    await user.type(amount, '1900');
    expect(within(dialog).getByText(/Больше 3% банка/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Применить' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(expressRegion()).getByText('Сумма · изменена вручную')).toBeInTheDocument();
    expect(expressRegion().querySelector('.analysis-stake-value')).toHaveTextContent(/^1\s900\s₽$/);
    await user.click(within(expressRegion()).getByRole('button', { name: /Вернуть 1\s320\s₽/ }));
    expect(within(expressRegion()).getByText('Рекомендуемая сумма')).toBeInTheDocument();
  });

  it('«Не ставить» и «Все-таки поставить»', async () => {
    const user = userEvent.setup();
    const decisions: unknown[] = [];
    let current = analysisDone();
    mockFetch(
      routes(() => current, {
        'PUT /api/analyses/1/decision': async (request) => {
          const body = (await request.json()) as { decision: 'skip' | null };
          decisions.push(body.decision);
          current = analysisDone({ decision: body.decision });
          return json(current);
        },
      }),
    );
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    await user.click(within(expressRegion()).getByRole('button', { name: 'Не ставить' }));
    expect(await within(expressRegion()).findByText('Без ставки')).toBeInTheDocument();
    await user.click(within(expressRegion()).getByRole('button', { name: 'Все-таки поставить' }));
    expect(await within(expressRegion()).findByText('Ждет решения')).toBeInTheDocument();
    expect(decisions).toEqual(['skip', null]);
  });

  it('на телефоне — вкладки разделов матча', async () => {
    const user = userEvent.setup();
    setViewportWidth(375);
    mockFetch(routes(analysisDone()));
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: /Экспресс из 2 событий/ });
    const [tabs] = screen.getAllByRole('group', { name: 'Раздел анализа матча' });
    expect(within(tabs!).getByRole('button', { name: 'Вероятности' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('list', { name: 'Вероятности по рынкам' })).toHaveLength(2);
    await user.click(within(tabs!).getByRole('button', { name: 'Факторы' }));
    expect(within(tabs!).getByRole('button', { name: 'Факторы' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('list', { name: 'Вероятности по рынкам' })).toHaveLength(1);
  });
});

describe('Анализ идет', () => {
  it('шаги из потока событий, отмена с подтверждением', async () => {
    const user = userEvent.setup();
    let current = analysisRunning();
    let cancelled = false;
    mockFetch(
      routes(() => current, {
        'POST /api/analyses/1/cancel': () => {
          cancelled = true;
          current = { ...analysisRunning(), status: 'cancelled', finished_at: '2026-10-11T21:11:00Z' };
          return json(current);
        },
      }),
    );
    renderAnalysis(1);
    expect(await screen.findByRole('heading', { level: 2, name: 'Анализирую 2 матча' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Ход анализа' })).toHaveAttribute('aria-valuetext', 'Шаг 7 из 9');
    expect(FakeSource.last?.url).toBe('/api/analyses/1/events');

    const running = analysisRunning();
    act(() => FakeSource.last!.onopen?.());
    act(() =>
      FakeSource.last!.send(
        progressEvent(running, {
          type: 'step',
          steps: null,
          step: { ...running.steps[6]!, state: 'done', tokens: 5467, cost_usd: 0.038 },
          totals: { ...running.totals, step: 8 },
        }),
      ),
    );
    expect(screen.getByRole('progressbar', { name: 'Ход анализа' })).toHaveAttribute('aria-valuetext', 'Шаг 8 из 9');

    // Обрыв связи — подсказка, браузер переподключается сам
    act(() => FakeSource.last!.fail());
    expect(screen.getByText(/Связь прервалась — обновляем…/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Отменить анализ' }));
    const dialog = screen.getByRole('dialog', { name: 'Отменить анализ?' });
    await user.click(within(dialog).getByRole('button', { name: 'Отменить анализ' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Анализ 2 матчей отменен' })).toBeInTheDocument();
    expect(cancelled).toBe(true);
    expect(screen.getByRole('button', { name: 'Продолжить с шага 7' })).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'Изменить события' })) {
      expect(link).toHaveAttribute('href', '/new?draft=1');
    }
  });
});

describe('Анализ идет: время, связь, двойное нажатие', () => {
  it('«Время» растет вместе с идущим шагом; связь вернулась — тост', async () => {
    mockFetch(routes(analysisRunning()));
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: 'Анализирую 2 матча' });
    const nums = () => document.querySelector('.analysis-progress .analysis-nums') as HTMLElement;
    // totals.elapsed_ms — 1 с готовых шагов; идущий шаг прибавляет свои секунды
    expect(nums()).toHaveTextContent(/Время 1 с/);
    await waitFor(() => expect(nums()).toHaveTextContent(/Время [3-9] с/), { timeout: 4000 });

    act(() => FakeSource.last!.onopen?.());
    act(() => FakeSource.last!.fail());
    expect(screen.getByText(/Связь прервалась — обновляем…/)).toBeInTheDocument();
    act(() => FakeSource.last!.onopen?.());
    expect(await screen.findByText('Связь восстановлена: ход анализа обновлен')).toBeInTheDocument();
    expect(screen.queryByText(/Связь прервалась — обновляем…/)).not.toBeInTheDocument();
  });

  it('двойное нажатие «Отменить анализ» в окне — один запрос', async () => {
    const user = userEvent.setup();
    let posts = 0;
    let current = analysisRunning();
    mockFetch(
      routes(() => current, {
        'POST /api/analyses/1/cancel': async () => {
          posts += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          current = { ...analysisRunning(), status: 'cancelled', finished_at: new Date().toISOString() };
          return posts === 1 ? json(current) : apiError(409, 'analysis.bad_state', 'Нельзя');
        },
      }),
    );
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: 'Анализирую 2 матча' });
    await user.click(screen.getByRole('button', { name: 'Отменить анализ' }));
    const confirm = within(screen.getByRole('dialog', { name: 'Отменить анализ?' })).getByRole('button', { name: 'Отменить анализ' });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Анализ 2 матчей отменен' })).toBeInTheDocument();
    expect(posts).toBe(1);
    expect(screen.queryByText(/С анализом в этом состоянии/)).not.toBeInTheDocument();
  });
});

describe('Анализ остановлен', () => {
  it('шаг со сбоем, причина и перезапуск без тела запроса', async () => {
    const user = userEvent.setup();
    let current = analysisFailed();
    let runBody: string | null = null;
    mockFetch(
      routes(() => current, {
        'POST /api/analyses/1/run': async (request) => {
          runBody = await request.text();
          current = analysisRunning({ attempt: 2, status: 'queued' });
          return json(current, 202);
        },
      }),
    );
    renderAnalysis(1);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent('Анализ остановлен на шаге 7 из 9 «Claude: Синнер — Руне».');
    expect(banner).toHaveTextContent('Claude сейчас перегружен');
    expect(screen.getByText('Шаг 7 не выполнен')).toBeInTheDocument();

    await user.click(within(banner).getByRole('button', { name: 'Перезапустить с этого шага' }));
    expect(await screen.findByText('Анализ #A-0001 · попытка 2')).toBeInTheDocument();
    expect(runBody).toBe('');
  });

  it('двойное нажатие «Перезапустить с этого шага» — один запрос', async () => {
    let posts = 0;
    let current = analysisFailed();
    mockFetch(
      routes(() => current, {
        'POST /api/analyses/1/run': async () => {
          posts += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          current = analysisRunning({ attempt: 2, status: 'queued' });
          return posts === 1 ? json(current, 202) : apiError(409, 'analysis.bad_state', 'Нельзя');
        },
      }),
    );
    renderAnalysis(1);
    const restart = within(await screen.findByRole('alert')).getByRole('button', { name: 'Перезапустить с этого шага' });
    act(() => {
      fireEvent.click(restart);
      fireEvent.click(restart);
    });
    expect(await screen.findByText('Анализ #A-0001 · попытка 2')).toBeInTheDocument();
    expect(posts).toBe(1);
  });

  it('отмена посреди шага: шаг не «в работе», «Потрачено» — по учету; доработавший вызов дописывается', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const running = analysisRunning();
      const base: Analysis = {
        ...running,
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        // в учете уже есть вызов шага 7 (он доработал после отмены), в шагах — еще нет
        cost_usd: 0.0386,
        totals: { ...running.totals, cost_usd: 0.000265 },
      };
      let current = base;
      mockFetch(routes(() => current));
      renderAnalysis(1);
      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent('Анализ отменен на шаге 7 из 9.');
      expect(banner).toHaveTextContent('Потрачено $0,04');
      const steps = screen.getByRole('list', { name: 'Шаги анализа' });
      expect(steps.querySelector('.is-active')).toBeNull();
      expect(within(steps).getAllByRole('listitem')[6]).toHaveTextContent('не выполнялся');

      // Сервер записал итог шага 7: экран перечитывает отмененный анализ, пока шаг «идет»
      current = {
        ...base,
        steps: base.steps.map((s) => (s.index === 6 ? { ...s, state: 'done', tokens: 5467, cost_usd: 0.0383 } : s)),
      };
      await act(() => vi.advanceTimersByTimeAsync(5500));
      expect(await screen.findByRole('button', { name: 'Продолжить с шага 8' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('остановка потолком: перезапуск оживает, когда администратор его поднял (без перезагрузки)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let budget = aiBudget({ per_analysis_usd: 0.3 });
      mockFetch({
        ...routes(analysisFailed({ error: { code: 'ai.analysis_cap', params: { cap: '0.30' }, step: 'claude' } })),
        'GET /api/ai/budget': () => json(budget),
      });
      renderAnalysis(1);
      const banner = await screen.findByRole('alert');
      expect(within(banner).getByRole('button', { name: 'Перезапустить с этого шага' })).toBeDisabled();
      budget = aiBudget({ per_analysis_usd: 0.5 });
      await act(() => vi.advanceTimersByTimeAsync(31_000));
      await waitFor(() => expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Перезапустить с этого шага' })).toBeEnabled());
    } finally {
      vi.useRealTimers();
    }
  });

  it('сбой разбора текста — это черновик: на «Новый анализ», а не «остановлен на шаге 0»', async () => {
    const failedParse = analysisDraft({ id: 3, status: 'failed', error: { code: 'ai.overloaded', params: {}, step: 'parse' }, draft: null });
    mockFetch({ ...routes(failedParse) });
    const router = renderAnalysis(3);
    await waitFor(() => expect(router.state.location.pathname).toBe('/new'));
    expect(router.state.location.search).toBe('?draft=3');
  });

  it('событие done пришло раньше полного анализа — заглушка итога, а не «итога нет»', async () => {
    let gets = 0;
    const done = analysisDone();
    mockFetch(
      routes(() => done, {
        'GET /api/analyses/1': async () => {
          gets += 1;
          if (gets === 1) return json(analysisRunning());
          await new Promise((resolve) => setTimeout(resolve, 400));
          return json(done);
        },
      }),
    );
    renderAnalysis(1);
    await screen.findByRole('heading', { level: 2, name: 'Анализирую 2 матча' });
    act(() => FakeSource.last!.send(progressEvent(analysisRunning(), { type: 'done', status: 'done', steps: null, step: null, totals: done.totals })));
    expect(screen.queryByText(/Итога у этого анализа нет/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Результат готовится')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'Экспресс из 2 событий · кэф 1.89' })).toBeInTheDocument();
  });

  it('черновик уходит на «Новый анализ», чужой — «Анализ не найден»', async () => {
    mockFetch(
      routes(analysisDraft(), {
        'GET /api/analyses/2': () => apiError(404, 'analysis.not_found', 'Анализ не найден'),
      }),
    );
    const router = renderAnalysis(6);
    await waitFor(() => expect(router.state.location.pathname).toBe('/new'));
    expect(router.state.location.search).toBe('?draft=6');

    await act(() => router.navigate('/analysis/2'));
    expect(await screen.findByText('Его нет или он принадлежит другому участнику.')).toBeInTheDocument();
  });
});
