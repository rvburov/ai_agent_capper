import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { DASHBOARD_PREFIX } from '../bets/keys';
import { learningKeys } from './keys';
import type { Lesson, LessonIn, LessonsList } from './types';

/*
 * Уроки (этап 5, волна 2 backend): GET /api/lessons — все уроки и пороги из настроек (предел
 * уроков в анализе, своих случаев для проверки, усадка); решения — только администратор
 * (быстрая проверка, включение, выключение), предложить урок и «сообщить, когда наберется» —
 * каждый. Числа считает сервер (Т15), экран только рисует.
 */

/** Как часто спрашивать ход быстрой проверки: пакет Batch отвечает минуты и часы. */
export const QUICK_POLL_MS = 5_000;

/** Запрос всех уроков: для useLessons и для свежего списка после решения (fetchQuery). */
export function lessonsQuery() {
  return queryOptions({
    queryKey: learningKeys.lessons,
    queryFn: () => unwrap(api.GET('/api/lessons')),
    staleTime: 30_000,
  });
}

/** Все уроки и пороги: общий кэш вкладки «Уроки», плиток и «Модели учится» на главной. */
export function useLessons({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({ ...lessonsQuery(), enabled });
}

/** Быстрая проверка идет: ответа пакета еще нет. */
export function quickRunning(lesson: Pick<Lesson, 'quick'> | undefined): boolean {
  const status = lesson?.quick?.status;
  return status === 'pending' || status === 'running';
}

/**
 * Один урок (GET /api/lessons/{id}): пока идет быстрая проверка (poll) — опрос раз в
 * QUICK_POLL_MS, ход и итог — в поле quick. Первым показывается урок из списка.
 */
export function useLesson(id: number, { poll = false, initial }: { poll?: boolean; initial?: Lesson } = {}) {
  return useQuery({
    queryKey: learningKeys.lesson(id),
    queryFn: () => unwrap(api.GET('/api/lessons/{lesson_id}', { params: { path: { lesson_id: id } } })),
    ...(initial ? { initialData: initial, initialDataUpdatedAt: 0 } : {}),
    refetchInterval: (query) => (poll && quickRunning(query.state.data) ? QUICK_POLL_MS : false),
  });
}

/** Словарь признаков условия урока (форма «Предложить урок»): меняется только с кодом. */
export function useLessonDictionary({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.dictionary,
    queryFn: () => unwrap(api.GET('/api/lessons/dictionary')),
    staleTime: Infinity,
    enabled,
  });
}

/** Быстрая проверка до запуска: матчей, цена, худший случай, бюджет проверок (администратор). */
export function useQuickCheckPreview(id: number, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.quickCheck(id),
    queryFn: () => unwrap(api.GET('/api/lessons/{lesson_id}/quick-check', { params: { path: { lesson_id: id } } })),
    // бюджет и резерв меняются от чужих прогонов: каждое открытие окна — свежие числа
    staleTime: 0,
    enabled,
  });
}

/**
 * Урок изменился (ответ сервера): он же — в списке и в карточке; сводка экрана, плитки и
 * главная («Модель учится», «Требует внимания») перечитываются.
 */
export function storeLesson(client: QueryClient, lesson: Lesson): void {
  client.setQueryData(learningKeys.lesson(lesson.id), lesson);
  client.setQueryData<LessonsList>(learningKeys.lessons, (list) =>
    list ? { ...list, items: list.items.map((item) => (item.id === lesson.id ? lesson : item)) } : list,
  );
  void client.invalidateQueries({ queryKey: learningKeys.all });
  void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
}

type LessonAction = 'enable' | 'disable' | 'notify-when-ready';

function postAction(id: number, action: LessonAction) {
  const params = { params: { path: { lesson_id: id } } };
  switch (action) {
    case 'enable':
      return unwrap(api.POST('/api/lessons/{lesson_id}/enable', params));
    case 'disable':
      return unwrap(api.POST('/api/lessons/{lesson_id}/disable', params));
    default:
      return unwrap(api.POST('/api/lessons/{lesson_id}/notify-when-ready', params));
  }
}

/** «Использовать в анализе», выключить, «Сообщить, когда наберется». */
export function useLessonAction(action: LessonAction) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => postAction(id, action),
    onSuccess: (lesson) => storeLesson(client, lesson),
  });
}

/** Запустить быструю проверку (202): ход — опросом урока. */
export function useStartQuickCheck(id: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/lessons/{lesson_id}/quick-check', { params: { path: { lesson_id: id } } })),
    onSuccess: (preview) => {
      client.setQueryData(learningKeys.quickCheck(id), preview);
      void client.invalidateQueries({ queryKey: learningKeys.lesson(id) });
    },
    // отказ (409: бюджет, уже идет) — свежие цена и остаток бюджета; урок и список — тоже:
    // проверку мог запустить другой администратор, тогда ход виден опросом урока
    onError: () => {
      void client.invalidateQueries({ queryKey: learningKeys.quickCheck(id) });
      void client.invalidateQueries({ queryKey: learningKeys.lesson(id) });
      void client.invalidateQueries({ queryKey: learningKeys.lessons, exact: true });
    },
  });
}

/** Предложить урок: гипотеза с условием из словаря. */
export function useProposeLesson() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LessonIn) => unwrap(api.POST('/api/lessons', { body })),
    onSuccess: (lesson) => {
      client.setQueryData(learningKeys.lesson(lesson.id), lesson);
      void client.invalidateQueries({ queryKey: learningKeys.all });
      void client.invalidateQueries({ queryKey: DASHBOARD_PREFIX });
    },
  });
}
