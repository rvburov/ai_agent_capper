import type { BetReview, LegReview, NewsResult } from './review';
import type { BetItem, BetLeg, BetPage, BetsSummary } from './types';

/*
 * Ответы API «Ставок» для тестов: экспресс Синнер П1 + Джокович П1 (как анализ из
 * features/analysis/testData.ts), 1 320 ₽ по кэфу 1.885. Каждый вызов — новый объект,
 * поля меняются аргументом over.
 */

const PLAYERS = {
  sinner: { id: 1, name: 'Jannik Sinner', name_ru: 'Янник Синнер' },
  rune: { id: 2, name: 'Holger Rune', name_ru: 'Хольгер Руне' },
  djokovic: { id: 3, name: 'Novak Djokovic', name_ru: 'Новак Джокович' },
  rublev: { id: 4, name: 'Andrey Rublev', name_ru: 'Андрей Рублев' },
};

const OUTCOMES_BO3 = { '2:0': 'win', '2:1': 'win', '1:2': 'loss', '0:2': 'loss' } as const;

export function betLeg(over: Partial<BetLeg> = {}): BetLeg {
  const leg: BetLeg = {
    id: 11,
    match: {
      id: 101,
      player1: { ...PLAYERS.sinner },
      player2: { ...PLAYERS.rune },
      day: '2026-10-13',
      tournament: 'Shanghai Masters',
      category: 'masters',
      surface: 'hard',
      round: 'R16',
      best_of: 3,
    },
    market: 'ML',
    selection: 1,
    odds_taken: '1.300',
    prediction_id: 501,
    p_final: 0.81,
    p_base: 0.79,
    p_claude: 0.83,
    result: null,
    score: null,
    settled_at: null,
    result_source: null,
    closing: null,
    clv: null,
    clv_fair: null,
    score_outcomes: { ...OUTCOMES_BO3 },
    edge: null,
    archive_result: null,
    archive_score: null,
    ...over,
  };
  // Перевес над рынком, как на сервере: прогноз ноги минус 1/кэф, если его не задали явно
  const p = leg.p_final ?? leg.p_claude;
  if (!('edge' in over)) leg.edge = p !== null ? p - 1 / Number(leg.odds_taken) : null;
  return leg;
}

/** Вторая нога: Джокович П1 @1.45. */
export function betLeg2(over: Partial<BetLeg> = {}): BetLeg {
  return betLeg({
    id: 12,
    match: {
      id: 102,
      player1: { ...PLAYERS.djokovic },
      player2: { ...PLAYERS.rublev },
      day: '2026-10-13',
      tournament: 'Shanghai Masters',
      category: 'masters',
      surface: 'hard',
      round: 'R16',
      best_of: 3,
    },
    odds_taken: '1.450',
    prediction_id: 502,
    p_final: 0.74,
    p_base: 0.72,
    p_claude: 0.76,
    ...over,
  });
}

/** Открытая ставка №7: экспресс из 2 событий. */
export function betOpen(over: Partial<BetItem> = {}): BetItem {
  return {
    id: 7,
    analysis_id: 1,
    placed_at: '2026-10-13T08:30:00Z',
    bookmaker: 'Fonbet',
    stake: '1320.00',
    currency: 'RUB',
    total_odds: '1.885',
    effective_odds: null,
    status: 'open',
    profit: null,
    payout: '2488.20',
    bank_after: null,
    settled_at: null,
    settled_by: null,
    source: 'app',
    updated_at: '2026-10-13T08:30:00.123456Z',
    clv: null,
    clv_fair: null,
    verdict: null,
    archive_to: null,
    awaiting_result: false,
    legs: [betLeg(), betLeg2()],
    ...over,
  };
}

