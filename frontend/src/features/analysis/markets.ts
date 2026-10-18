import i18n from '../../i18n';
import { formatLine, formatPercent, formatPp, formatUsd } from '../../lib/format';

type Translate = (key: string, options?: Record<string, unknown>) => string;
const tr: Translate = (key, options) => (i18n.t as unknown as Translate)(key, options);

/*
 * Рынки ставок на экране (Р28). Код рынка — строка с линией внутри, как на сервере
 * (backend/app/ml/markets.py, market_spec): ML; форы по сетам HCP_-1.5, HCP_+2.5; тотал сетов
 * STOT_2.5; форы по геймам GHCP_-3.5, GHCP_+3; тотал геймов GTOT_22.5, GTOT_22. У фор линия —
 * со стороны выбранного исхода (selection — игрок), у тоталов selection 1 — больше, 2 — меньше.
 * Линии половинные (22.5) или целые (22, при «ровно» — возврат); четвертных нет.
 * Семейство — строка экрана и счетчика «для сравнения»: ml, h15 (фора ±1.5), shcp (фора по
 * сетам ±2.5), stot, ghcp, gtot.
 */

export type MarketFamily = 'ml' | 'h15' | 'shcp' | 'stot' | 'ghcp' | 'gtot';
export const FAMILIES: readonly MarketFamily[] = ['ml', 'h15', 'shcp', 'stot', 'ghcp', 'gtot'];
/** Семейства блока «Другие рынки» формы (фора ±1.5 — прежние поля). */
export type ExtraFamily = Exclude<MarketFamily, 'ml' | 'h15'>;
export const EXTRA_FAMILIES: readonly ExtraFamily[] = ['shcp', 'stot', 'ghcp', 'gtot'];

export function isFamily(value: unknown): value is MarketFamily {
  return typeof value === 'string' && (FAMILIES as readonly string[]).includes(value);
}

export interface MarketSpec {
  family: MarketFamily;
  /** Линия исхода; у ML — null. */
  line: number | null;
}

// Пределы линий по геймам, как на сервере (GAME_HCP_MAX, GAME_TOTAL_MIN, GAME_TOTAL_MAX)
export const GAME_HCP_MAX = 30;
export const GAME_TOTAL_MIN = 10;
export const GAME_TOTAL_MAX = 80;
const SET_HCP = [1.5, 2.5];
const SET_TOTAL = [2.5, 3.5, 4.5];

const CODE = /^(HCP|GHCP|STOT|GTOT)_([+-]?)(\d{1,2}(?:\.5)?)$/;

/** Половинная (22.5) или целая (22) линия; четвертные (22.25) — нет. */
export function isHalfOrWhole(line: number): boolean {
  return Number.isFinite(line) && Math.abs(line * 2 - Math.round(line * 2)) < 1e-9;
}

export function isWholeLine(line: number | null): boolean {
  return line !== null && Number.isInteger(line);
}

/** Разбор кода рынка (как market_spec сервера); неверный код — null. */
export function marketSpec(code: string): MarketSpec | null {
  if (code === 'ML') return { family: 'ml', line: null };
  const found = CODE.exec(code);
  if (!found) return null;
  const [, prefix, sign, number] = found;
  const value = Number(number);
  if (prefix === 'HCP' || prefix === 'GHCP') {
    if (!sign) return null;
    const line = sign === '-' ? -value : value;
    if (prefix === 'HCP') return SET_HCP.includes(value) ? { family: value === 1.5 ? 'h15' : 'shcp', line } : null;
    return value >= 0.5 && value <= GAME_HCP_MAX ? { family: 'ghcp', line } : null;
  }
  if (sign) return null;
  if (prefix === 'STOT') return SET_TOTAL.includes(value) ? { family: 'stot', line: value } : null;
  return value >= GAME_TOTAL_MIN && value <= GAME_TOTAL_MAX ? { family: 'gtot', line: value } : null;
}

/** Код рынка из семейства и линии стороны: HCP_-2.5, GTOT_22, GHCP_+3. */
export function marketCode(family: MarketFamily, line: number | null): string {
  if (family === 'ml' || line === null) return 'ML';
  const abs = String(Math.abs(line));
  if (family === 'stot') return `STOT_${abs}`;
  if (family === 'gtot') return `GTOT_${abs}`;
  return `${family === 'ghcp' ? 'GHCP' : 'HCP'}_${line < 0 ? '-' : '+'}${abs}`;
}

export function familyOf(code: string): MarketFamily | null {
  return marketSpec(code)?.family ?? null;
}

export function isHandicap(family: MarketFamily): boolean {
  return family === 'h15' || family === 'shcp' || family === 'ghcp';
}

export function isTotal(family: MarketFamily): boolean {
  return family === 'stot' || family === 'gtot';
}

