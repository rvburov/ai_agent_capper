import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { isApiError } from '../../api/errors';
import type { components } from '../../api/schema';
import { analysisKeys } from '../analysis/keys';
import { refreshAfterCurrencyChange } from '../bank/currency';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';
import { ANALYTICS_PREFIX, betKeys, DASHBOARD_PREFIX } from './keys';
import type { BetFiltersQuery, BetItem, ClosingIn, LegSettleIn } from './types';

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
 * банк, букмекеры и «Ставки» перечитываются.
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
      void client.invalidateQueries({ queryKey: betKeys.all });
      void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
      // «Аналитика» показывает, сколько ставок в игре не учитывается
      void client.invalidateQueries({ queryKey: ANALYTICS_PREFIX });
    },
    // Ставка по анализу уже сохранена (ответ на первый запрос потерялся) или анализ сменил
    // состояние: экран должен увидеть это сразу, а не предлагать «Сохранить ставку» снова
    onError: (error, body) => {
      refreshAfterCurrencyChange(client, error);
      if (!isApiError(error) || !BET_CONFLICTS.has(error.code)) return;
      void client.invalidateQueries({ queryKey: analysisKeys.one(body.analysis_id) });
      void client.invalidateQueries({ queryKey: analysisKeys.list });
      void client.invalidateQueries({ queryKey: analysisKeys.bank });
    },
  });
}

// ---------- «Ставки» (этап 4) ----------

/** Ставок на странице истории и «В игре». */
export const HISTORY_PAGE = 20;
export const OPEN_PAGE = 50;

/**
 * Ставки по фильтрам страницами (курсор before — id последней ставки прошлой страницы).
 * При смене фильтров прежний список остается на экране, пока не придет новый.
 */
export function useBetList(query: BetFiltersQuery, { limit = HISTORY_PAGE, enabled = true } = {}) {
  const asUser = useViewAs();
  const listQuery = { ...query, limit };
  return useInfiniteQuery({
    queryKey: viewKey(asUser, betKeys.list(listQuery)),
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/bets', {
          params: {
            query: {
              ...(pageParam === null ? listQuery : { ...listQuery, before: pageParam }),
              ...asUserQuery(asUser),
            },
          },
        }),
      ),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Итоги по тем же фильтрам (GET /api/bets/summary). */
export function useBetSummary(query: BetFiltersQuery, { enabled = true } = {}) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, betKeys.summary(query)),
    queryFn: () => unwrap(api.GET('/api/bets/summary', { params: { query: { ...query, ...asUserQuery(asUser) } } })),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** Счетчики меню: открытые ставки и из них ждущие результата (GET /api/bets/counts). */
export function useBetCounts() {
  return useQuery({
    queryKey: betKeys.counts,
    queryFn: () => unwrap(api.GET('/api/bets/counts')),
  });
}

/**
 * Карточка ставки (GET /api/bets/{id}); initial — ставка из списка, пока карточка не пришла.
 * Ставка списка неполная (подсказки исхода из новостей сервер отдает только в карточке),
 * поэтому она считается устаревшей сразу: карточка запрашивается при открытии окна.
 */
export function useBet(id: number | null, initial?: BetItem) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, betKeys.one(id ?? 0)),
    queryFn: () =>
      unwrap(api.GET('/api/bets/{bet_id}', { params: { path: { bet_id: id ?? 0 }, query: asUserQuery(asUser) } })),
    enabled: id !== null,
    initialData: initial,
    initialDataUpdatedAt: initial ? 0 : undefined,
  });
}

/**
 * Более свежая из двух версий ставки (по updated_at): карточка в кэше могла остаться от
 * прошлого открытия, а список уже перечитан — расчет и сторно идут с последней версией.
 */
export function freshest(cached: BetItem | undefined, given: BetItem): BetItem {
  if (!cached || cached.id !== given.id) return given;
  return Date.parse(cached.updated_at) >= Date.parse(given.updated_at) ? cached : given;
}

/**
 * После расчета, сторно и закрытия меняются банк, итоги, главная и аналитика: перечитываем их.
 * Карточку кладем сразу (ответ сервера — уже новая версия ставки).
 */
export function refreshAfterBetChange(client: QueryClient, bet: BetItem | null): void {
  if (bet) client.setQueryData(betKeys.one(bet.id), bet);
  void client.invalidateQueries({ queryKey: betKeys.all, predicate: (q) => !bet || q.queryKey[1] !== 'one' || q.queryKey[2] !== bet.id });
  void client.invalidateQueries({ queryKey: analysisKeys.bank });
  void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
  void client.invalidateQueries({ queryKey: ANALYTICS_PREFIX });
  if (bet?.analysis_id) void client.invalidateQueries({ queryKey: analysisKeys.one(bet.analysis_id) });
}

// Версия ставки разошлась (другая вкладка) или ставку уже рассчитали: перечитываем карточку,
// окно покажет свежую версию
const STALE_CODES: ReadonlySet<string> = new Set(['bet.changed', 'bet.settled', 'bet.not_settled', 'bet.legacy']);

function refreshOnConflict(client: QueryClient, betId: number, error: unknown): void {
  if (!isApiError(error) || !STALE_CODES.has(error.code)) return;
  void client.invalidateQueries({ queryKey: betKeys.all });
  void client.invalidateQueries({ queryKey: analysisKeys.bank });
  void client.refetchQueries({ queryKey: betKeys.one(betId) });
}

export interface SettleVars {
  bet: BetItem;
  legs: LegSettleIn[];
}

/** «Сохранить результат» (PUT /api/bets/{id}/result) с версией ставки, которую видел участник. */
export function useSettleBet() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ bet, legs }: SettleVars) =>
      unwrap(
        api.PUT('/api/bets/{bet_id}/result', {
          params: { path: { bet_id: bet.id } },
          body: { expected_updated_at: bet.updated_at, legs },
        }),
      ),
    onSuccess: (bet) => refreshAfterBetChange(client, bet),
    onError: (error, { bet }) => refreshOnConflict(client, bet.id, error),
  });
}

/** «Исправить результат»: сторно расчета (POST /api/bets/{id}/reverse), ставка снова открыта. */
export function useReverseBet() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (bet: BetItem) =>
      unwrap(
        api.POST('/api/bets/{bet_id}/reverse', {
          params: { path: { bet_id: bet.id } },
          body: { expected_updated_at: bet.updated_at },
        }),
      ),
    onSuccess: (bet) => refreshAfterBetChange(client, bet),
    onError: (error, bet) => refreshOnConflict(client, bet.id, error),
  });
}

export interface ClosingVars {
  betId: number;
  legId: number;
  closing: ClosingIn | null;
}

/** Закрывающий кэф ноги (PUT /api/bets/{id}/legs/{leg}/closing); null — стереть. */
export function useSetClosing() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ betId, legId, closing }: ClosingVars) =>
      unwrap(
        api.PUT('/api/bets/{bet_id}/legs/{leg_id}/closing', {
          params: { path: { bet_id: betId, leg_id: legId } },
          body: { closing },
        }),
      ),
    onSuccess: (bet) => refreshAfterBetChange(client, bet),
    onError: (error, { betId }) => refreshOnConflict(client, betId, error),
  });
}
