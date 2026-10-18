import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { adminUser } from '../../features/admin/testData';
import { aiBudget } from '../../features/ai/testData';
import { analysisDone, bankOut, noValueStake, strategyV3, variantOut } from '../../features/analysis/testData';
import type { Analysis } from '../../features/analysis/types';
import type { BetIn } from '../../features/bets/api';
import { bookmakersOut } from '../../features/bookmakers/testData';
import { apiError, json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { AnalysisPage } from './AnalysisPage';

// Р29: варианты ставки в итоге анализа (экспресс стратегии, ординары, экспресс из лучших),
// «В свою ставку» и окно своей ставки, режим просмотра (Р27).

function api(analysis: Analysis | (() => Analysis), extra: Record<string, Handler> = {}): Record<string, Handler> {
  const current = typeof analysis === 'function' ? analysis : () => analysis;
  return {
    'GET /api/me/bank': () => json(bankOut()),
    'GET /api/me/bookmakers': () => json(['Fonbet']),
    'GET /api/me/bookmakers/list': () => json(bookmakersOut()),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/admin/users': () => json([adminUser({ id: 7 })]),
    [`GET /api/analyses/${current().id}`]: () => json(current()),
    ...extra,
  };
}

function open(analysis: Analysis | (() => Analysis), extra: Record<string, Handler> = {}, url = '/analysis/1') {
  return renderPage(<AnalysisPage />, {
    path: '/analysis/:id',
    url,
    me: url.includes('as=') ? ME_ADMIN : undefined,
    api: api(analysis, extra),
    stubs: { '/new': 'Новый анализ', '/bets': 'Ставки' },
  });
}

/** Анализ без экспресса стратегии: «надежнее» и «экспресс из лучших» (#analysis-noexp). */
function noExpress(): Analysis {
  const base = analysisDone();
  const result = base.result!;
  return {
    ...base,
    result: {
      ...result,
      express: null,
      no_express_key: 'analysis.express.too_few',
      matches: result.matches.map((m) => ({ ...m, markets: m.markets.map((r) => ({ ...r, in_express: false })) })),
      variants: [
        variantOut(),
        variantOut({
          code: 'best_express',
          kind: 'own',
          legs: [
            { prediction_id: 7, match_id: 92, market: 'ML', selection: 1, p: 0.904, odds: '1.45' },
            { prediction_id: 1, match_id: 91, market: 'ML', selection: 1, p: 0.99, odds: '1.30' },
          ],
          total_odds: '1.885',
          p: 0.895,
          value: 0.687,
          stake: '720.00',
          why_key: 'analysis.variants.why.best_express',
          why_params: { min_p: '0.5', max_pct: '0.015' },
          outside_strategy: true,
          issues: ['analysis.rules.legs_count'],
        }),
      ],
    },
  };
}

const card = (name: string | RegExp) => screen.getByRole('region', { name });

describe('Варианты ставки (Р29)', () => {
  it('экспресс стратегии — основной, рядом ординары «надежнее» и «лучший валуй» со своей суммой', async () => {
    const { user } = open(analysisDone());
    expect(await screen.findByRole('heading', { level: 3, name: 'Варианты ставки' })).toBeInTheDocument();
    const express = card('Экспресс стратегии');
    expect(within(express).getByText('Вариант 1 · основной')).toBeInTheDocument();
    expect(within(express).getByRole('button', { name: 'Собрать свою' })).toBeInTheDocument();

    const safer = card('Ординар · надежнее');
    expect(within(safer).getByText('Вариант 2')).toBeInTheDocument();
    expect(within(safer).getByText('Ординар')).toBeInTheDocument();
    expect(safer.querySelector('.analysis-stake-value')).toHaveTextContent(/^720\s₽$/);
    expect(within(safer).getByText('Самая высокая вероятность среди рынков с кэфом от 1.30 и валуем от нуля')).toBeInTheDocument();
    await user.click(within(safer).getByRole('button', { name: 'Как посчитана сумма' }));
    expect(within(safer).getByText('Ординар, кэф 1.30 → диапазон до 1.60')).toBeVisible();
    // у ординара поправки на валуй нет: сумма — доля полосы (решение владельца)
    expect(within(safer).queryByText(/Средний валуй ног/)).toBeNull();

    const value = card('Ординар · лучший валуй');
    expect(within(value).getByText('Вариант 3')).toBeInTheDocument();
    expect(within(value).getByText('Наибольший перевес среди исходов с вероятностью от 50%')).toBeInTheDocument();
    // «Экспресса нет» — не тупик и не показывается, когда экспресс есть
    expect(screen.queryByText('Экспресса стратегии нет.')).toBeNull();
  });

  it('«надежнее» совпал с лучшим валуем — одна карточка', async () => {
    const base = analysisDone();
    open({ ...base, result: { ...base.result!, variants: [base.result!.variants[0]!, variantOut({ also: ['value'] })] } });
    const both = await screen.findByRole('region', { name: 'Ординар · надежнее и лучший валуй' });
    expect(within(both).getByText(/Он же дает наибольший перевес/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ординар · лучший валуй' })).toBeNull();
  });

  it('экспресса стратегии нет: заголовок, почему, варианты и «Экспресс из лучших» вне стратегии', async () => {
    open(noExpress());
    expect(await screen.findByRole('heading', { level: 2, name: 'Экспресса стратегии нет · 2 варианта ставки' })).toBeInTheDocument();
    expect(screen.getByText('Экспресса стратегии нет.')).toBeInTheDocument();
    expect(screen.getByText(/Ставки нет: подходящих событий меньше двух/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Экспресс стратегии' })).toBeNull();

    const safer = card('Ординар · надежнее');
    expect(within(safer).getByText('Вариант 1')).toBeInTheDocument();
    expect(within(safer).getByRole('button', { name: 'Сохранить ставку' })).toHaveClass('primary');
    const best = card('Экспресс из лучших');
    expect(within(best).getByText('Вне стратегии')).toBeInTheDocument();
    expect(within(best).getByText(/В правила стратегии не проходит:/)).toBeInTheDocument();
    expect(within(best).getByText(/сумма не больше 1,5\s?% банка/)).toBeInTheDocument();
  });

  it('валуя нет нигде: общее предупреждение, суммы нет, сохранить — с суммой участника', async () => {
    const base = noExpress();
    const result = base.result!;
    const none = (v: (typeof result.variants)[number]) => ({
      ...v,
      value: -0.04,
      stake: null,
      stake_calc: noValueStake(v.total_odds),
      warnings: ['no_value' as const],
    });
    const { user } = open({ ...base, result: { ...result, variants: result.variants.map(none) } });
    expect(await screen.findByText('Валуя нет ни на одном рынке — модель не советует ставить.')).toBeInTheDocument();
    const safer = card('Ординар · надежнее');
    expect(safer).toHaveClass('is-novalue');
    expect(within(safer).getByText('Суммы нет: валуй ниже нуля')).toBeInTheDocument();
    expect(within(safer).getByText('Валуя нет — модель не советует ставить.')).toBeInTheDocument();
    // суммы нет — «Сохранить ставку» сначала просит сумму
    await user.click(within(safer).getByRole('button', { name: 'Сохранить ставку' }));
    const dialog = screen.getByRole('dialog', { name: 'Изменить сумму' });
    expect(within(dialog).getByText('Валуя нет — суммы по таблице нет, сумма на ваш риск')).toBeInTheDocument();
  });

  it('сохранить ординар: вид single, ноги варианта, сумма по таблице; карточка — «Сохранена»', async () => {
    const bodies: BetIn[] = [];
    let saved = false;
    const bet = {
      id: 12,
      kind: 'single',
      analysis_id: 1,
      placed_at: '2026-10-11T21:12:00Z',
      bookmaker: 'Fonbet',
      stake: '720.00',
      currency: 'RUB',
      total_odds: '1.300',
      status: 'open',
      legs: [{ id: 3, prediction_id: 1, match_id: 91, market: 'ML', selection: 1, odds_taken: '1.30' }],
      client_ref: 'x',
    };
    const brief = {
      id: 12,
      kind: 'single' as const,
      stake: '720.00',
      currency: 'RUB',
      total_odds: '1.300',
      bookmaker: 'Fonbet',
      legs: [{ prediction_id: 1, match_id: 91, market: 'ML' as const, selection: 1, odds_taken: '1.30' }],
    };
    const { user } = open(() => (saved ? analysisDone({ bets: [brief] }) : analysisDone()), {
      'POST /api/bets': async (request) => {
        bodies.push((await request.json()) as BetIn);
        saved = true;
        return json(bet, 201);
      },
    });
    const safer = await screen.findByRole('region', { name: 'Ординар · надежнее' });
    await user.click(within(safer).getByRole('button', { name: 'Сохранить ставку' }));
    const dialog = screen.getByRole('dialog', { name: 'Сохранить ставку' });
    expect(within(dialog).getByText(/Ординар — настоящая ставка/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить ставку' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bodies[0]).toMatchObject({ analysis_id: 1, kind: 'single', stake: '720.00', bookmaker: 'Fonbet', legs: [{ prediction_id: 1, odds_taken: '1.3' }] });
    expect(await within(card('Ординар · надежнее')).findByText('Сохранена')).toBeInTheDocument();
    expect(within(card('Ординар · надежнее')).getByText(/^Ставка №12 в игре: 720\s₽ @1\.30\./)).toBeInTheDocument();
    // экспресс стратегии остается несохраненным: у анализа может быть несколько ставок
    expect(within(card('Экспресс стратегии')).getByText('Ждет решения')).toBeInTheDocument();
    // но «Не ставить» уже нет: решение анализа — «поставил», сервер ответил бы 409
    expect(within(card('Экспресс стратегии')).queryByRole('button', { name: 'Не ставить' })).toBeNull();
    expect(within(card('Экспресс стратегии')).getByRole('button', { name: 'Сохранить ставку' })).toBeInTheDocument();
  });

  it('у анализа уже есть своя ставка (решение «поставил»): «Не ставить» у экспресса нет', async () => {
    const own = {
      id: 15,
      kind: 'own' as const,
      stake: '300.00',
      currency: 'RUB',
      total_odds: '3.600',
      bookmaker: 'Fonbet',
      legs: [{ prediction_id: 2, match_id: 91, market: 'ML' as const, selection: 2, odds_taken: '3.60' }],
    };
    open(analysisDone({ decision: 'bet', bets: [own] }));
    const express = await screen.findByRole('region', { name: 'Экспресс стратегии' });
    expect(within(express).getByText('Ждет решения')).toBeInTheDocument();
    expect(within(express).queryByRole('button', { name: 'Не ставить' })).toBeNull();
    expect(within(express).queryByText('Без ставки')).toBeNull();
  });

  it('ставок нет: «Не ставить» у экспресса есть', async () => {
    open(analysisDone());
    const express = await screen.findByRole('region', { name: 'Экспресс стратегии' });
    expect(within(express).getByRole('button', { name: 'Не ставить' })).toBeInTheDocument();
  });
});

describe('Своя ставка (Р29)', () => {
  it('«В свою ставку»: второй рынок того же матча заменяет первый, выплата и предупреждения', async () => {
    const { user } = open(analysisDone());
    await screen.findByRole('heading', { level: 3, name: 'Варианты ставки' });
    await user.click(screen.getByRole('button', { name: 'В свою ставку: Синнер П1, Синнер — Руне' }));
    let dialog = screen.getByRole('dialog', { name: 'Своя ставка' });
    expect(within(dialog).getByText('Ординар')).toBeInTheDocument();
    expect(within(dialog).getByText('Своя')).toBeInTheDocument();
    expect(within(dialog).getByText('Рекомендованной суммы нет: стратегия эту ставку не считает')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть' }));

    // пока своя ставка собирается — карточка в колонке вариантов, у исхода — «В своей ставке»
    const slip = screen.getByRole('region', { name: 'Своя ставка' });
    expect(within(slip).getByText('Синнер П1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'В своей ставке: Синнер П1, Синнер — Руне' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'В свою ставку: Руне П2, Синнер — Руне' }));
    dialog = screen.getByRole('dialog', { name: 'Своя ставка' });
    expect(within(dialog).getByText('Один рынок на матч: «Синнер П1» заменен на «Руне П2».')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: /^Синнер П1/ })).toBeNull();
    await user.type(within(dialog).getByRole('textbox', { name: /Сумма ставки/ }), '500');
    const kv = within(dialog);
    expect(kv.getByText(/^1\s800\s₽$/)).toBeInTheDocument();
    expect(kv.getByText(/^\+1\s300\s₽$/)).toBeInTheDocument();
    expect(kv.getByText(/1,04\s?% из 48\s000\s₽/)).toBeInTheDocument();
    // валуй по модели: 0,01 × 3,60 − 1 = −96,4%
    expect(kv.getByText('Валуя нет — модель не советует ставить.')).toBeInTheDocument();
    expect(kv.getByText('Уверенность анализа средняя:')).toBeInTheDocument();
  });

  it('из двух матчей — экспресс; сохранить: вид own, ошибка 422 — в окне; удачно — на «Ставки»', async () => {
    const bodies: BetIn[] = [];
    const { user, router } = open(analysisDone(), {
      'POST /api/bets': async (request) => {
        bodies.push((await request.json()) as BetIn);
        if (bodies.length === 1) return apiError(422, 'bet.same_match', 'Один рынок на матч');
        return json(
          {
            id: 13,
            kind: 'own',
            analysis_id: 1,
            placed_at: '2026-10-11T21:12:00Z',
            bookmaker: 'Fonbet',
            stake: '500.00',
            currency: 'RUB',
            total_odds: '1.885',
            status: 'open',
            legs: [],
            client_ref: 'x',
          },
          201,
        );
      },
    });
    await screen.findByRole('heading', { level: 3, name: 'Варианты ставки' });
    await user.click(screen.getByRole('button', { name: 'В свою ставку: Синнер П1, Синнер — Руне' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Закрыть' }));
    await user.click(screen.getByRole('button', { name: 'В свою ставку: Джокович П1, Джокович — Рублев' }));
    const dialog = screen.getByRole('dialog', { name: 'Своя ставка' });
    expect(within(dialog).getByText('Экспресс × 2')).toBeInTheDocument();
    expect(within(dialog).getByText(/≈ 89\s?% \(99\s?% × 90\s?%\)/)).toBeInTheDocument();

    // без суммы не сохраняется: фокус — на сумме
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить ставку' }));
    expect(bodies).toHaveLength(0);
    await user.type(within(dialog).getByRole('textbox', { name: /Сумма ставки/ }), '500');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить ставку' }));
    expect(await within(dialog).findByText('Один рынок на матч: уберите второй рынок того же матча')).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({
      analysis_id: 1,
      kind: 'own',
      stake: '500.00',
      bookmaker: 'Fonbet',
      legs: [
        { prediction_id: 1, odds_taken: '1.3' },
        { prediction_id: 7, odds_taken: '1.45' },
      ],
    });
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить ставку' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/bets'));
    expect(router.state.location.search).toBe('?new=13');
    expect(bodies[1]!.client_ref).toBe(bodies[0]!.client_ref);
  });

  it('«Собрать свою» из экспресса: события экспресса, событие можно убрать; рынок на проверке — с предупреждением', async () => {
    const base = analysisDone();
    // у Ф(+1.5) Рублева есть кэф — рынок на проверке, но в свою ставку взять можно
    const matches = base.result!.matches.map((m) =>
      m.match_id === 92 ? { ...m, markets: m.markets.map((r) => (r.market === 'HCP_+1.5' && r.selection === 2 ? { ...r, odds: '1.90', value: -0.3 } : r)) } : m,
    );
    const { user } = open({ ...base, result: { ...base.result!, matches } });
    const express = await screen.findByRole('region', { name: 'Экспресс стратегии' });
    await user.click(within(express).getByRole('button', { name: 'Собрать свою' }));
    let dialog = screen.getByRole('dialog', { name: 'Своя ставка' });
    expect(within(dialog).getByText(/Своя ставка собрана из экспресса/)).toBeInTheDocument();
    expect(within(dialog).getByText('Экспресс × 2')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Убрать «Синнер П1»' }));
    expect(within(dialog).getByText('Ординар')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Закрыть' }));

    await user.click(screen.getByRole('button', { name: 'В свою ставку: Рублев Ф2(+1.5), Джокович — Рублев' }));
    dialog = screen.getByRole('dialog', { name: 'Своя ставка' });
    expect(within(dialog).getByText('рынок на проверке')).toBeInTheDocument();
    expect(within(dialog).getByText('Модель по рынку не проверена:')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Убрать «Рублев Ф2(+1.5)»' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Своя ставка пуста')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Своя ставка' })).toBeNull();
  });
});

describe('Анализ без итога (старый бот)', () => {
  it('ни вариантов, ни таблицы рынков: «В свою ставку» и «Сохранить ставку» не предлагаются', async () => {
    open(analysisDone({ result: null }));
    expect(await screen.findByText(/Итога у этого анализа нет/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /В свою ставку/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Сохранить ставку/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Не ставить' })).toBeNull();
  });
});

describe('Режим просмотра (Р27)', () => {
  it('«В свою ставку», «Собрать свою» и «Сохранить ставку» варианта неактивны с подсказкой', async () => {
    const { user } = open(analysisDone(), {}, '/analysis/1?as=7');
    const add = await screen.findByRole('button', { name: /^В свою ставку: Синнер П1, Синнер — Руне\. Только просмотр/ });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    await user.click(add);
    expect(await screen.findByText('Только просмотр: свою ставку может собрать только участник')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();

    const safer = card('Ординар · надежнее');
    expect(within(safer).getByRole('button', { name: /^Сохранить ставку\. Только просмотр/ })).toHaveAttribute('aria-disabled', 'true');
    expect(within(safer).getByText('Только просмотр: сохранить ставку может только участник.')).toBeInTheDocument();
    expect(within(card('Экспресс стратегии')).getByRole('button', { name: /^Собрать свою\. Только просмотр/ })).toHaveAttribute('aria-disabled', 'true');
  });
});