/** Рассчитанная выигранная ставка №5 с закрытием на обеих ногах. */
export function betWon(over: Partial<BetItem> = {}): BetItem {
  const closing = { odds: '1.250', opp_odds: '4.200', by: 'pinnacle' as const, bookmaker: null, source: 'user' as const, q_close: 0.7865, unverified: false };
  return betOpen({
    id: 5,
    placed_at: '2026-10-05T09:00:00Z',
    status: 'won',
    profit: '1168.20',
    payout: '2488.20',
    effective_odds: '1.885',
    bank_after: '49168.20',
    settled_at: '2026-10-06T20:00:00Z',
    settled_by: 'manual',
    updated_at: '2026-10-06T20:00:00.5Z',
    clv: 0.0545,
    clv_fair: 0.0101,
    verdict: 'edge_confirmed',
    legs: [
      betLeg({ id: 51, result: 'win', score: '2:0', settled_at: '2026-10-06T20:00:00Z', result_source: 'manual', closing, clv: 0.04, clv_fair: 0.0225, score_outcomes: null }),
      betLeg2({ id: 52, result: 'win', score: '2:1', settled_at: '2026-10-06T20:00:00Z', result_source: 'manual', closing: { ...closing, odds: '1.400', opp_odds: null, q_close: null }, clv: 0.0357, clv_fair: null, score_outcomes: null }),
    ],
    ...over,
  });
}

/** Проигранная ставка №4: ординар, закрытия нет. */
export function betLost(over: Partial<BetItem> = {}): BetItem {
  return betOpen({
    id: 4,
    placed_at: '2026-09-28T10:00:00Z',
    stake: '1000.00',
    total_odds: '1.300',
    status: 'lost',
    profit: '-1000.00',
    payout: '0.00',
    settled_at: '2026-09-29T18:00:00Z',
    settled_by: 'manual',
    updated_at: '2026-09-29T18:00:00Z',
    verdict: 'no_closing',
    legs: [betLeg({ id: 41, result: 'loss', score: '1:2', settled_at: '2026-09-29T18:00:00Z', result_source: 'manual', score_outcomes: null })],
    ...over,
  });
}

/** Ставка старого бота №2: выигрыш, без закрытия и итоговой вероятности. */
export function betLegacy(over: Partial<BetItem> = {}): BetItem {
  return betOpen({
    id: 2,
    analysis_id: null,
    placed_at: '2026-09-10T10:00:00Z',
    bookmaker: 'Winline',
    stake: '500.00',
    total_odds: '1.450',
    status: 'won',
    profit: '225.00',
    payout: '725.00',
    effective_odds: '1.450',
    settled_at: '2026-09-11T10:00:00Z',
    settled_by: 'legacy',
    source: 'legacy',
    verdict: 'legacy',
    legs: [betLeg2({ id: 21, result: 'win', result_source: 'legacy', p_final: null, p_base: null, p_claude: 0.7, prediction_id: null, score_outcomes: null })],
    ...over,
  });
}

export function betPage(items: BetItem[], nextBefore: number | null = null): BetPage {
  return { items, next_before: nextBefore };
}

export function betsSummary(over: Partial<BetsSummary> = {}): BetsSummary {
  return {
    currency: 'RUB',
    settled: 3,
    won: 2,
    lost: 1,
    void: 0,
    winrate: 0.6667,
    turnover: '2820.00',
    profit: '393.20',
    roi: 0.1394,
    avg_stake: '940.00',
    open: 1,
    open_stake: '1320.00',
    clv: 0.0545,
    clv_positive: 1,
    clv_n: 1,
    legacy_settled: 1,
    ...over,
  };
}

// ---------- этап 5: расчет по архиву, разбор ИИ, подсказка из новостей ----------

/** Закрытие из архива tennis-data (Т1): эталон Pinnacle, момент снятия не проверен. */
export function archiveClosing(over: Partial<NonNullable<BetLeg['closing']>> = {}): NonNullable<BetLeg['closing']> {
  return { odds: '1.280', opp_odds: '3.900', by: 'pinnacle', bookmaker: null, source: 'archive', q_close: 0.7529, unverified: true, ...over };
}

/**
 * Ставка №9, рассчитанная сама по архиву: экспресс Синнер П1 (закрытие из архива) и Джокович
 * Ф1(−1.5) — у форы закрытия нет («внесите сами»).
 */
