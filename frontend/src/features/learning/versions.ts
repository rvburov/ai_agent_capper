import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { analysisKeys } from '../analysis/keys';
import { DASHBOARD_PREFIX } from '../bets/keys';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';
import { learningKeys } from './keys';
import type { EvalRun, EvalRuns, RulesCandidateIn, StrategyVersion, StrategyVersions } from './types';

/*
 * Версии стратегии (этап 5, волна 3 backend): инструкции анализа — общая линия, ее ведет
 * администратор (В5); правила суммы ставки — у каждого свои. Прогон версии на замороженном
 * наборе — только администратор, с кодом 2FA. Ни одна версия не включается сама: включение,
 * откат и отклонение — кнопкой. Числа (лог-лосс, ДИ, правила приема) считает сервер (Т15).
 */

/** Как часто спрашивать ход прогона: пакет Batch отвечает минуты и часы. */
export const EVAL_POLL_MS = 5_000;
/** Список прогонов, пока один идет: реже — это фон вкладки. */
export const EVAL_RUNS_POLL_MS = 15_000;

/** Прогон еще идет: пакет ждет отправки, бюджета или ответа. */
export function runActive(run: Pick<EvalRun, 'status'> | null | undefined): boolean {
  return run?.status === 'pending' || run?.status === 'running';
}

export function useStrategyVersions({ enabled = true }: { enabled?: boolean } = {}) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, learningKeys.versions),
    queryFn: () => unwrap(api.GET('/api/strategy/versions', { params: { query: asUserQuery(asUser) } })),
    staleTime: 30_000,
    enabled,
  });
}

/** Сравнение двух версий одной линии: a — база (активная), b — кандидат. */
export function useVersionCompare(a: number, b: number, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.compare(a, b),
    queryFn: () => unwrap(api.GET('/api/strategy/versions/compare', { params: { query: { a, b } } })),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

/**
 * Версия изменилась: список версий, сводка «Обучения модели», главная («Требует внимания»),
 * а для правил суммы — действующая стратегия и банк (адаптации) перечитываются.
 */
export function storeVersion(client: QueryClient, version: StrategyVersion): void {
  client.setQueryData<StrategyVersions>(learningKeys.versions, (list) => {
    if (!list) return list;
    const line = version.line === 'rules' ? 'rules' : 'instructions';
    const items = list[line];
    const next = items.some((item) => item.id === version.id) ? items.map((item) => (item.id === version.id ? version : item)) : [...items, version];
    return { ...list, [line]: next };
  });
  void client.invalidateQueries({ queryKey: learningKeys.all });
  void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
  if (version.line === 'rules') {
    void client.invalidateQueries({ queryKey: analysisKeys.strategy });
    void client.invalidateQueries({ queryKey: analysisKeys.bank });
  }
}

/** Отказ сервера: положение версий могло измениться в другом окне — перечитать все. */
function refreshVersions(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: learningKeys.all });
  void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
  void client.invalidateQueries({ queryKey: analysisKeys.strategy });
  void client.invalidateQueries({ queryKey: analysisKeys.bank });
}

export type VersionAction = 'activate' | 'rollback' | 'reject';

function postDecision(id: number, action: VersionAction) {
  const params = { params: { path: { version_id: id } } };
  switch (action) {
    case 'activate':
      return unwrap(api.POST('/api/strategy/versions/{version_id}/activate', params));
    case 'rollback':
      return unwrap(api.POST('/api/strategy/versions/{version_id}/rollback', params));
    default:
      return unwrap(api.POST('/api/strategy/versions/{version_id}/reject', params));
  }
}

/** «Включить», «Вернуть», «Отклонить»: отказ сервера (403, 409) — текстом его ошибки. */
export function useVersionDecision(action: VersionAction) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => postDecision(id, action),
    onSuccess: (version) => storeVersion(client, version),
    // отказ (409: версию уже включил или отклонил другой администратор) — список заново
    onError: () => refreshVersions(client),
  });
}

/** Кандидат своих правил суммы: сервер сразу проверяет его на ваших ставках (check). */
export function useCreateRulesCandidate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RulesCandidateIn) => unwrap(api.POST('/api/strategy/versions', { body })),
    onSuccess: (version) => storeVersion(client, version),
    onError: () => refreshVersions(client),
  });
}

