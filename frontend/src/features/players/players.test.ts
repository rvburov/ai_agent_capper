import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import ru from '../../i18n/locales/ru.json';
import {
  countryName,
  eloDelta,
  eloText,
  handText,
  hasSackmann,
  initials,
  newsState,
  playerIdOf,
  safeHttpUrl,
  scoreText,
  siteName,
  winShare,
} from './display';
import { DEFAULT_FILTERS, filtersFromSearch, PAGE_MAX, rankingQuery, searchWithFilters, withFilter } from './filters';
import { fieldLabel, hasContent, legacyView, psychTone } from './legacy';
import { archiveInfo, legacyProfile } from './testData';

// Локаль сервера: названия стран (players.countries) и коды errors.player.* приходят из API —
// тексты во фронтенде должны совпадать с серверными
const backend = import.meta.glob<{ errors: { player: Record<string, string> }; players: { countries: Record<string, string> } }>(
  '../../../../backend/app/locales/ru.json',
  { eager: true, import: 'default' },
);

const t = i18n.t.bind(i18n);

describe('Игроки: фильтры в адресе', () => {
  it('по умолчанию — за 52 недели, хард, место по Эло, первая страница; в адрес не пишется', () => {
    const filters = filtersFromSearch(new URLSearchParams());
    expect(filters).toEqual(DEFAULT_FILTERS);
    expect(searchWithFilters(filters).toString()).toBe('');
  });

  it('значения из адреса — только те, что примет сервер; страница — от 1 до PAGE_MAX', () => {
    const filters = filtersFromSearch(new URLSearchParams('q=%20синер%20&data=all&surface=clay&sort=elo&page=3'));
    expect(filters).toEqual({ q: ' синер ', data: 'all', surface: 'clay', sort: 'elo', page: 3 });
    expect(searchWithFilters(filters).toString()).toBe('q=%D1%81%D0%B8%D0%BD%D0%B5%D1%80&data=all&surface=clay&sort=elo&page=3');
    expect(filtersFromSearch(new URLSearchParams('data=bad&surface=carpet&sort=x&page=0'))).toEqual(DEFAULT_FILTERS);
    expect(filtersFromSearch(new URLSearchParams('page=999')).page).toBe(PAGE_MAX);
    expect(filtersFromSearch(new URLSearchParams(`q=${'а'.repeat(150)}`)).q).toHaveLength(100);
  });

  it('страница — offset по 50; пустой поиск не уходит; смена фильтра — первая страница', () => {
    const filters = { ...DEFAULT_FILTERS, q: '  ', page: 3 };
    expect(rankingQuery(filters, 3)).toEqual({ data: 'active', surface: 'hard', sort: 'rank', offset: 100, limit: 50 });
    expect(rankingQuery({ ...filters, q: ' Sinner ' }, 1)).toMatchObject({ q: 'Sinner', offset: 0 });
    expect(withFilter(filters, { surface: 'grass' })).toMatchObject({ surface: 'grass', page: 1 });
  });

  it('прочие параметры адреса остаются', () => {
    expect(searchWithFilters({ ...DEFAULT_FILTERS, data: 'news' }, new URLSearchParams('x=1&page=4')).toString()).toBe('x=1&data=news');
  });
});

