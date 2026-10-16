import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { apiErrorFrom } from '../../api/errors';
import { attachmentName, saveBlob } from '../account/api';
import { DASHBOARD_PREFIX } from '../bets/keys';
import { learningKeys } from './keys';

/*
 * Базовая модель (Эло по покрытиям + калибровка Платта, Т13, В6): GET /api/ml/model — версии
 * калибровки, проверка по месяцам против рынка архива, калибровка активной версии. Перекалибровка
 * включается сама, если не хуже (решает сервер); администратор может перекалибровать кнопкой
 * и вернуть прежнюю версию.
 */

export function useMlModel({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.model,
    queryFn: () => unwrap(api.GET('/api/ml/model')),
    staleTime: 60_000,
    enabled,
  });
}

function refresh(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: learningKeys.all });
  void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
}

/** «Перекалибровать» (администратор): решение — activated, rejected (с причиной) или skipped. */
export function useRecalibrate() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/admin/ml/recalibrate')),
    onSuccess: () => refresh(client),
  });
}

/** «Вернуть» прежнюю версию калибровки (только бывшую активной). */
export function useModelRollback() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/api/admin/ml/models/{model_id}/rollback', { params: { path: { model_id: id } } })),
    onSuccess: (model) => {
      client.setQueryData(learningKeys.model, model);
      refresh(client);
    },
  });
}

/**
 * «Выгрузить JSONL» (администратор, В9): снимки прогнозов для учебного трека (lab/) — по
 * архиву и свои, игроки обезличены, прогнозов участников нет (Р14). Файл собирает сервер по
 * запросу; возвращает имя файла.
 */
export function useExportSnapshots() {
  return useMutation({
    mutationFn: async (): Promise<string> => {
      const { data, error, response } = await api.GET('/api/admin/ml/export.jsonl', { parseAs: 'blob' });
      if (!response.ok || !data) throw apiErrorFrom(response.status, error);
      const name = attachmentName(response.headers.get('Content-Disposition'), 'snapshots.jsonl');
      saveBlob(data as Blob, name);
      return name;
    },
  });
}
