import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { notificationsQueryKey } from '../../api/keys';
import type { components } from '../../api/schema';
import type { NotificationItem, NotificationsOut } from './notifications';

/*
 * «Что присылать» (кабинет → «Уведомления», Р3, Р26): GET/PUT /api/me/notification-prefs.
 * Какие виды есть у человека (по роли и режиму ключа), какие обязательны и в какую строку
 * экрана они собраны (group) — решает сервер. У каждого вида — «на сайте» и push (значения по
 * умолчанию В2 — на сервере); тихие часы push — там же (quiet_hours, В3). push_available —
 * push включен хотя бы на одном устройстве (В5): иначе столбец «Push» и тихие часы неактивны.
 */

export type NotificationPrefs = components['schemas']['NotificationPrefsOut'];
export type NotificationPref = components['schemas']['NotificationPrefOut'];
export type NotificationKind = NotificationPref['kind'];
export type QuietHours = NotificationPrefs['quiet_hours'];

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
  /** Push по всем видам строки. */
  push: boolean;
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
      row.push = row.push && item.push;
      row.required = row.required || item.required;
      row.isNew = row.isNew || item.new;
    } else {
      rows.push({
        id,
        group: item.group,
        admin: item.admin,
        kinds: [item.kind],
        onSite: item.on_site,
        push: item.push,
        required: item.required,
        isNew: item.new,
      });
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

/** Что поменять у видов строки: на сайте, push или оба (непереданное не меняется). */
export interface PrefChange {
  kinds: NotificationKind[];
  onSite?: boolean;
  push?: boolean;
}

/** Сразу в кэше, при ошибке — откат; ответ сервера заменяет кэш. */
function useOptimisticPrefs<V>(mutationFn: (vars: V) => Promise<NotificationPrefs>, patch: (data: NotificationPrefs, vars: V) => NotificationPrefs) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (vars: V) => {
      await client.cancelQueries({ queryKey: notificationPrefsKey });
      const previous = client.getQueryData<NotificationPrefs>(notificationPrefsKey);
      client.setQueryData<NotificationPrefs>(notificationPrefsKey, (data) => (data ? patch(data, vars) : data));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(notificationPrefsKey, context.previous);
    },
    onSuccess: (data) => client.setQueryData(notificationPrefsKey, data),
    onSettled: () => client.invalidateQueries({ queryKey: notificationsQueryKey }),
  });
}

/**
 * Переключатели строки: «на сайте» (обязательные виды на сайте не выключаются) и push. После
 * ответа колокольчик перечитывается: выключенное он прячет, включенное снова показывает.
 */
export function useSetNotificationPref() {
  return useOptimisticPrefs(
    (vars: PrefChange) =>
      unwrap(
        api.PUT('/api/me/notification-prefs', {
          body: {
            items: vars.kinds.map((kind) => ({
              kind,
              ...(vars.onSite !== undefined ? { on_site: vars.onSite } : {}),
              ...(vars.push !== undefined ? { push: vars.push } : {}),
            })),
          },
        }),
      ),
    (data, vars) => ({
      ...data,
      items: data.items.map((item) =>
        vars.kinds.includes(item.kind)
          ? {
              ...item,
              on_site: vars.onSite !== undefined && !item.required ? vars.onSite : item.on_site,
              push: vars.push ?? item.push,
            }
          : item,
      ),
    }),
  );
}

/** Тихие часы push целиком (В3): начало равно концу — 422 с сервера, экран ловит это раньше. */
export function useSetQuietHours() {
  return useOptimisticPrefs(
    (quiet: QuietHours) => unwrap(api.PUT('/api/me/notification-prefs', { body: { quiet_hours: quiet } })),
    (data, quiet) => ({ ...data, quiet_hours: quiet }),
  );
}

/** Варианты начала и конца тихих часов: шаг 30 минут, «00:00» … «23:30». */
export const QUIET_TIMES: readonly string[] = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

/** Сколько минут длятся тихие часы (через полночь — тоже): 23:00–08:00 → 540. */
export function quietMinutes(start: string, end: string): number {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return (minutes(end) - minutes(start) + 24 * 60) % (24 * 60);
}
