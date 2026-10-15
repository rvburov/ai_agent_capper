import { describe, expect, it } from 'vitest';

import {
  badgeText,
  internalLink,
  markAllRead,
  markOneRead,
  notificationLink,
  notificationLook,
  notificationOutcome,
  staleQueriesFor,
  type NotificationItem,
  type NotificationsOut,
} from './notifications';

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
    // этап 3: бюджет, ключ Claude и просьба вернуть ключ администратора
    expect(notificationLook('budget_80')).toEqual(notificationLook('limit_80'));
    expect(notificationLook('budget_100')).toEqual(notificationLook('limit_100'));
    expect(notificationLook('ai_key_failed')).toEqual({ icon: 'key', tone: 'bad' });
    expect(notificationLook('ai_mode_request')).toEqual({ icon: 'key', tone: 'info' });
    expect(notificationLook('ai_mode_decision')).toEqual({ icon: 'key', tone: 'info' });
    // ссылки уведомлений этапа 3: ключ и бюджет с прокруткой к лимитам, ключ Claude участника
    expect(internalLink('/admin/key#adm-limits')).toBe('/admin/key#adm-limits');
    expect(internalLink('/profile/key')).toBe('/profile/key');
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

describe('уведомления этапа 5', () => {
  it('вид: ждет результата и расхождение — предупреждение, отчет и обучение — сведения, архив — база данных', () => {
    expect(notificationLook('bet_needs_result')).toEqual({ icon: 'clock', tone: 'warn' });
    expect(notificationLook('settle_conflict')).toEqual({ icon: 'alert', tone: 'warn' });
    expect(notificationLook('weekly_report')).toEqual({ icon: 'calendar', tone: 'info' });
    expect(notificationLook('learning')).toEqual({ icon: 'brain', tone: 'info' });
    expect(notificationLook('data_stale')).toEqual({ icon: 'database', tone: 'warn' });
  });

  it('«Ставка рассчитана» — цвет по исходу: выигрыш зеленый, проигрыш красный, возврат без цвета', () => {
    const settled = (outcome: NotificationItem['outcome']) => ({ ...item(9, false), kind: 'bet_settled', outcome });
    expect(notificationOutcome(settled('won'))).toBe('won');
    expect(notificationOutcome(settled('lost'))).toBe('lost');
    expect(notificationOutcome(settled('void'))).toBe('void');
    expect(notificationOutcome(settled(null))).toBeNull();
    expect(notificationOutcome({})).toBeNull();
    expect(notificationLook('bet_settled', 'won')).toEqual({ icon: 'ticket', tone: 'good' });
    expect(notificationLook('bet_settled', 'lost')).toEqual({ icon: 'ticket', tone: 'bad' });
    expect(notificationLook('bet_settled', 'void')).toEqual({ icon: 'ticket', tone: null });
    expect(notificationLook('bet_settled')).toEqual({ icon: 'ticket', tone: null });
    // исход красит только «Ставка рассчитана»
    expect(notificationLook('bet_needs_result', 'won')).toEqual({ icon: 'clock', tone: 'warn' });
  });

  it('«Пора загрузить файл tennis-data» ведет на «Администрирование → Данные»', () => {
    expect(notificationLink({ kind: 'data_stale', link: null })).toBe('/admin/data');
    expect(notificationLink({ kind: 'data_stale', link: '/admin/data' })).toBe('/admin/data');
  });

  it('ссылка без своей с сервера: ставки, отчеты, обучение', () => {
    expect(notificationLink({ kind: 'bet_needs_result', link: null })).toBe('/bets');
    expect(notificationLink({ kind: 'settle_conflict', link: null })).toBe('/bets');
    expect(notificationLink({ kind: 'bet_needs_result', link: '/bets?bet=66' })).toBe('/bets?bet=66');
    expect(notificationLink({ kind: 'weekly_report', link: null })).toBe('/learning/reports');
    expect(notificationLink({ kind: 'learning', link: null })).toBe('/learning');
    expect(notificationLink({ kind: 'learning', link: '/learning/versions' })).toBe('/learning/versions');
  });

  it('что перечитать: деньги не менялись — ставки и главная; обучение — его сводка', () => {
    expect(staleQueriesFor('bet_needs_result')).toEqual([['bets'], ['dashboard']]);
    expect(staleQueriesFor('settle_conflict')).toEqual([['bets'], ['dashboard']]);
    expect(staleQueriesFor('weekly_report')).toEqual([['learning'], ['dashboard']]);
    expect(staleQueriesFor('learning')).toEqual([['learning'], ['dashboard']]);
  });
});
