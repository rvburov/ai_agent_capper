import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  comparison,
  evalPlan,
  evalRun,
  evalSet,
  learningSummary,
  lessonsList,
  strategyVersion,
  strategyVersions,
  versionEval,
  versionsWithCandidate,
} from '../../features/learning/testData';
import type { StrategyVersion } from '../../features/learning/types';
import { strategyV3 } from '../../test/factories';
import { apiError, json, ME_ADMIN, ME_MEMBER, type Handler } from '../../test/fetchMock';
import { bodyOf, renderPage } from '../../test/renderPage';
import { LearningPage } from './LearningPage';

// Вкладка «Версии стратегии» (versionsPanel макета, Р25): таблица версий инструкций с
// лог-лоссом на замороженном наборе и разницей с рынком, сравнение кандидата с активной,
// прогон на наборе (план, 2FA, ход, «Остановить»), включение, откат и отклонение с причинами
// отказа сервера; заморозка набора. Часы зафиксированы.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const path = (request: Request) => new URL(request.url).pathname;

function compareOut(versions: StrategyVersion[]) {
  const [a, b] = versions;
  return { a, b, diff: [], comparison: b!.comparison };
}

function renderVersions({ admin = false, versions = versionsWithCandidate(), set = evalSet(), api = {}, width }: { admin?: boolean; versions?: StrategyVersion[]; set?: ReturnType<typeof evalSet> | null; api?: Record<string, Handler>; width?: number } = {}) {
  return renderPage(<LearningPage />, {
    path: '/learning/:tab?',
    url: '/learning/versions',
    me: admin ? ME_ADMIN : ME_MEMBER,
    ...(width ? { width } : {}),
    api: {
      'GET /api/learning': () => json(learningSummary({ eval_set: set })),
      'GET /api/lessons': () => json(lessonsList()),
      'GET /api/strategy/active': () => json(strategyV3()),
      'GET /api/strategy/versions': () => json(strategyVersions({ instructions: versions, eval_set: set })),
      'GET /api/strategy/versions/compare': () => json(compareOut(versions)),
      'GET /api/admin/eval/runs': () => json({ items: [], budget: evalPlan().budget }),
      ...api,
    },
    stubs: { '/profile/:tab?': 'Личный кабинет' },
  });
}

const panel = () => screen.getByRole('tabpanel', { name: 'Версии стратегии' });

