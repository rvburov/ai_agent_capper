import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { aiBudget } from '../../features/ai/testData';
import { clearDraft, loadDraft } from '../../features/analysis/draftStore';
import {
  analysisDone,
  analysisDraft,
  analysisRunning,
  bankOut,
  listItem,
  previewOut,
  strategyV3,
} from '../../features/analysis/testData';
import type { Analysis, ConfirmIn } from '../../features/analysis/types';
import { playLimitsOut } from '../../features/bank/testData';
import { apiError, json, ME_ADMIN, ME_MEMBER, mockFetch, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { setViewportWidth } from '../../test/setup';
import { NewAnalysisPage } from './NewAnalysisPage';

const TEXT = 'Синнер vs Руне, Test Open 9, хард, 1/8\nКэфы: П1 = 1.30, П2 = 3.60';

function routes(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/settings': () => json({ currency: 'RUB' }),
    'GET /api/me/bank': () => json(bankOut()),
    'GET /api/me/bookmakers': () => json(['Fonbet']),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    'GET /api/analyses': () => json([listItem({ id: 3 })]),
    'POST /api/analyses': () => json(analysisDraft(), 201),
    'POST /api/analyses/6/preview': () => json(previewOut()),
    ...extra,
  };
}

function renderNew(path = '/new', me: typeof ME_MEMBER | typeof ME_ADMIN = ME_MEMBER) {
  const { router } = renderPage(<NewAnalysisPage />, {
    path: '/new',
    url: path,
    me,
    stubs: { '/analysis/:id': 'Экран анализа' },
  });
  return router;
}

/** Черновик с одним событием: второй игрок — кандидат, которого нужно подтвердить (или его нет). */
function draftWith(status: 'check' | 'missing'): Analysis {
  const analysis = analysisDraft();
  const draft = analysis.draft!;
  const [first] = draft.events;
  draft.events = [
    {
      ...first!,
      player2:
        status === 'check'
          ? { ...first!.player2, status: 'check', raw: 'Рунэ', score: 0.82 }
          : { ...first!.player2, status: 'missing', raw: 'Зверьков', player: null, score: null, candidates: [] },
    },
  ];
  return analysis;
}

/** Причина, по которой запуск недоступен (под кнопкой «Запустить анализ»). */
function launchReason(): HTMLElement | undefined {
  return screen.getAllByRole('status').find((el) => el.classList.contains('new-reason'));
}

afterEach(() => {
  clearDraft();
});

