import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { aiKeys } from '../ai/keys';
import { analysisKeys } from './keys';
import type { Analysis, ConfirmIn } from './types';
import { isActive, isSettling } from './types';

// Запросы экранов «Новый анализ» и «Анализ»: данные — через клиент api и TanStack Query.

const path = (id: number) => ({ params: { path: { analysis_id: id } } });
const POLL_MS = 3000;
const SETTLE_POLL_MS = 5000;
const LIMIT_POLL_MS = 30_000;

/**
 * Анализ (GET /api/analyses/{id}). poll — запасной опрос раз в 3 с, пока анализ идет, а поток
 * событий недоступен (useAnalysisEvents сам решает, когда он нужен). Отмененный анализ с шагом
 * «в работе» перечитывается раз в 5 с: вызов, начатый до отмены, доработает и будет записан.
 */
export function useAnalysis(id: number | null, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: analysisKeys.one(id ?? 0),
    queryFn: () => unwrap(api.GET('/api/analyses/{analysis_id}', path(id ?? 0))),
    enabled: id !== null && id > 0,
    staleTime: 5_000,
    refetchInterval: (query) => {
      const analysis = query.state.data;
      if (poll && isActive(analysis?.status)) return POLL_MS;
      return isSettling(analysis) ? SETTLE_POLL_MS : false;
    },
  });
}

/**
 * Последние запущенные анализы для «Нового анализа» (5 штук). Черновики сервер не отдает
 * (launched): каждый разбор и каждая форма — новый черновик, они вытеснили бы анализы.
 */
export function useRecentAnalyses(limit = 5) {
  return useQuery({
    queryKey: [...analysisKeys.list, 'launched', limit],
    queryFn: () => unwrap(api.GET('/api/analyses', { params: { query: { limit, launched: true } } })),
    staleTime: 15_000,
  });
}

/** Новый анализ: текст — разбор Claude (2–5 с), форма — пустой черновик. */
export function useCreateAnalysis() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { input_kind: 'text' | 'form'; text?: string }) =>
      unwrap(api.POST('/api/analyses', { body })),
    onSuccess: (analysis) => {
      client.setQueryData(analysisKeys.one(analysis.id), analysis);
      void client.invalidateQueries({ queryKey: analysisKeys.list });
    },
  });
}

/**
 * «Перед запуском» (POST /api/analyses/{id}/preview) — расчет без Claude, поэтому запросом
 * на чтение: тело (JSON ConfirmIn) — в ключе запроса, прошлый ответ виден, пока идет новый.
 */
export function usePreview(id: number | null, body: string | null) {
  return useQuery({
    queryKey: analysisKeys.preview(id ?? 0, body ?? ''),
    queryFn: ({ signal }) =>
      unwrap(
        api.POST('/api/analyses/{analysis_id}/preview', {
          ...path(id ?? 0),
          body: body ? (JSON.parse(body) as ConfirmIn) : undefined,
          signal,
        }),
      ),
    enabled: id !== null && body !== null,
    placeholderData: keepPreviousData,
    staleTime: 20_000,
  });
}

function useAnalysisMutation<V>(fn: (vars: V) => Promise<Analysis>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (analysis) => {
      client.setQueryData(analysisKeys.one(analysis.id), analysis);
      void client.invalidateQueries({ queryKey: analysisKeys.list });
    },
  });
}

/** Запуск: события, банк и букмекер; без тела — перезапуск с упавшего шага. */
export function useRunAnalysis() {
  return useAnalysisMutation((vars: { id: number; body?: ConfirmIn }) =>
    unwrap(api.POST('/api/analyses/{analysis_id}/run', { ...path(vars.id), body: vars.body })),
  );
}

export function useCancelAnalysis() {
  return useAnalysisMutation((id: number) => unwrap(api.POST('/api/analyses/{analysis_id}/cancel', path(id))));
}

/** «Не ставить» (skip) или снять это решение (null). */
export function useDecision() {
  return useAnalysisMutation((vars: { id: number; decision: 'skip' | null }) =>
    unwrap(api.PUT('/api/analyses/{analysis_id}/decision', { ...path(vars.id), body: { decision: vars.decision } })),
  );
}

/** Активная версия стратегии участника (правила для «Перед запуском» и экспресса). */
export function useStrategy() {
  return useQuery({
    queryKey: analysisKeys.strategy,
    queryFn: () => unwrap(api.GET('/api/strategy/active')),
    staleTime: 5 * 60_000,
  });
}

/** Банк по учету и адаптации суммы (Р22). */
export function useBank() {
  return useQuery({
    queryKey: analysisKeys.bank,
    queryFn: () => unwrap(api.GET('/api/me/bank')),
    staleTime: 30_000,
  });
}

/** Букмекеры участника, частые первыми. */
export function useBookmakers() {
  return useQuery({
    queryKey: analysisKeys.bookmakers,
    queryFn: () => unwrap(api.GET('/api/me/bookmakers')),
    staleTime: 5 * 60_000,
  });
}

/**
 * Лимит и режим ключа участника (GET /api/ai/budget): блок лимита и причины запрета. poll —
 * анализ остановлен лимитом или потолком: раз в 30 с проверяем, не поднял ли его
 * администратор (кнопка перезапуска станет доступной без перезагрузки). Ключ кэша — общий с
 * вкладкой «Ключ Claude»: расход, перечитанный в одном месте, виден в другом.
 */
export function useAiAccess({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: aiKeys.budget,
    queryFn: () => unwrap(api.GET('/api/ai/budget')),
    staleTime: 15_000,
    refetchInterval: poll ? LIMIT_POLL_MS : false,
  });
}
