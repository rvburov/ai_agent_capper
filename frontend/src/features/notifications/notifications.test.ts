import { describe, expect, it } from 'vitest';

import { badgeText, internalLink, markAllRead, markOneRead, notificationLook, type NotificationsOut } from './notifications';

const item = (id: number, read: boolean) => ({
  id,
  kind: 'new_device',
  title: `Уведомление ${id}`,
  body: '',
  link: null,
  created_at: '2026-10-08T09:00:00Z',
  read_at: read ? '2026-10-08T10:00:00Z' : null,
});

const data: NotificationsOut = { items: [item(1, false), item(2, false), item(3, true)], unread: 2 };

describe('центр уведомлений', () => {
  it('ссылка — только путь этого сайта', () => {
    expect(internalLink('/profile/security')).toBe('/profile/security');
    expect(internalLink('//evil.example')).toBeNull();
    expect(internalLink('/\\evil.example')).toBeNull();
    expect(internalLink('https://evil.example')).toBeNull();
    expect(internalLink('javascript:alert(1)')).toBeNull();
    expect(internalLink('/a b')).toBeNull();
    expect(internalLink(null)).toBeNull();
  });

  it('счетчик больше 99 — «99+»', () => {
    expect(badgeText(3)).toBe('3');
    expect(badgeText(120)).toBe('99+');
  });

  it('вид уведомления: иконка и цвет', () => {
    expect(notificationLook('login_failures')).toEqual({ icon: 'lock', tone: 'bad' });
    expect(notificationLook('new_device')).toEqual({ icon: 'device', tone: 'info' });
    expect(notificationLook('что-то новое')).toEqual({ icon: 'bell', tone: null });
  });

  it('одно прочитано: отметка и счетчик, повтор ничего не меняет', () => {
    const next = markOneRead(data, 1, '2026-10-08T11:00:00Z');
    expect(next?.unread).toBe(1);
    expect(next?.items[0]?.read_at).toBe('2026-10-08T11:00:00Z');
    expect(markOneRead(next, 1, 'x')).toBe(next);
    expect(markOneRead(next, 3, 'x')).toBe(next);
  });

  it('все прочитаны: счетчик 0, старые отметки не меняются', () => {
    const next = markAllRead(data, '2026-10-08T11:00:00Z');
    expect(next?.unread).toBe(0);
    expect(next?.items.every((n) => n.read_at)).toBe(true);
    expect(next?.items[2]?.read_at).toBe('2026-10-08T10:00:00Z');
  });
});