/** Рынок по геймам: исход — по счету по геймам («6:4 7:6»). */
export function isGamesFamily(family: MarketFamily | null): boolean {
  return family === 'ghcp' || family === 'gtot';
}

export function isGamesMarket(code: string): boolean {
  return isGamesFamily(familyOf(code));
}

/** Обратный исход (пара без маржи): Ф1(−3.5) ↔ Ф2(+3.5), больше ↔ меньше той же линии. */
export function oppositeOf(market: string, selection: number): { market: string; selection: number } {
  const spec = marketSpec(market);
  const other = selection === 1 ? 2 : 1;
  if (!spec || spec.line === null || !isHandicap(spec.family)) return { market, selection: other };
  return { market: marketCode(spec.family, -spec.line), selection: other };
}

/** Имена игроков для подписей фор («Фора по геймам Синнер −3.5»). */
export interface SideNames {
  p1: string;
  p2: string;
}

export function familyName(family: MarketFamily): string {
  return tr(`analysis.market.family.${family}`);
}

/**
 * Подпись исхода без имени игрока там, где оно не нужно: П1, Ф2(−1.5), «Тотал геймов больше
 * 22.5». Форы новых рынков с именами — «Фора по геймам Синнер −3.5», без имен — «Ф1(−3.5) по геймам».
 */
export function marketLabel(market: string, selection: number, names?: SideNames | null): string {
  const spec = marketSpec(market);
  if (!spec || spec.family === 'ml' || spec.line === null) return i18n.t('analysis.market.ml', { n: selection });
  const line = formatLine(spec.line, { signed: isHandicap(spec.family) });
  if (isTotal(spec.family)) {
    return i18n.t(selection === 1 ? 'analysis.market.over' : 'analysis.market.under', { family: familyName(spec.family), line });
  }
  if (spec.family === 'h15' || (spec.family === 'shcp' && !names)) return i18n.t('analysis.market.hcp', { n: selection, line });
  if (!names) return i18n.t('analysis.market.hcpGames', { n: selection, line });
  return i18n.t('analysis.market.hcpNamed', { family: familyName(spec.family), name: selection === 1 ? names.p1 : names.p2, line });
}

/**
 * Полная подпись исхода в таблице и ставке: «Синнер П1», «Руне Ф2(+1.5)», «Фора по сетам
 * Синнер −2.5», «Тотал сетов меньше 2.5».
 */
export function outcomeLabel(market: string, selection: number, names: SideNames): string {
  const spec = marketSpec(market);
  if (!spec || spec.family === 'ml' || spec.family === 'h15') {
    return `${selection === 1 ? names.p1 : names.p2} ${marketLabel(market, selection)}`.trim();
  }
  return marketLabel(market, selection, names);
}

export type ValueTier = 'strong' | 'good' | 'small';

/** Уровень валуя для метки: сильный ≥ 15%, хороший ≥ 10%, небольшой ≥ 5% (как value_tier). */
export function valueTier(tier: string): ValueTier | null {
  return tier === 'strong' || tier === 'good' || tier === 'small' ? tier : null;
}

// Вероятность целыми процентами («66%») — общая для всех экранов, живет в lib/format
export { formatProb } from '../../lib/format';

/**
 * Поправка Claude в процентных пунктах: «+4 п.п.», «−2 п.п.», «±0 п.п.». Общий формат п.п. —
 * formatPp в lib/format; здесь только вид экрана анализа: целые и ноль со знаком «±».
 * unit: false — только число (в узкой ячейке единица уже в заголовке).
 */
export function ppDelta(delta: number, { unit = true }: { unit?: boolean } = {}): string {
  return formatPp(delta, { digits: 0, zero: '±', unit });
}

/** Модель Claude по имени: claude-opus-5-5 → «Opus 5.5». */
export function modelName(model: string | null | undefined): string {
  if (!model) return '';
  const found = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(model);
  if (!found) return model;
  const [, family = '', major = '', minor = ''] = found;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`;
}

/** Доля банка без лишних нулей: 0.0225 → «2,25%», 0.015 → «1,5%», 0.02 → «2%». */
export function formatShare(share: number | string | null | undefined): string {
  const n = typeof share === 'string' ? Number(share) : share;
  if (n === null || n === undefined || !Number.isFinite(n)) return formatPercent(null);
  return formatPercent(n, { digits: 2 }).replace(/([.,]\d*?)0+%$/, '$1%').replace(/[.,]%$/, '%');
}

/** Расход Claude: меньше цента — с тремя-четырьмя знаками («$0,004», «$0,0003»), иначе «$0,13». */
export function usdSmall(value: number): string {
  if (value > 0 && value < 0.001) return formatUsd(value, 4);
  if (value > 0 && value < 0.01) return formatUsd(value, 3);
  return formatUsd(value, 2);
}
