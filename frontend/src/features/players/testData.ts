import type {
  ArchiveInfo,
  H2H,
  LegacyProfile,
  NewsItem,
  PlayerCard,
  PlayerMatch,
  PlayerMatches,
  PlayerNews,
  PlayerRanking,
  PlayerRow,
  TodayMatch,
} from './types';

/*
 * Фабрики ответов API «Игроков» и карточки для тестов (типы — из OpenAPI). Мир: 13 октября 2026,
 * архив загружен сегодня в 04:10 UTC, результаты по 12 октября; Синнер — №1 по Эло.
 */

/** Победы и поражения с долей побед, как ее считает сервер (4 знака; матчей нет — null). */
export function winLoss(wins: number, losses: number) {
  const played = wins + losses;
  return { wins, losses, win_share: played > 0 ? Math.round((wins / played) * 10_000) / 10_000 : null };
}

export function archiveInfo(over: Partial<ArchiveInfo> = {}): ArchiveInfo {
  return {
    data_to: '2026-10-12',
    last_load: '2026-10-13T04:10:00Z',
    stale: false,
    stale_days: 0,
    stale_after_days: 3,
    sources: [
      { source: 'sackmann', last_load: '2026-10-13T04:00:00Z' },
      { source: 'tennis_data', last_load: '2026-10-13T04:10:00Z' },
    ],
    ...over,
  };
}

export function playerRow(over: Partial<PlayerRow> = {}): PlayerRow {
  return {
    id: 1,
    name: 'Jannik Sinner',
    name_ru: 'Янник Синнер',
    country: 'ITA',
    age: 25,
    rank: 1,
    elo_all: 2150,
    elo_surface: 2180,
    elo_delta: 30,
    matches_52w: 64,
    form: ['W', 'W', 'L', 'W', 'W', 'W', 'W', 'L', 'W', 'W'],
    wins: 8,
    losses: 2,
    last_match: { match_id: 501, day: '2026-10-12', tournament: 'Шанхай', category: 'masters', round: 'R16' },
    news_checked_at: '2026-10-13T08:00:00Z',
    news_fresh: true,
    today: false,
    ...over,
  };
}

export const RUNE_ROW: Partial<PlayerRow> = {
  id: 6,
  name: 'Holger Rune',
  name_ru: 'Хольгер Руне',
  country: 'DEN',
  age: 23,
  rank: 12,
  elo_all: 1990,
  elo_surface: 1975,
  elo_delta: -15,
  form: ['L', 'W', 'W', 'L', 'W'],
  wins: 3,
  losses: 2,
  news_checked_at: null,
  news_fresh: false,
  today: true,
};

export function rankingOut(over: Partial<PlayerRanking> = {}): PlayerRanking {
  const items = over.items ?? [playerRow(), playerRow(RUNE_ROW)];
  return {
    items,
    total: items.length,
    offset: 0,
    limit: 50,
    query: null,
    fuzzy: false,
    data: 'active',
    surface: 'hard',
    sort: 'rank',
    counts: { all: 2790, active: 412, news: 18 },
    as_of: '2026-10-12',
    rank_days: 364,
    news_ttl_hours: 12,
    archive: archiveInfo(),
    sackmann: true,
    ...over,
  };
}

export function todayMatch(over: Partial<TodayMatch> = {}): TodayMatch {
  return {
    match_id: 900,
    side: 1,
    elo: 2180,
    opponent_elo: 2010,
    opponent: { id: 6, name: 'Holger Rune', name_ru: 'Хольгер Руне' },
    opponent_rank: 12,
    tournament: 'Test Open',
    round: 'R16',
    scheduled_at: '2026-10-13T11:00:00Z',
    surface: 'hard',
    bets: [{ bet_id: 7, leg_id: 71, market: 'ML', selection: 1, odds_taken: '1.300' }],
    analyses: [12],
    elo_prob: 0.69,
    h2h: { wins: 3, losses: 1, surface_wins: 2, surface_losses: 0, last_day: '2025-10-08', last_won: true },
    ...over,
  };
}

