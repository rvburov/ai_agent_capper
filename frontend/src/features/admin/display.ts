import i18n from '../../i18n';
import { formatDate, formatDateTime, type DateInput } from '../../lib/format';

// Подписи раздела «Администрирование»: срок кода, IP, месяц расхода.

/** «осталось 40 мин», «осталось 23 часа», «еще 6 дней», «срок вышел» — как в макете. */
export function timeLeft(expires: DateInput, now: number = Date.now()): string {
  const at = expires instanceof Date ? expires.getTime() : new Date(expires).getTime();
  const minutes = Math.floor((at - now) / 60_000);
  if (!(minutes > 0)) return i18n.t('admin.left.expired');
  if (minutes < 60) return i18n.t('admin.left.minutes', { count: minutes });
  if (minutes < 48 * 60) return i18n.t('admin.left.hours', { count: Math.floor(minutes / 60) });
  return i18n.t('admin.left.days', { count: Math.floor(minutes / 1440) });
}

/** Время внутри фразы со строчной буквы: «действует до завтра, 09:20». */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase('ru') + text.slice(1);
}

/**
 * День по UTC внутри фразы (runs_out_on лимита — день месяца расходов, а он по UTC): «сегодня»,
 * «завтра», иначе «16 окт».
 */
export function utcDayInline(day: string, now: Date = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  const tomorrow = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  if (day === today) return lowerFirst(i18n.t('format.today'));
  if (day === tomorrow) return lowerFirst(i18n.t('format.tomorrow'));
  return formatDate(`${day}T12:00:00Z`, { timeZone: 'UTC' });
}

/** «Сегодня, 09:20» строчными — для середины фразы. */
export function whenInline(value: DateInput | null | undefined): string {
  return lowerFirst(formatDateTime(value));
}

/**
 * IP в журнале частично, как в макете: «95.216.•.•». IPv6 — первые две группы: «2a01:4f9:…».
 * Полный адрес администратору для этой работы не нужен.
 */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return '—';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.•.•`;
  if (ip.includes(':')) return `${ip.split(':').filter(Boolean).slice(0, 2).join(':')}:…`;
  return ip;
}

/**
 * Месяц расхода для подписей «за октябрь». Расход считается за календарный месяц UTC
 * (как на сервере), поэтому и месяц берется по UTC.
 */
export function spendMonth(now: Date = new Date()): string {
  const months: readonly string[] = i18n.t('admin.months', { returnObjects: true });
  return months[now.getUTCMonth()] ?? '';
}
