import type { QueryKey } from '@tanstack/react-query';

import { meQueryKey } from '../../api/keys';
import type { IconName } from '../../components';
import type { components } from '../../api/schema';
import { paths } from '../../app/paths';
import { adminKeys } from '../admin/keys';
import { aiKeys } from '../ai/keys';
import { analysisKeys } from '../analysis/keys';
import { MONEY_QUERIES } from '../bank/currency';
import { ANALYTICS_PREFIX, betKeys, DASHBOARD_PREFIX } from '../bets/keys';

// Центр уведомлений (колокольчик, Р3): вид уведомления, ссылки и отметка прочитанного в кэше.

export type NotificationsOut = components['schemas']['NotificationsOut'];
export type NotificationItem = components['schemas']['NotificationOut'];

export type NotificationTone = 'good' | 'warn' | 'bad' | 'info' | null;

/** Иконка и цвет кружка по виду уведомления (как в макете: DATA.notifications). */
export function notificationLook(kind: string): { icon: IconName; tone: NotificationTone } {
  switch (kind) {
    case 'new_device':
      return { icon: 'device', tone: 'info' };
    case 'login_failures':
      return { icon: 'lock', tone: 'bad' };
    case 'limit_80':
      return { icon: 'coins', tone: 'warn' };
    case 'limit_100':
      return { icon: 'coins', tone: 'bad' };
    // Этап 3: общий бюджет ключа администратора — как лимит участника
    case 'budget_80':
      return { icon: 'coins', tone: 'warn' };
    case 'budget_100':
      return { icon: 'coins', tone: 'bad' };
    // Ключ Claude: не работает; просьба вернуть ключ администратора и решение по ней
    case 'ai_key_failed':
      return { icon: 'key', tone: 'bad' };
    case 'ai_mode_request':
      return { icon: 'key', tone: 'info' };
    case 'ai_mode_decision':
      return { icon: 'key', tone: 'info' };
    case 'data_stale':
      return { icon: 'clock', tone: 'warn' };
    case 'admin_message':
      return { icon: 'megaphone', tone: 'info' };
    case 'bet_settled':
      return { icon: 'ticket', tone: null };
    // Этап 4: сигнал расхода ИИ администратору (текст правила с числами — с сервера)
    case 'ai_alert':
      return { icon: 'alert', tone: 'warn' };
    default:
      return { icon: 'bell', tone: null };
  }
}

// Лимит и расход на ИИ: «Ключ Claude» и блок лимита анализа
const AI_BUDGET: readonly QueryKey[] = [aiKeys.all];

/**
 * Какие данные устарели, когда пришло уведомление этого вида: событие (просьба, решение,
 * расход) уже случилось на сервере, а открытый экран показывает старое. Переход по ссылке
 * уведомления на ту же страницу данные сам не перечитывает.
 */
export function staleQueriesFor(kind: string): readonly QueryKey[] {
  switch (kind) {
    case 'ai_mode_request':
      return [adminKeys.users, adminKeys.aiLimits, adminKeys.attention];
    case 'ai_mode_decision':
      return [...AI_BUDGET, meQueryKey];
    case 'ai_key_failed':
      return [...AI_BUDGET, adminKeys.aiKey];
    case 'limit_80':
    case 'limit_100':
      return [...AI_BUDGET, adminKeys.aiLimits, adminKeys.users, adminKeys.attention];
    case 'budget_80':
    case 'budget_100':
      return [...AI_BUDGET, adminKeys.aiBudget, adminKeys.aiLimits];
    // Архив матчей устарел: дело администратора на «Обзоре» и в кабинете
    case 'data_stale':
      return [adminKeys.attention];
    // Администратор сменил валюту программы: все суммы — заново (без уведомления участник
    // заметит смену по первому ответу в новой валюте, watchProgramCurrency)
    case 'currency_changed':
      return MONEY_QUERIES;
    // Ставка рассчитана сама (этап 5): ставки, банк, главная и аналитика
    case 'bet_settled':
      return [betKeys.all, analysisKeys.bank, DASHBOARD_PREFIX, ANALYTICS_PREFIX];
    default:
      return [];
  }
}

/** Ссылка уведомления — только путь этого сайта («/profile/security»), иначе без перехода. */
export function internalLink(link: string | null | undefined): string | null {
  if (typeof link !== 'string' || !/^\/(?![/\\])/.test(link) || /[\s\\]/.test(link)) return null;
  return link;
}

/**
 * Куда ведет уведомление без ссылки с сервера: «Ставка рассчитана» — на «Ставки» (ставку
 * откроет ссылка /bets?bet=ID, когда сервер ее пришлет), архив матчей — на «Обзор»
 * администрирования, где видно, когда была последняя загрузка.
 */
export function notificationLink(item: Pick<NotificationItem, 'kind' | 'link'>): string | null {
  const own = internalLink(item.link);
  if (own) return own;
  switch (item.kind) {
    case 'bet_settled':
      return paths.bets;
    case 'data_stale':
      return paths.admin();
    default:
      return null;
  }
}

/** Счетчик на колокольчике: больше 99 — «99+». */
export function badgeText(unread: number): string {
  return unread > 99 ? '99+' : String(unread);
}

/** Одно уведомление прочитано: отметка в кэше сразу, не дожидаясь сервера. */
export function markOneRead(data: NotificationsOut | undefined, id: number, at: string): NotificationsOut | undefined {
  if (!data) return data;
  let changed = false;
  const items = data.items.map((item) => {
    if (item.id !== id || item.read_at) return item;
    changed = true;
    return { ...item, read_at: at };
  });
  return changed ? { items, unread: Math.max(0, data.unread - 1) } : data;
}

/** Все прочитаны. */
export function markAllRead(data: NotificationsOut | undefined, at: string): NotificationsOut | undefined {
  if (!data) return data;
  return { items: data.items.map((item) => (item.read_at ? item : { ...item, read_at: at })), unread: 0 };
}
