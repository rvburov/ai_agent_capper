import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';
import { adminKeys, invalidateAdmin } from './keys';
import { personName } from './people';
import type { AdminUser } from './types';

/*
 * «Администрирование → Сообщение» (PANELS.message макета admin.js): короткое уведомление всем
 * участникам или одному — в центр уведомлений на сайте (push — этап 6). Отправленные — те же
 * записи «Сообщение участникам», что в журнале. Сколько получит «всем», считает сервер
 * (recipients_all в GET /api/admin/messages); список «одному» — активные люди, кроме вас.
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

export function useSendMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { text: string; userId: number | null }) =>
      unwrap(api.POST('/api/admin/messages', { body: { text: body.text, user_id: body.userId, preview: false } })),
    networkMode: 'always',
    onSuccess: () => invalidateAdmin(client),
  });
}
