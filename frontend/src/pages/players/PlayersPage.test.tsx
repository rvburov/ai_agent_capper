import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { archiveInfo, playerRow, rankingOut, RUNE_ROW } from '../../features/players/testData';
import type { PlayerRow } from '../../features/players/types';
import { apiError, json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { PlayersPage } from './PlayersPage';

function query(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

function renderPlayers(url = '/players', handler: Handler = () => json(rankingOut()), options: { width?: number; admin?: boolean } = {}) {
  return renderPage(<PlayersPage />, {
    path: '/players',
    url,
    api: { 'GET /api/players/ranking': handler },
    stubs: { '/players/:id': 'Карточка игрока' },
    ...(options.width ? { width: options.width } : {}),
    ...(options.admin ? { me: ME_ADMIN } : {}),
  });
}

/** n игроков с номерами from…from+n−1. */
function rows(from: number, n: number): PlayerRow[] {
  return Array.from({ length: n }, (_, i) => playerRow({ id: from + i, name: `Player ${from + i}`, name_ru: null, rank: from + i }));
}

// Даты фикстур — 12–13 октября 2026. «Сегодня», месяц и год в подписях считаются от часов
// браузера: фиксируем их, иначе завтра (1 ноября, 1 января) тесты станут красными
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Игроки: список', () => {
  it('плитки, таблица и строка итогов — числа с сервера', async () => {
    const { calls } = renderPlayers();
    const table = await screen.findByRole('table', { name: 'Игроки' });
    const sinner = within(table).getByRole('link', { name: 'Янник Синнер' }).closest('tr')!;
    expect(sinner).toHaveTextContent('№1');
    expect(within(sinner).getByText('2150')).toBeInTheDocument();
    expect(within(sinner).getByText('2180')).toBeInTheDocument();
    expect(within(sinner).getByText('+30 к общему')).toBeInTheDocument();
    expect(within(sinner).getByText('8–2')).toBeInTheDocument();
    expect(within(sinner).getByText('Шанхай, 1/8 финала')).toBeInTheDocument();
    expect(within(sinner).getByText('Свежие')).toBeInTheDocument();
    expect(within(sinner).getByTitle('Италия')).toHaveTextContent('ITA');
    const rune = within(table).getByRole('link', { name: 'Хольгер Руне' }).closest('tr')!;
    expect(within(rune).getByTitle('Матч сегодня в ваших ставках или анализах')).toHaveTextContent('сегодня');
    expect(within(rune).getByText('Не искали')).toBeInTheDocument();
    expect(within(rune).getByText('−15 к общему')).toBeInTheDocument();

    const tile = (label: string) => screen.getByText(label, { selector: '.stat-label' }).closest('section')!;
    expect(tile('Игроков в базе')).toHaveTextContent('2 790');
    expect(tile('Играли за 52 недели')).toHaveTextContent('412');
    expect(tile('Результаты в базе')).toHaveTextContent('по 12 октзагрузка сегодня, 04:10 UTC');
    expect(tile('Новости за 12 ч')).toHaveTextContent('18');
    expect(screen.getByText(/^Показано 2 из 2/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Показать еще/ })).toBeNull();
    // строка авторства Сакманна — его архив загружался
    expect(screen.getByText(/Jeff Sackmann, tennis_atp \(CC BY-NC-SA 4\.0\)/)).toBeInTheDocument();
    const q = query(calls.find((r) => r.url.includes('/api/players/ranking'))!);
    expect(Object.fromEntries(q)).toEqual({ data: 'active', surface: 'hard', sort: 'rank', offset: '0', limit: '50' });
  });

  it('поиск — в адрес и в запрос после паузы; с опечаткой — подпись «с учетом опечаток»', async () => {
    const { user, router, calls } = renderPlayers('/players', (request) =>
      json(query(request).get('q') ? rankingOut({ items: [playerRow()], query: 'синер', fuzzy: true }) : rankingOut()),
    );
    await screen.findByRole('table', { name: 'Игроки' });
    await user.type(screen.getByRole('searchbox', { name: 'Поиск' }), 'синер');
    await waitFor(() => expect(router.state.location.search).toBe('?q=%D1%81%D0%B8%D0%BD%D0%B5%D1%80'));
    expect(await screen.findByText(/^Найден 1 игрок по всей базе, с учетом опечаток/)).toBeInTheDocument();
    expect(calls.some((r) => query(r).get('q') === 'синер' && query(r).get('offset') === '0')).toBe(true);
  });

  it('никого не нашли — текст про опечатки и «Сбросить фильтры» очищает поиск', async () => {
    const { user, router } = renderPlayers('/players?q=zzz&data=all', (request) => json(rankingOut(query(request).get('q') ? { items: [], total: 0, query: 'zzz' } : {})));
    expect(await screen.findByText('В базе нет игрока «zzz» даже с учетом опечаток. Проверьте написание: можно по-русски или латиницей.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сбросить фильтры' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(await screen.findByRole('table', { name: 'Игроки' })).toBeInTheDocument();
  });

  it('фильтры — в адресе: какие игроки, покрытие для Эло и сортировка', async () => {
    const { user, router, calls } = renderPlayers();
    await screen.findByRole('table', { name: 'Игроки' });
    await user.click(within(screen.getByRole('group', { name: 'Какие игроки' })).getByRole('button', { name: /Вся база/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?data=all'));
    await user.click(within(screen.getByRole('group', { name: 'Покрытие для Эло' })).getByRole('button', { name: 'Грунт' }));
    await waitFor(() => expect(router.state.location.search).toBe('?data=all&surface=clay'));
    expect(await screen.findByRole('columnheader', { name: 'Эло · Грунт' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сортировка: Место по Эло' }));
    await user.click(within(screen.getByRole('listbox', { name: 'Сортировка' })).getByRole('option', { name: 'Последний матч в базе' }));
    await waitFor(() => expect(router.state.location.search).toBe('?data=all&surface=clay&sort=last'));
    await waitFor(() => expect(calls.some((r) => query(r).get('sort') === 'last' && query(r).get('surface') === 'clay' && query(r).get('data') === 'all')).toBe(true));
    // счетчики в переключателе — с сервера
    expect(within(screen.getByRole('group', { name: 'Какие игроки' })).getByRole('button', { name: /Вся база/ })).toHaveTextContent('Вся база2 790');
  });

  it('страницы по 50 с сервера: «Показать еще» дочитывает следующую, страница — в адресе', async () => {
    const handler: Handler = (request) => {
      const offset = Number(query(request).get('offset'));
      return json(rankingOut({ items: offset === 0 ? rows(1, 50) : rows(51, 20), total: 70, offset }));
    };
    const { user, router, calls } = renderPlayers('/players', handler);
    await screen.findByRole('table', { name: 'Игроки' });
    expect(screen.getByText(/^Показано 50 из 70/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Показать еще 20' }));
    await waitFor(() => expect(router.state.location.search).toBe('?page=2'));
    expect(await screen.findByText(/^Показано 70 из 70/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(71);
    expect(calls.map((r) => query(r).get('offset'))).toEqual(expect.arrayContaining(['0', '50']));
    expect(screen.queryByRole('button', { name: /^Показать еще/ })).toBeNull();
  });

  it('открытие со страницей 2 в адресе — обе страницы подряд', async () => {
    const handler: Handler = (request) => {
      const offset = Number(query(request).get('offset'));
      return json(rankingOut({ items: offset === 0 ? rows(1, 50) : rows(51, 5), total: 55, offset }));
    };
    renderPlayers('/players?page=2', handler);
    expect(await screen.findByText(/^Показано 55 из 55/)).toBeInTheDocument();
  });

  it('строка открывает карточку игрока', async () => {
    const { user, router } = renderPlayers();
    const table = await screen.findByRole('table', { name: 'Игроки' });
    await user.click(within(table).getByText('2150'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/players/1'));
  });

  it('архив устарел: участнику — «администратор получил уведомление», администратору — команда', async () => {
    const stale = rankingOut({ archive: archiveInfo({ stale: true, stale_days: 4, data_to: '2026-10-08' }) });
    const view = renderPlayers('/players', () => json(stale));
    expect(await screen.findByText('Архив матчей не обновлялся 4 дня.')).toBeInTheDocument();
    expect(screen.getByText(/Архив обновляет администратор/)).toBeInTheDocument();
    expect(screen.getByText(/ · 4 дня без обновления/)).toBeInTheDocument();
    view.unmount();
    renderPlayers('/players', () => json(stale), { admin: true });
    expect(await screen.findByText('bash deploy/local.sh data')).toBeInTheDocument();
  });

  it('загрузок в журнале нет, а матчи в базе есть — не «еще не загружался»; строка Сакманна на месте', async () => {
    const archive = archiveInfo({ stale: true, stale_days: null, last_load: null, data_to: '2026-08-30', sources: [{ source: 'sackmann', last_load: null }, { source: 'tennis_data', last_load: null }] });
    renderPlayers('/players', () => json(rankingOut({ archive })));
    expect(await screen.findByText('Не все архивы матчей загружались.')).toBeInTheDocument();
    expect(screen.queryByText(/еще не загружался/)).toBeNull();
    expect(screen.getByText(/В базе нет матчей после 30 авг/)).toBeInTheDocument();
    expect(screen.getByText(/Jeff Sackmann, tennis_atp \(CC BY-NC-SA 4\.0\)/)).toBeInTheDocument();
  });

  it('ошибка загрузки — текст и «Повторить», без ложного «никого не нашли»', async () => {
    let fail = true;
    const { user } = renderPlayers('/players', () => (fail ? apiError(503, 'common.unavailable', 'Сервер недоступен') : json(rankingOut())));
    expect(await screen.findByText(/Список игроков не загрузился/)).toBeInTheDocument();
    expect(screen.queryByText('Никого не нашли по этим условиям.')).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await screen.findByRole('table', { name: 'Игроки' })).toBeInTheDocument();
  });

  it('телефон 375: строки — ссылки на карточку с местом, Эло и формой, без таблицы', async () => {
    renderPlayers('/players', () => json(rankingOut({ items: [playerRow(), playerRow(RUNE_ROW)] })), { width: 375 });
    const list = await screen.findByRole('list', { name: 'Игроки' });
    expect(screen.queryByRole('table')).toBeNull();
    const sinner = within(list).getAllByRole('link')[0]!;
    expect(sinner).toHaveAttribute('href', '/players/1');
    expect(sinner).toHaveTextContent('Янник Синнер');
    expect(sinner).toHaveTextContent('№1 по Эло');
    expect(sinner).toHaveTextContent('Матч в базе: 12 окт · Шанхай');
    expect(within(list).getAllByRole('link')[1]).toHaveTextContent('Новости: не искали');
    // короткие подписи переключателя на телефоне
    expect(within(screen.getByRole('group', { name: 'Какие игроки' })).getByRole('button', { name: /За 52 нед\./ })).toBeInTheDocument();
  });
});
