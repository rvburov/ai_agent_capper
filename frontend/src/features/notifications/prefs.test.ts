import { describe, expect, it } from 'vitest';

import { notificationLink, notificationLook, staleQueriesFor } from './notifications';
import { hiddenKinds, prefRows, visibleNotifications } from './prefs';
import { adminPrefsOut, memberPrefsOut } from './testData';

const note = (id: number, kind: string, read = false) => ({
  id,
  kind,
  title: kind,
  body: '',
  link: null,
  created_at: '2026-10-14T09:00:00Z',
  read_at: read ? '2026-10-14T10:00:00Z' : null,
});

describe('что присылать: строки экрана', () => {
  it('виды одной группы — одна строка; обязательные отмечены', () => {
    const rows = prefRows(memberPrefsOut(['limit_80']));
    expect(rows.map((row) => row.id)).toEqual(['bet', 'limit', 'decision', 'login', 'fails', 'message']);
    const limit = rows.find((row) => row.id === 'limit');
    expect(limit?.kinds).toEqual(['limit_80', 'limit_100']);
    // строка выключена, если выключен хоть один вид из нее
    expect(limit?.onSite).toBe(false);
    expect(rows.filter((row) => row.required).map((row) => row.id)).toEqual(['login', 'fails', 'message']);
  });

  it('у администратора — раздел «Для администратора»: ключ участника и ключ администратора — разные строки', () => {
    const rows = prefRows(adminPrefsOut());
    expect(rows.filter((row) => row.admin).map((row) => row.id)).toEqual([
      'requestsAdmin',
      'usersAdmin',
      'budgetAdmin',
      'keyAdmin',
      'archiveAdmin',
      'alertAdmin',
    ]);
  });

  it('незнакомая группа сервера не ломает экран — ее нет в списке', () => {
    const prefs = memberPrefsOut();
    prefs.items.push({ ...prefs.items[0]!, group: 'future' });
    expect(prefRows(prefs).map((row) => row.id)).not.toContain('future');
  });
});

describe('колокольчик учитывает настройки', () => {
  it('выключенные виды не показываются, счетчик — без них', () => {
    const data = { items: [note(3, 'bet_settled'), note(2, 'admin_message'), note(1, 'bet_settled', true)], unread: 5 };
    const hidden = hiddenKinds(memberPrefsOut(['bet_settled']));
    expect([...hidden]).toEqual(['bet_settled']);
    const shown = visibleNotifications(data, hidden);
    expect(shown.items.map((item) => item.id)).toEqual([2]);
    expect(shown.unread).toBe(4);
    // все включены — как пришло с сервера
    expect(visibleNotifications(data, hiddenKinds(memberPrefsOut()))).toEqual({ items: data.items, unread: 5 });
  });

  it('обязательный вид не прячется, даже если сервер прислал его выключенным', () => {
    const prefs = memberPrefsOut();
    prefs.items = prefs.items.map((item) => (item.kind === 'new_device' ? { ...item, on_site: false } : item));
    expect(hiddenKinds(prefs).size).toBe(0);
  });
});

describe('уведомления этапа 4', () => {
  it('сигнал расхода ИИ — предупреждение', () => {
    expect(notificationLook('ai_alert')).toEqual({ icon: 'alert', tone: 'warn' });
  });

  it('ссылка: своя с сервера (ставка, анализ), иначе — по виду', () => {
    expect(notificationLink({ kind: 'bet_settled', link: '/bets?bet=12' })).toBe('/bets?bet=12');
    expect(notificationLink({ kind: 'ai_alert', link: '/analysis/42' })).toBe('/analysis/42');
    expect(notificationLink({ kind: 'bet_settled', link: null })).toBe('/bets');
    expect(notificationLink({ kind: 'data_stale', link: null })).toBe('/admin');
    expect(notificationLink({ kind: 'admin_message', link: null })).toBeNull();
    expect(notificationLink({ kind: 'bet_settled', link: 'https://evil.example' })).toBe('/bets');
  });

  it('ставка рассчитана — перечитать ставки, банк, главную и аналитику', () => {
    // этап 5: и сводку «Обучения модели» (рассчитано ставок)
    expect(staleQueriesFor('bet_settled')).toEqual([['bets'], ['bank'], ['dashboard'], ['analytics'], ['learning']]);
  });
});
