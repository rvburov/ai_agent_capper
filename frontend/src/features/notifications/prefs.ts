import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { notificationsQueryKey } from '../../api/keys';
import type { components } from '../../api/schema';
import type { NotificationItem, NotificationsOut } from './notifications';

/*
 * «Что присылать» (кабинет → «Уведомления», Р3): GET/PUT /api/me/notification-prefs. Какие
 * виды есть у человека (по роли и режиму ключа), какие обязательны и в какую строку экрана
 * они собраны (group) — решает сервер. Push — только показ (этап 6).
 */

export type NotificationPrefs = components['schemas']['NotificationPrefsOut'];
export type NotificationPref = components['schemas']['NotificationPrefOut'];
export type NotificationKind = NotificationPref['kind'];

export const notificationPrefsKey = ['notification-prefs'] as const;

export function useNotificationPrefs({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: notificationPrefsKey,
    queryFn: () => unwrap(api.GET('/api/me/notification-prefs')),
    staleTime: 5 * 60_000,
    enabled,
  });
}

/**
 * Строки экрана: группа сервера, у разделов администратора — с пометкой Admin (ключ участника
 * и ключ администратора — разные строки). Текст строки — profile.notifs.rows.<id>.
 */
export const PREF_ROWS = [
  'bet',
  'needs',
  'weekly',
  'limit',
  'key',
  'decision',
  'login',
  'fails',
  'message',
  'learningAdmin',
  'requestsAdmin',
  'usersAdmin',
  'budgetAdmin',
  'keyAdmin',
  'archiveAdmin',
  'alertAdmin',
] as const;
export type PrefRowId = (typeof PREF_ROWS)[number];

function isRowId(value: string): value is PrefRowId {
  return (PREF_ROWS as readonly string[]).includes(value);
}

/** Строка экрана: виды одной группы (limit_80 и limit_100 — одна строка «Лимит ИИ»). */
export interface PrefRow {
  id: PrefRowId;
  group: string;
  admin: boolean;
  kinds: NotificationKind[];
  onSite: boolean;
  required: boolean;
  /** Вид появился недавно — пометка «новое» (решает сервер). */
  isNew: boolean;
}

/** Виды по строкам экрана, в порядке сервера. Группы, которой экран не знает, нет в списке. */
export function prefRows(prefs: NotificationPrefs | undefined): PrefRow[] {
  const rows: PrefRow[] = [];
  for (const item of prefs?.items ?? []) {
    const id = item.admin ? `${item.group}Admin` : item.group;
    if (!isRowId(id)) continue;
    const row = rows.find((r) => r.id === id);
    if (row) {
      row.kinds.push(item.kind);
      row.onSite = row.onSite && item.on_site;
      row.required = row.required || item.required;
      row.isNew = row.isNew || item.new;
    } else {
      rows.push({ id, group: item.group, admin: item.admin, kinds: [item.kind], onSite: item.on_site, required: item.required, isNew: item.new });
    }
  }
  return rows;
}

/** Выключенные «на сайте» виды: колокольчик их не показывает. */
export function hiddenKinds(prefs: NotificationPrefs | undefined): ReadonlySet<string> {
  return new Set((prefs?.items ?? []).filter((item) => !item.on_site && !item.required).map((item) => item.kind));
}

/** Список колокольчика без выключенных видов; непрочитанные — минус скрытые непрочитанные. */
export function visibleNotifications(data: NotificationsOut | undefined, hidden: ReadonlySet<string>): { items: NotificationItem[]; unread: number } {
  const items = data?.items ?? [];
  if (!hidden.size) return { items, unread: data?.unread ?? 0 };
  const shown = items.filter((item) => !hidden.has(item.kind));
  // Счетчик сервера считает все непрочитанные: скрытые из загруженных вычитаются (старше 50
  // последних не видно — их сервер вычтет сам, когда научится, см. заявку к backend)
  const unreadHidden = items.filter((item) => hidden.has(item.kind) && !item.read_at).length;
  return { items: shown, unread: Math.max(0, (data?.unread ?? 0) - unreadHidden) };
}

/**
 * Переключатель «на сайте»: сразу в кэше, при ошибке — откат. После ответа колокольчик
 * перечитывается: выключенное он прячет, включенное снова показывает.
 */
export function useSetNotificationPref() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { kinds: NotificationKind[]; onSite: boolean }) =>
      unwrap(api.PUT('/api/me/notification-prefs', { body: { items: vars.kinds.map((kind) => ({ kind, on_site: vars.onSite })) } })),
    onMutate: async (vars) => {
      await client.cancelQueries({ queryKey: notificationPrefsKey });
      const previous = client.getQueryData<NotificationPrefs>(notificationPrefsKey);
      client.setQueryData<NotificationPrefs>(notificationPrefsKey, (data) =>
        data
          ? { ...data, items: data.items.map((item) => (vars.kinds.includes(item.kind) && !item.required ? { ...item, on_site: vars.onSite } : item)) }
          : data,
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(notificationPrefsKey, context.previous);
    },
    onSuccess: (data) => client.setQueryData(notificationPrefsKey, data),
    onSettled: () => client.invalidateQueries({ queryKey: notificationsQueryKey }),
  });
}
