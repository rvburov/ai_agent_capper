import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';
import { isLegacy } from './display';
import { useViewAs } from '../view/context';
import { asUserQuery, viewKey } from '../view/viewMode';
import { betKeys } from './keys';
import type { BetItem, BetLeg, LegResult } from './types';

/*
 * Этап 5: разбор ставки ИИ (В3, Р25) и подсказка исхода из новостей (В1-Г).
 *
 * Разбор пишет сервер: Sonnet 5.5 через Batch, один на матч (общий для всех, кто на него
 * ставил); ответ по схеме проверяет код. Экран только показывает его (GET
 * /api/bets/{id}/review, чужая ставка — 404): состояние ставки целиком и разбор матча каждой
 * ноги с исходом. Пока разбора нет — «разбор будет в течение нескольких часов».
 *
 * Подсказка из новостей — поле ноги news_result в карточке ставки (GET /api/bets/{id}): шаг
 * новостей перед анализом нашел результат матча. Это только подсказка: «Подставить 2:0»
 * заполняет форму, деньги считаются по нажатию «Сохранить результат».
 *
 * Типы — из OpenAPI бэкенда (schema.d.ts).
 */

type Schemas = components['schemas'];

export type BetReview = Schemas['BetReviewOut'];
export type LegReview = Schemas['LegReviewOut'];
export type ReviewLesson = Schemas['ReviewLessonOut'];
export type NewsResult = Schemas['NewsResultOut'];
export type ReviewVerdict = NonNullable<LegReview['verdict']>;
export type NotReviewedReason = NonNullable<BetReview['reason']>;

/** Подсказка ноги, если сервер ее прислал (только в карточке ставки, GET /api/bets/{id}). */
export function legNewsResult(leg: BetLeg): NewsResult | null {
  return leg.news_result ?? null;
}

/** Исход ставки на победу по победителю из новостей (у форы исход дает только счет). */
export function newsResultOutcome(leg: Pick<BetLeg, 'market' | 'selection'>, news: Pick<NewsResult, 'winner'>): LegResult | null {
  if (leg.market !== 'ML') return null;
  return leg.selection === news.winner ? 'win' : 'loss';
}

/**
 * Счет из новости для показа: «6-3 3-6 7-6(5)» → «6:3 3:6 7:6(5)», как счет в макете. На дефисе
 * браузер переносит строку внутри сета («6-3 3-» / «6»), на двоеточии между цифрами — нет.
 */
export function newsScoreText(score: string): string {
  return score.replace(/(\d)\s*[-\u2013\u2014]\s*(?=\d)/g, '$1:');
}

/** Ссылка на источник — только http(s). */
export function safeSourceUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Что показывать в блоке «Разбор ИИ». */
export type ReviewShown =
  | { kind: 'open' }
  | { kind: 'not_reviewed'; reason: NotReviewedReason }
  | { kind: 'pending'; legs: LegReview[] }
  | { kind: 'failed' }
  | { kind: 'done'; legs: LegReview[] };

/** Разбор бывает только у рассчитанной ставки приложения с исходом (не возврат). */
export function reviewable(bet: Pick<BetItem, 'status' | 'source'>): boolean {
  return bet.status !== 'open' && bet.status !== 'void' && !isLegacy(bet);
}

/**
 * Состояние блока. Открытая, бот и возврат — без запроса. Готовые разборы показываются и
 * тогда, когда часть ног еще в пакете.
 */
export function reviewShown(bet: Pick<BetItem, 'status' | 'source'>, review: BetReview | null | undefined): ReviewShown {
  if (bet.status === 'open') return { kind: 'open' };
  if (isLegacy(bet)) return { kind: 'not_reviewed', reason: 'legacy' };
  if (bet.status === 'void') return { kind: 'not_reviewed', reason: 'void' };
  if (!review || review.state === 'open') return { kind: 'pending', legs: [] };
  const done = review.legs.filter((leg) => leg.status === 'done');
  switch (review.state) {
    case 'not_reviewed':
      return { kind: 'not_reviewed', reason: review.reason ?? 'no_prediction' };
    case 'pending':
      return { kind: 'pending', legs: done };
    case 'failed':
      return { kind: 'failed' };
    default:
      return done.length ? { kind: 'done', legs: done } : { kind: 'failed' };
  }
}

// Ключ — под betKeys.all: расчет, сторно и уведомление «ставка рассчитана» перечитывают его сами
export const reviewKey = (id: number) => [...betKeys.all, 'review', id] as const;

async function fetchReview(id: number, asUser: number | null): Promise<BetReview> {
  return unwrap(api.GET('/api/bets/{bet_id}/review', { params: { path: { bet_id: id }, query: asUserQuery(asUser) } }));
}

/** Разбор ставки; у открытой, возврата и ставки бота запроса нет. */
export function useBetReview(bet: Pick<BetItem, 'id' | 'status' | 'source'>) {
  const asUser = useViewAs();
  return useQuery({
    queryKey: viewKey(asUser, reviewKey(bet.id)),
    queryFn: () => fetchReview(bet.id, asUser),
    enabled: reviewable(bet),
  });
}
