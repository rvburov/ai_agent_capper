import type { ChipKind, IconName } from '../../components';
import { getDisplayTimeZone, type Currency } from '../../lib/format';
import type { BetItem, BetLeg, BetStatus, Closing, Market, Verdict } from './types';

/*
 * Как показывать ставку: метки статуса и исхода, вердикт по CLV, чей закрывающий кэф, имена
 * игроков, месяц ставки в поясе участника. Числа (CLV, выплата, вердикт) считает сервер, здесь —
 * только их вид. Тексты — ключи bets.* в ru.json.
 */

/** Вид метки; подпись — t(`bets.status.${status}`), t(`bets.verdict.${verdict}`) и т.п. */
export interface ChipMeta {
  kind: ChipKind;
  icon: IconName;
}

/** Метка статуса ставки (statusChip макета): «В игре», «Выигрыш», «Проигрыш», «Возврат». */
export const STATUS_CHIP: Record<BetStatus, ChipMeta> = {
  open: { kind: 'info', icon: 'clock' },
  won: { kind: 'good', icon: 'check' },
  lost: { kind: 'bad', icon: 'x' },
  void: { kind: 'outline', icon: 'refresh' },
};

/** Вердикт по CLV считает сервер (services/bets.py, verdict); здесь — метка и пояснение. */
export const VERDICT_CHIP: Record<Verdict, ChipMeta> = {
  legacy: { kind: 'outline', icon: 'info' },
  void: { kind: 'outline', icon: 'refresh' },
  no_closing: { kind: 'outline', icon: 'info' },
  edge_confirmed: { kind: 'good', icon: 'check' },
  won_against_market: { kind: 'warn', icon: 'alert' },
  variance: { kind: 'info', icon: 'info' },
  model_error: { kind: 'serious', icon: 'alert' },
};

/** Исход ноги на экране: open — еще не сыграно, unknown — старый бот исход не записал. */
export type LegShown = 'win' | 'loss' | 'void' | 'open' | 'unknown';

export function legShown(bet: Pick<BetItem, 'status'>, leg: Pick<BetLeg, 'result'>): LegShown {
  if (bet.status === 'void') return 'void';
  if (leg.result) return leg.result;
  return bet.status === 'open' ? 'open' : 'unknown';
}

export const LEG_ICON: Record<LegShown, IconName> = {
  win: 'check',
  loss: 'x',
  void: 'refresh',
  open: 'clock',
  unknown: 'info',
};

export const LEG_CHIP: Record<LegShown, ChipMeta> = {
  win: { kind: 'good', icon: 'check' },
  loss: { kind: 'bad', icon: 'x' },
  void: { kind: 'outline', icon: 'refresh' },
  open: { kind: 'info', icon: 'clock' },
  unknown: { kind: 'outline', icon: 'info' },
};

/** Ключ рынка в текстах (в названии рынка есть точка — разделитель ключей i18next). */
export const MARKET_KEY = { ML: 'ml', 'HCP_-1.5': 'minus', 'HCP_+1.5': 'plus' } as const satisfies Record<Market, string>;

/** Ставка старого бота (В5): без CLV и вердикта. */
export function isLegacy(bet: Pick<BetItem, 'source'>): boolean {
  return bet.source === 'legacy';
}

/**
 * Результат перенесен импортом старого бота: сервер его не пересчитывает (409 bet.legacy),
 * поэтому «Исправить результат» не показываем. Открытую ставку бота и рассчитанную самим
 * участником исправить можно.
 */
export function isImported(bet: Pick<BetItem, 'source' | 'status' | 'settled_by'>): boolean {
  return bet.source === 'legacy' && bet.status !== 'open' && bet.settled_by !== 'manual';
}

/** Цвет числа: плюс — зеленый, минус — красный, ноль и прочерк — серый. */
export function toneClass(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number(value) : value;
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return 'muted';
  return n > 0 ? 'good-text' : 'bad-text';
}

/** Вероятность исхода по модели: итоговая (p_final), у ставок бота — оценка Claude. */
export function legProb(leg: Pick<BetLeg, 'p_final' | 'p_claude'>): number | null {
  return leg.p_final ?? leg.p_claude ?? null;
}

/** Вероятность по кэфу: 1 / кэф. */
export function impliedProb(odds: string | number): number | null {
  const n = Number(odds);
  return Number.isFinite(n) && n > 0 ? 1 / n : null;
}

/** Шанс экспресса по модели — произведение вероятностей ног; нет у какой-то ноги — null. */
export function parlayProb(legs: readonly Pick<BetLeg, 'p_final' | 'p_claude'>[]): number | null {
  let p = 1;
  for (const leg of legs) {
    const value = legProb(leg);
    if (value === null) return null;
    p *= value;
  }
  return legs.length ? p : null;
}

