import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';
import { adminKeys, invalidateAdmin } from './keys';
import { personName } from './people';
import type { AdminUser } from './types';

/*
 * «Администрирование → Сообщение» (PANELS.message макета admin.js): короткое уведомление всем
 * участникам или одному — в центр уведомлений на сайте и, с флажком «Также push» (В8), push
 * тем, у кого он включен. Отправленные — те же записи «Сообщение участникам», что в журнале.
 * Сколько получит «всем» и у скольких из них push, считает сервер (recipients_all и
 * push_recipients_all в GET /api/admin/messages; у одного — предпросмотр POST с preview);
 * администратор видит только число, без устройств (Р14). Список «одному» — активные люди,
 * кроме вас.
 */

export type AdminMessage = components['schemas']['MessageOut'];

// Как MessageText на сервере (app/schemas/admin_settings.py)
export const MESSAGE_MAX = 280;
// Счетчик знаков желтеет, когда осталось меньше этого
export const MESSAGE_WARN_LEFT = 30;
// Отправленных на экране
export const SENT_SHOWN = 5;

export const messageKeys = {
  list: [...adminKeys.all, 'messages'] as const,
};

/** Кого можно выбрать «одному»: активные люди программы, кроме вас (по имени). */
export function recipientsOf(users: readonly AdminUser[] | undefined, meId: number): AdminUser[] {
  return (users ?? [])
    .filter((user) => user.status === 'active' && user.id !== meId)
    .sort((a, b) => personName(a).localeCompare(personName(b), 'ru'));
}

/** Текст, который уйдет на сервер: без пробелов по краям (сервер обрезает так же). */
export function messageText(text: string): string {
  return text.trim();
}

export function useAdminMessages() {
  return useQuery({
    queryKey: messageKeys.list,
    queryFn: () => unwrap(api.GET('/api/admin/messages')),
  });
}

/**
 * Есть ли push у одного выбранного получателя: предпросмотр (preview — без отправки) отдает
 * push_recipients. Предпросмотру нужен текст сообщения, поэтому — только когда он введен;
 * число не зависит от текста, и запрос повторяется только при смене получателя.
 */
export function useRecipientPush(userId: number | null, text: string) {
  return useQuery({
    queryKey: [...messageKeys.list, 'push', userId],
    queryFn: async () => {
      const out = await unwrap(api.POST('/api/admin/messages', { body: { text, user_id: userId, preview: true, also_push: true } }));
      return out.push_recipients;
    },
    enabled: userId !== null && text !== '',
    staleTime: 60_000,
  });
}

export function useSendMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string; userId: number | null; alsoPush: boolean }) =>
      unwrap(
        api.POST('/api/admin/messages', {
          body: { text: body.text, user_id: body.userId, preview: false, also_push: body.alsoPush },
        }),
      ),
    networkMode: 'always',
    onSuccess: () => invalidateAdmin(client),
  });
}
