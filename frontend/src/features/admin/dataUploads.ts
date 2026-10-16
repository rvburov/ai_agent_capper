import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { isApiError } from '../../api/errors';
import type { components } from '../../api/schema';
import { analysisKeys } from '../analysis/keys';
import { ANALYTICS_PREFIX, betKeys, DASHBOARD_PREFIX } from '../bets/keys';
import { learningKeys } from '../learning/keys';
import { adminKeys } from './keys';

/*
 * «Администрирование → Данные» (этап 5, В1): файл tennis-data ГОД.xlsx раз в неделю. Сайт
 * отдает файл только браузеру, поэтому его скачивает администратор и загружает здесь. Тело
 * запроса — сам файл, имя — параметр filename (POST /api/admin/data/tennis-data); ответ 202 —
 * загрузка в очереди, ход — опрос GET /api/admin/data/uploads/{id} (status, step), отчет — в
 * том же ответе. Свежесть архива и история — GET /api/admin/data/uploads.
 */

export type DataUpload = components['schemas']['DataUploadOut'];
export type DataUploads = components['schemas']['DataUploadsOut'];
export type DataUploadReport = components['schemas']['DataUploadReportOut'];
export type UploadStep = NonNullable<DataUpload['step']>;
export type UnlinkedMatch = components['schemas']['UnlinkedMatchOut'];

/** Шаги обработки файла в воркере — в порядке выполнения. */
export const UPLOAD_STEPS: readonly UploadStep[] = ['tennis_data', 'players_link', 'elo', 'settle'];

/** Как часто спрашивать ход загрузки, мс. */
export const POLL_MS = 1500;

const MB = 1024 * 1024;

/** Загрузка еще идет: в очереди или в работе. */
export function isActive(upload: Pick<DataUpload, 'status'> | null | undefined): boolean {
  return upload?.status === 'queued' || upload?.status === 'running';
}

/** Размер в мегабайтах (как предел сервера: 10 МБ = 10 × 2^20 байт). */
export function sizeMb(bytes: number): number {
  return bytes / MB;
}

export type FileProblem = 'not_xlsx' | 'empty' | 'too_large';

/**
 * Быструю проверку файла сервер делает сам (422 и 413 с текстом); здесь — только то, что
 * видно без отправки: расширение и размер, чтобы не гнать 10 МБ впустую.
 */
export function fileProblem(file: Pick<File, 'name' | 'size'>, maxMb: number): FileProblem | null {
  if (!/\.xlsx$/i.test(file.name.trim())) return 'not_xlsx';
  if (file.size === 0) return 'empty';
  if (file.size > maxMb * MB) return 'too_large';
  return null;
}

export type StepState = 'done' | 'run' | 'wait' | 'failed' | 'skipped';

/**
 * Состояние каждого шага: по отчету (когда загрузка закончилась), иначе по текущему шагу —
 * до него сделано, он идет, после — ждут.
 */
export function stepStates(upload: Pick<DataUpload, 'status' | 'step' | 'report'>): Record<UploadStep, StepState> {
  const out = {} as Record<UploadStep, StepState>;
  const reported = new Map((upload.report?.steps ?? []).map((s) => [s.step, s.status]));
  const current = upload.step ? UPLOAD_STEPS.indexOf(upload.step) : -1;
  UPLOAD_STEPS.forEach((step, i) => {
    const done = reported.get(step);
    if (done === 'ok') out[step] = 'done';
    else if (done === 'failed' || done === 'skipped') out[step] = done;
    else if (upload.status === 'running' && current >= 0) out[step] = i < current ? 'done' : i === current ? 'run' : 'wait';
    else if (upload.status === 'done') out[step] = 'done';
    else out[step] = 'wait';
  });
  return out;
}

/** Последняя законченная загрузка с отчетом — для карточки «Отчет загрузки». */
export function latestReport(uploads: readonly DataUpload[]): (DataUpload & { report: DataUploadReport }) | null {
  for (const upload of uploads) {
    if (upload.status === 'done' && upload.report) return upload as DataUpload & { report: DataUploadReport };
  }
  return null;
}

/** Ответ 413 от Caddy (предел тела) приходит не JSON: свой текст вместо «неизвестной ошибки». */
export function isTooLarge(error: unknown): boolean {
  return isApiError(error) && error.status === 413;
}

// ---------- запросы ----------

export function useDataUploads({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: adminKeys.dataUploads,
    queryFn: () => unwrap(api.GET('/api/admin/data/uploads')),
    enabled,
  });
}

/** Загрузка по номеру; пока идет — опрос раз в POLL_MS. */
export function useDataUpload(id: number | null) {
  return useQuery({
    queryKey: adminKeys.dataUpload(id ?? 0),
    queryFn: () => unwrap(api.GET('/api/admin/data/uploads/{upload_id}', { params: { path: { upload_id: id ?? 0 } } })),
    enabled: id !== null,
    refetchInterval: (query) => (isActive(query.state.data) ? POLL_MS : false),
  });
}

/** Отправить файл: тело — сам файл (не multipart), имя — в параметре filename. */
export function useUploadTennisData() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const body = await file.arrayBuffer();
      return unwrap(
        api.POST('/api/admin/data/tennis-data', {
          params: { query: { filename: file.name } },
          // тело — байты файла как есть; в схеме OpenAPI оно описано строкой (format: binary)
          body: body as unknown as string,
          bodySerializer: (value: unknown) => value as BodyInit,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      );
    },
    onSuccess: (upload) => {
      client.setQueryData(adminKeys.dataUpload(upload.id), upload);
      void client.invalidateQueries({ queryKey: adminKeys.dataUploads });
      void client.invalidateQueries({ queryKey: adminKeys.audit });
    },
  });
}

/**
 * Загрузка закончилась: архив, отчет и история — заново; ставки могли рассчитаться сами (и у
 * администратора), поэтому — ставки, банк, главная, аналитика и обучение модели; дела
 * администратора (архив устарел) — тоже.
 */
export function refreshAfterUpload(client: QueryClient): void {
  for (const queryKey of [
    adminKeys.dataUploads,
    adminKeys.audit,
    adminKeys.attention,
    betKeys.all,
    analysisKeys.bank,
    DASHBOARD_PREFIX,
    ANALYTICS_PREFIX,
    learningKeys.all,
  ]) {
    void client.invalidateQueries({ queryKey });
  }
}