export function betAuto(over: Partial<BetItem> = {}): BetItem {
  return betOpen({
    id: 9,
    placed_at: '2026-10-08T09:00:00Z',
    status: 'won',
    profit: '1168.20',
    payout: '2488.20',
    effective_odds: '1.885',
    bank_after: '49168.20',
    settled_at: '2026-10-12T08:14:00Z',
    settled_by: 'auto',
    updated_at: '2026-10-12T08:14:00.5Z',
    clv: null,
    clv_fair: null,
    verdict: 'no_closing',
    archive_to: '2026-10-11',
    legs: [
      betLeg({ id: 91, result: 'win', score: '2:0', settled_at: '2026-10-12T08:14:00Z', result_source: 'auto', closing: archiveClosing(), clv: 0.0156, clv_fair: -0.0212, score_outcomes: null, match: { ...betLeg().match, id: 191, day: '2026-10-09' } }),
      betLeg2({ id: 92, market: 'HCP_-1.5', result: 'win', score: '2:0', settled_at: '2026-10-12T08:14:00Z', result_source: 'auto', score_outcomes: null, match: { ...betLeg2().match, id: 192, day: '2026-10-09' } }),
    ],
    ...over,
  });
}

/** Открытая ставка №8: матчи уже сыграны, исхода в архиве нет — «ждет результата». */
export function betAwaiting(over: Partial<BetItem> = {}, news: NewsResult | null = null): BetItem {
  const leg = betLeg({ id: 81, match: { ...betLeg().match, id: 181, day: '2026-10-10' } });
  return betOpen({
    id: 8,
    placed_at: '2026-10-10T07:00:00Z',
    stake: '1000.00',
    total_odds: '1.300',
    payout: '1300.00',
    awaiting_result: true,
    updated_at: '2026-10-10T07:00:00.1Z',
    legs: [news ? { ...leg, news_result: news } : leg],
    ...over,
  });
}

/** Подсказка исхода по новостям (news_result): Синнер выиграл 6:3 6:4 — «Подставить 2:0». */
export function newsResult(over: Partial<NewsResult> = {}): NewsResult {
  return {
    winner: 1,
    sets: '2:0',
    score: '6:3 6:4',
    retired: false,
    source_name: 'atptour.com',
    source_url: 'https://www.atptour.com/en/news/sinner-rune-2026',
    published_on: '2026-10-10',
    found_at: '2026-10-11T07:40:00Z',
    ...over,
  };
}

/** Разбор матча ноги: ошибка модели, гипотеза ушла в урок L-022. */
export function legReview(over: Partial<LegReview> = {}): LegReview {
  return {
    leg_id: 92,
    match_id: 192,
    market: 'HCP_-1.5',
    selection: 1,
    same_pick: true,
    won: false,
    clv: null,
    status: 'done',
    verdict: 'model_error',
    what: 'Джокович — Рублев, Ф1(−1.5) не сыграла. Модель давала 74%, рынок без маржи 64%.',
    why: 'Соперники близки по Эло на харде, а модель заложила уверенную победу 2:0.',
    hypothesis: 'Фора −1.5 на харде при разнице Эло меньше 100 — модель завышает шанс.',
    lesson: { id: 22, code: 'L-022', status: 'hypothesis', in_prompt: false, n_cases: 3, n_cases_few: false, own_cases: 1, need_cases: 20, text: 'Фора −1.5 на харде при близком Эло' },
    model: 'claude-sonnet-5-5',
    cost_usd: 0.0062,
    done_at: '2026-10-12T09:20:00Z',
    ...over,
  };
}

/** Разбор ставки (GET /api/bets/{id}/review): готов, по одному матчу. */
export function betReview(over: Partial<BetReview> = {}, legs: LegReview[] = [legReview()]): BetReview {
  return { bet_id: 9, state: 'done', reason: null, clv_verdict: 'no_closing', legs, ...over };
}
