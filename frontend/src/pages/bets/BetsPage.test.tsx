import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { bankOut } from '../../features/analysis/testData';
import { betLeg, betLeg2, betLegacy, betLost, betOpen, betPage, betsSummary, betWon } from '../../features/bets/testData';
import type { BetItem } from '../../features/bets/types';
import { apiError, json, type Handler } from '../../test/fetchMock';
import { bodyOf, renderPage } from '../../test/renderPage';
import { BetsPage } from './BetsPage';

/** Даты фикстур — октябрь 2026; в другом году подписи дат получают год. Часы браузера — на 13 октября. */
function fixClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const MONTH = betsSummary({ settled: 2, won: 1, lost: 1, profit: '168.20', turnover: '2320.00', roi: 0.0725 });

function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

/** Ответы «Ставок»: открытая №7, рассчитанные №5 (выигрыш), №4 (проигрыш), №2 (бот). */
function betsApi(over: Record<string, Handler> = {}): Record<string, Handler> {
  const history = [betWon(), betLost(), betLegacy()];
  return {
    'GET /api/me/bank': () => json(bankOut({ equity: '48000.00', balance: '46680.00', in_play: '1320.00' })),
    'GET /api/bets/summary': (request) => json(query(request).has('from') ? MONTH : betsSummary()),
    'GET /api/bets': (request) => {
      const q = query(request);
      if (q.get('status') === 'open') return json(betPage([betOpen()]));
      if (q.get('status') === 'won') return json(betPage([betWon()]));
      return json(betPage([betOpen(), ...history]));
    },
    'GET /api/bets/7': () => json(betOpen()),
    'GET /api/bets/5': () => json(betWon()),
    'GET /api/bets/4': () => json(betLost()),
    ...over,
  };
}

function renderBets(url = '/bets', api: Record<string, Handler> = betsApi(), width?: number) {
  return renderPage(<BetsPage />, { path: '/bets', url, api, width, stubs: { '/analysis/:id': 'Анализ', '/players/:id': 'Игрок', '/new': 'Новый анализ' } });
}

function settledFrom(bet: BetItem, over: Partial<BetItem>): BetItem {
  return { ...bet, status: 'won', profit: '1168.20', settled_at: '2026-10-13T12:00:00Z', updated_at: '2026-10-13T12:00:00.100Z', verdict: 'edge_confirmed', ...over };
}