describe('Новый анализ: текст', () => {
  it('разбор → карточки событий → «Перед запуском» → запуск и переход на анализ', async () => {
    const user = userEvent.setup();
    const sent: { run: ConfirmIn | null } = { run: null };
    const { calls } = mockFetch(
      routes({
        'POST /api/analyses/6/run': async (request) => {
          sent.run = (await request.json()) as ConfirmIn;
          return json(analysisRunning({ id: 6 }), 202);
        },
      }),
    );
    const router = renderNew();

    expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeDisabled();
    expect(launchReason()).toHaveTextContent('Вставьте текст с событиями');

    await user.type(screen.getByLabelText('Текст событий'), TEXT.replace(/\n/g, '{Shift>}{Enter}{/Shift}'));
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));

    expect(await screen.findByText('Разобрано · 2 события')).toBeInTheDocument();
    const post = calls.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/analyses');
    expect(await post!.clone().json()).toMatchObject({ input_kind: 'text' });
    expect(screen.getAllByText('Янник Синнер').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Андрей Рублев').length).toBeGreaterThan(0);
    // категория турнира — подписью, а не кодом базы
    expect(document.querySelector('.new-ev-meta-text')).toHaveTextContent(/ · ATP 500( · |$)/);
    await waitFor(() => expect(router.state.location.search).toBe('?draft=6'));

    // «Перед запуском» — по расчету сервера: цена и время
    const launch = await screen.findByRole('button', { name: 'Запустить анализ' });
    await waitFor(() => expect(launch).toBeEnabled());
    expect(screen.getByText(/Займет ~2,1 мин/)).toBeInTheDocument();

    await user.click(launch);
    await waitFor(() => expect(router.state.location.pathname).toBe('/analysis/6'));
    expect(sent.run).toMatchObject({ bank: '48000.00', bookmaker: 'Fonbet' });
    expect((sent.run?.events ?? []).map((e) => [e.player1_id, e.player2_id])).toEqual([
      [1, 6],
      [3, 5],
    ]);
    expect(sent.run?.events?.[0]?.odds.ML).toEqual(['1.3', '3.6']);
  });

  it('другое название турнира — формат матча (до 2 или 3 побед) не переносится со старого', async () => {
    const user = userEvent.setup();
    const sent: { run: ConfirmIn | null } = { run: null };
    mockFetch(
      routes({
        'POST /api/analyses/6/run': async (request) => {
          sent.run = (await request.json()) as ConfirmIn;
          return json(analysisRunning({ id: 6 }), 202);
        },
      }),
    );
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), TEXT.replace(/\n/g, '{Shift>}{Enter}{/Shift}'));
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    await user.click(await screen.findByRole('button', { name: 'Исправить событие 1' }));
    const tour = screen.getByLabelText('Турнир');
    await user.clear(tour);
    await user.type(tour, 'Japan Open');
    await user.click(screen.getByRole('button', { name: 'Готово' }));
    const launch = await screen.findByRole('button', { name: 'Запустить анализ' });
    await waitFor(() => expect(launch).toBeEnabled());
    await user.click(launch);
    await waitFor(() => expect(sent.run).not.toBeNull());
    expect(sent.run?.events?.map((e) => [e.tournament_name, e.best_of])).toEqual([
      ['Japan Open', null],
      ['Test Open 5', 3],
    ]);
  });

  it('Ctrl+Enter разбирает текст; 429 — через сколько минут повторить', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        'POST /api/analyses': () =>
          apiError(429, 'common.rate_limited', 'Too many requests', { retry_after: 1700 }),
      }),
    );
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Руне');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Слишком много разборов за час. Повторите через 29 мин',
    );
  });

  it('слишком длинный текст — ошибка у поля', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        'POST /api/analyses': () =>
          apiError(422, 'analysis.text_too_long', 'Text too long', { max: 20000 }),
      }),
    );
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Руне');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Слишком длинный текст: не больше 20000 символов');
    expect(screen.getByLabelText('Текст событий')).toHaveAttribute('aria-invalid', 'true');
  });

  it('похожий игрок: без подтверждения не запустим, «Да, это …» подтверждает', async () => {
    const user = userEvent.setup();
    mockFetch(routes({ 'POST /api/analyses': () => json(draftWith('check'), 201) }));
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Рунэ');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));

    expect(await screen.findByText('«Рунэ» — это Хольгер Руне?')).toBeInTheDocument();
    expect(await screen.findByText('Подтвердите игрока «Рунэ»')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Да, это Руне' }));
    expect(screen.queryByText('«Рунэ» — это Хольгер Руне?')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeEnabled());
  });

  it('игрока нет в базе — причина и подсказка исправить имя', async () => {
    const user = userEvent.setup();
    mockFetch(routes({ 'POST /api/analyses': () => json(draftWith('missing'), 201) }));
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Зверьков');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    expect(await screen.findByText('«Зверьков» нет в базе ATP')).toBeInTheDocument();
    expect(
      screen.getByText('«Зверьков» нет в базе ATP — анализ с ним не запустим. Исправьте имя или уберите событие'),
    ).toBeInTheDocument();
  });

  it('банк в другой валюте и непонятые строки', async () => {
    const user = userEvent.setup();
    const analysis = analysisDraft();
    analysis.draft = {
      ...analysis.draft!,
      bank: '520.00',
      currency: 'USD',
      ledger_bank: '48000.00',
      bank_note_key: 'analysis.draft.bank_currency',
      unknown_lines: [{ line_no: 3, text: 'Медведев сегодня в форме' }],
    };
    mockFetch(routes({ 'POST /api/analyses': () => json(analysis, 201) }));
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), 'Банк $520');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    expect(
      await screen.findByText(/Банк в тексте в другой валюте: сумму ставки посчитаем от банка по учету/),
    ).toBeInTheDocument();
    expect(screen.getByText('Не понял 1 строку:')).toBeInTheDocument();
    expect(screen.getByText('строка 3: «Медведев сегодня в форме»')).toBeInTheDocument();
  });

  it('убрать событие: остается одно; правка текста — разобрать снова', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Руне');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    await user.click(await screen.findByRole('button', { name: 'Убрать событие 1' }));
    expect(await screen.findByText('Разобрано · 1 событие')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Разобрать заново' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Текст событий'), '!');
    expect(screen.getByText('Текст изменен — разберите заново')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Разобрать' })).toBeInTheDocument();
    expect(launchReason()).toHaveTextContent('Текст изменен — нажмите «Разобрать»');
  });
});

