import type { IconName } from '../../components';
import type { components } from '../../api/schema';

// Центр уведомлений (колокольчик, Р3): вид уведомления, ссылки и отметка прочитанного в кэше.

export type NotificationsOut = components['schemas']['NotificationsOut'];
export type NotificationItem = components['schemas']['NotificationOut'];

export type NotificationTone = 'good' | 'warn' | 'bad' | 'info' | null;

/** Иконка и цвет кружка по виду уведомления (как в макете: DATA.notifications). */
export function notificationLook(kind: string): { icon: IconName; tone: NotificationTone } {
  switch (kind) {
    case 'new_device':
      return { icon: 'device', tone: 'info' };
    case 'login_failures':
      return { icon: 'lock', tone: 'bad' };
    case 'limit_80':
      return { icon: 'coins', tone: 'warn' };
    case 'limit_100':
      return { icon: 'coins', tone: 'bad' };
    case 'data_stale':
      return { icon: 'clock', tone: 'warn' };
    case 'admin_message':
      return { icon: 'megaphone', tone: 'info' };
    case 'bet_settled':
      return { icon: 'ticket', tone: null };
    default:
      return { icon: 'bell', tone: null };
  }
}

/** Ссылка уведомления — только путь этого сайта («/profile/security»), иначе без перехода. */
export function internalLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string' || !/^\/(?![/\\])/.test(link) || /[\s\\]/.test(link)) return null;
  return link;
}

/** Счетчик на колокольчике: больше 99 — «99+». */
export function badgeText(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

/** Одно уведомление прочитано: отметка в кэше сразу, не дожидаясь сервера. */
export function markOneRead(data: NotificationsOut | undefined, id: number, at: string): NotificationsOut | undefined {
  if (!data) return data;
  let changed = false;
  const items = data.items.map((item) => {
    if (item.id !== id || item.read_at) return item;
    changed = true;
    return { ...item, read_at: at };
  });
  return changed ? { items, unread: Math.max(0, data.unread - 1) } : data;
}

/** Все прочитаны. */
export function markAllRead(data: NotificationsOut | undefined, at: string): NotificationsOut | undefined {
  if (!data) return data;
  return { items: data.items.map((item) => (item.read_at ? item : { ...item, read_at: at })), unread: 0 };
}
