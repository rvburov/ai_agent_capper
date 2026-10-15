import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { h2hOut, legacyProfile, matchesOut, newsOut, playerCard, todayMatch } from '../../features/players/testData';
import type { PlayerCard } from '../../features/players/types';
import { apiError, json, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { PlayerPage } from './PlayerPage';

function renderCard(url: string, card: PlayerCard | Handler = playerCard(), over: Record<string, Handler> = {}, width?: number) {
  const handler: Handler = typeof card === 'function' ? card : () => json(card);
  return renderPage(<PlayerPage />, {
    path: '/players/:id/:tab?',
    url,
    api: {
      'GET /api/players/1': handler,
      'GET /api/players/1/matches': () => json(matchesOut()),
      'GET /api/players/1/news': () => json(newsOut()),
      'GET /api/players/1/h2h/6': () => json(h2hOut()),
      ...over,
    },
    stubs: { '/bets': 'Экран ставок', '/analysis/:id': 'Анализ', '/players': 'Список игроков' },
    ...(width ? { width } : {}),
  });
}

function cardOf(title: string): HTMLElement {
  return screen.getByRole('heading', { level: 3, name: title }).closest('section')!;
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

describe('Карточка игрока', () => {
  it('шапка и «Обзор» без профиля бота и без «сегодня»', async () => {
    renderCard('/players/1');
    const hero = await screen.findByRole('region', { name: 'Игрок Янник Синнер' });
    expect(within(hero).getByRole('heading', { level: 2, name: 'Янник Синнер' })).toBeInTheDocument();
    expect(within(hero).getByText(/Италия · 25 лет · правша, двуручный бэкхенд/)).toBeInTheDocument();
    expect(within(hero).getByText('Лучшее покрытие по Эло — хард')).toBeInTheDocument();
    expect(within(hero).queryByText('Есть профиль из старого бота')).toBeNull();
    expect(within(hero).getByText('Новости свежие')).toBeInTheDocument();
    expect(within(hero).getByText('Матч в базе: 12 окт')).toBeInTheDocument();
    expect(within(hero).getByText(/Шанхай, 1\/8 финала · архив загружен .*04:10 UTC/)).toBeInTheDocument();
    expect(within(hero).getByText('№1')).toBeInTheDocument();
    expect(within(hero).getByText('+30 к общему')).toBeInTheDocument();
    expect(within(hero).getByText('1–1')).toBeInTheDocument();

    const tabs = screen.getByRole('tablist', { name: 'Разделы карточки игрока' });
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Обзор', 'Матчи', 'Новости']);
    expect(within(tabs).getByRole('tab', { name: 'Матчи' })).toHaveAttribute('href', '/players/1/matches');

    const elo = cardOf('Эло по покрытиям');
    expect(within(elo).getByRole('list', { name: 'Эло по покрытиям и разница с общим' })).toHaveTextContent('Хард2180+30');
    expect(within(elo).getByText('−60')).toBeInTheDocument();
    expect(within(elo).queryByText(/^Сегодня:/)).toBeNull();

    const form = cardOf('Форма');
    expect(within(form).getByRole('img', { name: 'Последние 2 матча в базе, начиная с последнего: победа, поражение' })).toHaveTextContent('ВП');
    expect(within(form).getByText('В — победа, П — поражение; слева последний матч (обведен). 1 победа из 2.')).toBeInTheDocument();
    // «дней без матчей» — только когда игрок в моих матчах сегодня
    expect(within(form).queryByText('Дней без матчей в базе')).toBeNull();

    const serve = cardOf('Подача и прием');
    expect(within(serve).getByText('по данным архива до мая 2026: 52 недели до 25 мая 2026 · против среднего по туру (топ-50 по Эло)')).toBeInTheDocument();
    expect(within(serve).getByRole('img', { name: 'Попадание первой: 64%, средний по туру 62%' })).toBeInTheDocument();
    expect(within(serve).getByText('+2 п.п.')).toBeInTheDocument();
    // двойных меньше, чем в среднем по туру, — это хорошо
    expect(within(serve).getByText('−0,8')).toHaveClass('good-text');

    const results = cardOf('Результаты');
    expect(within(results).getByText('52–12')).toBeInTheDocument();
    expect(within(results).getByText('9–3 · 75%')).toBeInTheDocument();
    expect(screen.getByText(/Jeff Sackmann, tennis_atp/)).toBeInTheDocument();
  });

  it('«сегодня» из своей ставки: строка в шапке, Эло и личные встречи, все встречи по кнопке', async () => {
    const { user, calls } = renderCard('/players/1', playerCard({ today: [todayMatch()] }));
    const hero = await screen.findByRole('region', { name: 'Игрок Янник Синнер' });
    expect(within(hero).getByText(/соперник —/).closest('div')).toHaveTextContent('Сегодня, 14:00 · соперник — Хольгер Руне (№12 по Эло) · в вашей ставке №7 · кэф 1.30');
    expect(within(hero).getByRole('link', { name: 'Внести результат' })).toHaveAttribute('href', '/bets?bet=7');
    expect(within(hero).getByRole('link', { name: 'Хольгер Руне' })).toHaveAttribute('href', '/players/6');

    const elo = cardOf('Эло по покрытиям');
    expect(within(elo).getByText('Сегодня: Синнер — Руне')).toBeInTheDocument();
    // Эло обоих на покрытии матча и сторона игрока — с сервера; кэф своей ставки на его победу
    expect(within(elo).getByText('Эло на харде: 2180 против 2010 → 69% на победу · ваш кэф 1.30 → 77% с маржой букмекера')).toBeInTheDocument();
    expect(within(elo).getByText('Личные встречи: 3–1, на харде 2–0 · последняя — 8 окт 2025, победа')).toBeInTheDocument();
    expect(within(elo).getByRole('link', { name: 'анализе #A-0012' })).toHaveAttribute('href', '/analysis/12');
    expect(within(cardOf('Форма')).getByText('Дней без матчей в базе')).toBeInTheDocument();

    expect(calls.some((r) => r.url.includes('/h2h/'))).toBe(false);
    await user.click(within(elo).getByRole('button', { name: 'Все встречи' }));
    const list = await within(elo).findByRole('list', { name: 'Личные встречи, сначала последняя' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(list).toHaveTextContent('Пекин, 1/2 финала · 6:3 6:4победа');
    expect(list).toHaveTextContent('Ролан Гаррос, 1/16 финала · 6:7(4) 4:6поражение');
  });

  it('«сегодня»: ставка на соперника — без «ваш кэф»; Эло соперника нет — только вероятность', async () => {
    // игрок — вторая сторона матча, нога ставки — на первую (на соперника)
    renderCard('/players/1', playerCard({ today: [todayMatch({ side: 2 })] }));
    await screen.findByRole('heading', { level: 3, name: 'Эло по покрытиям' });
    const elo = cardOf('Эло по покрытиям');
    expect(await within(elo).findByText('Эло на харде: 2180 против 2010 → 69% на победу')).toBeInTheDocument();
  });

  it('«сегодня»: нет Эло соперника в таблице текущего Эло — вероятность без чисел Эло', async () => {
    renderCard('/players/1', playerCard({ today: [todayMatch({ opponent_elo: null, bets: [] })] }));
    await screen.findByRole('heading', { level: 3, name: 'Эло по покрытиям' });
    const elo = cardOf('Эло по покрытиям');
    expect(await within(elo).findByText('По Эло на харде: 69% на победу')).toBeInTheDocument();
  });

  it('«сегодня» в двух ставках — номера ставок через ключ локали', async () => {
    const legs = [
      { bet_id: 7, leg_id: 71, market: 'ML' as const, selection: 1, odds_taken: '1.300' },
      { bet_id: 8, leg_id: 81, market: 'ML' as const, selection: 1, odds_taken: '1.320' },
    ];
    renderCard('/players/1', playerCard({ today: [todayMatch({ bets: legs })] }));
    const hero = await screen.findByRole('region', { name: 'Игрок Янник Синнер' });
    expect(within(hero).getByText(/соперник —/).closest('div')).toHaveTextContent('· в ваших ставках №7, №8');
  });

  it('два анализа одного матча: строка, «Открыть анализ» и «Итог» ведут на последний', async () => {
    renderCard('/players/1', playerCard({ today: [todayMatch({ bets: [], analyses: [12, 15] })] }));
    const hero = await screen.findByRole('region', { name: 'Игрок Янник Синнер' });
    expect(within(hero).getByText(/соперник —/).closest('div')).toHaveTextContent('· в вашем анализе #A-0015');
    expect(within(hero).getByRole('link', { name: 'Открыть анализ' })).toHaveAttribute('href', '/analysis/15');
    const elo = cardOf('Эло по покрытиям');
    expect(within(elo).getByRole('link', { name: 'анализе #A-0015' })).toHaveAttribute('href', '/analysis/15');
    expect(within(elo).queryByRole('link', { name: 'анализе #A-0012' })).toBeNull();
  });

  it('«сегодня» из анализа без ставки — «Открыть анализ», вероятности по Эло нет', async () => {
    renderCard('/players/1', playerCard({ today: [todayMatch({ bets: [], scheduled_at: null, elo_prob: null, h2h: { wins: 0, losses: 0, surface_wins: 0, surface_losses: 0, last_day: null, last_won: null } })] }));
    const hero = await screen.findByRole('region', { name: 'Игрок Янник Синнер' });
    expect(within(hero).getByText(/соперник —/).closest('div')).toHaveTextContent('Сегодня · соперник — Хольгер Руне (№12 по Эло) · в вашем анализе #A-0012');
    expect(within(hero).getByRole('link', { name: 'Открыть анализ' })).toHaveAttribute('href', '/analysis/12');
    const elo = cardOf('Эло по покрытиям');
    expect(within(elo).getByText('Вероятности по Эло нет: у одного из игроков нет рейтинга')).toBeInTheDocument();
    expect(within(elo).getByText('Личных встреч в базе нет')).toBeInTheDocument();
    expect(within(elo).queryByRole('button', { name: 'Все встречи' })).toBeNull();
  });

  it('профиль из бота: вкладка с пометкой «по памяти, в анализ не идет»', async () => {
    const { user, router } = renderCard('/players/1', playerCard({ legacy_profile: legacyProfile() }));
    const hero = await screen.findByRole('region', { name: 'Игрок Янник Синнер' });
    expect(within(hero).getByText('Есть профиль из старого бота')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Профиль из бота' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/players/1/profile'));
    expect(await screen.findByText(/Его заполняла модель бота сама, часто по памяти/)).toBeInTheDocument();
    const game = cardOf('Игровой профиль');
    expect(within(game).getByText('Атакующий')).toBeInTheDocument();
    expect(within(game).getByText('Правша')).toBeInTheDocument();
    expect(within(cardOf('Физика')).getByText('средняя 8,5 из 10')).toBeInTheDocument();
    expect(within(cardOf('Психология')).getByText('Стабильный')).toBeInTheDocument();
    expect(within(cardOf('Психология')).getByText('Играет агрессивнее')).toBeInTheDocument();
    expect(within(cardOf('Сильные и слабые стороны')).getByText('Игра у сетки')).toBeInTheDocument();
    expect(within(game).getByText(/Из старого бота · перенесено 2 июля 2026 · источник не указан/)).toBeInTheDocument();
  });

  it('вкладки «Профиль» без профиля нет — адрес ведет на «Обзор»', async () => {
    const { router } = renderCard('/players/1/profile');
    await screen.findByRole('region', { name: 'Игрок Янник Синнер' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/players/1'));
    expect(cardOf('Эло по покрытиям')).toBeInTheDocument();
  });

  it('«Матчи»: итоги двух сезонов, неявка отмечена, следующая страница по курсору', async () => {
    let page = 0;
    const { user, calls } = renderCard('/players/1/matches', playerCard(), {
      'GET /api/players/1/matches': (request) => {
        page += 1;
        const before = new URL(request.url).searchParams.get('before');
        return json(before ? matchesOut({ items: [], summary: null, next_before: null, total: 3 }) : matchesOut({ next_before: 499, total: 3 }));
      },
    });
    const card = await screen.findByRole('heading', { level: 3, name: 'Последние матчи в базе' }).then((h) => h.closest('section')!);
    await within(card).findByRole('table', { name: 'Матчи игрока в базе' });
    expect(within(card).getByText('52 из 64')).toBeInTheDocument();
    expect(within(card).getByText('14–6')).toBeInTheDocument();
    expect(within(card).getByText('Томми Пол снялся')).toBeInTheDocument();
    expect(within(card).getByText('Без игры')).toBeInTheDocument();
    expect(within(card).getByText(/неявка в счет не идет/)).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Новак Джокович' })).toHaveAttribute('href', '/players/3');
    expect(within(card).getByText(/Всего в базе 3 матча/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Показать еще' }));
    await waitFor(() => expect(page).toBe(2));
    expect(calls.some((r) => new URL(r.url).searchParams.get('before') === '499')).toBe(true);
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Показать еще' })).toBeNull());
  });

  it('«Новости»: вид и сайт-источник; ссылка — только http(s)', async () => {
    renderCard('/players/1/news');
    const card = await screen.findByRole('heading', { level: 3, name: 'Новости' }).then((h) => h.closest('section')!);
    const articles = await within(card).findAllByRole('article');
    expect(articles).toHaveLength(2);
    expect(within(articles[0]!).getByText('Травма')).toBeInTheDocument();
    expect(within(articles[0]!).getByRole('link', { name: 'atptour.com' })).toHaveAttribute('href', 'https://www.atptour.com/en/news/sinner');
    expect(within(articles[0]!).getByRole('link', { name: 'atptour.com' })).toHaveAttribute('rel', 'noopener noreferrer');
    // ссылка javascript: не становится ссылкой
    expect(within(articles[1]!).queryByRole('link')).toBeNull();
    expect(within(articles[1]!).getByText('tennis.com')).toBeInTheDocument();
    expect(within(card).getByText(/^Свежие · до/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Искать/ })).toBeNull();
  });

  it('«Новости»: кто проверял — модель шага новостей и свой анализ; чужой анализ — «из общей базы»', async () => {
    renderCard('/players/1/news');
    expect(await screen.findByText(/^Проверены .+ при анализе #A-0012 · Sonnet 5\.5, веб-поиск · за 14 дней$/)).toBeInTheDocument();
  });

  it('«Новости»: анализ другого участника сервер не называет — «из общей базы новостей»', async () => {
    renderCard('/players/1/news', undefined, { 'GET /api/players/1/news': () => json(newsOut({ checked_analysis_id: null, checked_model: null })) });
    expect(await screen.findByText(/^Проверены .+ · из общей базы новостей · веб-поиск · за 14 дней$/)).toBeInTheDocument();
  });

  it('разница с туром и доля побед — с сервера (serve.diff, win_share), а не вычитанием в браузере', async () => {
    const base = playerCard();
    // нарочно не равно «игрок минус тур» и «победы / матчи»: экран обязан взять числа сервера
    const card = playerCard({
      serve: { ...base.serve!, diff: { ...base.serve!.diff!, first_in: 0.08 } },
      key_matches: { ...base.key_matches, top10: { wins: 9, losses: 3, win_share: 0.7 } },
    });
    renderCard('/players/1', card);
    await screen.findByRole('heading', { level: 3, name: 'Подача и прием' });
    expect(within(cardOf('Подача и прием')).getByText('+8 п.п.')).toBeInTheDocument();
    expect(within(cardOf('Результаты')).getByText('9–3 · 70%')).toBeInTheDocument();
  });

  it('новости не искали — пустое состояние без запроса кнопкой', async () => {
    renderCard('/players/1/news', playerCard({ news: { checked_at: null, fresh: false, ttl_hours: 12, lookback_days: 14, count: 0 } }), {
      'GET /api/players/1/news': () => json(newsOut({ items: [], checked_at: null, fresh: false })),
    });
    expect(await screen.findByText('Новости об игроке еще не искали')).toBeInTheDocument();
    expect(screen.getByText('Ищутся перед анализом матча с игроком')).toBeInTheDocument();
  });

  it('игрока нет (404) и номер не число — «Такого игрока нет в базе»', async () => {
    const view = renderCard('/players/1', () => apiError(404, 'player.not_found', 'Игрока нет в базе'));
    expect(await screen.findByRole('heading', { level: 2, name: 'Такого игрока нет в базе' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'К списку игроков' })).toHaveAttribute('href', '/players');
    view.unmount();
    const { calls } = renderCard('/players/abc');
    expect(await screen.findByText('По адресу «abc» никого не нашли. Игроки приходят из архивов ATP: если игрока нет и там, анализ матча с ним не запустим.')).toBeInTheDocument();
    expect(calls.some((r) => r.url.includes('/api/players/'))).toBe(false);
  });

  it('карточка не загрузилась — текст ошибки и «Повторить»', async () => {
    renderCard('/players/1', () => apiError(503, 'common.unavailable', 'Сервер недоступен'));
    expect(await screen.findByText(/Карточка игрока не загрузилась/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('телефон 375: вкладки в одну строку, «Профиль» коротко, матчи списком', async () => {
    renderCard('/players/1/matches', playerCard({ legacy_profile: legacyProfile() }), {}, 375);
    const tabs = await screen.findByRole('tablist', { name: 'Разделы карточки игрока' });
    expect(tabs).toHaveClass('players-tabs', 'players-tabs-4');
    expect(within(tabs).getByRole('tab', { name: 'Профиль' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Матчи игрока в базе' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('table', { name: 'Матчи игрока в базе' })).toBeNull();
  });
});
