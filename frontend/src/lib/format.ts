// Форматирование денег, чисел и дат. Суммы, проценты, кэфы и даты в интерфейсе выводятся
// только через эти функции (CLAUDE.md). Вид — как в макете (mockup/js/ui.js, fmt):
// «48 133 ₽», «$0,30», «1.85», «12,5%», «8 окт», «Сегодня, 14:05», «5 мин назад».
// Локаль и слова («Сегодня», месяцы) берутся из файла перевода (format.*).

import i18n from '../i18n';

export type Currency = 'RUB' | 'USD' | 'EUR';

/** Сумма из API: Decimal приходит строкой («48133.00»), расчеты на клиенте — числом. */
export type Amount = number | string;
export type DateInput = string | number | Date;

const MINUS = '\u2212';
const DASH = '\u2014';

function locale(): string {
  return i18n.t('format.locale');
}

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const loc = locale();
  const key = loc + JSON.stringify(options);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(loc, options);
    numberFormats.set(key, format);
  }
  return format;
}

function toNumber(value: Amount | null | undefined): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return typeof value === 'number' ? value : Number(value);
}

// Как в макете: знак минус U+2212 вместо дефиса
function withMinus(text: string): string {
  return text.replace('-', MINUS);
}

// Значение, которое при округлении до digits знаков станет нулем, — просто ноль: Intl сохраняет
// знак у отрицательного нуля, и без этого вышло бы «−0 ₽» или «−0,0%»
function dropNegativeZero(n: number, digits: number): number {
  return Math.abs(n) < 0.5 * 10 ** -digits ? 0 : n;
}

/** Деньги в валюте программы (Р17): рубли без копеек, доллары и евро с центами. */
export function formatMoney(
  amount: Amount | null | undefined,
  currency: Currency,
  { signed = false }: { signed?: boolean } = {},
): string {
  const value = toNumber(amount);
  if (!Number.isFinite(value)) return DASH;
  const digits = currency === 'RUB' ? 0 : 2;
  return withMinus(
    numberFormat({
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(dropNegativeZero(value, digits)),
  );
}

/** Расходы на Claude — всегда в долларах, знак впереди: «$0,30». */
export function formatUsd(amount: Amount | null | undefined, digits = 2): string {
  const value = toNumber(amount);
  if (!Number.isFinite(value)) return DASH;
  const rounded = Number(value.toFixed(digits));
  const body = numberFormat({
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(rounded));
  return (rounded < 0 ? MINUS : '') + '$' + body;
}

/** Число с разделителем разрядов: «12 480», «0,25». */
export function formatNumber(value: Amount | null | undefined, digits = 0): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  return withMinus(
    numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
      dropNegativeZero(n, digits),
    ),
  );
}

/** Кэф как на табло: всегда две цифры после точки — «1.85». */
export function formatOdds(value: Amount | null | undefined): string {
  const n = toNumber(value);
  return Number.isFinite(n) ? n.toFixed(2) : DASH;
}

/** Доля 0..1 в процентах: 0.125 → «12,5%». signed — со знаком: «+3,2%», «−1,0%». */
export function formatPercent(
  fraction: number | null | undefined,
  { digits = 1, signed = false }: { digits?: number; signed?: boolean } = {},
): string {
  const n = toNumber(fraction);
  if (!Number.isFinite(n)) return DASH;
  return (
    withMinus(
      numberFormat({
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        signDisplay: signed ? 'exceptZero' : 'auto',
      }).format(dropNegativeZero(n * 100, digits)),
    ) + '%'
  );
}

// ---------- даты ----------

// Часовой пояс пользователя (users.tz). Пока профиль не загружен — пояс браузера.
let displayTimeZone: string | undefined;

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function setDisplayTimeZone(timeZone: string | null | undefined): void {
  displayTimeZone = timeZone && isValidTimeZone(timeZone) ? timeZone : undefined;
}

export function getDisplayTimeZone(): string | undefined {
  return displayTimeZone;
}

export interface DateFormatOptions {
  /** Пояс показа; по умолчанию — пояс пользователя. */
  timeZone?: string;
  /** «Сейчас» для «Сегодня» и «5 мин назад»; в тестах задается явно. */
  now?: DateInput;
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partFormats = new Map<string, Intl.DateTimeFormat>();

// Календарные части момента в нужном поясе. Числа берем из en-US: цифры там всегда ASCII.
function partsIn(date: Date, timeZone: string | undefined): Parts {
  const key = timeZone ?? '';
  let format = partFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    partFormats.set(key, format);
  }
  const parts: Parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const part of format.formatToParts(date)) {
    if (part.type in parts) parts[part.type as keyof Parts] = Number(part.value);
  }
  return parts;
}