/** «Перед запуском»: новости всех игроков устарели, в оценку вошли новости news игроков. */
function stalePreview(news: number) {
  const preview = previewOut();
  for (const event of preview.events) for (const player of event.players) player.news_fresh = false;
  preview.estimate.news_players = news;
  return preview;
}

describe('Новый анализ: новости в цене', () => {
  it('сверх лимита поисков анализа: «N из M игроков» с причиной, а не все игроки', async () => {
    const user = userEvent.setup();
    mockFetch(routes({ 'POST /api/analyses/6/preview': () => json(stalePreview(2)) }));
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), TEXT.replace(/\n/g, '{Shift>}{Enter}{/Shift}'));
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeEnabled());
    const costs = document.querySelector('.new-costs') as HTMLElement;
    expect(within(costs).getByText('2 из 4 игроков — лимит поисков на анализ')).toBeInTheDocument();
  });

  it('все устаревшие новости входят в лимит — просто число игроков', async () => {
    const user = userEvent.setup();
    mockFetch(routes({ 'POST /api/analyses/6/preview': () => json(stalePreview(4)) }));
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), TEXT.replace(/\n/g, '{Shift>}{Enter}{/Shift}'));
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeEnabled());
    const costs = document.querySelector('.new-costs') as HTMLElement;
    expect(within(costs).getByText('4 игрока')).toBeInTheDocument();
  });
});