/** Профиль из бота: шаблоны 01–04 с частью полей. */
export function legacyProfile(over: Partial<LegacyProfile> = {}): LegacyProfile {
  return {
    updated_at: '2026-07-02T12:30:00Z',
    profile: {
      '01': { meta: { 'дата_заполнения': '2025-11-02', 'источник': '' }, 'личные_данные': { 'хват_ракетки': 'Полузападный' } },
      '02': { 'игровой_профиль': { 'стиль_игры': 'Атакующий', 'позиция_на_корте': 'Задняя линия', 'тип_подачи': 'Комбинированная' } },
      '03': {
        'физические_способности': {
          'скорость': { 'оценка': 9, 'комментарий': 'Быстрый' },
          'выносливость': { 'оценка': 8, 'комментарий': '' },
          'средняя_оценка': 8.5,
        },
        'технические_способности': { 'форхенд': { 'оценка': 9 }, 'игра_у_сетки': { 'оценка': 5 } },
        'сильные_стороны': ['Форхенд', 'Прием'],
        'слабые_стороны': ['Игра у сетки'],
      },
      '04': {
        'психотип': { 'тип_характера': 'Стабильный' },
        'оценки': { 'игра_под_давлением': { 'оценка': 9 } },
        'поведенческие_паттерны': { 'на_тайбрейке': 'Играет агрессивнее', 'при_проигрыше_сета': '' },
      },
    },
    ...over,
  };
}

export function playerCard(over: Partial<PlayerCard> = {}): PlayerCard {
  return {
    id: 1,
    name: 'Jannik Sinner',
    name_ru: 'Янник Синнер',
    country: 'ITA',
    birth_date: '2001-08-16',
    age: 25,
    hand: 'R',
    backhand: 'two',
    rank: 1,
    matches_52w: 64,
    rank_days: 364,
    elo: {
      all: 2150,
      matches: 320,
      surfaces: [
        { surface: 'hard', elo: 2180, matches: 200, delta: 30 },
        { surface: 'clay', elo: 2090, matches: 80, delta: -60 },
        { surface: 'grass', elo: 2120, matches: 40, delta: -30 },
      ],
      best_surface: 'hard',
    },
    form: {
      matches: [
        { match_id: 501, day: '2026-10-12', won: true, opponent: { id: 3, name: 'Novak Djokovic', name_ru: 'Новак Джокович' }, opponent_rank: 4, score: '6:4 6:3', surface: 'hard', tournament: 'Шанхай', round: 'R16' },
        { match_id: 500, day: '2026-10-10', won: false, opponent: { id: 2, name: 'Carlos Alcaraz', name_ru: 'Карлос Алькарас' }, opponent_rank: 2, score: '4:6 3:6', surface: 'hard', tournament: 'Шанхай', round: 'R32' },
      ],
      wins: 1,
      losses: 1,
      matches_14d: 2,
      rest_days: 1,
    },
    last_match: { match_id: 501, day: '2026-10-12', tournament: 'Шанхай', category: 'masters', round: 'R16' },
    serve: {
      period_from: '2025-05-26',
      period_to: '2026-05-25',
      player: {
        matches: 48,
        first_in: 0.64,
        first_won: 0.78,
        second_won: 0.55,
        aces_per_match: 8.2,
        double_faults_per_match: 2.1,
        first_return_won: 0.33,
        second_return_won: 0.55,
        bp_converted: 0.43,
        bp_saved: 0.665,
      },
      tour: {
        matches: 2000,
        first_in: 0.62,
        first_won: 0.74,
        second_won: 0.52,
        aces_per_match: 6.6,
        double_faults_per_match: 2.9,
        first_return_won: 0.3,
        second_return_won: 0.51,
        bp_converted: 0.4,
        bp_saved: 0.62,
      },
      tour_players: 50,
      // игрок минус тур — с сервера
      diff: {
        first_in: 0.02,
        first_won: 0.04,
        second_won: 0.03,
        aces_per_match: 1.6,
        double_faults_per_match: -0.8,
        first_return_won: 0.03,
        second_return_won: 0.04,
        bp_converted: 0.03,
        bp_saved: 0.045,
      },
    },
    results: {
      since: '2025-01-01',
      surfaces: [
        { surface: 'hard', ...winLoss(40, 8) },
        { surface: 'clay', ...winLoss(12, 4) },
      ],
      total: winLoss(52, 12),
    },
    key_matches: {
      since: '2025-10-14',
      top10: winLoss(9, 3),
      deciders: winLoss(7, 2),
      tiebreaks: winLoss(14, 6),
    },
    news: { checked_at: '2026-10-13T08:00:00Z', fresh: true, ttl_hours: 12, lookback_days: 14, count: 2 },
    archive: archiveInfo(),
    sackmann: true,
    legacy_profile: null,
    today: [],
    ...over,
  };
}