describe('Игроки: подписи', () => {
  it('Эло — целым без разделителя, разница со знаком, ноль — «±0»', () => {
    expect(eloText(2150.4)).toBe('2150');
    expect(eloText(null)).toBe('—');
    expect(eloDelta(30)).toBe('+30');
    expect(eloDelta(-15)).toBe('−15');
    expect(eloDelta(0)).toBe('±0');
  });

  it('страна по коду IOC, неизвестный код — сам код; рука и бэкхенд', () => {
    expect(countryName('ita', t)).toBe('Италия');
    expect(countryName('XYZ', t)).toBe('XYZ');
    expect(countryName(null, t)).toBeNull();
    expect(handText('L', 'one', t)).toBe('левша, одноручный бэкхенд');
    expect(handText('U', null, t)).toBeNull();
    expect(initials('Янник Синнер')).toBe('ЯС');
  });

  it('свежесть новостей и доля побед', () => {
    expect(newsState(null, false)).toBe('never');
    expect(newsState('2026-10-13T08:00:00Z', true)).toBe('fresh');
    expect(newsState('2026-10-01T08:00:00Z', false)).toBe('stale');
    expect(winShare(3, 1)).toBe(0.75);
    expect(winShare(0, 0)).toBeNull();
  });

  it('ссылка источника — только http(s); сайт — имя или домен без www', () => {
    expect(safeHttpUrl('https://www.atptour.com/x')).toBe('https://www.atptour.com/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,1')).toBeNull();
    expect(safeHttpUrl('не ссылка')).toBeNull();
    expect(siteName(null, 'https://www.atptour.com/x')).toBe('atptour.com');
    expect(siteName(' ESPN ', 'https://espn.com')).toBe('ESPN');
    expect(siteName(null, 'javascript:1')).toBe('—');
  });

  it('номер карточки из адреса — только целое положительное', () => {
    expect(playerIdOf('12')).toBe(12);
    expect(playerIdOf('0')).toBeNull();
    expect(playerIdOf('12abc')).toBeNull();
    expect(playerIdOf('-1')).toBeNull();
    expect(playerIdOf(undefined)).toBeNull();
  });

  it('строка авторства Сакманна — если его архив загружался или матчи в базе есть (при сомнении — показываем)', () => {
    expect(hasSackmann(archiveInfo())).toBe(true);
    // загрузок в журнале нет, но матчи в базе есть — данные Сакманна могут быть: строка нужна
    expect(hasSackmann(archiveInfo({ last_load: null, sources: [{ source: 'sackmann', last_load: null }] }))).toBe(true);
    // база пуста — строки нет
    expect(hasSackmann(archiveInfo({ data_to: null, last_load: null, sources: [{ source: 'sackmann', last_load: null }] }))).toBe(false);
  });

  it('счет — геймы через двоеточие, как в макете; тай-брейк и пометки не трогаются', () => {
    expect(scoreText('6-3 7-6(4)')).toBe('6:3 7:6(4)');
    expect(scoreText('6-4 3-6 7-6(10) RET')).toBe('6:4 3:6 7:6(10) RET');
    expect(scoreText('6:4 6:3')).toBe('6:4 6:3');
    expect(scoreText(null)).toBe('—');
  });
});

describe('Игроки: профиль из бота', () => {
  it('поля шаблонов 01–04: стиль, оценки, стороны, психотип; пустые и чужие — пропущены', () => {
    const view = legacyView(legacyProfile());
    expect(view).toMatchObject({ style: 'Атакующий', position: 'Задняя линия', serveType: 'Комбинированная', grip: 'Полузападный', filledAt: '2025-11-02', source: null });
    expect(view.physical).toEqual([
      { label: 'Скорость', value: 9, comment: 'Быстрый' },
      { label: 'Выносливость', value: 8, comment: null },
    ]);
    expect(view.technical.map((r) => r.label)).toEqual(['Форхенд', 'Игра у сетки']);
    // средняя — как записал бот, без расчета в браузере; не записал — нет
    expect(view.physicalAvg).toBe(8.5);
    expect(view.technicalAvg).toBeNull();
    expect(view.strengths).toEqual(['Форхенд', 'Прием']);
    expect(view.patterns).toEqual([{ label: 'На тайбрейке', text: 'Играет агрессивнее' }]);
    expect(psychTone(view.psychType)).toBe('good');
    expect(hasContent(view)).toBe(true);
  });

  it('профиль не того вида — пусто, без ошибок', () => {
    const view = legacyView(legacyProfile({ profile: { '03': { 'физические_способности': { 'скорость': { 'оценка': 'много' } } }, '02': 'текст' } }));
    expect(hasContent(view)).toBe(false);
    expect(fieldLabel('взрывная_сила')).toBe('Взрывная сила');
    expect(psychTone(null)).toBe('outline');
  });
});

describe('Игроки: тексты сервера', () => {
  const server = Object.values(backend)[0]!;

  it('коды errors.player.* сервера — те же тексты во фронтенде', () => {
    expect(ru.errors.player).toEqual(server.errors.player);
  });

  it('страны — копия players.countries сервера', () => {
    expect(ru.players.countries).toEqual(server.players.countries);
  });
});
