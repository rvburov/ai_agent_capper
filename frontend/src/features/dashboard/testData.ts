import { bankOut } from '../analysis/testData';
import { brierOut, kpiOut, seriesOut, thresholdsOut } from '../analytics/testData';
import type { Adaptation } from '../bank/types';
import { betOpen } from '../bets/testData';
import type { AdminAttention, AiUsage, Dashboard, MyMatch, OpenBet, RecentBet } from './types';

// Данные для тестов главной: участник, 13 октября 2026 (вторник), период 30 дней.

/**
 * Правила В7: защита банка включена, рост ставки выключен (как после миграции 0004). met —
 * условие выполнено (считает сервер).
 */
const RULES = [
  { key: 'dd10', enabled: true, active: false, met: false, params: { from: '0.10', max_pct: '0.025' } },
  { key: 'dd20', enabled: true, active: false, met: false, params: { from: '0.20', max_pct: '0.015' } },
  { key: 'up15', enabled: false, active: false, met: false, params: { bank_up: '0.15', min_winrate: '0.60', max_pct: '0.04' } },
  { key: 'week_loss', enabled: true, active: false, met: false, params: { loss: '-0.05', max_pct: '0.02' } },
  { key: 'week_win', enabled: false, active: false, met: false, params: { win: '0.10', add: '0.005' } },
] as const;

export const ADAPTATIONS: Adaptation[] = RULES.map((rule) => ({ ...rule, params: { ...rule.params } }));

export function recentBet(over: Partial<RecentBet> = {}): RecentBet {
  return {
    id: 5,
    placed_at: '2026-10-11T08:00:00Z',
    settled_at: '2026-10-12T18:00:00Z',
    legs: 2,
    total_odds: '1.885',
    status: 'won',
    stake: '1320.00',
    profit: '1168.20',
    source: 'app',
    equity_after: '50860.00',
    ...over,
  };
}

export function openBetOut(over: Partial<OpenBet> = {}): OpenBet {
  return { ...betOpen(), implied: [1 / 1.3, 1 / 1.45], ...over };
}

export function myMatch(over: Partial<MyMatch> = {}): MyMatch {
  return {
    match_id: 101,
    player1: { id: 1, name: 'Jannik Sinner', name_ru: 'Янник Синнер' },
    player2: { id: 2, name: 'Holger Rune', name_ru: 'Хольгер Руне' },
    rank1: 2,
    rank2: 11,
    tournament: 'Shanghai Masters',
    round: 'R16',
    scheduled_at: '2026-10-13T11:30:00Z',
    bets: [{ bet_id: 7, leg_id: 11, market: 'ML', selection: 1, odds_taken: '1.300' }],
    analyses: [],
    ...over,
  };
}

export function adminAttention(over: Partial<AdminAttention> = {}): AdminAttention {
  return {
    archive: {
      days: 4,
      last_load: '2026-10-09T03:30:00Z',
      stale_after_days: 3,
      update_hour_utc: 3,
      update_minute: 30,
      sources: [
        { source: 'sackmann', last_load: '2026-10-09T03:30:00Z' },
        { source: 'tennis_data', last_load: '2026-10-10T03:30:00Z' },
      ],
    },
    return_requests: [{ user_id: 3, name: 'Олег', at: '2026-10-12T10:00:00Z' }],
    limits: [{ user_id: 2, name: 'Анна', spent_usd: 8.5, limit_usd: 10, share: 0.85, level: '80' }],
    alert_pct: 80,
    ...over,
  };
}

