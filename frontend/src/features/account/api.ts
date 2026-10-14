import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { apiErrorFrom } from '../../api/errors';
import { meQueryKey } from '../../api/keys';
import type { components } from '../../api/schema';

/*
 * Кабинет → «Данные» (GDPR, Р15, В10): экспорт своих данных сразу скачиванием, согласие на
 * обезличенные прогнозы и удаление аккаунта с 7 днями на отмену. Пока аккаунт ждет удаления,
 * сервер отвечает на все, кроме профиля, отмены и выхода, 403 account.deletion_pending —
 * приложение показывает вместо экранов один экран отмены (DeletionPendingScreen).
 */

export type ExportFormat = 'json' | 'csv';
export type DeletionOut = components['schemas']['DeletionOut'];

/** Имя файла из Content-Disposition: attachment; filename="capper-export-2026-10-14.json". */
export function attachmentName(header: string | null, fallback: string): string {
  const found = header ? /filename="?([^";]+)"?/i.exec(header) : null;
  const name = found?.[1]?.trim();
  return name && /^[\w.-]+$/.test(name) ? name : fallback;
}

/** Отдать файл браузеру: ссылка с download, клик и уборка. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Браузер забирает файл по ссылке асинхронно: адрес освобождаем позже
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * «Скачать JSON» и «Скачать CSV (ZIP)»: архив собирается сервером по запросу (GET
 * /api/me/export?format=), ссылок, которые где-то хранятся, нет. Возвращает имя файла.
 */
export function useExportData() {
  return useMutation({
    mutationFn: async (format: ExportFormat): Promise<string> => {
      const { data, error, response } = await api.GET('/api/me/export', {
        params: { query: { format } },
        parseAs: 'blob',
      });
      if (!response.ok || !data) throw apiErrorFrom(response.status, error);
      const fallback = `capper-export.${format === 'json' ? 'json' : 'zip'}`;
      const name = attachmentName(response.headers.get('Content-Disposition'), fallback);
      saveBlob(data as Blob, name);
      return name;
    },
  });
}

/** Согласие на обезличенные прогнозы (PATCH /api/me, Р15): новый профиль — сразу в кэш. */
export function useConsent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (consent: boolean) => unwrap(api.PATCH('/api/me', { body: { consent_training: consent } })),
    onSuccess: (me) => client.setQueryData(meQueryKey, me),
  });
}

/**
 * «Удалить аккаунт» (POST /api/me/deletion): пароль и код 2FA. Сервер завершает все сеансы и
 * стирает cookie — дальше вызывающий выводит из аккаунта (как выход).
 */
export function useRequestDeletion() {
  return useMutation({
    mutationFn: (body: { password: string; code: string }) => unwrap(api.POST('/api/me/deletion', { body })),
  });
}

/** «Отменить удаление» (DELETE /api/me/deletion): профиль перечитывается — приложение снова открыто. */
export function useCancelDeletion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.DELETE('/api/me/deletion')),
    // Нечего отменять (отменили в другой вкладке) — тоже перечитать профиль
    onSettled: () => client.invalidateQueries({ queryKey: meQueryKey }),
  });
}

/** Ответ сервера «аккаунт ждет удаления» на любой запрос. */
export const DELETION_PENDING = 'account.deletion_pending';
