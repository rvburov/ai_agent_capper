// Форматирование денег, чисел и дат. Суммы, проценты, кэфы и даты в интерфейсе выводятся
// только через эти функции (CLAUDE.md). Вид — как в макете (mockup/js/ui.js, fmt):
// «48 133 ₽», «48,1 тыс. ₽», «$0,30», «1.85», «12,5%», «66%», «+2,1 п.п.», «8 окт», «3–5 окт»,
// «Сегодня, 14:05», «5 мин назад».
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

/**
 * Число с разделителем разрядов: «12 480», «0,25». signed — со знаком, как разница Brier
 * с рынком: «+0,012», «−0,012», ноль без знака.
 */
export function formatNumber(
  value: Amount | null | undefined,
  digits = 0,
  { signed = false }: { signed?: boolean } = {},
): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  return withMinus(
    numberFormat({
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(dropNegativeZero(n, digits)),
  );
}

/**
 * Сколько знаков после запятой нужно, чтобы соседние деления оси с шагом step не слились
 * в одну подпись: шаг 1 и крупнее — 0, 0,5 и 0,1 — 1, 0,05 — 2.
 */
export function stepDigits(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0;
  return Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
}

// Единица сокращения, в которой Intl покажет значение: 1, тысяча, миллион, миллиард, триллион
function compactUnit(value: number): number {
  const abs = Math.abs(value);
  if (abs < 1000) return 1;
  return 10 ** Math.min(12, 3 * Math.floor(Math.log10(abs) / 3));
}

/**
 * Сокращенное число для осей графиков и плиток: «950», «4,8 тыс.», «48 тыс.», «1,2 млн».
 * digits — сколько знаков после запятой у тысяч и миллионов (лишние нули не пишутся).
 * step — шаг делений оси: знаков столько, чтобы соседние деления различались
 * («990 тыс.», «1 млн», «1,01 млн»).
 */
export function formatCompact(
  value: Amount | null | undefined,
  { digits = 1, signed = false, step }: { digits?: number; signed?: boolean; step?: number } = {},
): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  const max = step === undefined ? digits : stepDigits(step / compactUnit(n));
  return withMinus(
    numberFormat({
      notation: 'compact',
      maximumFractionDigits: max,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(dropNegativeZero(n, max)),
  );
}

/**
 * Сокращенная сумма в валюте программы: «48,1 тыс. ₽», «1,2 млн ₽», «950 ₽». Меньше тысячи —
 * как в formatMoney, но без лишних нулей: рубли целыми, доллары и евро — до центов («12,5 $»).
 * step — шаг делений оси, как в formatCompact.
 */
export function formatMoneyCompact(
  amount: Amount | null | undefined,
  currency: Currency,
  { digits = 1, signed = false, step }: { digits?: number; signed?: boolean; step?: number } = {},
): string {
  const value = toNumber(amount);
  if (!Number.isFinite(value)) return DASH;
  // Ниже тысячи — знаки суммы: 999,5 ₽ округлится до «1 тыс. ₽», а не покажет копейки
  // (Intl переходит к «тыс.» по значению, округленному до maximumFractionDigits)
  let max = Math.abs(value) >= 1000 ? digits : currency === 'RUB' ? 0 : 2;
  if (step !== undefined) max = stepDigits(step / compactUnit(value));
  return withMinus(
    numberFormat({
      style: 'currency',
      currency,
      notation: 'compact',
      minimumFractionDigits: 0,
      maximumFractionDigits: max,
      signDisplay: signed ? 'exceptZero' : 'auto',
    }).format(dropNegativeZero(value, max)),
  );
}

/** Кэф как на табло: всегда две цифры после точки — «1.85». */
export function formatOdds(value: Amount | null | undefined): string {
  const n = toNumber(value);
  return Number.isFinite(n) ? n.toFixed(2) : DASH;
}

/**
 * Кэф, посчитанный сервером до 0.001 (кэф расчета экспресса с возвратом ноги): третий знак,
 * если он не ноль, — «1.335», иначе как на табло — «1.30». По нему сходится выплата.
 */
export function formatOddsExact(value: Amount | null | undefined): string {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return DASH;
  const milli = Math.round(n * 1000);
  return (milli / 1000).toFixed(milli % 10 === 0 ? 2 : 3);
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

/** Вероятность целыми процентами: «66%» (прогноз модели, 1/кэф, калибровка). */
export function formatProb(p: number | null | undefined): string {
  return formatPercent(p, { digits: 0 });
}

/** Диапазон вероятностей: «70–75%» (корзина калибровки). */
export function formatProbRange(lo: number | null | undefined, hi: number | null | undefined): string {
  const a = toNumber(lo);
  const b = toNumber(hi);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return DASH;
  return i18n.t('format.probRange', {
    from: formatNumber(a * 100),
    to: formatNumber(b * 100),
  });
}

/**
 * Разница долей в процентных пунктах: 0.021 → «+2,1 п.п.», −0.01 → «−1,0 п.п.», ноль — «0,0 п.п.»
 * (ROI к прошлому периоду, прогноз против факта). signed: false — без плюса. zero: '±' —
 * ноль как «±0 п.п.» (поправка Claude к вероятности, экран анализа). unit: false — только
 * число, когда единица уже в заголовке столбца.
 */
export function formatPp(
  delta: number | null | undefined,
  {
    digits = 1,
    signed = true,
    zero = '',
    unit = true,
  }: { digits?: number; signed?: boolean; zero?: '' | '±'; unit?: boolean } = {},
): string {
  const n = toNumber(delta);
  if (!Number.isFinite(n)) return DASH;
  let value = formatNumber(n * 100, digits, { signed });
  // ноль после округления (formatNumber уже без знака) — со знаком «±», если просили
  if (zero && dropNegativeZero(n * 100, digits) === 0) value = zero + value;
  return unit ? i18n.t('format.pp', { value }) : value;
}

/**
 * Интервал из двух значений одним форматом: 95% ДИ ROI «−3,2%…+8,4%», Brier «−0,012…+0,004».
 * Нет любого конца — прочерк.
 */
export function formatInterval<T>(
  lo: T | null | undefined,
  hi: T | null | undefined,
  format: (value: T) => string,
): string {
  if (lo === null || lo === undefined || hi === null || hi === undefined) return DASH;
  return i18n.t('format.interval', { from: format(lo), to: format(hi) });
}

/**
 * Доля 0..1 числом процентов без знака «%», когда «%» стоит один раз на несколько чисел: начало
 * диапазона «70» в «70–75%», подписи столбцов CLV «+2». По умолчанию — целые.
 */
export function formatPercentNumber(
  fraction: number | null | undefined,
  { digits = 0, signed = false }: { digits?: number; signed?: boolean } = {},
): string {
  const n = toNumber(fraction);
  if (!Number.isFinite(n)) return DASH;
  return formatNumber(n * 100, digits, { signed });
}

/** Интервал долей целыми процентами, «%» один раз: 95% ДИ ROI «−8…+16%». Нет конца — прочерк. */
export function formatPercentRange(
  lo: number | null | undefined,
  hi: number | null | undefined,
  { signed = false }: { signed?: boolean } = {},
): string {
  const range = formatInterval(lo, hi, (value) => formatPercentNumber(value, { signed }));
  return range === DASH ? DASH : `${range}%`;
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

// «2026-10-03» — календарный день (ряд банка по дням, последний матч), а не момент времени:
// показываем его как есть, в любом поясе пользователя
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function zoneOf(value: DateInput, timeZone: string | undefined): string | undefined {
  return typeof value === 'string' && DATE_ONLY.test(value) ? 'UTC' : (timeZone ?? displayTimeZone);
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
  if (!date || value === null || value === undefined) return DASH;
  const timeZone = zoneOf(value, options.timeZone);
  const p = partsIn(date, timeZone);
  const showYear =
    options.year === 'always' ||
    p.year !== partsIn(nowDate(options), options.timeZone ?? displayTimeZone).year;
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
  if (!date || value === null || value === undefined) return DASH;
  const p = partsIn(date, zoneOf(value, options.timeZone));
  const months: readonly string[] = i18n.t('format.monthsGenitive', { returnObjects: true });
  return i18n.t('format.dateYear', { day: p.day, month: months[p.month - 1] ?? p.month, year: p.year });
}

/** День и месяц полностью, без года: «1 ноября» («С 1 ноября расход начнется заново»). */
export function formatDayMonth(
  value: DateInput | null | undefined,
  options: Pick<DateFormatOptions, 'timeZone'> = {},
): string {
  const date = toDate(value);
  if (!date || value === null || value === undefined) return DASH;
  const p = partsIn(date, zoneOf(value, options.timeZone));
  const months: readonly string[] = i18n.t('format.monthsGenitive', { returnObjects: true });
  return i18n.t('format.date', { day: p.day, month: months[p.month - 1] ?? p.month });
}

/** Время в поясе пользователя: «14:05» (начало матча на главной). */
export function formatTime(
  value: DateInput | null | undefined,
  options: Pick<DateFormatOptions, 'timeZone'> = {},
): string {
  const date = toDate(value);
  if (!date) return DASH;
  const p = partsIn(date, options.timeZone ?? displayTimeZone);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

const weekdayFormats = new Map<string, Intl.DateTimeFormat>();

/** День недели словом: «вторник». День без времени («2026-10-13») — календарный, в любом поясе. */
export function formatWeekday(
  value: DateInput | null | undefined,
  options: Pick<DateFormatOptions, 'timeZone'> = {},
): string {
  const date = toDate(value);
  if (!date || value === null || value === undefined) return DASH;
  const timeZone = zoneOf(value, options.timeZone);
  const key = `${locale()}|${timeZone ?? ''}`;
  let format = weekdayFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone });
    weekdayFormats.set(key, format);
  }
  return format.format(date);
}

/**
 * Диапазон дат: «3–5 окт», «28 сен – 5 окт», «28 дек 2025 – 5 янв 2026» (год — если концы
 * в разных годах или не в текущем), один день — «8 окт». month: 'long' — месяц полностью:
 * «1–13 октября» (период расходов). Конец раньше начала — концы меняются местами.
 */
export function formatDateRange(
  from: DateInput | null | undefined,
  to: DateInput | null | undefined,
  options: DateFormatOptions & { month?: 'short' | 'long' } = {},
): string {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b || from === null || from === undefined || to === null || to === undefined) return DASH;
  let p = partsIn(a, zoneOf(from, options.timeZone));
  let q = partsIn(b, zoneOf(to, options.timeZone));
  if (dayNumber(q) < dayNumber(p)) [p, q] = [q, p];
  const nowYear = partsIn(nowDate(options), options.timeZone ?? displayTimeZone).year;
  const months: readonly string[] =
    options.month === 'long'
      ? i18n.t('format.monthsGenitive', { returnObjects: true })
      : i18n.t('format.monthsShort', { returnObjects: true });
  const month = (n: number) => months[n - 1] ?? String(n);
  const withYear = p.year !== q.year || p.year !== nowYear;
  const one = (x: Parts) =>
    withYear
      ? i18n.t('format.dateYear', { day: x.day, month: month(x.month), year: x.year })
      : i18n.t('format.date', { day: x.day, month: month(x.month) });

  if (dayNumber(p) === dayNumber(q)) return one(p);
  if (p.year === q.year && p.month === q.month) {
    return withYear
      ? i18n.t('format.dayRangeYear', { from: p.day, to: q.day, month: month(p.month), year: p.year })
      : i18n.t('format.dayRange', { from: p.day, to: q.day, month: month(p.month) });
  }
  return i18n.t('format.dateRange', { from: one(p), to: one(q) });
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