export function dashboardOut(over: Partial<Dashboard> = {}): Dashboard {
  return {
    period: '30d',
    date_from: '2026-09-14',
    date_to: '2026-10-13',
    kpi: kpiOut({ roi_ci: null, clv_ci: null }),
    prev: {
      date_from: '2026-08-15',
      date_to: '2026-09-13',
      settled: 30,
      turnover: '40000.00',
      profit: '1360.00',
      roi: 0.034,
      winrate: 0.6,
      clv: 0.015,
      clv_n: 20,
    },
    change: { profit: '1500.00', roi: 0.021, winrate: 0.025, clv: 0.006 },
    brier: brierOut(),
    series: seriesOut({ group: 'week', start: '2026-09-13' }),
    recent: [recentBet(), recentBet({ id: 4, status: 'lost', profit: '-1320.00', equity_after: '49691.80', settled_at: '2026-10-10T18:00:00Z' })],
    small_sample: false,
    currency: 'RUB',
    tz: 'Europe/Helsinki',
    today: '2026-10-13',
    greeting: 'morning',
    thresholds: thresholdsOut(),
    bank: bankOut({
      balance: '49540.00',
      in_play: '1320.00',
      equity: '50860.00',
      peak: '51200.00',
      drawdown: '0.0066',
      invested: '48000.00',
      growth: '0.0596',
      week_change: '0.0100',
      winrate: '0.6250',
      settled_bets: 42,
      adaptations: ADAPTATIONS,
    }),
    open_bets: [openBetOut()],
    open_count: 1,
    open_stake: '1320.00',
    my_matches: [myMatch()],
    admin: null,
    ...over,
  };
}

type UsageSums = AiUsage['totals'];

function sums(cost: number, over: Partial<UsageSums> = {}): UsageSums {
  return {
    runs: 10,
    errors: 0,
    cost_usd: cost,
    input_tokens: 20_000,
    cache_write_tokens: 10_000,
    cache_read_tokens: 70_000,
    output_tokens: 8_000,
    prompt_tokens: 100_000,
    web_searches: 4,
    cache_share: 0.7,
    ...over,
  };
}

function kind(name: string, cost: number): AiUsage['kinds'][number] {
  return {
    ...sums(cost),
    kind: name,
    avg_cost_usd: cost / 10,
    avg_prompt_tokens: 10_000,
    avg_output_tokens: 800,
    models: [],
    efforts: [],
  };
}

/**
 * Свой расход за октябрь (GET /api/ai/usage) участника на ключе администратора: $1,93, из кэша
 * 68% входных токенов, дороже всего оценка матча ($1,43 — 74%), прогноз ≈ $4,50.
 */
export function aiUsageOut(over: Partial<AiUsage> = {}): AiUsage {
  return {
    month: '2026-10',
    month_start: '2026-10-01',
    last_day: '2026-10-31',
    days_in_month: 31,
    days_elapsed: 13,
    current: true,
    totals: sums(1.93, { cache_share: 0.68 }),
    own_usd: 1.93,
    acceptance_usd: 0,
    shared_usd: 0,
    admin_key_usd: 1.93,
    own_key_usd: 0,
    search_usd: 0.08,
    cache_saved_usd: 0.4,
    days: [],
    kinds: [kind('analysis', 1.43), kind('news', 0.38), kind('parse', 0.12)],
    models: [],
    steps: [],
    versions: [],
    analyses: [],
    avg_analysis_usd: 0.13,
    admin_key_avg_usd: 0.13,
    forecast_usd: 4.5,
    analyses_left: 62,
    prices: [],
    settings: {
      parse_model: 'claude-haiku-5-5',
      parse_effort: 'low',
      news_enabled: true,
      news_model: 'claude-sonnet-5-5',
      news_effort: 'low',
      news_searches_per_match: 2,
      news_searches_per_analysis: 6,
      news_searches_per_day: 40,
      news_ttl_hours: 12,
      news_lookback_days: 7,
      news_domains: [],
      news_prompt_cache: true,
      analysis_model: 'claude-opus-5-5',
      analysis_effort: 'medium',
      analysis_parallel: 2,
      assessment_reuse_hours: 6,
      soft_cap_usd: 0.5,
      hard_cap_usd: 1.5,
      default_per_analysis_usd: 0.5,
    },
    ...over,
  };
}