describe('Новый анализ: черновик и «Изменить события»', () => {
  it('черновик по адресу /new?draft=ID загружается с сервера', async () => {
    mockFetch(routes({ 'GET /api/analyses/6': () => json(analysisDraft()) }));
    renderNew('/new?draft=6');
    expect(await screen.findByText('Разобрано · 2 события')).toBeInTheDocument();
    expect(screen.getByLabelText('Текст событий')).toHaveValue(analysisDraft().input_text);
  });

  it('запущенный анализ: события подтверждены, запуск создает новый анализ', async () => {
    const user = userEvent.setup();
    const done = analysisDone();
    const created: string[] = [];
    mockFetch(
      routes({
        'GET /api/analyses/1': () => json(done),
        'POST /api/analyses': async (request) => {
          created.push(((await request.json()) as { input_kind: string }).input_kind);
          return json({ ...analysisDraft({ id: 7, input_kind: 'form', status: 'needs_confirmation' }), draft: null }, 201);
        },
        'POST /api/analyses/1/preview': () => json(previewOut()),
        'POST /api/analyses/7/run': () => json(analysisRunning({ id: 7 }), 202),
      }),
    );
    const router = renderNew('/new?draft=1');
    const launch = await screen.findByRole('button', { name: 'Запустить анализ' });
    await waitFor(() => expect(launch).toBeEnabled());
    await user.click(launch);
    await waitFor(() => expect(router.state.location.pathname).toBe('/analysis/7'));
    expect(created).toEqual(['form']);
    // Запущенный анализ живет на своем экране: черновик стерт, адрес анализа — без ?draft
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.search).toBe('');
    expect(loadDraft(ME_MEMBER.id)).toBeNull();
  });

  it('черновика нет или он чужой (404): ошибка и «Начать заново», а не вечная заглушка', async () => {
    const user = userEvent.setup();
    mockFetch(routes({ 'GET /api/analyses/99999': () => apiError(404, 'analysis.not_found', 'Анализ не найден') }));
    const router = renderNew('/new?draft=99999');
    const alert = await screen.findByText(/Черновик не открылся\./);
    expect(alert.closest('[role="alert"]')).toHaveTextContent('Его нет среди ваших анализов');
    expect(screen.queryByLabelText('Текст событий')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Начать заново' }));
    expect(await screen.findByLabelText('Текст событий')).toHaveValue('');
    expect(router.state.location.search).toBe('');
  });

  it('загрузка не удалась, «Новый анализ» в меню (адрес без черновика) — пустой ввод', async () => {
    mockFetch(routes({ 'GET /api/analyses/99999': () => apiError(404, 'analysis.not_found', 'Анализ не найден') }));
    const router = renderNew('/new?draft=99999');
    await screen.findByText(/Черновик не открылся\./);
    await act(() => router.navigate('/new'));
    expect(await screen.findByLabelText('Текст событий')).toHaveValue('');
    expect(router.state.location.search).toBe('');
  });

  it('черновик другого участника в той же вкладке не показывается', async () => {
    const user = userEvent.setup();
    mockFetch(routes());
    const first = renderNew('/new', ME_ADMIN);
    await user.type(screen.getByLabelText('Текст событий'), 'Текущий банк: 77 777 ₽');
    await waitFor(() => expect(loadDraft(ME_ADMIN.id)?.text).toBe('Текущий банк: 77 777 ₽'));
    void first;
    cleanup();
    // Выход и вход другого участника в той же вкладке: черновик стерт, а не показан
    renderNew('/new', ME_MEMBER);
    expect(await screen.findByLabelText('Текст событий')).toHaveValue('');
    expect(loadDraft(ME_ADMIN.id)).toBeNull();
  });

  it('сбой Claude при разборе: «нажмите «Разобрать» еще раз», причина — текст не разобран', async () => {
    const user = userEvent.setup();
    const codes = ['ai.overloaded', 'ai.bad_output'];
    mockFetch(routes({ 'POST /api/analyses': () => apiError(503, codes.shift() ?? 'ai.timeout', 'Claude') }));
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Руне');
    // текст есть, разбора не было — не «Добавьте хотя бы одно событие»
    expect(launchReason()).toHaveTextContent('Текст не разобран — нажмите «Разобрать»');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Claude сейчас перегружен. Нажмите «Разобрать» еще раз через несколько минут');
    expect(alert).not.toHaveTextContent(/Перезапустите анализ/);
    expect(launchReason()).toHaveTextContent('Текст не разобран — нажмите «Разобрать»');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    expect(await screen.findByText('Claude ответил не по схеме. Нажмите «Разобрать» еще раз')).toBeInTheDocument();
  });

  it('нет ключа администратора: администратору — задать ключ и ссылка, участнику — написать администратору', async () => {
    const user = userEvent.setup();
    const noKey = {
      'GET /api/ai/budget': () =>
        json(aiBudget({ has_key: false, monthly_usd: null, left_usd: null, daily_analyses: null, reason_code: 'ai.no_admin_key' })),
      'POST /api/analyses': () => apiError(409, 'ai.no_admin_key', 'Ключ Claude администратора не задан. Напишите администратору'),
    };
    mockFetch(routes(noKey));
    renderNew('/new', ME_ADMIN);
    await waitFor(() =>
      expect(launchReason()).toHaveTextContent('Ключ Claude администратора не задан. Задайте его в «Администрирование → Ключ и бюджет»'),
    );
    expect(screen.getByRole('link', { name: 'Открыть «Ключ и бюджет»' })).toHaveAttribute('href', '/admin/key');
    await user.type(screen.getByLabelText('Текст событий'), 'Синнер vs Руне');
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Задайте его в «Администрирование → Ключ и бюджет»');
    expect(within(alert).getByRole('link', { name: 'Открыть «Ключ и бюджет»' })).toHaveAttribute('href', '/admin/key');
    cleanup();

    mockFetch(routes(noKey));
    renderNew('/new', ME_MEMBER);
    await waitFor(() => expect(launchReason()).toHaveTextContent('Ключ Claude администратора не задан. Напишите администратору'));
    expect(screen.queryByRole('link', { name: 'Открыть «Ключ и бюджет»' })).not.toBeInTheDocument();
  });

  it('пауза и лимит дня — «Перед запуском» говорит сразу, запуск неактивен', async () => {
    // «завтра, 00:00» считается от часов браузера: после 21:00 UTC 14 октября полночь по
    // Хельсинки уже «сегодня». Фиксируем часы на дне фикстуры
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const paused = playLimitsOut({ paused_until: '2026-10-21T21:00:00Z', blocked: 'paused', blocked_until: '2026-10-21T21:00:00Z' });
    const { calls } = mockFetch(
      routes({ 'GET /api/analyses/6': () => json(analysisDraft()), 'GET /api/me/play-limits': () => json(paused) }),
    );
    renderNew('/new?draft=6');
    // тот же последний день, что в кабинете: «до 21 октября включительно»
    await waitFor(() =>
      expect(launchReason()).toHaveTextContent(
        'Вы взяли паузу до 21 октября включительно: новые ставки и анализы недоступны. Досрочно пауза не снимается',
      ),
    );
    expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeDisabled();
    expect(calls.some((r) => r.url.endsWith('/run'))).toBe(false);
    cleanup();

    const stake = playLimitsOut({ stake_per_day: '3000.00', blocked: 'stake_limit', blocked_until: '2026-10-14T21:00:00Z' });
    mockFetch(routes({ 'GET /api/analyses/6': () => json(analysisDraft()), 'GET /api/me/play-limits': () => json(stake) }));
    renderNew('/new?draft=6');
    await waitFor(() =>
      expect(launchReason()).toHaveTextContent(/^Лимит суммы ставок в день \(3 000 ₽\) исчерпан\. Новые ставки и анализы будут доступны завтра, 00:00$/),
    );
    expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeDisabled();
  });

  it('общего бюджета не хватает на этот анализ: администратору — поднять бюджет', async () => {
    const preview = previewOut();
    preview.access = { ...preview.access, allowed: false, reason_code: 'ai.budget_exhausted', reason_params: {} };
    mockFetch(
      routes({
        'GET /api/analyses/6': () => json(analysisDraft()),
        'POST /api/analyses/6/preview': () => json(preview),
      }),
    );
    renderNew('/new?draft=6', ME_ADMIN);
    await waitFor(() => expect(launchReason()).toHaveTextContent(/Поднимите бюджет в «Администрирование → Ключ и бюджет»/));
    expect(screen.getByRole('link', { name: 'Открыть «Ключ и бюджет»' })).toHaveAttribute('href', '/admin/key');
  });

  it('сбой разбора: текст снова в поле, черновик не привязан к упавшему анализу', async () => {
    const failed = analysisDraft({ id: 4, status: 'failed', error: { code: 'ai.overloaded', params: {}, step: 'parse' }, draft: null, input_text: 'Синнер vs Руне' });
    mockFetch(routes({ 'GET /api/analyses/4': () => json(failed) }));
    const router = renderNew('/new?draft=4');
    expect(await screen.findByLabelText('Текст событий')).toHaveValue('Синнер vs Руне');
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});

describe('Новый анализ: сбои запросов', () => {
  for (const [label, handler] of [
    ['ответ 500', () => apiError(500, 'common.internal', 'Внутренняя ошибка сервера')],
    [
      'сеть недоступна',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ] as const) {
    it(`форма: черновик на сервере не создался (${label}) — один запрос, причина и «Повторить»`, async () => {
      const user = userEvent.setup();
      let posts = 0;
      let fail = true;
      mockFetch(
        routes({
          'POST /api/analyses': () => {
            posts += 1;
            if (fail) return (handler as () => Response)();
            return json({ ...analysisDraft({ id: 8, input_kind: 'form', input_text: '' }), draft: null }, 201);
          },
          'POST /api/analyses/8/preview': () => json(previewOut({ events: [] })),
        }),
      );
      renderNew();
      await user.click(screen.getByRole('tab', { name: 'Заполнить форму' }));
      await user.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Добавить событие' }));
      await waitFor(() => expect(posts).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(posts).toBe(1);
      // Сбой виден сразу, блоком с «Повторить»; сами не повторяем
      const block = screen.getByText(/^Черновик анализа не создался:/).closest('[role="alert"]') as HTMLElement;
      expect(block).toBeInTheDocument();
      expect(loadDraft(ME_MEMBER.id)?.analysisId).toBeNull();
      fail = false;
      await user.click(within(block).getByRole('button', { name: 'Повторить' }));
      await waitFor(() => expect(loadDraft(ME_MEMBER.id)?.analysisId).toBe(8));
      expect(posts).toBe(2);
      expect(screen.queryByText(/^Черновик анализа не создался:/)).not.toBeInTheDocument();
    });
  }

  it('«Перед запуском» не посчитался — причина и «Повторить»; 404 — новый черновик для тех же событий', async () => {
    const user = userEvent.setup();
    let previews = 0;
    let fail: 'none' | '500' | '404' = '500';
    mockFetch(
      routes({
        'POST /api/analyses/6/preview': () => {
          previews += 1;
          if (fail === '500') return apiError(500, 'common.internal', 'Внутренняя ошибка сервера');
          if (fail === '404') return apiError(404, 'analysis.not_found', 'Анализ не найден');
          return json(previewOut());
        },
        'POST /api/analyses/9/preview': () => json(previewOut()),
      }),
    );
    renderNew();
    await user.type(screen.getByLabelText('Текст событий'), TEXT.replace(/\n/g, '{Shift>}{Enter}{/Shift}'));
    await user.click(screen.getByRole('button', { name: 'Разобрать' }));
    await screen.findByText('Разобрано · 2 события');
    expect(await screen.findByText(/Не удалось посчитать цену: Внутренняя ошибка сервера/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeDisabled();
    fail = 'none';
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Запустить анализ' })).toBeEnabled());
    expect(previews).toBeGreaterThanOrEqual(2);
  });
});

describe('Новый анализ: форма и телефон', () => {
  it('форма: событие с подсказками игроков из базы', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes({
        'POST /api/analyses': () =>
          json({ ...analysisDraft({ id: 8, input_kind: 'form', input_text: '' }), draft: null }, 201),
        'POST /api/analyses/8/preview': () => json(previewOut({ events: [] })),
        'GET /api/players': (request) => {
          const q = new URL(request.url).searchParams.get('q');
          return json(
            q?.startsWith('Син')
              ? [{ id: 1, name: 'Jannik Sinner', name_ru: 'Янник Синнер', country: 'ITA', score: 0.95, matched: 'Синнер', matches: 40, elo_rank: 1, last_match: '2026-08-27' }]
              : [],
          );
        },
      }),
    );
    renderNew();
    await user.click(screen.getByRole('tab', { name: 'Заполнить форму' }));
    const panel = screen.getByRole('tabpanel');
    await user.click(within(panel).getByRole('button', { name: 'Добавить событие' }));
    const name = await within(panel).findByRole('combobox', { name: /Игрок 1/ });
    await user.type(name, 'Син');
    await user.click(await screen.findByRole('option', { name: /Янник Синнер/ }));
    expect(name).toHaveValue('Янник Синнер');
    expect(launchReason()).toHaveTextContent('Событие 1: укажите обоих игроков');
  });

  it('игрок по подсказкам: пока набирается — без «нет в базе»; уход из поля — по ответу на этот же текст', async () => {
    const user = userEvent.setup();
    const hit = (id: number, name: string, name_ru: string, score: number) => ({ id, name, name_ru, country: 'ARG', score, matched: name_ru, matches: 100, elo_rank: id, last_match: '2026-10-01' });
    const FRAN = hit(31, 'Francisco Cerundolo', 'Франсиско Серундоло', 0.95);
    const JM = hit(77, 'Juan Manuel Cerundolo', 'Хуан Мануэль Серундоло', 0.97);
    const asked: string[] = [];
    mockFetch(
      routes({
        'POST /api/analyses': () => json({ ...analysisDraft({ id: 8, input_kind: 'form', input_text: '' }), draft: null }, 201),
        'POST /api/analyses/8/preview': () => json(previewOut({ events: [] })),
        'GET /api/players': async (request) => {
          const q = new URL(request.url).searchParams.get('q') ?? '';
          asked.push(q);
          if (q.includes('Хуан')) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return json([JM, { ...FRAN, score: 0.6 }]);
          }
          if (q.startsWith('Серундоло')) return json([FRAN, { ...JM, score: 0.93 }]);
          if (q.startsWith('Похож')) return json([{ ...FRAN, score: 0.8 }]);
          return json([]);
        },
      }),
    );
    renderNew();
    await user.click(screen.getByRole('tab', { name: 'Заполнить форму' }));
    const panel = screen.getByRole('tabpanel');
    await user.click(within(panel).getByRole('button', { name: 'Добавить событие' }));
    const field = await within(panel).findByRole('combobox', { name: /Игрок 1/ });
    await user.type(field, 'Серундоло');
    await waitFor(() => expect(asked).toContain('Серундоло'));
    // Набирается — строка под полем подсказывает выбрать, красного «нет в базе» нет
    expect(within(panel).queryByText(/нет в базе ATP/)).not.toBeInTheDocument();
    expect(within(panel).getByText('Выберите игрока из подсказок')).toBeInTheDocument();
    // Уточнили и сразу ушли из поля: подсказки еще по «Серундоло» — Франсиско не подставляем
    await user.type(field, ' Хуан');
    await user.tab();
    expect(loadDraft(ME_MEMBER.id)?.events[0]?.p1.player?.id).not.toBe(FRAN.id);
    // Пришел ответ на «Серундоло Хуан» — подставлен лучший по нему
    await waitFor(() => expect(loadDraft(ME_MEMBER.id)?.events[0]?.p1.player?.id).toBe(JM.id));
    expect(field).toHaveValue('Хуан Мануэль Серундоло');

    // Второй игрок: нет в базе — «нет в базе ATP» только после ухода из поля
    const second = within(panel).getByRole('combobox', { name: /Игрок 2/ });
    await user.type(second, 'Зверьков');
    await waitFor(() => expect(asked).toContain('Зверьков'));
    expect(within(panel).queryByText(/«Зверьков» нет в базе ATP/)).not.toBeInTheDocument();
    await user.tab();
    expect(await within(panel).findByText(/«Зверьков» нет в базе ATP/)).toBeInTheDocument();
    // Похожий (0,7–0,9) — спросить, тот ли это игрок
    await user.clear(second);
    await user.type(second, 'Похожий');
    await waitFor(() => expect(asked).toContain('Похожий'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await user.tab();
    expect(await within(panel).findByText(/«Похожий» — это Франсиско Серундоло\?/)).toBeInTheDocument();
  });

  it('«Последние анализы» — только запущенные, имена как на карточках', async () => {
    const { calls } = mockFetch(routes({ 'GET /api/analyses': () => json({ items: [listItem({ id: 3, decision: 'bet' })], next_cursor: null }) }));
    renderNew();
    const link = await screen.findByRole('link', { name: /^Анализ #A-0003: Синнер — Руне, Джокович — Рублев, готов$/ });
    expect(link).toHaveAttribute('href', '/analysis/3');
    expect(link).toHaveTextContent('ставка сохранена');
    const list = calls.find((r) => new URL(r.url).pathname === '/api/analyses');
    expect(new URL(list!.url).searchParams.get('launched')).toBe('true');
  });

  it('на телефоне — панель запуска снизу', async () => {
    setViewportWidth(375);
    mockFetch(routes());
    renderNew();
    const bar = await screen.findByRole('region', { name: 'Запуск анализа' });
    expect(bar).toHaveTextContent('0 событий · Точный');
    expect(within(bar).getByRole('button', { name: 'Запустить' })).toBeDisabled();
  });
});