/** Букмекер своего закрывающего кэфа (by = bookmaker): названный или букмекер ставки. */
export function closingBookmaker(closing: Pick<Closing, 'by' | 'bookmaker'>, betBookmaker: string): string | null {
  return closing.by === 'bookmaker' ? (closing.bookmaker ?? betBookmaker) : null;
}

/** Валюта суммы из API (валюта программы, Р17). */
export function currencyOf(code: string | null | undefined): Currency {
  return code === 'USD' || code === 'EUR' ? code : 'RUB';
}

/** Покрытие ставки — по первой ноге (у экспресса бывают разные; строка истории показывает первое). */
export function betSurface(bet: Pick<BetItem, 'legs'>): string | null {
  return bet.legs[0]?.match.surface ?? null;
}

/** Турнир ставки — первой ноги. */
export function betTournament(bet: Pick<BetItem, 'legs'>): string | null {
  return bet.legs.find((leg) => leg.match.tournament)?.match.tournament ?? null;
}

// ---------- дни и месяцы в поясе участника ----------

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** Календарный день момента в поясе участника: «2026-10-13». */
export function localDay(value: string | Date, timeZone: string | undefined = getDisplayTimeZone()): string {
  const key = timeZone ?? '';
  let format = dayFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormats.set(key, format);
  }
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(format.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Месяц ставки в поясе участника: «2026-10». */
export function monthOf(placedAt: string, timeZone?: string): string {
  return localDay(placedAt, timeZone).slice(0, 7);
}

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 2000, m ?? 1, 0));
  return date.toISOString().slice(0, 10);
}

const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * Даты месяца истории для итогов месяца (GET /api/bets/summary?from=&to=): месяц,
 * пересеченный с периодом фильтра (последние N дней вместе с сегодняшним, как у сервера)
 * или со своим диапазоном. Пересечения нет — null.
 */
export function monthRange(
  month: string,
  filters: { period: string; from: string | null; to: string | null },
  today: string,
): { from: string; to: string } | null {
  let from = `${month}-01`;
  let to = lastDayOf(month);
  if (filters.from || filters.to) {
    if (filters.from && filters.from > from) from = filters.from;
    if (filters.to && filters.to < to) to = filters.to;
  } else {
    const days = PERIOD_DAYS[filters.period];
    if (days !== undefined) {
      const start = shiftDay(today, -(days - 1));
      if (start > from) from = start;
    }
  }
  return from <= to ? { from, to } : null;
}

// ---------- этап 5: расчет по архиву tennis-data ----------

/**
 * Кто рассчитал ставку — метка под датой в истории: «авто · архив ‹дата›» (по файлу
 * tennis-data) или «внесено вами». У открытой и у перенесенной из бота метки нет.
 */
export function settledBy(bet: Pick<BetItem, 'status' | 'settled_by' | 'source'>): 'auto' | 'manual' | null {
  if (bet.status === 'open') return null;
  if (bet.settled_by === 'auto') return 'auto';
  if (bet.settled_by === 'manual') return 'manual';
  return null;
}

/** Закрытие из архива tennis-data (Т1): только П1/П2, момент снятия кэфа не проверен. */
export function isArchiveClosing(closing: Pick<Closing, 'source'> | null | undefined): boolean {
  return closing?.source === 'archive';
}

/**
 * У форы рассчитанной ставки нет закрытия: в архиве tennis-data кэфов на форы нет, закрытие
 * вносит участник («внесите сами»).
 */
export function closingByHand(bet: Pick<BetItem, 'status' | 'source'>, leg: Pick<BetLeg, 'market' | 'closing' | 'result'>): boolean {
  return bet.status !== 'open' && !isLegacy(bet) && leg.market !== 'ML' && !leg.closing && legShown(bet, leg) !== 'void';
}

/** Ноги, по которым архив разошелся с расчетом ставки (Т3): банк не меняли, проверяет участник. */
export function archiveConflicts(bet: Pick<BetItem, 'status' | 'legs'>): BetLeg[] {
  if (bet.status === 'open') return [];
  return bet.legs.filter((leg) => leg.archive_result !== null);
}

/** Последний день матчей ставки («матчи сыграны 4 окт»); дней нет — null. */
export function lastMatchDay(bet: Pick<BetItem, 'legs'>): string | null {
  const days = bet.legs.map((leg) => leg.match.day).filter((day): day is string => Boolean(day));
  return days.length ? (days.sort()[days.length - 1] ?? null) : null;
}

/**
 * Ставка «ждет результата», а архив уже дальше дня ее матчей: файл с этими днями загружен, но
 * исхода в нем нет (не основной тур или имя игрока записано иначе), сама ставка не рассчитается.
 * День матча не сравниваем на равенство: в файле день матча мог быть по другому поясу.
 */
export function missingInArchive(bet: Pick<BetItem, 'legs' | 'awaiting_result' | 'archive_matches_to'>): boolean {
  const day = lastMatchDay(bet);
  return bet.awaiting_result && day !== null && bet.archive_matches_to != null && bet.archive_matches_to > day;
}
