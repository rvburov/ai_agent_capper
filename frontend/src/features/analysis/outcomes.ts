import i18n from '../../i18n';
import { formatLine } from '../../lib/format';
import { FAMILIES, familyName, isHandicap, isTotal, marketSpec, type MarketFamily, type SideNames } from './markets';
import type { MarketRow } from './types';

/*
 * Исходы на экране анализа (Р28): что значит исход («Синнер выигрывает 2:0», «23 гейма и
 * больше», у целой линии — «ровно 22 — возврат») и группы строк таблицы рынков. Отдельно от
 * markets.ts: тексты нужны только «Анализу», а не каждому экрану (бюджет JS первого экрана).
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
const tr: Translate = (key, options) => (i18n.t as unknown as Translate)(key, options);

function games(count: number, form: 'nom' | 'gen'): string {
  return i18n.t(form === 'nom' ? 'analysis.marketDesc.games' : 'analysis.marketDesc.gamesGen', { count });
}

/**
 * Что значит исход: «Синнер выигрывает 2:0»; в матче до 3 побед −1.5 — это 3:0 или 3:1; у целой
 * линии — «ровно 22 — возврат». name — игрок выбранной стороны (у тоталов не нужен).
 */
export function marketDescription(market: string, selection: number, name: string, bestOf: number): string {
  const spec = marketSpec(market);
  const five = bestOf === 5;
  const d = (key: string, options: Record<string, unknown> = {}) => tr(`analysis.marketDesc.${key}`, { name, ...options });
  if (!spec || spec.family === 'ml' || spec.line === null) return d('ml');
  const line = spec.line;
  const abs = Math.abs(line);
  const whole = Number.isInteger(line);
  if (spec.family === 'h15') return line < 0 ? d(five ? 'minus5' : 'minus3') : d(five ? 'plus5' : 'plus3');
  if (spec.family === 'shcp') return line < 0 ? d('setsSweep') : d('setsOne');
  if (spec.family === 'stot') {
    if (abs === 2.5) return d(selection === 1 ? 'setsThree' : 'setsTwo');
    return selection === 1 ? d('setsOver', { n: Math.ceil(abs) }) : d('setsUnder', { n: Math.floor(abs) });
  }
  if (spec.family === 'gtot') {
    if (whole) return d(selection === 1 ? 'gamesOverWhole' : 'gamesUnderWhole', { games: games(abs, 'gen'), n: abs });
    return selection === 1 ? d('gamesOver', { games: games(Math.ceil(abs), 'nom') }) : d('gamesUnder', { games: games(Math.floor(abs), 'nom') });
  }
  if (line === 0) return d('ghcpZero');
  if (line < 0) return whole ? d('ghcpMinusWhole', { games: games(abs, 'gen'), n: abs }) : d('ghcpMinus', { games: games(Math.ceil(abs), 'gen') });
  return whole ? d('ghcpPlusWhole', { games: games(abs, 'gen'), n: abs }) : d('ghcpPlus', { games: games(Math.floor(abs), 'gen') });
}

// ---------- группы строк таблицы анализа ----------

export interface MarketGroup {
  /** Ключ группы: ml, h15, shcp:-2.5 (линия игрока 1), stot:2.5, ghcp:-4.5, gtot:22. */
  key: string;
  family: MarketFamily;
  /** Линия группы: у фор — игрока 1, у тоталов — линия; у ml и h15 — null. */
  line: number | null;
  rows: MarketRow[];
}

/** Название группы: «Победа в матче», «Фора по сетам ±1.5», «Фора по геймам: Синнер −4.5», «Тотал геймов 22.5». */
export function groupTitle(group: Pick<MarketGroup, 'family' | 'line'>, names: SideNames): string {
  if (group.family === 'ml' || group.family === 'h15' || group.line === null) return familyName(group.family);
  if (isTotal(group.family)) return i18n.t('analysis.marketGroup.total', { family: familyName(group.family), line: formatLine(group.line) });
  return i18n.t('analysis.marketGroup.hcp', { family: familyName(group.family), name: names.p1, line: formatLine(group.line, { signed: true }) });
}

// Порядок строк ±1.5 как в макете: Ф1(−1.5), Ф2(+1.5), затем зеркальные Ф2(−1.5), Ф1(+1.5)
const HCP15_ORDER = ['HCP_-1.5/1', 'HCP_+1.5/2', 'HCP_-1.5/2', 'HCP_+1.5/1'];

function groupOf(row: MarketRow): { key: string; family: MarketFamily; line: number | null } | null {
  const spec = marketSpec(row.market);
  if (!spec) return null;
  if (spec.family === 'ml' || spec.family === 'h15' || spec.line === null) return { key: spec.family, family: spec.family, line: null };
  const line = isHandicap(spec.family) && row.selection === 2 ? -spec.line : spec.line;
  return { key: `${spec.family}:${line}`, family: spec.family, line };
}

function rowOrder(row: MarketRow): number {
  const i = HCP15_ORDER.indexOf(`${row.market}/${row.selection}`);
  return i >= 0 ? i : row.selection;
}

/**
 * Группы строк для таблицы: рынок с линией и статусом, в каждой — исходы с кэфом участника
 * (П1 и П2 — всегда). Порядок: победа, фора ±1.5, фора и тотал сетов, фора и тотал геймов.
 */
export function marketGroups(rows: readonly MarketRow[]): MarketGroup[] {
  const groups = new Map<string, MarketGroup>();
  for (const row of rows) {
    const g = groupOf(row);
    if (!g || (row.odds === null && g.family !== 'ml')) continue;
    let group = groups.get(g.key);
    if (!group) {
      group = { ...g, rows: [] };
      groups.set(g.key, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()]
    .sort((a, b) => FAMILIES.indexOf(a.family) - FAMILIES.indexOf(b.family) || (a.line ?? 0) - (b.line ?? 0))
    .map((group) => ({ ...group, rows: [...group.rows].sort((a, b) => rowOrder(a) - rowOrder(b)) }));
}

/** Исходы для таблицы одним списком, в порядке групп. */
export function shownMarkets(rows: readonly MarketRow[]): MarketRow[] {
  return marketGroups(rows).flatMap((g) => g.rows);
}