function toDate(value: DateInput | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayNumber(parts: Parts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000;
}

function monthShort(month: number): string {
  const months: readonly string[] = i18n.t('format.monthsShort', { returnObjects: true });
  return months[month - 1] ?? String(month);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function nowDate(options: DateFormatOptions): Date {
  return toDate(options.now ?? Date.now()) ?? new Date();
}

/** «8 окт»; год добавляется, если он не текущий (или year: 'always'): «8 окт 2025». */
export function formatDate(
  value: DateInput | null | undefined,
  options: DateFormatOptions & { year?: 'auto' | 'always' } = {},
): string {
  const date = toDate(value);
  if (!date) return DASH;
  const timeZone = options.timeZone ?? displayTimeZone;
  const p = partsIn(date, timeZone);
  const showYear = options.year === 'always' || p.year !== partsIn(nowDate(options), timeZone).year;
  return showYear
    ? i18n.t('format.dateYear', { day: p.day, month: monthShort(p.month), year: p.year })
    : i18n.t('format.date', { day: p.day, month: monthShort(p.month) });
}

/** Полная дата с годом: «30 июня 2026» (дата регистрации, выпуска кодов). */
export function formatDateLong(
  value: DateInput | null | undefined,
  options: Pick<DateFormatOptions, 'timeZone'> = {},
): string {
  const date = toDate(value);
  if (!date) return DASH;
  const p = partsIn(date, options.timeZone ?? displayTimeZone);
  const months: readonly string[] = i18n.t('format.monthsGenitive', { returnObjects: true });
  return i18n.t('format.dateYear', { day: p.day, month: months[p.month - 1] ?? p.month, year: p.year });
}

/** День и месяц полностью, без года: «1 ноября» («С 1 ноября расход начнется заново»). */
export function formatDayMonth(
  value: DateInput | null | undefined,
  options: Pick<DateFormatOptions, 'timeZone'> = {},
): string {
  const date = toDate(value);
  if (!date) return DASH;
  const p = partsIn(date, options.timeZone ?? displayTimeZone);
  const months: readonly string[] = i18n.t('format.monthsGenitive', { returnObjects: true });
  return i18n.t('format.date', { day: p.day, month: months[p.month - 1] ?? p.month });
}

/**
 * «Сегодня, 14:05», «Вчера, 09:30», «8 окт, 14:05». calendar: false — без «Сегодня»;
 * year: 'always' — с годом и в текущем году: «8 окт 2026, 14:05» (для файлов, которые хранят).
 */
export function formatDateTime(
  value: DateInput | null | undefined,
  options: DateFormatOptions & { calendar?: boolean; year?: 'auto' | 'always' } = {},
): string {
  const date = toDate(value);
  if (!date) return DASH;
  const timeZone = options.timeZone ?? displayTimeZone;
  const p = partsIn(date, timeZone);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  let day: string | null = null;
  if (options.calendar !== false) {
    const diff = dayNumber(p) - dayNumber(partsIn(nowDate(options), timeZone));
    if (diff === 0) day = i18n.t('format.today');
    else if (diff === -1) day = i18n.t('format.yesterday');
    else if (diff === 1) day = i18n.t('format.tomorrow');
  }
  return i18n.t('format.dateTime', {
    date: day ?? formatDate(date, { ...options, timeZone }),
    time,
  });
}

/** «только что», «5 мин назад», «3 ч назад», «2 дня назад»; старше 30 дней — дата. */
export function formatRelative(
  value: DateInput | null | undefined,
  options: DateFormatOptions = {},
): string {
  const date = toDate(value);
  if (!date) return DASH;
  const diffMs = nowDate(options).getTime() - date.getTime();
  const future = diffMs < 0;
  const minutes = Math.round(Math.abs(diffMs) / 60_000);
  if (minutes < 2) return i18n.t('format.justNow');
  if (minutes < 60) {
    return i18n.t(future ? 'format.inMinutes' : 'format.minutesAgo', { count: minutes });
  }
  if (minutes < 23.5 * 60) {
    const hours = Math.round(minutes / 60);
    return i18n.t(future ? 'format.inHours' : 'format.hoursAgo', { count: hours });
  }
  const days = Math.round(minutes / 1440);
  if (days < 30) return i18n.t(future ? 'format.inDays' : 'format.daysAgo', { count: days });
  return formatDate(date, options);
}

// ---------- время и токены (ход анализа) ----------

/** Длительность из миллисекунд: «0 с», «45 с», «1 мин 28 с», «1 ч 5 мин» (fmt.duration в макете). */
export function formatDuration(ms: number | null | undefined): string {
  const n = toNumber(ms);
  if (!Number.isFinite(n)) return DASH;
  const total = Math.max(0, Math.round(n / 1000));
  if (total < 60) return i18n.t('format.durationSec', { s: total });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return i18n.t('format.durationMin', { m: minutes, s: total % 60 });
  return i18n.t('format.durationHour', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

/** Оценка времени до запуска: «~45 с», «~1,5 мин» (fmtTime в mockup/js/screens/new-analysis.js). */
export function formatEstimate(seconds: number | null | undefined): string {
  const n = toNumber(seconds);
  if (!Number.isFinite(n)) return DASH;
  if (n < 60) return i18n.t('format.aboutSec', { n: Math.max(5, Math.round(n / 5) * 5) });
  const minutes = Math.round(n / 6) / 10;
  return i18n.t('format.aboutMin', { n: formatNumber(minutes, Number.isInteger(minutes) ? 0 : 1) });
}

/** Токены: «2 400»; compact — «41,2 тыс.» (от 10 тысяч). */
export function formatTokens(
  value: number | null | undefined,
  { compact = false }: { compact?: boolean } = {},
): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  if (compact && n >= 10_000) return i18n.t('format.thousands', { n: formatNumber(n / 1000, 1) });
  return formatNumber(n);
}

// ---------- поля ввода сумм («Новый анализ», окна ставки) ----------

/** Знак валюты программы рядом с полем суммы: «₽», «$», «€». */
export function currencySign(currency: Currency): string {
  const part = numberFormat({ style: 'currency', currency })
    .formatToParts(0)
    .find((item) => item.type === 'currency');
  return part?.value ?? currency;
}

/** Сумма в поле ввода, без знака валюты: «48 000» (рубли), «477,14» (доллары и евро). */
export function formatAmountInput(amount: Amount | null | undefined, currency: Currency): string {
  const value = toNumber(amount);
  if (!Number.isFinite(value)) return '';
  const digits = currency === 'RUB' ? 0 : 2;
  return numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}