export function playerMatch(over: Partial<PlayerMatch> = {}): PlayerMatch {
  return {
    match_id: 501,
    day: '2026-10-12',
    tournament: 'Шанхай',
    category: 'masters',
    surface: 'hard',
    round: 'R16',
    opponent: { id: 3, name: 'Novak Djokovic', name_ru: 'Новак Джокович' },
    opponent_rank: 4,
    // архив пишет геймы через дефис; на экране — через двоеточие, как в макете
    score: '6-4 6-3',
    won: true,
    walkover: false,
    best_of: 3,
    ...over,
  };
}

export function matchesOut(over: Partial<PlayerMatches> = {}): PlayerMatches {
  return {
    items: [
      playerMatch(),
      playerMatch({ match_id: 499, day: '2026-10-08', walkover: true, won: true, score: null, opponent: { id: 9, name: 'Tommy Paul', name_ru: 'Томми Пол' }, opponent_rank: 15 }),
    ],
    next_before: null,
    total: 2,
    summary: { since: '2025-01-01', played: 64, wins: 52, tiebreaks: winLoss(14, 6), deciders: winLoss(7, 2), best_of_5: 12 },
    ...over,
  };
}

export function newsItem(over: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 1,
    kind: 'injury',
    published_at: '2026-10-12T10:00:00Z',
    summary: 'Синнер прошел обследование после матча, травмы нет.',
    source_url: 'https://www.atptour.com/en/news/sinner',
    source_name: null,
    details: null,
    ...over,
  };
}

export function newsOut(over: Partial<PlayerNews> = {}): PlayerNews {
  return {
    items: [newsItem(), newsItem({ id: 2, kind: 'result', source_url: 'javascript:alert(1)', source_name: 'tennis.com' })],
    next_before: null,
    checked_at: '2026-10-13T08:00:00Z',
    fresh: true,
    ttl_hours: 12,
    lookback_days: 14,
    checked_model: 'claude-sonnet-5-5',
    checked_analysis_id: 12,
    ...over,
  };
}

export function h2hOut(over: Partial<H2H> = {}): H2H {
  return {
    player: { id: 1, name: 'Jannik Sinner', name_ru: 'Янник Синнер' },
    opponent: { id: 6, name: 'Holger Rune', name_ru: 'Хольгер Руне' },
    player_rank: 1,
    opponent_rank: 12,
    player_wins: 3,
    opponent_wins: 1,
    surfaces: [{ surface: 'hard', ...winLoss(2, 0) }],
    matches: [
      { match_id: 300, day: '2025-10-08', winner_id: 1, score: '6-3 6-4', surface: 'hard', tournament: 'Пекин', category: '500', round: 'SF', best_of: 3 },
      { match_id: 200, day: '2024-06-01', winner_id: 6, score: '6-7(4) 4-6', surface: 'clay', tournament: 'Ролан Гаррос', category: 'grand_slam', round: 'R32', best_of: 5 },
    ],
    ...over,
  };
}
