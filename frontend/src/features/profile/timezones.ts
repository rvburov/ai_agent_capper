import type { TFunction } from 'i18next';

import type { DropdownOption } from '../../components';

/*
 * Часовые пояса для выбора в профиле. Список — как в макете (DATA.timezones): участники
 * в Финляндии, Германии и США (Р11). Смещение считается на сегодня, поэтому летнее и
 * зимнее время показываются верно. Пояс пользователя не из списка (задан при регистрации
 * по браузеру) и пояс этого браузера добавляются в начало, чтобы их можно было оставить.
 */

export const TIMEZONE_CITIES = [
  { value: 'Europe/Helsinki', city: 'helsinki' },
  { value: 'Europe/Berlin', city: 'berlin' },
  { value: 'America/New_York', city: 'newYork' },
  { value: 'America/Chicago', city: 'chicago' },
  { value: 'America/Denver', city: 'denver' },
  { value: 'America/Los_Angeles', city: 'losAngeles' },
] as const;

export type TimeZoneCity = (typeof TIMEZONE_CITIES)[number]['city'];

const MINUS = '−';

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Пояс браузера: Intl.DateTimeFormat().resolvedOptions().timeZone. */
export function browserTimeZone(): string | null {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Смещение от UTC в момент at: «+3», «−4», «+5:30», «» для самого UTC. null — браузер не умеет. */
export function utcOffset(timeZone: string, at: Date = new Date()): string | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    return name === undefined ? null : parseShortOffset(name);
  } catch {
    return null;
  }
}

/** «GMT+5:30» → «+5:30», «GMT−4» → «−4», нулевое смещение → пустая строка, иное → null.
 *  Нулевое смещение одни версии ICU пишут «GMT», другие «GMT+0». */
export function parseShortOffset(name: string): string | null {
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  if (!match) return null;
  const [, sign, hours, minutes] = match;
  if (!sign || !hours || (Number(hours) === 0 && !minutes)) return '';
  return `${sign === '-' ? MINUS : '+'}${Number(hours)}${minutes ? `:${minutes}` : ''}`;
}

function cityOf(timeZone: string): TimeZoneCity | null {
  return TIMEZONE_CITIES.find((zone) => zone.value === timeZone)?.city ?? null;
}

/** Название пояса: «Хельсинки» для поясов из списка, иначе имя IANA без подчеркиваний. */
export function timeZoneName(t: TFunction, timeZone: string): string {
  const city = cityOf(timeZone);
  return city ? t(`profile.tz.cities.${city}`) : timeZone.replace(/_/g, ' ');
}

/** «по Нью-Йорку» — дательный падеж, только для поясов из списка. */
export function timeZoneDative(t: TFunction, timeZone: string): string | null {
  const city = cityOf(timeZone);
  return city ? t(`profile.tz.dative.${city}`) : null;
}

/** Подпись в списке: «Хельсинки (UTC+3)». */
export function timeZoneLabel(t: TFunction, timeZone: string, at?: Date): string {
  const name = timeZoneName(t, timeZone);
  const offset = utcOffset(timeZone, at);
  if (offset === null) return name;
  const utc = t('profile.tz.utc', { offset });
  // Сам UTC — без повтора: «UTC», а не «UTC (UTC)»
  return utc === name ? name : t('profile.tz.option', { city: name, offset: utc });
}

/** Варианты для Dropdown: свой пояс и пояс браузера (если их нет в списке), затем список. */
export function timeZoneOptions(
  t: TFunction,
  current: string | null | undefined,
  { browser = browserTimeZone(), at }: { browser?: string | null; at?: Date } = {},
): DropdownOption[] {
  const listed = new Set<string>(TIMEZONE_CITIES.map((zone) => zone.value));
  const extra: string[] = [];
  // Свой пояс показываем всегда, даже если браузер его не знает; пояс браузера — если он годный
  if (current && !listed.has(current)) extra.push(current);
  if (browser && !listed.has(browser) && !extra.includes(browser) && isValidTimeZone(browser)) {
    extra.push(browser);
  }
  return [...extra, ...listed].map((value) => ({ value, label: timeZoneLabel(t, value, at) }));
}
