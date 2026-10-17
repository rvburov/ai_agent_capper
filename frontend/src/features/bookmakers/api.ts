import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';
import { analysisKeys } from '../analysis/keys';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';

/*
 * «Мои букмекеры» кабинета (В9): GET /api/me/bookmakers/list — действующие и скрытые, с числом
 * ставок и суммой в игре; добавить, переименовать, скрыть и вернуть, удалить. Формы ставки и
 * «Нового анализа» берут названия без скрытых из GET /api/me/bookmakers (useBookmakers) — у
 * обоих ключ под ['bookmakers'], поэтому любое изменение здесь обновляет и выбор в формах.
 */

export type Bookmaker = components['schemas']['BookmakerOut'];
export type BookmakerList = components['schemas']['BookmakersOut'];

export const bookmakerKeys = {
  all: analysisKeys.bookmakers,
  list: [...analysisKeys.bookmakers, 'list'] as const,
};

export function useBookmakerList() {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, bookmakerKeys.list),
    queryFn: () => unwrap(api.GET('/api/me/bookmakers/list', { params: { query: asUserQuery(asUser) } })),
    staleTime: 60_000,
  });
}

function useBookmakerMutation<V, R>(request: (value: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: request,
    // Ответ уже изменился на сервере, а список мог устареть (другая вкладка): перечитываем
    // и при ошибке — 404 и 409 значат, что на экране старое
    onSettled: () => client.invalidateQueries({ queryKey: bookmakerKeys.all }),
  });
}

export function useAddBookmaker() {
  return useBookmakerMutation((name: string) => unwrap(api.POST('/api/me/bookmakers', { body: { name } })));
}

export function useUpdateBookmaker() {
  return useBookmakerMutation((vars: { id: number; name?: string; archived?: boolean }) =>
    unwrap(
      api.PATCH('/api/me/bookmakers/{bookmaker_id}', {
        params: { path: { bookmaker_id: vars.id } },
        body: { name: vars.name ?? null, archived: vars.archived ?? null },
      }),
    ),
  );
}

export function useDeleteBookmaker() {
  return useBookmakerMutation((id: number) =>
    unwrap(api.DELETE('/api/me/bookmakers/{bookmaker_id}', { params: { path: { bookmaker_id: id } } })),
  );
}

/** Две буквы названия для значка: «Fonbet» → «FO». */
export function bookmakerMark(name: string): string {
  return name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '?';
}

/** Название уже есть в списке (без учета регистра, и у скрытых); except — свое при переименовании. */
export function nameTaken(items: readonly Bookmaker[], name: string, except?: number): boolean {
  const key = name.trim().toLocaleLowerCase('ru');
  return items.some((item) => item.id !== except && item.name.trim().toLocaleLowerCase('ru') === key);
}
