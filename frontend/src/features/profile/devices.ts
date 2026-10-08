import type { IconName } from '../../components';

/** Устройство из метки «Chrome · Android»: телефон или компьютер — для иконки в списке. */
export function deviceIcon(label: string): IconName {
  return /\b(iOS|Android)\b/.test(label) ? 'device' : 'laptop';
}

/** Метка устройства или подпись «Неизвестное устройство» (вход не из браузера). */
export function deviceName(label: string | null | undefined, unknown: string): string {
  const text = label?.trim();
  return text ? text : unknown;
}

/**
 * IP частично, как в макете: «88.193.xx.xx». Свой адрес так узнать можно, а случайный
 * зритель экрана полного адреса не увидит. IPv6 — первые две группы: «2a01:4f9:…».
 */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return '—';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.xx.xx`;
  if (ip.includes(':')) {
    const groups = ip.split(':').filter(Boolean).slice(0, 2);
    return `${groups.join(':')}:…`;
  }
  return ip;
}

/** Время внутри фразы со строчной буквы: «· сегодня, 19:54», «вход вчера, 23:52». */
export function lowerFirst(text: string): string {
  return text.charAt(0).toLocaleLowerCase() + text.slice(1);
}
