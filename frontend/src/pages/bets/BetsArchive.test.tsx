import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bankOut } from '../../features/analysis/testData';
import {
  archiveClosing,
  betAuto,
  betAwaiting,
  betLeg,
  betLeg2,
  betLegacy,
  betOpen,
  betPage,
  betReview,
  betsSummary,
  betWon,
  legReview,
  newsResult,
} from '../../features/bets/testData';
import type { BetItem } from '../../features/bets/types';
import { fixClock } from '../../test/clock';
import { apiError, json, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { BetsPage } from './BetsPage';

// «Ставки» этапа 5 (bets.js макета, Р25): авторасчет по архиву tennis-data, «ждет результата»,
// закрытие из архива, расхождение с архивом, разбор ИИ и подсказка исхода из новостей.

fixClock('2026-10-13T12:00:00Z');

function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

interface Setup {
  open?: BetItem[];
  history?: BetItem[];
  over?: Record<string, Handler>;
}

/** Ставка, как ее отдает список: подсказку из новостей сервер кладет только в карточку. */
function listed(bet: BetItem): BetItem {
  return { ...bet, legs: bet.legs.map((leg) => ({ ...leg, news_result: null })) };
}

function betsApi({ open = [], history = [betAuto()], over = {} }: Setup = {}): Record<string, Handler> {
  const handlers: Record<string, Handler> = {
    'GET /api/me/bank': () => json(bankOut({ equity: '48000.00', balance: '46680.00', in_play: '1320.00' })),
    'GET /api/bets/summary': () => json(betsSummary()),
    'GET /api/bets': (request) => json(betPage((query(request).get('status') === 'open' ? open : history).map(listed))),
  };
  for (const bet of [...open, ...history]) {
    handlers[`GET /api/bets/${bet.id}`] = () => json(bet);
    // разборы ног еще в очереди
    handlers[`GET /api/bets/${bet.id}/review`] = () => json(betReview({ bet_id: bet.id, state: bet.status === 'open' ? 'open' : 'pending' }, []));
  }
  return { ...handlers, ...over };
}

function renderBets(setup: Setup = {}, width?: number) {
  return renderPage(<BetsPage />, {
    path: '/bets',
    url: '/bets',
    api: betsApi(setup),
    width,
    stubs: { '/analysis/:id': 'Анализ', '/players/:id': 'Игрок', '/new': 'Новый анализ', '/learning': 'Обучение модели' },
  });
}

async function detailOf(id: number): Promise<HTMLElement> {
  const legs = await screen.findByRole('table', { name: `События ставки №${id}` });
  return legs.closest('.bets-detail') as HTMLElement;
}

describe('Ставки: расчет по архиву tennis-data', () => {
  it('авто: метка «авто · архив», когда и по какому архиву, закрытие из архива и «внесите сами» у форы', async () => {
    renderBets({ history: [betAuto()], over: { 'GET /api/bets/9/review': () => json(betReview()) } });
    const row = await screen.findByText('авто · архив 11 окт');
    expect(row.closest('.bets-by')).toHaveAttribute('title', 'Рассчитана автоматически по архиву tennis-data (матчи по 11 окт)');
    const detail = await detailOf(9);
    expect(within(detail).getByText(/^Рассчитана автоматически 12 окт, \d\d:14 по архиву tennis-data \(матчи по 11 окт\)\./)).toBeInTheDocument();
    const legs = within(detail).getByRole('table', { name: 'События ставки №9' });
    const archive = within(legs).getByText('архив tennis-data · Pinnacle');
    expect(archive).toHaveAttribute('title', 'Кэф из архива tennis-data (эталон Pinnacle → Betfair → средний), момент снятия не проверен');
    const byHand = within(legs).getByText('внесите сами');
    expect(byHand).toHaveAttribute('title', 'В архиве tennis-data нет кэфов на форы — закрытие вносите сами');
    // «Исправить результат» — и у ставки, рассчитанной архивом
    expect(within(detail).getByRole('button', { name: 'Исправить результат' })).toBeInTheDocument();
  });

  it('вручную: «внесено вами» и «ручной расчет главнее»', async () => {
    renderBets({ history: [betWon()] });
    expect(await screen.findByText('внесено вами')).toBeInTheDocument();
    const detail = await detailOf(5);
    expect(within(detail).getByText(/^Результат внесли вы 6 окт\. Ручной расчет главнее/)).toBeInTheDocument();
    expect(within(detail).queryByText(/^авто · архив/)).toBeNull();
  });

  it('старый бот: без метки «кто рассчитал», без разбора — пояснение', async () => {
    renderBets({ history: [betLegacy()] });
    const detail = await detailOf(2);
    expect(within(detail).queryByText('внесено вами')).toBeNull();
    expect(within(detail).getByText('Перенесена из старого бота.')).toBeInTheDocument();
    expect(within(detail).getByText(/^Ставки старого бота не разбираются/)).toBeInTheDocument();
  });

  it('расхождение с архивом: пометка у события, «Банк не меняли» и «Исправить результат»', async () => {
    const conflict = betWon({
      id: 6,
      legs: [
        betLeg({ id: 61, result: 'win', score: '2:1', result_source: 'manual', archive_result: 'loss', archive_score: '1:2', score_outcomes: null }),
      ],
    });
    const { user } = renderBets({ history: [conflict] });
    const detail = await detailOf(6);
    expect(within(detail).getByText('архив: 1:2')).toBeInTheDocument();
    const note = within(detail).getByText('Архив показывает другое.').closest('.callout') as HTMLElement;
    expect(note).toHaveTextContent('В файле tennis-data счет матча Синнер — Руне — 1:2: по нему П1 не сыграла, а вы внесли выигрыш. Банк не меняли.');
    await user.click(within(note).getByRole('button', { name: 'Исправить результат' }));
    expect(await screen.findByRole('dialog', { name: 'Исправить результат №6' })).toBeInTheDocument();
  });

  it('без расхождения пометки нет', async () => {
    renderBets({ history: [betAuto()] });
    const detail = await detailOf(9);
    expect(within(detail).queryByText('Архив показывает другое.')).toBeNull();
    expect(within(detail).queryByText(/^архив: /)).toBeNull();
  });
});

describe('Ставки: «ждет результата» и подсказка из новостей', () => {
  it('даты архива с сервера: «матчи по …» и «≈ следующий файл» в карточке и в окне', async () => {
    const bet = betAwaiting({ archive_matches_to: '2026-10-04', next_upload: '2026-10-12' });
    const { user } = renderBets({ open: [bet], history: [] });
    const card = await screen.findByRole('article', { name: 'Открытая ставка №8' });
    expect(
      within(card).getByText(
        /^Матчи сыграны 10 окт\. В архиве tennis-data матчи по 4 окт: ставка рассчитается сама после загрузки файла ≈ 12 окт\./,
      ),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №8' });
    expect(
      within(dialog).getByText(/В архиве tennis-data матчи по 4 окт — ставка рассчитается сама после загрузки файла ≈ 12 окт, с закрытием П1\/П2 из архива/),
    ).toBeInTheDocument();
  });

  it('архив уже дальше дня матча, а исхода нет — «рассчитается сама» не обещаем, «внесите результат сами»', async () => {
    const bet = betAwaiting({ archive_matches_to: '2026-10-11', next_upload: '2026-10-19' });
    const { user } = renderBets({ open: [bet], history: [] });
    const card = await screen.findByRole('article', { name: 'Открытая ставка №8' });
    const reason = within(card).getByText(/^Матчи сыграны 10 окт\. В архиве tennis-data матчи уже по 11 окт, а исхода этой ставки там нет/);
    expect(reason).toHaveTextContent('Сама ставка не рассчитается — внесите результат сами');
    expect(reason).not.toHaveTextContent('рассчитается сама');
    await user.click(within(card).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №8' });
    expect(within(dialog).getByText(/^В архиве tennis-data матчи уже по 11 окт, а исхода этой ставки там нет: сама она не рассчитается\./)).toBeInTheDocument();
    expect(within(dialog).queryByText(/рассчитается сама после загрузки/)).toBeNull();
  });

  it('архив по день матча — еще обещаем авторасчет: день в файле мог быть по другому поясу', async () => {
    renderBets({ open: [betAwaiting({ archive_matches_to: '2026-10-10', next_upload: '2026-10-19' })], history: [] });
    const card = await screen.findByRole('article', { name: 'Открытая ставка №8' });
    expect(within(card).getByText(/В архиве tennis-data матчи по 10 окт: ставка рассчитается сама после загрузки файла ≈ 19 окт/)).toBeInTheDocument();
  });

  it('карточка: метка и причина; окно: пояснение про архив, «Подставить 2:0» заполняет форму, но не сохраняет', async () => {
    const bet = betAwaiting({}, newsResult());
    const { user, calls } = renderBets({ open: [bet], history: [] });
    const card = await screen.findByRole('article', { name: 'Открытая ставка №8' });
    expect(within(card).getByText('Ждет результата')).toBeInTheDocument();
    expect(within(card).queryByText('В игре')).toBeNull();
    expect(within(card).getByText(/^Матчи сыграны 10 окт\. Ставка рассчитается сама, когда исход появится в архиве tennis-data/)).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №8' });
    expect(within(dialog).getByText('Ждет результата')).toBeInTheDocument();
    expect(within(dialog).getByText('Матчи сыграны 10 окт.')).toBeInTheDocument();
    expect(within(dialog).getByText(/ручной расчет главнее, архив его не изменит/)).toBeInTheDocument();
    // в списке подсказки нет (как в настоящем API): окно перечитывает карточку ставки
    const hint = await within(dialog).findByRole('note');
    expect(calls.filter((r) => r.method === 'GET' && new URL(r.url).pathname === '/api/bets/8')).toHaveLength(1);
    expect(hint).toHaveTextContent('Найдено в новостях: Синнер выиграл 6:3 6:4');
    expect(hint).toHaveTextContent('atptour.com · 10 окт · подсказка, проверьте перед сохранением');
    expect(within(hint).getByRole('link', { name: 'atptour.com' })).toHaveAttribute('href', 'https://www.atptour.com/en/news/sinner-rune-2026');
    await user.click(within(hint).getByRole('button', { name: 'Подставить 2:0' }));
    const leg = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    expect(within(leg).getByRole('textbox', { name: 'Счет по сетам' })).toHaveValue('2:0');
    expect(within(leg).getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
    // подсказка ничего не сохраняет: деньги — только по «Сохранить результат»
    expect(calls.some((r) => r.method === 'PUT')).toBe(false);
    expect(within(dialog).getByRole('button', { name: 'Сохранить результат' })).toBeEnabled();
  });

  it('подсказки нет — блока нет; ставка не ждет — обычная метка «В игре»', async () => {
    const { user, calls } = renderBets({ open: [betAwaiting(), betOpen()], history: [] });
    const waiting = await screen.findByRole('article', { name: 'Открытая ставка №8' });
    expect(within(screen.getByRole('article', { name: 'Открытая ставка №7' })).getByText('В игре')).toBeInTheDocument();
    await user.click(within(waiting).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №8' });
    // карточка пришла, подсказки в ней нет
    await waitFor(() => expect(calls.some((r) => r.method === 'GET' && new URL(r.url).pathname === '/api/bets/8')).toBe(true));
    expect(within(dialog).queryByText(/Найдено в новостях/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Подставить/ })).toBeNull();
  });

  it('в новости нет счета по сетам — «Подставить исход» по победителю', async () => {
    const bet = betAwaiting({}, newsResult({ winner: 2, sets: null, score: '7-6(5) 6-7 6-4', source_name: null }));
    const { user } = renderBets({ open: [bet], history: [] });
    await user.click(within(await screen.findByRole('article', { name: 'Открытая ставка №8' })).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №8' });
    const hint = await within(dialog).findByRole('note');
    // счет из новости с дефисами показываем через двоеточие: на дефисе строка рвется внутри сета
    expect(hint).toHaveTextContent('Руне выиграл 7:6(5) 6:7 6:4');
    // имени источника нет — сайт из адреса
    expect(within(hint).getByRole('link', { name: 'atptour.com' })).toBeInTheDocument();
    await user.click(within(hint).getByRole('button', { name: 'Подставить исход' }));
    const leg = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    expect(within(leg).getByRole('button', { name: 'Проиграл' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(leg).getByRole('textbox', { name: 'Счет по сетам' })).toHaveValue('');
  });

  it('снятие — подсказка без кнопки: исход по правилам букмекера выбирает участник', async () => {
    const bet = betAwaiting({}, newsResult({ retired: true, sets: null, score: '6:3 2:0, отказ' }));
    const { user } = renderBets({ open: [bet], history: [] });
    await user.click(within(await screen.findByRole('article', { name: 'Открытая ставка №8' })).getByRole('button', { name: 'Внести результат' }));
    const hint = await within(await screen.findByRole('dialog', { name: 'Результат ставки №8' })).findByRole('note');
    expect(hint).toHaveTextContent('Синнер прошел дальше: соперник снялся (6:3 2:0, отказ)');
    expect(hint).toHaveTextContent('снятие — исход выберите по правилам букмекера');
    expect(within(hint).queryByRole('button')).toBeNull();
  });

  it('ссылка на источник — только http(s)', async () => {
    const bet = betAwaiting({}, newsResult({ source_url: 'javascript:alert(1)' }));
    const { user } = renderBets({ open: [bet], history: [] });
    await user.click(within(await screen.findByRole('article', { name: 'Открытая ставка №8' })).getByRole('button', { name: 'Внести результат' }));
    const hint = await within(await screen.findByRole('dialog', { name: 'Результат ставки №8' })).findByRole('note');
    expect(hint).toHaveTextContent('atptour.com · 10 окт');
    expect(within(hint).queryByRole('link')).toBeNull();
  });
});

describe('Ставки: разбор ИИ', () => {
  it('разбор есть: вывод, что произошло, почему, гипотеза со ссылкой на урок, вердикт по CLV строкой', async () => {
    renderBets({ history: [betAuto()], over: { 'GET /api/bets/9/review': () => json(betReview()) } });
    const detail = await detailOf(9);
    expect(await within(detail).findByText('Ошибка модели')).toBeInTheDocument();
    expect(within(detail).getByText('Что произошло.').parentElement).toHaveTextContent('Модель давала 74%, рынок без маржи 64%.');
    expect(within(detail).getByText('Почему.').parentElement).toHaveTextContent('Соперники близки по Эло на харде');
    const hypothesis = within(detail).getByText('Гипотеза.').parentElement as HTMLElement;
    expect(within(hypothesis).getByRole('link', { name: 'L-022' })).toHaveAttribute('href', '/learning');
    expect(hypothesis).toHaveTextContent('L-022 — гипотеза, 3 из 20 случаев, из них ваших 1. Фора −1.5 на харде');
    // вердикт по CLV — строкой внутри, его считает код
    expect(within(detail).getByText('По CLV, без ИИ:')).toBeInTheDocument();
    expect(within(detail).getByText('Без закрытия')).toBeInTheDocument();
    expect(within(detail).getByText(/^Sonnet 5\.5 · Batch · ≈ \$0,01 за матч · 12 окт, \d\d:20 · один разбор на матч, общий для всех/)).toBeInTheDocument();
  });

  it('гипотеза: общих случаев меньше порога — «меньше 5», свои отдельно (Р14)', async () => {
    const lesson = { id: 22, code: 'L-022', status: 'hypothesis' as const, in_prompt: false, n_cases: null, n_cases_few: true, own_cases: 1, need_cases: 20, text: 'Фора −1.5 на харде' };
    renderBets({ history: [betAuto()], over: { 'GET /api/bets/9/review': () => json(betReview({}, [legReview({ lesson })])) } });
    const detail = await detailOf(9);
    const hypothesis = (await within(detail).findByText('Гипотеза.')).parentElement as HTMLElement;
    expect(hypothesis).toHaveTextContent('L-022 — гипотеза, меньше 5 из 20 случаев, из них ваших 1.');
    expect(hypothesis).not.toHaveTextContent('null');
  });

  it('экспресс: разбор каждого матча со своим выводом; статусы урока; без гипотезы — «Новой гипотезы нет»', async () => {
    const lesson = { id: 22, code: 'L-022', status: 'confirmed' as const, in_prompt: true, n_cases: 20, n_cases_few: false, own_cases: 2, need_cases: 20, text: 'Фора −1.5 на харде' };
    const legs = [
      legReview({ leg_id: 91, match_id: 191, market: 'ML', won: true, verdict: 'fine', what: 'Синнер выиграл 2:0.', why: null, hypothesis: null, lesson: null }),
      legReview({ lesson }),
    ];
    renderBets({ history: [betAuto()], over: { 'GET /api/bets/9/review': () => json(betReview({}, legs)) } });
    const detail = await detailOf(9);
    const first = (await within(detail).findByText('Синнер — Руне · П1')).closest('.bets-review-leg') as HTMLElement;
    expect(within(first).getByText('Прогноз подтвердился')).toBeInTheDocument();
    expect(within(first).getByText('Прогноз подтвердился').closest('[title]')).toHaveAttribute('title', 'Вывод по вашей ставке: сыграла');
    expect(within(first).getByText('Гипотеза.').parentElement).toHaveTextContent('Новой гипотезы нет.');
    expect(within(first).queryByText('Почему.')).toBeNull();
    const second = within(detail).getByText('Джокович — Рублев · Ф1(−1.5)').closest('.bets-review-leg') as HTMLElement;
    expect(within(second).getByText('Ошибка модели')).toBeInTheDocument();
    expect(within(second).getByText('Гипотеза.').parentElement).toHaveTextContent('L-022 — в инструкциях анализа.');
  });

  it('разобран прогноз модели на другой исход — общий разбор матча и свой вывод по ставке', async () => {
    // общий разбор — про фаворита модели (П2), ставка участника на другой исход: вывод по ней — «Невезение»
    const legs = [legReview({ same_pick: false, market: 'ML', selection: 2, won: false, clv: 0.04, verdict: 'luck' })];
    renderBets({ history: [betAuto()], over: { 'GET /api/bets/9/review': () => json(betReview({}, legs)) } });
    const detail = await detailOf(9);
    expect(
      await within(detail).findByText('Разбирали прогноз модели на П2: разбор один на матч, общий для всех, кто на него ставил. Ваша ставка — на другой исход, вывод — по ней.'),
    ).toBeInTheDocument();
    const verdict = within(detail).getByText('Невезение');
    expect(verdict.closest('[title]')).toHaveAttribute('title', 'Вывод по вашей ставке: не сыграла');
    expect(within(detail).getByText('Что произошло.').parentElement).toHaveTextContent('Модель давала 74%');
  });

  it('разбор в очереди или в пакете — «разбор готовится»; часть готова — готовое и «остальные готовятся»', async () => {
    const queued = betAuto({ id: 10, placed_at: '2026-10-07T09:00:00Z' });
    const partly = betAuto({ id: 11, placed_at: '2026-10-06T09:00:00Z' });
    const { user } = renderBets({
      history: [betAuto(), queued, partly],
      over: {
        'GET /api/bets/10/review': () => json(betReview({ bet_id: 10, state: 'pending' }, [legReview({ status: 'submitted', verdict: null, what: null, why: null, hypothesis: null, lesson: null })])),
        'GET /api/bets/11/review': () =>
          json(betReview({ bet_id: 11, state: 'pending' }, [legReview(), legReview({ leg_id: 91, status: 'queued', verdict: null, what: null, why: null, hypothesis: null, lesson: null })])),
      },
    });
    const first = await detailOf(9);
    expect(await within(first).findByText(/^Разбор готовится: запрос в пакете Batch, разбор появится в течение нескольких часов, иногда до суток/)).toBeInTheDocument();
    expect(within(first).getByText('По CLV, без ИИ:')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Детали ставки №10' }));
    expect(await within(await detailOf(10)).findByText(/^Разбор готовится/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Детали ставки №11' }));
    const third = await detailOf(11);
    expect(await within(third).findByText('Ошибка модели')).toBeInTheDocument();
    expect(within(third).getByText(/^Разбор остальных матчей готовится/)).toBeInTheDocument();
  });

  it('разбор не удался; нет прогноза — свой текст', async () => {
    const failed = betAuto({ id: 10, placed_at: '2026-10-07T09:00:00Z' });
    const { user } = renderBets({
      history: [betAuto(), failed],
      over: {
        'GET /api/bets/9/review': () => json(betReview({ state: 'failed' }, [legReview({ status: 'failed', verdict: null })])),
        'GET /api/bets/10/review': () => json(betReview({ bet_id: 10, state: 'not_reviewed', reason: 'no_prediction' }, [])),
      },
    });
    expect(await within(await detailOf(9)).findByText(/^Разбор не получился/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Детали ставки №10' }));
    expect(await within(await detailOf(10)).findByText('Разбора нет: у событий ставки нет прогноза модели.')).toBeInTheDocument();
  });

  it('ставка рассчитана до начала разборов (before_start) — свой текст и вердикт по CLV', async () => {
    renderBets({
      history: [betAuto()],
      over: { 'GET /api/bets/9/review': () => json(betReview({ state: 'not_reviewed', reason: 'before_start' }, [])) },
    });
    const detail = await detailOf(9);
    expect(await within(detail).findByText('Разбора нет: ставка рассчитана до включения разборов ИИ. Разбираются ставки, рассчитанные позже.')).toBeInTheDocument();
    expect(within(detail).getByText('По CLV, без ИИ:')).toBeInTheDocument();
  });

  it('проигранный экспресс рассчитан по архиву, у ноги со снятием исхода нет — «Без исхода», а не «Не записан»', async () => {
    const lost = betAuto({
      status: 'lost',
      profit: '-1320.00',
      payout: '0.00',
      bank_after: '46680.00',
      legs: [
        betLeg({ id: 91, result: 'loss', score: '0:2', settled_at: '2026-10-12T08:14:00Z', result_source: 'auto', closing: archiveClosing(), score_outcomes: null, match: { ...betLeg().match, id: 191, day: '2026-10-09' } }),
        betLeg2({ id: 92, result: null, score: null, settled_at: null, result_source: null, score_outcomes: null, match: { ...betLeg2().match, id: 192, day: '2026-10-09' } }),
      ],
    });
    renderBets({ history: [lost], over: { 'GET /api/bets/9/review': () => json(betReview({ state: 'pending' }, [])) } });
    const detail = await detailOf(9);
    const rows = within(within(detail).getByRole('table', { name: 'События ставки №9' })).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Не зашло');
    expect(rows[1]).toHaveTextContent('Без исхода');
    expect(rows[1]).not.toHaveTextContent('Не записан');
    expect(within(detail).queryByText(/старым ботом/)).toBeNull();
  });

  it('возврат не разбирается — запроса разбора нет', async () => {
    const voided = betWon({ id: 3, status: 'void', profit: '0.00', payout: '1320.00', verdict: 'void', legs: [betLeg({ id: 31, result: 'void', closing: null, score_outcomes: null })] });
    const { calls } = renderBets({ history: [voided] });
    const detail = await detailOf(3);
    expect(within(detail).getByText('Возврат не разбирается: исхода нет.')).toBeInTheDocument();
    expect(calls.some((r) => r.url.endsWith('/review'))).toBe(false);
  });

  it('ошибка загрузки разбора — текст и «Повторить»', async () => {
    let fail = true;
    const { user } = renderBets({
      history: [betAuto()],
      over: { 'GET /api/bets/9/review': () => (fail ? apiError(500, 'internal', 'Сбой') : json(betReview())) },
    });
    const detail = await detailOf(9);
    expect(await within(detail).findByText(/^Разбор не загрузился\./)).toBeInTheDocument();
    fail = false;
    await user.click(within(detail).getByRole('button', { name: 'Повторить' }));
    expect(await within(detail).findByText('Ошибка модели')).toBeInTheDocument();
  });

  it('после ручного расчета — сообщение «разбор появится в течение нескольких часов»', async () => {
    const saved = { ...betOpen(), status: 'won' as const, profit: '1168.20', settled_at: '2026-10-13T12:00:00Z', settled_by: 'manual' as const, updated_at: '2026-10-13T12:00:00.100Z', verdict: 'no_closing' as const };
    const { user } = renderBets({ open: [betOpen()], history: [], over: { 'PUT /api/bets/7/result': () => json(saved), 'GET /api/bets/7/review': () => apiError(404, 'bet.not_found', 'нет') } });
    const card = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    await user.click(within(card).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №7' });
    for (const group of within(dialog).getAllByRole('group', { name: /^Событие/ })) {
      await user.click(within(group).getByRole('button', { name: 'Выиграл' }));
    }
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить результат' }));
    expect(await screen.findByText(/Разбор ИИ появится в течение нескольких часов \(Sonnet 5\.5 через Batch, ≈ \$0,01 за матч\) — в деталях ставки\./)).toBeInTheDocument();
  });
});

describe('Ставки: телефон', () => {
  it('нижний лист: разбор ИИ, кто рассчитал, закрытие из архива и «внесите сами»', async () => {
    const { user } = renderBets({ history: [betAuto()], over: { 'GET /api/bets/9/review': () => json(betReview()) } }, 375);
    const card = await screen.findByRole('button', { name: /^Ставка №9, / });
    await user.click(card);
    const sheet = await screen.findByRole('dialog', { name: 'Ставка №9' });
    expect(await within(sheet).findByText('Ошибка модели')).toBeInTheDocument();
    expect(within(sheet).getByText('Разбор ИИ')).toBeInTheDocument();
    expect(within(sheet).getByText(/^Рассчитана автоматически 12 окт/)).toBeInTheDocument();
    expect(within(sheet).getByText('архив tennis-data · Pinnacle')).toHaveAttribute('title', expect.stringContaining('момент снятия не проверен'));
    expect(within(sheet).getByText('внесите сами')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Исправить' })).toBeInTheDocument();
  });

  it('закрытие внесено участником — без подписи архива', async () => {
    const own = betAuto({ legs: [betLeg({ id: 91, result: 'win', score: '2:0', closing: archiveClosing({ source: 'user', unverified: false }), score_outcomes: null })] });
    renderBets({ history: [own] });
    const detail = await detailOf(9);
    await waitFor(() => expect(within(detail).getByText('эталон · Pinnacle')).not.toHaveAttribute('title'));
  });
});