// ---------- проверка версий на наборе (администратор) ----------

export function useEvalSets({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.evalSets,
    queryFn: () => unwrap(api.GET('/api/admin/eval/sets')),
    staleTime: 60_000,
    enabled,
  });
}

/** Заморозить набор: список матчей и его sha256 больше не меняются. Денег не тратит. */
export function useFreezeSet() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/admin/eval/sets', { body: {} })),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: learningKeys.all });
    },
  });
}

/** План прогона до запуска: цена по живым числам, худший случай, бюджет проверок, можно ли. */
export function useEvalPlan(versionId: number | null, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.evalPlan(versionId ?? 0),
    queryFn: () => unwrap(api.GET('/api/admin/eval/runs/preview', { params: { query: { version_id: versionId ?? 0 } } })),
    // бюджет и резерв меняются от других проверок: каждое открытие окна — свежие числа
    staleTime: 0,
    enabled: enabled && versionId !== null,
  });
}

/** Прогоны (проверки версий, быстрые проверки уроков, приемка): пока один идет — опрос. */
export function useEvalRuns({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.evalRuns,
    queryFn: () => unwrap(api.GET('/api/admin/eval/runs')),
    refetchInterval: (query) => (query.state.data?.items.some((run) => run.kind === 'eval' && runActive(run)) ? EVAL_RUNS_POLL_MS : false),
    staleTime: 10_000,
    enabled,
  });
}

/** Последний идущий прогон версии на наборе (не быстрая проверка урока). */
export function activeEvalRun(runs: EvalRuns | undefined): EvalRun | null {
  return runs?.items.find((run) => run.kind === 'eval' && runActive(run)) ?? null;
}

/** Один прогон: пока идет — опрос раз в EVAL_POLL_MS. */
export function useEvalRun(id: number | null, { initial }: { initial?: EvalRun } = {}) {
  return useQuery({
    queryKey: learningKeys.evalRun(id ?? 0),
    queryFn: () => unwrap(api.GET('/api/admin/eval/runs/{run_id}', { params: { path: { run_id: id ?? 0 } } })),
    ...(initial ? { initialData: initial, initialDataUpdatedAt: 0 } : {}),
    refetchInterval: (query) => (runActive(query.state.data) ? EVAL_POLL_MS : false),
    enabled: id !== null,
  });
}

/** Прогон изменился: он же в списке; закончился — версии, сводка и главная заново. */
function storeRun(client: QueryClient, run: EvalRun): void {
  client.setQueryData(learningKeys.evalRun(run.id), run);
  client.setQueryData<EvalRuns>(learningKeys.evalRuns, (list) =>
    list ? { ...list, items: list.items.some((item) => item.id === run.id) ? list.items.map((item) => (item.id === run.id ? run : item)) : [run, ...list.items] } : list,
  );
  void client.invalidateQueries({ queryKey: learningKeys.evalRuns });
  void client.invalidateQueries({ queryKey: learningKeys.versions });
  void client.invalidateQueries({ queryKey: learningKeys.summary });
}

/** Запуск прогона с кодом 2FA (202): ход — опросом прогона. */
export function useStartEval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { versionId: number; totp: string }) =>
      unwrap(api.POST('/api/admin/eval/runs', { body: { version_id: vars.versionId, totp_code: vars.totp } })),
    onSuccess: (run) => storeRun(client, run),
    // отказ (409: бюджет, уже идет) — свежий план
    onError: (_error, vars) => {
      void client.invalidateQueries({ queryKey: learningKeys.evalPlan(vars.versionId) });
      void client.invalidateQueries({ queryKey: learningKeys.evalRuns });
    },
  });
}

/** «Остановить»: ждущий — сразу abandoned, пакет у Anthropic отменяется, начатое дособирается. */
export function useCancelEval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => unwrap(api.POST('/api/admin/eval/runs/{run_id}/cancel', { params: { path: { run_id: id } } })),
    onSuccess: (run) => storeRun(client, run),
    onError: () => {
      void client.invalidateQueries({ queryKey: learningKeys.evalRuns });
    },
  });
}
