import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { meQueryKey } from '../../api/keys';
import { invalidateAiBudget } from './keys';
import type { AiMode } from './types';

/**
 * Свой ключ участника и режим ключа (Р7, Р12). После любого действия перечитываются лимит
 * (и в блоке лимита анализа) и профиль: режим ключа есть и в /api/me.
 */
function refresh(client: QueryClient): Promise<unknown> {
  return Promise.all([invalidateAiBudget(client), client.invalidateQueries({ queryKey: meQueryKey })]);
}

function useAiMutation<V, R>(request: (value: V) => Promise<R>) {
  const client = useQueryClient();
  // networkMode 'always': без сети запрос сразу падает с ошибкой «Нет связи с сервером», а не
  // встает на паузу до появления сети (кнопка бесконечно «Проверяем ключ…», потом сохранение
  // само, без нового нажатия)
  return useMutation({ mutationFn: request, networkMode: 'always', onSuccess: () => refresh(client) });
}

/** Сохранить свой ключ: сервер проверяет его в Anthropic и переводит на свой ключ. */
export function useSaveOwnKey() {
  return useAiMutation((key: string) => unwrap(api.PUT('/api/me/ai-key', { body: { key } })));
}

/** «Проверить»: итог проверки пишется к ключу (verified_at или last_error). */
export function useCheckOwnKey() {
  return useAiMutation(() => unwrap(api.POST('/api/me/ai-key/check')));
}

export function useDeleteOwnKey() {
  return useAiMutation(() => unwrap(api.DELETE('/api/me/ai-key')));
}

/** Переход на свой ключ (нужен проверенный); администратор так возвращается на ключ администратора. */
export function useSetAiMode() {
  return useAiMutation((mode: AiMode) => unwrap(api.PUT('/api/me/ai-mode', { body: { mode } })));
}

/** Просьба вернуть ключ администратора (Р12) и ее отмена. */
export function useReturnRequest() {
  return useAiMutation(() => unwrap(api.POST('/api/me/ai-mode/return-request')));
}

export function useCancelReturnRequest() {
  return useAiMutation(() => unwrap(api.DELETE('/api/me/ai-mode/return-request')));
}

/** Свой потолок одного анализа на своем ключе, $0,10–20. Сумма уходит строкой (Decimal). */
export function useSetOwnCap() {
  return useAiMutation((perAnalysisUsd: string) =>
    unwrap(api.PUT('/api/me/ai-cap', { body: { per_analysis_usd: perAnalysisUsd } })),
  );
}