describe('«Версии стратегии»', () => {
  it('правило улучшения: в правилах приема — лог-лосс и формат, без токенов; токенов столько же — «столько же», а не «дороже»', async () => {
    const [base, cand] = versionsWithCandidate();
    const same = comparison({
      rule: 'improve',
      verdict: 'noise',
      passed: false,
      log_loss: { a: 0.484, b: 0.484, diff: 0, low: 0, high: 0, margin: 0, ok: false },
      brier: { a: 0.156, b: 0.156, diff: 0, low: 0, high: 0, margin: null, ok: null },
      ece: { a: 0.092, b: 0.092, diff: 0, low: 0, high: 0, margin: null, ok: null },
      tokens_per_event: { a: 5900, b: 5900, change: 0, ok: false },
      cost_per_event: { a: 0.014, b: 0.014, change: 0, ok: false },
    });
    const versions = [base!, { ...cand!, goal: 'quality' as const, comparison: same }];
    const { user } = renderVersions({ versions });
    const rules = (await within(panel()).findByRole('heading', { name: 'Как принимается новая версия' })).closest('section')!;
    expect(await within(rules).findByText('Ошибок формата: 0')).toBeInTheDocument();
    expect(within(rules).getByText('ДИ лог-лосса: 0,000…0,000')).toBeInTheDocument();
    expect(within(rules).queryByText(/^Токенов/)).toBeNull();
    await user.click(within(panel()).getByRole('button', { name: 'Сравнить v3 и v4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение v3 и v4' });
    const tokens = (await within(dialog).findByText('Токенов на анализ')).closest('tr')!;
    expect(tokens).toHaveTextContent('столько же');
    expect(tokens).not.toHaveTextContent('дороже');
  });

  it('участник: таблица версий — лог-лосс, разница с рынком и ДИ, статус; правила приема с итогом кандидата; включать нельзя', async () => {
    const { user, calls } = renderVersions();
    const table = await within(panel()).findByRole('table', { name: 'Инструкции анализа' });
    const rows = within(table).getAllByRole('row').slice(1);
    // новые сверху: кандидат v4, потом активная v3
    expect(rows[0]).toHaveTextContent('v4сжатое досье10 окт0,615 · 1 прогон+0,017ДИ −0,002…+0,034');
    expect(rows[0]).toHaveTextContent('≈ 6,5 тыс.Кандидат');
    expect(rows[1]).toHaveTextContent('v3основная1 окт0,612 · 2 прогона+0,014');
    expect(rows[1]).toHaveTextContent('Активная');
    expect(within(panel()).getByText(/замороженном наборе S-2026-08: 250 матчей с 1 авг .*45 трудных, без новостей · sha256 9f2c41ab77e0/)).toBeInTheDocument();
    expect(within(panel()).getByText(/лог-лосс 0,598\), момент снятия кэфов не проверен\. Два прогона v3 разошлись на 0,003/)).toBeInTheDocument();
    expect(within(panel()).getByText('Ведет администратор')).toBeInTheDocument();
    expect(within(panel()).queryByRole('button', { name: 'Оценить на наборе' })).toBeNull();

    const rules = within(panel()).getByRole('heading', { name: 'Как принимается новая версия' }).closest('section')!;
    expect(within(rules).getByText('Кандидат v4 сделан ради экономии — его проверяют по правилу 3')).toBeInTheDocument();
    expect(within(rules).getByText('Выполнено: v3 × 2, v4 × 1')).toBeInTheDocument();
    expect(within(rules).getByText('К v4 не относится')).toBeInTheDocument();
    for (const chip of ['Лог-лосс: до +0,008', 'Brier: до +0,004', 'ECE: до +1,2 п.п.', 'Ошибок формата: 0', 'Токенов −31%']) {
      expect(within(rules).getByText(chip)).toBeInTheDocument();
    }

    await user.click(within(panel()).getByRole('button', { name: 'Сравнить v3 и v4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение v3 и v4' });
    const lossRow = (await within(dialog).findByText('Лог-лосс')).closest('tr')!;
    expect(lossRow).toHaveTextContent('0,6120,615+0,00395% ДИ −0,004…+0,008допуск до +0,010не хуже');
    // ECE — со знаком процента, как в окне версии
    expect(within(dialog).getByText('Калибровка (ECE)').closest('tr')).toHaveTextContent('3,1%3,5%+0,4 п.п.');
    expect(within(dialog).getByText(/v4 проходит правило экономии/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Досье короче на треть/)).toBeInTheDocument();
    expect(within(dialog).getByText('Инструкции общие для всех участников — включает версию администратор.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Включить v4' })).toBeNull();
    const compare = calls.find((request) => path(request) === '/api/strategy/versions/compare')!;
    expect(new URL(compare.url).searchParams.toString()).toBe('a=1&b=2');
  });

  it('администратор: «Включить v4» из сравнения — отказ сервера текстом (нет прогона), потом успех', async () => {
    let attempt = 0;
    const versions = versionsWithCandidate();
    const { user } = renderVersions({
      admin: true,
      versions,
      api: {
        'POST /api/strategy/versions/2/activate': () => {
          attempt += 1;
          return attempt === 1
            ? apiError(409, 'strategy.eval_needed', 'Сначала прогон кандидата на замороженном наборе матчей: без проверки инструкции не включаются')
            : json({ ...versions[1], status: 'active', activated_at: '2026-10-15T10:00:00Z' });
        },
      },
    });
    await user.click(await within(panel()).findByRole('button', { name: 'Сравнить v3 и v4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение v3 и v4' });
    await user.click(await within(dialog).findByRole('button', { name: 'Включить v4' }));
    expect(await within(dialog).findByText(/^Сначала прогон кандидата на замороженном наборе/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Включить v4' }));
    expect(await screen.findByText('v4 работает со следующего анализа у всех участников · v3 в архиве, откат в один клик')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('администратор: 409 у «Включить» (версию уже включил другой) — текст сервера и свежий список версий', async () => {
    const [active, candidate] = versionsWithCandidate();
    let enabledElsewhere = false;
    const { user } = renderVersions({
      admin: true,
      api: {
        'GET /api/strategy/versions': () =>
          json(
            strategyVersions({
              instructions: enabledElsewhere
                ? [{ ...active!, status: 'archived', can_rollback: true }, { ...candidate!, status: 'active' }]
                : [active!, candidate!],
              eval_set: evalSet(),
            }),
          ),
        'POST /api/strategy/versions/2/activate': () => {
          enabledElsewhere = true;
          return apiError(409, 'strategy.not_candidate', 'Включить или отклонить можно только кандидата');
        },
      },
    });
    await user.click(await within(panel()).findByRole('button', { name: 'Сравнить v3 и v4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение v3 и v4' });
    await user.click(await within(dialog).findByRole('button', { name: 'Включить v4' }));
    expect(await within(dialog).findByText('Включить или отклонить можно только кандидата')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Оставить v3' }));
    // список перечитан после отказа: v4 активна, v3 в архиве — без перезагрузки страницы
    const table = within(panel()).getByRole('table', { name: 'Инструкции анализа' });
    await waitFor(() => expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Активная'));
    expect(within(table).getAllByRole('row')[2]).toHaveTextContent('Архив');
  });

  it('администратор: кандидата включить нельзя — причина сервера (урок отклонен); «Отклонить»', async () => {
    const [active, candidate] = versionsWithCandidate();
    const blocked = { ...candidate!, lessons: ['L-007'], can_activate: false, activate_reason: 'strategy.lesson_closed' };
    const { user, calls } = renderVersions({
      admin: true,
      versions: [active!, blocked],
      api: { 'POST /api/strategy/versions/2/reject': () => json({ ...blocked, status: 'rejected' }) },
    });
    const table = await within(panel()).findByRole('table', { name: 'Инструкции анализа' });
    await user.click(within(table).getAllByRole('row')[1]!);
    const dialog = await screen.findByRole('dialog', { name: 'Версия v4 · сжатое досье' });
    expect(within(dialog).getByText('Урок L-007 отклонен или списан — версию с ним включить нельзя.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Включить v4' })).toBeDisabled();
    expect(within(dialog).getByText('Уроки в инструкциях')).toBeInTheDocument();
    // необратимо — сначала подтверждение; «Оставить кандидатом» ничего не отправляет
    await user.click(within(dialog).getByRole('button', { name: 'Отклонить' }));
    expect(within(dialog).getByText(/^Отклонить кандидата v4\? Он уйдет в «Не включена»/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Да, отклонить v4' })).toHaveFocus());
    await user.click(within(dialog).getByRole('button', { name: 'Оставить кандидатом' }));
    expect(calls.some((request) => request.method === 'POST' && path(request) === '/api/strategy/versions/2/reject')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Отклонить' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Да, отклонить v4' }));
    expect(await screen.findByText('Кандидат v4 отклонен')).toBeInTheDocument();
    expect(calls.some((request) => request.method === 'POST' && path(request) === '/api/strategy/versions/2/reject')).toBe(true);
  });

  it('администратор: «Вернуть» бывшую активную версию', async () => {
    const versions = [
      strategyVersion({ id: 3, code: 'v5', name: 'v5 · + урок L-004', created_at: '2026-10-12T09:00:00Z', parent_id: 1, eval: null }),
      strategyVersion({ status: 'archived', archived_at: '2026-10-12T09:00:00Z', eval: versionEval(), can_rollback: true }),
    ];
    const { user } = renderVersions({ admin: true, versions, api: { 'POST /api/strategy/versions/1/rollback': () => json({ ...versions[1], status: 'active' }) } });
    const table = await within(panel()).findByRole('table', { name: 'Инструкции анализа' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('не прогонялась');
    await user.click(within(table).getAllByRole('row')[2]!);
    const dialog = await screen.findByRole('dialog', { name: 'Версия v3 · основная' });
    expect(within(dialog).getByText('0,612 · рынок 0,598 · разница +0,014 (95% ДИ −0,004…+0,031)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Вернуть v3' }));
    expect(await screen.findByText('Снова активна v3 · v5 вернулась в кандидаты')).toBeInTheDocument();
  });

  it('администратор: прогон на наборе — план, бюджет $30 первого месяца, код 2FA, ход и «Остановить»', async () => {
    let starts = 0;
    const { user, calls } = renderVersions({
      admin: true,
      api: {
        'GET /api/admin/eval/runs/preview': () => json(evalPlan()),
        'POST /api/admin/eval/runs': () => {
          starts += 1;
          return starts === 1 ? apiError(403, 'admin.totp_invalid', 'Неверный код 2FA') : json(evalRun(), 202);
        },
        'GET /api/admin/eval/runs/13': () => json(evalRun()),
        'POST /api/admin/eval/runs/13/cancel': () => json(evalRun({ waiting: 'eval.canceling' })),
      },
    });
    await user.click(await within(panel()).findByRole('button', { name: 'Оценить на наборе' }));
    const dialog = await screen.findByRole('dialog', { name: 'Оценить версию на наборе' });
    expect(within(dialog).getByRole('button', { name: /^Что прогнать:/ })).toHaveTextContent('v4 · кандидат');
    expect(await within(dialog).findByText('S-2026-08 · 250 матчей, без новостей')).toBeInTheDocument();
    expect(within(dialog).getByText('3 пакета по ≤ 100 через Batch (Opus 5.5), следующий — после сбора предыдущего')).toBeInTheDocument();
    expect(within(dialog).getByText('≈ $3,10')).toBeInTheDocument();
    // худший случай — как считает сервер: матчи набора и пакет повтора истекших и сбойных
    expect(within(dialog).getByText('≈ $38,50 ((250 + 100 повторов) × $0,11 при 8 тыс. токенов ответа), резерв на пакет ≤ $11,00')).toBeInTheDocument();
    expect(within(dialog).getByText('$4,20 из $30 · остаток $25,80 · со следующего месяца $25 в месяц')).toBeInTheDocument();
    const preview = calls.find((request) => path(request) === '/api/admin/eval/runs/preview')!;
    expect(new URL(preview.url).searchParams.get('version_id')).toBe('2');

    const run = within(dialog).getByRole('button', { name: 'Запустить прогон' });
    await user.click(run);
    expect(within(dialog).getByText('Введите шестизначный код 2FA')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'Код 2FA' }), '123456');
    await user.click(run);
    expect(await within(dialog).findByText('Неверный код 2FA')).toBeInTheDocument();
    // поле очищено, фокус в нем — новый код вводится сразу
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Код 2FA' })).toHaveFocus());
    await user.type(within(dialog).getByRole('textbox', { name: 'Код 2FA' }), '654321');
    await user.click(within(dialog).getByRole('button', { name: 'Запустить прогон' }));
    const body = await bodyOf(calls.filter((request) => request.method === 'POST' && path(request) === '/api/admin/eval/runs').at(-1)!);
    expect(body).toEqual({ version_id: 2, totp_code: '654321' });

    const progress = await screen.findByRole('dialog', { name: 'Прогон v4 на наборе S-2026-08' });
    expect(await within(progress).findByText('Пакетов собрано: 1 из 3 · 250 матчей набора')).toBeInTheDocument();
    expect(within(progress).getByText('Потрачено $1,20 · резерв худшего случая $11,00')).toBeInTheDocument();
    await user.click(within(progress).getByRole('button', { name: 'Остановить' }));
    expect(await screen.findByText(/^Прогон v4 останавливается/)).toBeInTheDocument();
  });

  it('администратор: прогон не стартует — причина плана словами, кнопка недоступна', async () => {
    const { user } = renderVersions({
      admin: true,
      api: {
        'GET /api/admin/eval/runs/preview': () =>
          json(evalPlan({ can_run: false, reason: 'eval.budget', estimate_source: 'settings', budget: { budget_usd: 25, spent_usd: 20, reserved_usd: 0, left_usd: 5, first_month: false, next_usd: 25 } })),
      },
    });
    await user.click(await within(panel()).findByRole('button', { name: 'Оценить на наборе' }));
    const dialog = await screen.findByRole('dialog', { name: 'Оценить версию на наборе' });
    expect(await within(dialog).findByText(/^Худший случай одного пакета больше остатка бюджета проверок/)).toBeInTheDocument();
    expect(within(dialog).getByText('$20,00 из $25 · остаток $5,00')).toBeInTheDocument();
    // прошлых прогонов нет — цена по ценам модели, а не «по прошлым прогонам»
    expect(within(dialog).getByText('Оценка цены')).toBeInTheDocument();
    expect(within(dialog).getByText('≈ $3,10 — по ценам модели: прошлых прогонов еще нет')).toBeInTheDocument();
    expect(within(dialog).queryByText('Цена по прошлым прогонам')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Запустить прогон' })).toBeDisabled();
  });

  it('администратор: идет прогон — полоса хода во вкладке, «Остановить»; отказ сервера — текстом', async () => {
    const { user } = renderVersions({
      admin: true,
      api: {
        'GET /api/admin/eval/runs': () => json({ items: [evalRun({ chunks_done: 2 })], budget: evalPlan().budget }),
        'POST /api/admin/eval/runs/13/cancel': () => apiError(409, 'eval.run_closed', 'Прогон уже закончен: останавливать нечего'),
      },
    });
    const banner = (await within(panel()).findByText('Идет прогон v4 на наборе S-2026-08.')).closest('.callout') as HTMLElement;
    expect(banner).toHaveTextContent('Пакетов собрано 2 из 3, потрачено $1,20.');
    await user.click(within(banner).getByRole('button', { name: 'Остановить' }));
    expect(await screen.findByText('Прогон уже закончен: останавливать нечего')).toBeInTheDocument();
  });

  it('администратор: набор не заморожен — «Заморозить набор»: отказ сервера текстом, затем успех', async () => {
    let attempt = 0;
    const { user } = renderVersions({
      admin: true,
      set: null,
      versions: [strategyVersion()],
      api: {
        'POST /api/admin/eval/sets': () => {
          attempt += 1;
          return attempt === 1
            ? apiError(422, 'eval.set_too_small', 'Сыгранных матчей после даты среза знаний модели 120, а нужно не меньше 200. Загрузите свежий файл tennis-data')
            : json(evalSet(), 201);
        },
      },
    });
    const freeze = await within(panel()).findByRole('button', { name: 'Заморозить набор' });
    expect(within(panel()).getByRole('button', { name: 'Оценить на наборе' })).toBeDisabled();
    expect(within(panel()).queryByRole('table')).toBeNull();
    await user.click(freeze);
    expect(await within(panel()).findByText(/^Сыгранных матчей после даты среза знаний модели 120/)).toBeInTheDocument();
    await user.click(freeze);
    expect(await screen.findByText('Набор S-2026-08 заморожен: 250 матчей. Список и его sha256 больше не меняются')).toBeInTheDocument();
  });

  it('сравнение чаще 20 раз в минуту — текст сервера (429)', async () => {
    const { user } = renderVersions({ api: { 'GET /api/strategy/versions/compare': () => apiError(429, 'common.rate_limited', 'Слишком часто — попробуйте через минуту') } });
    await user.click(await within(panel()).findByRole('button', { name: 'Сравнить v3 и v4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение v3 и v4' });
    expect(await within(dialog).findByText('Слишком часто — попробуйте через минуту')).toBeInTheDocument();
  });

  it('375 px: версии — карточки с лог-лоссом, рынком, Brier и токенами; сравнение — списком', async () => {
    const { user } = renderVersions({ width: 375 });
    const cards = await within(panel()).findByRole('list', { name: 'Инструкции анализа' });
    const first = within(cards).getAllByRole('button')[0]!;
    expect(first).toHaveTextContent('v410 октсжатое досьеКандидатЛог-лосс0,615К рынку+0,017Brier0,212Токенов≈ 6,5 тыс.');
    await user.click(within(panel()).getByRole('button', { name: 'Сравнить v3 и v4' }));
    const dialog = await screen.findByRole('dialog', { name: 'Сравнение v3 и v4' });
    expect(await within(dialog).findByText('v3 0,612 → v4 0,615 · разница +0,003')).toBeInTheDocument();
    expect(within(dialog).queryByRole('table')).toBeNull();
  });
});
