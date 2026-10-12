import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { isApiError } from '../../api/errors';
import type { components } from '../../api/schema';
import { analysisKeys } from '../analysis/keys';

export type BetIn = components['schemas']['BetIn'];
export type Bet = components['schemas']['BetOut'];

/** Ключ идемпотентности ставки: один на открытое окно, 8–64 символа [A-Za-z0-9_-]. */
export function newClientRef(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `w${Date.now().toString(36)}_${body}`;
}

export const CLIENT_REF = /^[A-Za-z0-9_-]{8,64}$/;

/** Ставку по анализу сохранить нельзя: она уже есть или анализ не готов. */
export const BET_CONFLICTS: ReadonlySet<string> = new Set(['bet.duplicate', 'bet.analysis_state']);

/**
 * «Сохранить ставку» (POST /api/bets): повтор с тем же client_ref вернет ту же ставку, поэтому
 * повторное нажатие после сбоя сети безопасно. После ответа — анализ (ставка сохранена),
 * банк и букмекеры перечитываются.
 */
export function usePlaceBet() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: BetIn) => unwrap(api.POST('/api/bets', { body })),
    onSuccess: (bet) => {
      if (bet.analysis_id !== null) void client.invalidateQueries({ queryKey: analysisKeys.one(bet.analysis_id) });
      void client.invalidateQueries({ queryKey: analysisKeys.list });
      void client.invalidateQueries({ queryKey: analysisKeys.bank });
      void client.invalidateQueries({ queryKey: analysisKeys.bookmakers });
    },
    // Ставка по анализу уже сохранена (ответ на первый запрос потерялся) или анализ сменил
    // состояние: экран должен увидеть это сразу, а не предлагать «Сохранить ставку» снова
    onError: (error, body) => {
      if (!isApiError(error) || !BET_CONFLICTS.has(error.code)) return;
      void client.invalidateQueries({ queryKey: analysisKeys.one(body.analysis_id) });
      void client.invalidateQueries({ queryKey: analysisKeys.list });
      void client.invalidateQueries({ queryKey: analysisKeys.bank });
    },
  });
}