describe('Ставки: экран', () => {
  it('итоги, «В игре» и история по месяцам с итогами месяца с сервера', async () => {
    const { calls } = renderBets();
    const summary = await screen.findByRole('region', { name: 'Итоги по ставкам' });
    expect(await within(summary).findByText('2 · 1 · 0')).toBeInTheDocument();
    expect(within(summary).getByText('+393 ₽')).toBeInTheDocument();
    expect(within(summary).getByText('+13,9%')).toBeInTheDocument();
    expect(within(summary).getByText('1 из 1')).toBeInTheDocument();
    expect(within(summary).getByText('банк сейчас')).toBeInTheDocument();

    const open = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    expect(within(open).getByText('Экспресс из 2 событий')).toBeInTheDocument();
    expect(within(open).getByText('2 488 ₽')).toBeInTheDocument();
    expect(within(open).getByRole('link', { name: 'Почему эта ставка' })).toHaveAttribute('href', '/analysis/1');
    expect(within(open).getByRole('link', { name: 'Синнер' })).toHaveAttribute('href', '/players/1');

    const table = await screen.findByRole('table', { name: 'Рассчитанные ставки по месяцам' });
    expect(within(table).getByText('Октябрь 2026')).toBeInTheDocument();
    expect(within(table).getByText('Сентябрь 2026')).toBeInTheDocument();
    // открытая ставка в истории не повторяется
    expect(table.querySelector('tr[data-bet="7"]')).toBeNull();
    // самая свежая рассчитанная раскрыта: события с закрытием и вердикт
    const legs = await screen.findByRole('table', { name: 'События ставки №5' });
    expect(within(legs).getAllByText('эталон · Pinnacle')).toHaveLength(2);
    expect(within(legs).getAllByText('+4,0%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Перевес подтвержден').length).toBeGreaterThan(0);
    // «Банк после» — капитал после расчета с сервера (bank_after), браузер его не считает
    const facts = legs.closest('tr')?.parentElement ?? document.body;
    expect(within(facts as HTMLElement).getByText('Банк после').nextElementSibling).toHaveTextContent('49 168 ₽');
    // ставка бота — без CLV, с пометкой
    const bot = table.querySelector('tr[data-bet="2"]') as HTMLElement;
    expect(within(bot).getByText('старый бот')).toBeInTheDocument();
    expect(within(bot).getByTitle('Старый бот закрывающих кэфов не записывал — CLV не считается')).toHaveTextContent('—');

    // итоги месяца — запросом с датами месяца
    await waitFor(() => expect(within(table).getAllByText('+168 ₽')).toHaveLength(2));
    const months = calls.filter((r) => r.url.includes('/api/bets/summary') && query(r).has('from')).map((r) => `${query(r).get('from')}…${query(r).get('to')}`);
    expect(months).toEqual(expect.arrayContaining(['2026-10-01…2026-10-31', '2026-09-01…2026-09-30']));
  });

  it('фильтр статуса — в адресе и в запросах; «В игре» скрыто для рассчитанных', async () => {
    const { user, router, calls } = renderBets();
    await screen.findByRole('article', { name: 'Открытая ставка №7' });
    await user.click(screen.getByRole('button', { name: 'Статус ставки: Все статусы' }));
    await user.click(within(screen.getByRole('listbox', { name: 'Статус ставки' })).getByRole('option', { name: 'Выигрыш' }));
    await waitFor(() => expect(router.state.location.search).toBe('?status=won'));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Открытая ставка №7' })).toBeNull());
    expect(calls.some((r) => r.url.includes('/api/bets?') && query(r).get('status') === 'won')).toBe(true);
    expect(calls.some((r) => r.url.includes('/api/bets/summary') && query(r).get('status') === 'won')).toBe(true);
    expect(screen.getByRole('link', { name: 'Экспорт CSV' })).toHaveAttribute('href', '/api/bets/export.csv?status=won');
    expect(screen.getByText('за все время · выигрыш')).toBeInTheDocument();
  });

  it('вид ставки (Р29): метки «Своя» и «Ординар», фильтр «Вид ставки» — в адресе и в запросах', async () => {
    const api = betsApi({
      'GET /api/bets': (request) => {
        if (query(request).get('status') === 'open') return json(betPage([betOpen({ kind: 'own' })]));
        return json(betPage([betOpen({ kind: 'own' }), betWon(), betLost({ kind: 'single' })]));
      },
      'GET /api/bets/7': () => json(betOpen({ kind: 'own' })),
    });
    const { user, router, calls } = renderBets('/bets', api);
    const open = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    expect(within(open).getByText('Своя')).toBeInTheDocument();
    const row = (await screen.findByRole('table', { name: 'Рассчитанные ставки по месяцам' })).querySelector('tr[data-bet="4"]') as HTMLElement;
    expect(within(row).getByText('Ординар')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Рассчитанные ставки по месяцам' }).querySelector('tr[data-bet="5"] .bets-kind')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Вид ставки: Все ставки' }));
    await user.click(within(screen.getByRole('listbox', { name: 'Вид ставки' })).getByRole('option', { name: 'Свои' }));
    await waitFor(() => expect(router.state.location.search).toBe('?kind=own'));
    expect(calls.some((r) => r.url.includes('/api/bets/summary') && query(r).get('kind') === 'own')).toBe(true);
    expect(screen.getByRole('link', { name: 'Экспорт CSV' })).toHaveAttribute('href', '/api/bets/export.csv?kind=own');
  });

  it('поиск уходит в адрес после паузы ввода', async () => {
    const { user, router } = renderBets();
    await screen.findByRole('article', { name: 'Открытая ставка №7' });
    await user.type(screen.getByRole('searchbox', { name: /Поиск ставок/ }), 'синнер');
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('q')).toBe('синнер'));
  });

  it('результат: счет отмечает исход, закрытие дает CLV, сводка и запрос с версией ставки', async () => {
    const saved = settledFrom(betOpen(), { payout: '2488.20' });
    const { user, calls } = renderBets('/bets', betsApi({ 'PUT /api/bets/7/result': () => json(saved) }));
    const open = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    await user.click(within(open).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №7' });
    const save = within(dialog).getByRole('button', { name: 'Сохранить результат' });
    expect(save).toBeDisabled();

    const sinner = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    await user.type(within(sinner).getByRole('textbox', { name: 'Счет по сетам' }), '2:1');
    expect(within(sinner).getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sinner).getByText('Отметили по счету — можно поправить')).toBeInTheDocument();
    await user.type(within(sinner).getByRole('textbox', { name: 'На ваш исход' }), '1.25');
    expect(within(sinner).getByText('CLV +4,0%')).toBeInTheDocument();
    expect(within(sinner).getByText(/вторая сторона даст CLV без маржи/)).toBeInTheDocument();
    await user.type(within(sinner).getByRole('textbox', { name: /^На обратный исход/ }), '4.2');
    expect(within(sinner).getByText('без маржи +2,2%')).toBeInTheDocument();

    const djokovic = within(dialog).getByRole('group', { name: 'Событие 2: Джокович — Рублев' });
    await user.click(within(djokovic).getByRole('button', { name: 'Проиграл' }));
    // проиграна — видно сразу; банк после — капитал минус сумма
    expect(within(dialog).getByText('−1 320 ₽')).toBeInTheDocument();
    expect(within(dialog).getByText('46 680 ₽')).toBeInTheDocument();
    // счет против выбранного исхода — предупреждение, не запрет (В16)
    await user.type(within(djokovic).getByRole('textbox', { name: 'Счет по сетам' }), '2:0');
    expect(within(djokovic).getByText('По счету ставка выиграла — проверьте, что выбрано верно')).toBeInTheDocument();
    await user.click(within(djokovic).getByRole('button', { name: 'Возврат' }));
    expect(within(dialog).getByText('кэф пересчитан: 1.30')).toBeInTheDocument();
    expect(within(dialog).getByText('Событие с возвратом считается с кэфом 1,00 — так рассчитывают экспрессы букмекеры.')).toBeInTheDocument();
    await user.click(within(djokovic).getByRole('button', { name: 'Выиграл' }));
    expect(within(dialog).getByText('2 488 ₽')).toBeInTheDocument();

    await user.click(save);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Результат ставки №7' })).toBeNull());
    const put = calls.find((r) => r.method === 'PUT');
    expect(await bodyOf(put as Request)).toEqual({
      expected_updated_at: '2026-10-13T08:30:00.123456Z',
      legs: [
        { leg_id: 11, result: 'win', score: '2:1', closing: { odds: '1.25', opp_odds: '4.2', by: 'pinnacle', bookmaker: null } },
        { leg_id: 12, result: 'win', score: '2:0' },
      ],
    });
    expect(await screen.findByText('Ставка №7 рассчитана: выигрыш +1 168 ₽.')).toBeInTheDocument();
  });

  it('гонка: 409 — текст ошибки, карточка перечитана, повтор с новой версией и без чужого закрытия', async () => {
    let version = 0;
    // в другой вкладке внесли закрытие первого события (расчет там отменили — ставка открыта)
    const otherClosing = { odds: '1.800', opp_odds: '2.100', by: 'pinnacle' as const, bookmaker: null, source: 'user' as const, q_close: 0.54, unverified: false };
    const fresh = betOpen({ updated_at: '2026-10-13T09:00:00Z', legs: [betLeg({ closing: otherClosing }), betLeg2()] });
    const { user, calls } = renderBets(
      '/bets',
      betsApi({
        'GET /api/bets/7': () => json(version ? fresh : betOpen()),
        'PUT /api/bets/7/result': () => {
          version += 1;
          return version === 1
            ? apiError(409, 'bet.changed', 'Ставка изменилась')
            : json(settledFrom(betOpen(), { status: 'lost', profit: '-1320.00', verdict: 'no_closing' }));
        },
      }),
    );
    await user.click(within(await screen.findByRole('article', { name: 'Открытая ставка №7' })).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №7' });
    for (const group of within(dialog).getAllByRole('group', { name: /^Событие/ })) {
      await user.click(within(group).getByRole('button', { name: 'Проиграл' }));
    }
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить результат' }));
    // перезагрузка стерла бы введенное: текст говорит, что свежая версия уже в окне
    expect(await within(dialog).findByText('Ставка изменилась в другом окне или вкладке — в окне уже свежая версия. Проверьте поля и сохраните еще раз.')).toBeInTheDocument();
    // поля закрытия, которые участник не трогал, показывают свежую версию; исходы — его
    const first = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    await waitFor(() => expect(within(first).getByRole('textbox', { name: 'На ваш исход' })).toHaveValue('1.80'));
    expect(within(first).getByRole('button', { name: 'Проиграл' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить результат' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Результат ставки №7' })).toBeNull());
    const puts = calls.filter((r) => r.method === 'PUT');
    // закрытие из другой вкладки не стирается: closing не передается
    expect(await bodyOf(puts[1] as Request)).toEqual({
      expected_updated_at: '2026-10-13T09:00:00Z',
      legs: [
        { leg_id: 11, result: 'loss' },
        { leg_id: 12, result: 'loss' },
      ],
    });
  });

  it('гонка: ставку уже рассчитали — окно показывает итог сервера, а не свой', async () => {
    let put = false;
    const lost = settledFrom(betOpen(), {
      status: 'lost',
      profit: '-1320.00',
      payout: '0.00',
      verdict: 'no_closing',
      legs: [betLeg({ result: 'loss', score: '0:2' }), betLeg2({ result: 'win', score: '2:0' })],
    });
    const { user } = renderBets(
      '/bets',
      betsApi({
        'GET /api/bets/7': () => json(put ? lost : betOpen()),
        'PUT /api/bets/7/result': () => {
          put = true;
          return apiError(409, 'bet.settled', 'Ставка уже рассчитана');
        },
      }),
    );
    await user.click(within(await screen.findByRole('article', { name: 'Открытая ставка №7' })).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №7' });
    for (const group of within(dialog).getAllByRole('group', { name: /^Событие/ })) {
      await user.click(within(group).getByRole('button', { name: 'Выиграл' }));
    }
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить результат' }));
    expect(await within(dialog).findByText(/^Ставка уже рассчитана — возможно, в другом окне/)).toBeInTheDocument();
    // исходы и сводка — то, что записал сервер: проигрыш, выплата 0
    const first = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    expect(within(first).getByRole('button', { name: 'Проиграл' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(first).getByRole('textbox', { name: 'Счет по сетам' })).toHaveValue('0:2');
    const sum = dialog.querySelector('.bets-ssum') as HTMLElement;
    expect(within(sum).getByText('Проигрыш')).toBeInTheDocument();
    expect(within(sum).getByText('−1 320 ₽')).toBeInTheDocument();
    expect(within(sum).queryByText('Выигрыш')).toBeNull();
    expect(within(sum).queryByText(/^сейчас/)).toBeNull();
    // текст «уже рассчитана» один, без второй плашки ошибки
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Сохранить результат' })).toBeNull();
  });

  it('исправить результат: сторно с версией, затем окно с прежними значениями', async () => {
    const reopened = betOpen({ ...betWon(), status: 'open', profit: null, verdict: null, settled_at: null, updated_at: '2026-10-13T12:00:00Z', legs: betWon().legs.map((leg) => ({ ...leg, result: null, score: null, score_outcomes: { '2:0': 'win', '2:1': 'win', '1:2': 'loss', '0:2': 'loss' } })) });
    const { user, calls } = renderBets('/bets', betsApi({ 'POST /api/bets/5/reverse': () => json(reopened) }));
    const detail = await screen.findByRole('table', { name: 'События ставки №5' });
    const box = detail.closest('.bets-detail') as HTMLElement;
    await user.click(within(box).getByRole('button', { name: 'Исправить результат' }));
    const confirm = await screen.findByRole('dialog', { name: 'Исправить результат №5' });
    expect(within(confirm).getByText(/выплата 2 488 ₽ спишется обратной проводкой/)).toBeInTheDocument();
    expect(within(confirm).getByText('Банк после сторно')).toBeInTheDocument();
    expect(within(confirm).getByText('46 832 ₽')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Отменить расчет и исправить' }));
    const post = calls.find((r) => r.method === 'POST' && r.url.endsWith('/reverse'));
    expect(await bodyOf(post as Request)).toEqual({ expected_updated_at: '2026-10-06T20:00:00.5Z' });
    const settle = await screen.findByText('Прошлый расчет уже отменен сторно.');
    const dialog = settle.closest('[role="dialog"]') as HTMLElement;
    const first = within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' });
    expect(within(first).getByRole('button', { name: 'Выиграл' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(first).getByRole('textbox', { name: 'Счет по сетам' })).toHaveValue('2:0');
    expect(within(first).getByRole('textbox', { name: 'На ваш исход' })).toHaveValue('1.25');
    expect(within(dialog).getByRole('button', { name: 'Сохранить исправление' })).toBeEnabled();
  });

  it('закрытие позже: только измененные события, CLV ставки в сообщении', async () => {
    const after = { ...betLost(), clv: 0.04 };
    const { user, calls } = renderBets('/bets', betsApi({ 'PUT /api/bets/4/legs/41/closing': () => json(after) }));
    const table = await screen.findByRole('table', { name: 'Рассчитанные ставки по месяцам' });
    await user.click(table.querySelector('tr[data-bet="4"]') as HTMLElement);
    const legs = await screen.findByRole('table', { name: 'События ставки №4' });
    await user.click(within(legs.closest('.bets-detail') as HTMLElement).getByRole('button', { name: 'Внести закрытие' }));
    const dialog = await screen.findByRole('dialog', { name: 'Закрывающие кэфы · №4' });
    await user.type(within(dialog).getByRole('textbox', { name: 'На ваш исход' }), '1.25');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Закрывающие кэфы сохранены: CLV ставки +4,0%')).toBeInTheDocument();
    const put = calls.find((r) => r.method === 'PUT');
    expect(await bodyOf(put as Request)).toEqual({ closing: { odds: '1.25', opp_odds: null, by: 'pinnacle', bookmaker: null } });
  });

  it('ставка бота: в деталях нет закрытия и исправления', async () => {
    const { user } = renderBets();
    const table = await screen.findByRole('table', { name: 'Рассчитанные ставки по месяцам' });
    await user.click(table.querySelector('tr[data-bet="2"]') as HTMLElement);
    const legs = await screen.findByRole('table', { name: 'События ставки №2' });
    const box = legs.closest('.bets-detail') as HTMLElement;
    expect(within(box).getByText(/Ставка перенесена из старого Telegram-бота/)).toBeInTheDocument();
    expect(within(box).queryByRole('button', { name: 'Исправить результат' })).toBeNull();
    expect(within(box).queryByRole('button', { name: /закрыти|Закрывающие/ })).toBeNull();
  });

  it('/bets?bet=7 открывает окно результата, неизвестная ставка — сообщение', async () => {
    const { router } = renderBets('/bets?bet=7');
    expect(await screen.findByRole('dialog', { name: 'Результат ставки №7' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('/bets?bet=99 — ставки нет', async () => {
    renderBets('/bets?bet=99', betsApi({ 'GET /api/bets/99': () => apiError(404, 'bet.not_found', 'Ставка не найдена') }));
    expect(await screen.findByText('Ставка №99 не найдена')).toBeInTheDocument();
  });

  it('телефон: карточки, нижний лист и шторка фильтров с числом ставок', async () => {
    fixClock();
    const { user, calls } = renderBets('/bets', betsApi(), 375);
    const history = await screen.findByRole('region', { name: 'История ставок' });
    const card = await within(history).findByRole('button', { name: /^Ставка №5, 5 окт, Выигрыш, \+1\s168\s₽/ });
    await user.click(card);
    const sheet = await screen.findByRole('dialog', { name: 'Ставка №5' });
    expect(within(sheet).getByRole('button', { name: 'Исправить' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Закрытие' })).toBeInTheDocument();
    await user.click(within(sheet).getAllByRole('button', { name: 'Закрыть' }).at(-1) as HTMLElement);

    await user.click(screen.getByRole('button', { name: 'Фильтры' }));
    const filters = await screen.findByRole('dialog', { name: 'Фильтры' });
    expect(await within(filters).findByRole('button', { name: 'Показать 4 ставки' })).toBeEnabled();
    await user.click(within(within(filters).getByRole('group', { name: 'Покрытие' })).getByRole('button', { name: 'Грунт' }));
    await waitFor(() => expect(calls.some((r) => r.url.includes('/api/bets/summary') && query(r).get('surface') === 'clay')).toBe(true));
    await user.click(within(filters).getByRole('button', { name: /^Показать/ }));
    expect(await screen.findByRole('button', { name: 'Убрать фильтр: Грунт' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Фильтры, выбрано: 1' })).toBeInTheDocument();
  });
});

/** Открытые ставки №100…№81 — ими целиком занята первая страница истории без фильтра статуса. */
function manyOpen(count = 20): BetItem[] {
  return Array.from({ length: count }, (_, i) => betOpen({ id: 100 - i, analysis_id: null }));
}

describe('Ставки: история, ссылки и ошибки', () => {
  it('история без фильтра статуса — запрос status=settled: открытые страницу не занимают', async () => {
    const open = manyOpen();
    const { calls } = renderBets(
      '/bets',
      betsApi({
        'GET /api/bets': (request) => {
          const q = query(request);
          if (q.get('status') === 'open') return json(betPage(open));
          if (q.get('status') === 'settled') return json(betPage([betWon(), betLost()]));
          return json(betPage(open, 81));
        },
        'GET /api/bets/summary': (request) => json(query(request).has('from') ? MONTH : betsSummary({ settled: 2, open: 20 })),
      }),
    );
    const table = await screen.findByRole('table', { name: 'Рассчитанные ставки по месяцам' });
    expect(within(table).getByText('Октябрь 2026')).toBeInTheDocument();
    expect(table.querySelector('tr[data-bet="5"]')).not.toBeNull();
    expect(table.querySelector('tr[data-bet="4"]')).not.toBeNull();
    expect(screen.getByText('Показано 2 из 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Показать еще/ })).toBeNull();
    const lists = calls.filter((r) => new URL(r.url).pathname === '/api/bets');
    // «В игре» — status=open, история — status=settled; списка без статуса нет
    expect(lists.map((r) => query(r).get('status')).sort()).toEqual(['open', 'settled']);
  });

  it('ссылка «Все N ставок за период» с главной: status=settled в адресе — только история', async () => {
    const { calls } = renderBets(
      '/bets?period=30d&status=settled',
      betsApi({
        'GET /api/bets': (request) => json(betPage(query(request).get('status') === 'settled' ? [betWon(), betLost()] : [])),
        'GET /api/bets/summary': (request) => json(query(request).has('from') ? MONTH : betsSummary({ settled: 2, open: 0 })),
      }),
    );
    expect(await screen.findByRole('table', { name: 'Рассчитанные ставки по месяцам' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Фильтры ставок' })).getByText('Рассчитанные')).toBeInTheDocument();
    const lists = calls.filter((r) => new URL(r.url).pathname === '/api/bets');
    expect(lists.every((r) => query(r).get('status') === 'settled' && query(r).get('period') === '30d')).toBe(true);
  });

  it('рассчитанных нет: «пусто» — только когда страниц больше нет', async () => {
    renderBets(
      '/bets',
      betsApi({
        'GET /api/bets': () => json(betPage([betOpen()])),
        'GET /api/bets/summary': () => json(betsSummary({ settled: 0, won: 0, lost: 0, winrate: null, open: 1 })),
      }),
    );
    expect(await screen.findByText('Рассчитанных ставок пока нет. Внесите результат открытой ставки после матча.')).toBeInTheDocument();
  });

  it('ошибка загрузки — плашка с «Повторить», без ложных «пусто» и вечного скелета', async () => {
    const fail = () => apiError(500, 'common.internal', 'Сбой сервера');
    renderBets('/bets', betsApi({ 'GET /api/bets': fail, 'GET /api/bets/summary': fail }));
    expect(await screen.findByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(await screen.findByText('Итоги не загрузились.')).toBeInTheDocument();
    expect(await screen.findByText('История не загрузилась.')).toBeInTheDocument();
    expect(screen.queryByText(/Открытых ставок нет/)).toBeNull();
    expect(screen.queryByText(/Рассчитанных ставок пока нет/)).toBeNull();
  });

  it('упала только история — итоги есть, а история не говорит «пусто»', async () => {
    renderBets(
      '/bets',
      betsApi({
        'GET /api/bets': (request) => (query(request).get('status') === 'open' ? json(betPage([betOpen()])) : apiError(500, 'common.internal', 'Сбой сервера')),
      }),
    );
    expect(await screen.findByText('История не загрузилась.')).toBeInTheDocument();
    expect(screen.queryByText(/Рассчитанных ставок пока нет/)).toBeNull();
    expect(await screen.findByRole('article', { name: 'Открытая ставка №7' })).toBeInTheDocument();
  });

  it('/bets?bet=ID на компьютере: страницы дочитываются до ставки, строка раскрыта, листа нет', async () => {
    const first = Array.from({ length: 20 }, (_, i) => betWon({ id: 60 - i }));
    const { router, calls } = renderBets(
      '/bets?bet=4',
      betsApi({
        'GET /api/bets': (request) => {
          const q = query(request);
          if (q.get('status') === 'open') return json(betPage([betOpen()]));
          if (q.get('before') === '41') return json(betPage([betLost()]));
          return json(betPage(first, 41));
        },
        'GET /api/bets/summary': (request) => json(query(request).has('from') ? MONTH : betsSummary({ settled: 21 })),
      }),
    );
    expect(await screen.findByRole('table', { name: 'События ставки №4' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((r) => query(r).get('before') === '41')).toBe(true);
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('/bets?bet=ID с фильтрами, под которые ставка не попадает: фильтры сбрасываются', async () => {
    const { router } = renderBets(
      '/bets?status=won&bet=4',
      betsApi({
        'GET /api/bets': (request) => {
          const q = query(request);
          if (q.get('status') === 'won') return json(betPage([betWon()]));
          if (q.get('status') === 'open') return json(betPage([betOpen()]));
          return json(betPage([betOpen(), betWon(), betLost()]));
        },
      }),
    );
    expect(await screen.findByRole('table', { name: 'События ставки №4' })).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('/bets?bet=ID неизвестной ставки — одно сообщение, а не два', async () => {
    renderBets('/bets?bet=99', betsApi({ 'GET /api/bets/99': () => apiError(404, 'bet.not_found', 'Ставка не найдена') }));
    expect(await screen.findByText('Ставка №99 не найдена')).toBeInTheDocument();
    await screen.findByRole('table', { name: 'Рассчитанные ставки по месяцам' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getAllByText('Ставка №99 не найдена')).toHaveLength(1);
  });

  it('/bets?new=ID — новая ставка из анализа подсвечена', async () => {
    const { router } = renderBets('/bets?new=7');
    const card = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    expect(card).toHaveClass('is-new');
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });

  it('поиск из двух слов: пробел после паузы не пропадает', async () => {
    const { user, router } = renderBets();
    await screen.findByRole('article', { name: 'Открытая ставка №7' });
    const box = screen.getByRole('searchbox', { name: /Поиск ставок/ });
    await user.type(box, 'Синнер ');
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('q')).toBe('Синнер'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(box).toHaveValue('Синнер ');
    await user.type(box, 'Руне');
    expect(box).toHaveValue('Синнер Руне');
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get('q')).toBe('Синнер Руне'));
    expect(box).toHaveValue('Синнер Руне');
  });

  it('одна граница дат — подпись «с …» или «по …», как у метки фильтра', async () => {
    fixClock();
    renderBets('/bets?from=2026-10-01');
    const summary = await screen.findByRole('region', { name: 'Итоги по ставкам' });
    expect(within(summary).getByText('с 1 окт')).toBeInTheDocument();
  });

  it('после расчета: банк в сообщении — только перечитанный, фокус — на сообщении', async () => {
    const saved = settledFrom(betOpen(), { payout: '2488.20' });
    let settledNow = false;
    let release: () => void = () => undefined;
    const slowBank = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = renderBets(
      '/bets',
      betsApi({
        'GET /api/me/bank': async () => {
          if (!settledNow) return json(bankOut({ equity: '48000.00', balance: '46680.00', in_play: '1320.00' }));
          await slowBank;
          return json(bankOut({ equity: '49168.20', balance: '49168.20', in_play: '0.00' }));
        },
        'PUT /api/bets/7/result': () => {
          settledNow = true;
          return json(saved);
        },
      }),
    );
    const open = await screen.findByRole('article', { name: 'Открытая ставка №7' });
    const button = within(open).getByRole('button', { name: 'Внести результат' });
    button.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №7' });
    for (const group of within(dialog).getAllByRole('group', { name: /^Событие/ })) {
      await user.click(within(group).getByRole('button', { name: 'Выиграл' }));
    }
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить результат' }));
    const banner = (await screen.findByText('Ставка №7 рассчитана: выигрыш +1 168 ₽.')).closest('.bets-banner') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(banner));
    // пока /api/me/bank не ответил — прежний банк не показываем
    expect(within(banner).queryByText(/Банк —/)).toBeNull();
    const summary = screen.getByRole('region', { name: 'Итоги по ставкам' });
    expect(within(summary).queryByText('48 000 ₽')).toBeNull();
    release();
    expect(await within(banner).findByText(/Банк — 49 168 ₽\./)).toBeInTheDocument();
  });

  it('исправить результат: двойной клик — одно сторно', async () => {
    const reopened = betOpen({ ...betWon(), status: 'open', profit: null, verdict: null, settled_at: null, updated_at: '2026-10-13T12:00:00Z' });
    const { user, calls } = renderBets('/bets', betsApi({ 'POST /api/bets/5/reverse': () => json(reopened) }));
    const detail = await screen.findByRole('table', { name: 'События ставки №5' });
    await user.click(within(detail.closest('.bets-detail') as HTMLElement).getByRole('button', { name: 'Исправить результат' }));
    const confirm = await screen.findByRole('dialog', { name: 'Исправить результат №5' });
    await user.dblClick(within(confirm).getByRole('button', { name: 'Отменить расчет и исправить' }));
    expect(await screen.findByText('Прошлый расчет уже отменен сторно.')).toBeInTheDocument();
    expect(calls.filter((r) => r.method === 'POST' && r.url.endsWith('/reverse'))).toHaveLength(1);
  });

  it('возврат ноги: пересчитанный кэф с тремя знаками, как у сервера', async () => {
    const bet = betOpen({
      id: 8,
      stake: '777.77',
      total_odds: '2.810',
      payout: '2185.53',
      legs: [betLeg({ odds_taken: '1.335' }), betLeg2({ odds_taken: '2.105' })],
    });
    const { user } = renderBets('/bets', betsApi({ 'GET /api/bets': () => json(betPage([bet])), 'GET /api/bets/8': () => json(bet) }));
    await user.click(within(await screen.findByRole('article', { name: 'Открытая ставка №8' })).getByRole('button', { name: 'Внести результат' }));
    const dialog = await screen.findByRole('dialog', { name: 'Результат ставки №8' });
    expect(within(dialog).getByText('кэф 2.81')).toBeInTheDocument();
    await user.click(within(within(dialog).getByRole('group', { name: 'Событие 1: Синнер — Руне' })).getByRole('button', { name: 'Выиграл' }));
    await user.click(within(within(dialog).getByRole('group', { name: 'Событие 2: Джокович — Рублев' })).getByRole('button', { name: 'Возврат' }));
    // 777,77 × 1,335 = 1 038,32: так считает сервер
    expect(within(dialog).getByText('кэф пересчитан: 1.335')).toBeInTheDocument();
    expect(within(dialog).getByText('1 038 ₽')).toBeInTheDocument();
  });
});

describe('Ставки: ссылка на ставку, когда история не загрузилась', () => {
  it('/bets?bet=ID: история с ошибкой — детали листом, а не вечное ожидание', async () => {
    renderBets(
      '/bets?bet=4',
      betsApi({
        'GET /api/bets': (request) => (query(request).get('status') === 'open' ? json(betPage([betOpen()])) : apiError(500, 'common.internal', 'Сбой сервера')),
      }),
    );
    expect(await screen.findByRole('dialog', { name: 'Ставка №4' })).toBeInTheDocument();
  });
});
